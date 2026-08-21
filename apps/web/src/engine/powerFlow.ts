import type { Cable } from '../data/cables';
import type { SimulationState } from '../store/simulation';

export interface SolvedPowerEdge {
  magnitudeKw: number;
  direction: 'forward' | 'reverse';
  reason: 'flowing' | 'status-off' | 'data-unavailable' | 'zero-flow';
}

interface Edge { key: string; cable: Cable; segmentIndex: number; from: string; to: string }

const EPSILON = 0.01;

function nodeForAnchor(
  anchorId: string,
  cable: Cable,
  segmentIndex: number,
  end: 'from' | 'to',
  cables: Cable[],
  seen = new Set<string>(),
): string {
  const component = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (component && !anchorId.startsWith('cable:')) return `component:${component[1]}`;
  const reference = anchorId.match(/^cable:(.+)\.(from|to)$/);
  if (reference) {
    const referenceKey = `${reference[1]}:${reference[2]}`;
    if (seen.has(referenceKey)) return `junction:${referenceKey}`;
    const referenced = cables.find((item) => item.id === reference[1]);
    if (!referenced?.segments.length) return `junction:${referenceKey}`;
    const referencedEnd = reference[2] as 'from' | 'to';
    const nested = referencedEnd === 'from'
      ? referenced.segments[0].fromAnchorId
      : referenced.segments[referenced.segments.length - 1].toAnchorId;
    if (!nested) return `junction:${referenceKey}`;
    const nextSeen = new Set(seen);
    nextSeen.add(referenceKey);
    return nodeForAnchor(
      nested,
      referenced,
      referencedEnd === 'from' ? 0 : referenced.segments.length - 1,
      referencedEnd,
      cables,
      nextSeen,
    );
  }
  return `junction:${cable.id}:${cable.segments.length === 1 ? end : `${segmentIndex}:${end}`}`;
}

function statusAvailable(state: SimulationState, key: string): boolean {
  if (state.controlMode !== 'replay') return true;
  return state.playbackSnapshot?.statusAvailability[key as keyof NonNullable<SimulationState['playbackSnapshot']>['statusAvailability']] === true;
}

function enabledComponent(id: string, state: SimulationState): boolean | null {
  if (id === 'pv-array') {
    if (state.controlMode !== 'replay') return state.pv_on || state.pv_power > EPSILON;
    return statusAvailable(state, 'pv_on') ? state.pv_on : null;
  }
  // 采集文件没有 CB/GS 遥信时只能标记“未知”，不能把未知误判为明确分闸。
  if (id === 'combiner-box') return statusAvailable(state, 'cb_connected') ? state.cb_connected : true;
  if (id === 'grid') return statusAvailable(state, 'grid_online') ? state.grid_online : null;
  if (id === 'grid-switch') {
    if (!statusAvailable(state, 'grid_online')) return null;
    return state.grid_online && (statusAvailable(state, 'gs_on') ? state.gs_on : true);
  }
  if (id === 'load') return statusAvailable(state, 'load_on') ? state.load_on : null;
  if (id === 'heat-pump') return statusAvailable(state, 'hp_on') ? state.hp_on : null;
  if (id === 'pump') return statusAvailable(state, 'pump_on') ? state.pump_on : null;
  return true;
}

function injectionFor(id: string, state: SimulationState): number | null {
  const replay = state.controlMode === 'replay';
  const values = state.playbackSnapshot?.values;
  if (id === 'pv-array') {
    if (replay) {
      if (!state.pv_on) return 0;
      const power = values?.pv_power
        ?? (values?.pv_voltage != null && values?.pv_current != null
          ? values.pv_voltage * values.pv_current / 1000
          : null);
      return power == null ? null : Math.max(0, power);
    }
    return state.pv_on && state.cb_connected ? Math.max(0, state.pv_power) : 0;
  }
  if (id === 'battery') {
    if (!replay) return state.battery_power_kw;
    return values?.battery_voltage != null && values?.battery_current != null
      ? -(values.battery_voltage * values.battery_current) / 1000
      : null;
  }
  if (id === 'load') {
    if (!state.load_on) return 0;
    const power = replay ? values?.system_active_power : state.load_power_kw;
    return power == null ? null : -Math.max(0, power);
  }
  if (id === 'heat-pump') {
    if (!state.hp_on) return 0;
    const power = replay ? values?.hp_power : state.hp_power;
    return power == null ? null : -Math.max(0, power);
  }
  return 0;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j <= n; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= n; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row[n]);
}

