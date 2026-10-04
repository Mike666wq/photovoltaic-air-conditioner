import { expect, it } from 'vitest';
import { latestByChannel, sourceTrendLines } from './realtimeSource';
import { buildTrendSeries } from '../components/bmsRealtime/MonitoringTrendChart';
import { buildExperimentTrendLines } from './experimentRealtimeTypes';
it('按接收顺序而不是客户端时间选当前来源，各通道独立', () => {
  const samples = [{ acceptedOrder: 3, channel: 'PLC', source: 'simulation' }, { acceptedOrder: 1, channel: 'PLC', source: 'serial' }, { acceptedOrder: 2, channel: 'DDSU666', source: 'serial' }];
  expect(latestByChannel(samples, s => s.channel)).toEqual([samples[0], samples[2]]);
});
it('真实→模拟→真实不跨越中间来源重连，保留所有零值与负值', () => {
  const points = ['serial', 'simulation', 'serial'].map((source, i) => ({ time: new Date(1000 + i * 1000).toISOString(), source, session: 'same-session', value: i - 1 }));
  const lines = sourceTrendLines('温度', '℃', points), built = buildTrendSeries(lines);
  expect(lines[0].points[0].session).not.toBe(lines[0].points[1].session);
  expect(built[0].data).toEqual([[1000, -1], [3000, null], [3000, 1]]);
  expect(built[1].data).toEqual([[2000, 0]]);
});
it('模拟期间缺失测点，返回实测仍通过来源段号断线；质量或单位不匹配断线', () => {
  const points = [0, 2].map((sourceSegment, i) => ({ entryId: i + 1, observedUtc: new Date(1000 + i * 1000).toISOString(), value: 25, quality: 'good', unit: '℃', receivedAt: '', configVersion: 'c1', acquisitionRound: i, connectionSessionId: 's1', source: 'serial' as const, equipmentId: 'PLC', sourceSegment }));
  expect(buildTrendSeries(buildExperimentTrendLines('T1', '℃', points))[0].data).toEqual([[1000, 25], [2000, null], [2000, 25]]);
  expect(buildExperimentTrendLines('T1', 'W', points)[0].points.every(p => p.value === null)).toBe(true);
  expect(buildExperimentTrendLines('T1', '℃', [{ ...points[0], quality: 'timeout' }])[0].points[0].value).toBeNull();
});
