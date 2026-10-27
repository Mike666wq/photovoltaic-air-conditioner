import { describe, expect, it } from 'vitest';
import { BMS_ALARM_DECODER_VERSION, bmsAlarmPackSummary, decodeBmsAlarm } from './bmsAlarmDecoder';

const pack = (states = Array(15).fill(0), cells = [0, 1], temperatures = [0, 0xf0]) => [
  cells.length, ...cells, temperatures.length, ...temperatures, 0, 0, 0, 0, 15, ...states, 0xaa,
];
const hex = (bytes: number[]) => bytes.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();

describe('BMS告警协议解码', () => {
  it('严格解码单Pack及带INFOFLAG载荷，保留原始位、未知状态码和零值', () => {
    const states = Array(15).fill(0); states[0] = 1; states[4] = 0xc0; states[5] = 0x29; states[6] = 0x80;
    const result = decodeBmsAlarm(hex([1, 1, ...pack(states, [0, 0x77], [0xf1])]), 1);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.infoFlagOffset).toBe(1); expect(result.layout).toBe('single'); expect(result.version).toBe(BMS_ALARM_DECODER_VERSION);
    expect(result.packs[0].cells).toEqual([0, 0x77]); expect(result.packs[0].cells[0]).toBe(0);
    expect(result.packs[0].unknownFlags).toContain('电芯 2 未知状态码 0x77');
    expect(result.packs[0].alarms).toContain('状态1 告警：单体过压');
    expect(bmsAlarmPackSummary(result.packs[0])).toBe('检测到 1 条告警或保护状态 · 另含未知状态码或未映射状态位');
    expect(result.packs[0].runtime).toEqual(['正在充电', '正在放电', '放电 MOS · 开', '充电 MOS · 关', '交流输入 · 有', '限流 · 启用']);
    expect(result.packs[0].states[6]).toEqual(expect.objectContaining({ hex: '0x80', bits: '10000000' }));
    expect(result.packs[0].temperatures).toEqual([0xf1]); expect(result.packs[0].reserved).toBe(0xaa);
  });

  it('解码多Pack并按目标Pack选择，同时保留完整载荷中的各Pack', () => {
    const first = pack(Array(15).fill(0), [0]); const second = pack(Array(15).fill(0), [2]);
    const result = decodeBmsAlarm(hex([2, ...first, ...second]), 2);
    expect(result.status).toBe('decoded');
    if (result.status === 'decoded') {
      expect(result.layout).toBe('multi'); expect(result.packs.map(item => item.pack)).toEqual([1, 2]); expect(result.packs[1].cells).toEqual([2]);
    }
  });

  it('截断、不支持结构和缺失告警帧都不能伪装成无告警', () => {
    expect(decodeBmsAlarm('', 1)).toMatchObject({ status: 'unknown' });
    expect(decodeBmsAlarm(hex([1, ...pack().slice(0, -1)]), 1)).toMatchObject({ status: 'unknown' });
    expect(decodeBmsAlarm(hex([1, 0, 0]), 1)).toMatchObject({ status: 'unknown' });
  });

  it('有效全零告警状态显示无告警；未知码原值仍可查看', () => {
    const result = decodeBmsAlarm(hex([1, ...pack(Array(15).fill(0), [0], [0])]), 1);
    expect(result.status).toBe('decoded');
    if (result.status === 'decoded') { expect(result.packs[0].alarms).toEqual([]); expect(result.packs[0].runtime).toEqual(['未充电', '未放电', '放电 MOS · 关', '充电 MOS · 关', '交流输入 · 无', '限流 · 未启用']); }
  });

  it('未识别状态码保留原值并标为未知，不计入已确认告警或无告警', () => {
    const result = decodeBmsAlarm(hex([1, ...pack(Array(15).fill(0), [0x77], [0xfe])]), 1);
    expect(result.status).toBe('decoded');
    if (result.status === 'decoded') {
      const decoded = result.packs[0];
      expect(decoded.cells).toEqual([0x77]); expect(decoded.temperatures).toEqual([0xfe]);
      expect(decoded.alarms).toEqual([]);
      expect(decoded.unknownFlags).toEqual(['电芯 1 未知状态码 0x77', '温度测点 1 未知状态码 0xFE']);
      expect(bmsAlarmPackSummary(decoded)).toContain('告警状态部分未知');
      expect(bmsAlarmPackSummary(decoded)).not.toContain('无已解码告警');
    }
  });
});
