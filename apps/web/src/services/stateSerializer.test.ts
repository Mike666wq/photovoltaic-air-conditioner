import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, PERSIST_SCHEMA_VERSION } from '../data/saveSchema';
import { useSimStore } from '../store/simulation';
import {
  applyDocumentToStore,
  DocumentValidationError,
  serializeState,
  validateDocument,
} from './stateSerializer';

describe('场景文档序列化与迁移', () => {
  beforeEach(() => {
    useSimStore.setState({
      controlMode: 'simulation',
      playbackSnapshot: null,
      injectionDataset: null,
      injectionSources: [],
      injectionFieldAvailability: {},
      timelineIndex: -1,
      timelineCursorMs: null,
      timelinePlaying: false,
    });
  });

  it('新保存文档使用 v2，并能通过深校验', () => {
    const saved = serializeState('校验场景');
    expect(saved.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);
    expect(validateDocument(saved)).toEqual(saved);
  });

  it('把缺少新字段的 v1 文档迁移为 v2 默认值', () => {
    const legacy = createEmptyDocument() as unknown as Record<string, any>;
    legacy.schemaVersion = 1;
    delete legacy.simulation.sac_water_level;
    delete legacy.simulation.sac_water_temp;
    delete legacy.simulation.sac_fan_speed;
    delete legacy.simulation.sac_outlet_temp;
    delete legacy.simulation.sac_on;
    delete legacy.preferences.snapToGrid;
    delete legacy.preferences.smartGuides;
    legacy.layout.cables = [{
      id: 'legacy-cable', kind: 'power',
      segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'inverter.left' }],
      floatingFrom: null, floatingTo: null,
    }];

    const migrated = validateDocument(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.simulation).toMatchObject({ sac_water_level: 72, sac_on: true });
    expect(migrated.preferences).toMatchObject({ snapToGrid: true, smartGuides: true });
    expect(migrated.layout.cables[0]).toMatchObject({
      animationEnabled: true,
      direction: 'forward',
      directionMode: 'forward',
      routeMode: 'orthogonal-auto',
    });
  });

  it('拒绝非有限坐标、悬空线缆引用和引用环', () => {
    const invalidPoint = createEmptyDocument() as unknown as Record<string, any>;
    invalidPoint.layout.positions = { pv: { x: Number.NaN, y: 0 } };
    expect(() => validateDocument(invalidPoint)).toThrow(DocumentValidationError);

    const missingRef = createEmptyDocument() as unknown as Record<string, any>;
    missingRef.layout.cables = [{
      id: 'a', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [{ fromAnchorId: 'cable:missing.to', toAnchorId: 'load.left' }],
      floatingFrom: null, floatingTo: null,
    }];
    expect(() => validateDocument(missingRef)).toThrow(/不存在的线缆/);

    const cycle = createEmptyDocument() as unknown as Record<string, any>;
    cycle.layout.cables = [
      { id: 'a', kind: 'power', animationEnabled: true, direction: 'forward', floatingFrom: null, floatingTo: null,
        segments: [{ fromAnchorId: 'cable:b.to', toAnchorId: 'load.left' }] },
      { id: 'b', kind: 'power', animationEnabled: true, direction: 'forward', floatingFrom: null, floatingTo: null,
        segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'cable:a.from' }] },
    ];
    expect(() => validateDocument(cycle)).toThrow(/引用环/);
  });

  it('打开场景时原子退出并清空旧回放会话', () => {
    const snapshot = {
      timestamp: 1, values: { pv_power: 9 }, availability: { pv_power: true }, provenance: {},
      statuses: {}, statusAvailability: {}, sourceIds: [], sourceRowIndices: {}, sourceTimestamps: {},
    };
    useSimStore.setState({
      controlMode: 'replay',
      playbackSnapshot: snapshot,
      injectionSources: [{} as any],
      timelineIndex: 88,
      timelineCursorMs: 123,
      timelinePlaying: true,
      injectionFieldAvailability: { pv_power: true },
    });
    const doc = validateDocument(createEmptyDocument());
    doc.simulation.pv_power = 1.25;
    applyDocumentToStore(doc);

    expect(useSimStore.getState()).toMatchObject({
      pv_power: 1.25,
      controlMode: 'simulation',
      playbackSnapshot: null,
      injectionSources: [],
      injectionDataset: null,
      timelineIndex: -1,
      timelineCursorMs: null,
      timelinePlaying: false,
      injectionFieldAvailability: {},
    });
  });
});