/** 基于节点注入功率和 KCL 求解每一段功率流；等效单位阻抗使闭环也有稳定唯一解。 */
export function solvePowerSegment(cable: Cable, segmentIndex: number, state: SimulationState): SolvedPowerEdge {
  const edges: Edge[] = [];
  for (const item of state.cables) {
    if (item.kind !== 'power') continue;
    item.segments.forEach((segment, index) => edges.push({
      key: `${item.id}:${index}`,
      cable: item,
      segmentIndex: index,
      from: nodeForAnchor(segment.fromAnchorId, item, index, 'from', state.cables),
      to: nodeForAnchor(segment.toAnchorId, item, index, 'to', state.cables),
    }));
  }
  const target = edges.find((edge) => edge.cable.id === cable.id && edge.segmentIndex === segmentIndex);
  if (!target) return { magnitudeKw: 0, direction: cable.direction, reason: 'data-unavailable' };

  for (const node of [target.from, target.to]) {
    if (!node.startsWith('component:')) continue;
    const status = enabledComponent(node.slice('component:'.length), state);
    if (status == null) return { magnitudeKw: 0, direction: cable.direction, reason: 'data-unavailable' };
    if (!status) return { magnitudeKw: 0, direction: cable.direction, reason: 'status-off' };
  }

  const adjacency = new Map<string, Edge[]>();
  for (const edge of edges) {
    const edgeEnabled = [edge.from, edge.to].every((node) => {
      if (!node.startsWith('component:')) return true;
      return enabledComponent(node.slice('component:'.length), state) === true;
    });
    if (!edgeEnabled) continue;
    for (const node of [edge.from, edge.to]) {
      if (!adjacency.has(node)) adjacency.set(node, []);
      adjacency.get(node)!.push(edge);
    }
  }

  const connected = new Set<string>();
  const connectedQueue = [target.from];
  while (connectedQueue.length) {
    const node = connectedQueue.shift()!;
    if (connected.has(node)) continue;
    connected.add(node);
    for (const edge of adjacency.get(node) ?? []) {
      const next = edge.from === node ? edge.to : edge.from;
      if (!connected.has(next)) connectedQueue.push(next);
    }
  }
  if (!connected.has(target.to)) {
    return { magnitudeKw: 0, direction: cable.direction, reason: 'zero-flow' };
  }
  const componentNodes = [...connected].filter((node) => node.startsWith('component:'));
  const componentIds = componentNodes.map((node) => node.slice('component:'.length));
  const injections = new Map<string, number>();
  for (const id of componentIds) {
    const injection = injectionFor(id, state);
    if (injection == null) {
      return { magnitudeKw: 0, direction: cable.direction, reason: 'data-unavailable' };
    }
    injections.set(`component:${id}`, injection);
  }

  // 电网在线时作为平衡节点；孤网则由逆变器承担汇总节点，避免不完整测点制造功率。
  const knownTotal = [...injections.values()].reduce((sum, value) => sum + value, 0);
  const slack = state.grid_online && state.gs_on && adjacency.has('component:grid')
    ? 'component:grid'
    : adjacency.has('component:inverter') ? 'component:inverter'
    : adjacency.has('component:load') ? 'component:load'
    : adjacency.has('component:heat-pump') ? 'component:heat-pump'
    : null;
  const reference = slack && connected.has(slack) ? slack : [...connected][0];
  injections.set(reference, (injections.get(reference) ?? 0) - knownTotal);

  const unknownNodes = [...connected].filter((node) => node !== reference);
  const indexByNode = new Map(unknownNodes.map((node, index) => [node, index]));
  const matrix = unknownNodes.map(() => unknownNodes.map(() => 0));
  const vector = unknownNodes.map((node) => injections.get(node) ?? 0);
  for (const node of unknownNodes) {
    const row = indexByNode.get(node)!;
    for (const edge of adjacency.get(node) ?? []) {
      const neighbour = edge.from === node ? edge.to : edge.from;
      matrix[row][row] += 1;
      const column = indexByNode.get(neighbour);
      if (column != null) matrix[row][column] -= 1;
    }
  }
  const solved = solveLinearSystem(matrix, vector);
  if (!solved) return { magnitudeKw: 0, direction: cable.direction, reason: 'data-unavailable' };
  const potential = (node: string) => node === reference ? 0 : solved[indexByNode.get(node)!];
  const signedFlow = potential(target.from) - potential(target.to);
  const magnitudeKw = Math.abs(signedFlow);
  if (!Number.isFinite(magnitudeKw) || magnitudeKw <= EPSILON) {
    return { magnitudeKw: 0, direction: cable.direction, reason: 'zero-flow' };
  }
  return {
    magnitudeKw,
    direction: signedFlow > 0 ? 'forward' : 'reverse',
    reason: 'flowing',
  };
}
