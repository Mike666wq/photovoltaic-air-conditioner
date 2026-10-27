/** 与公开采集端 Protocol.DataParser.Alarm、Program.DecodeStatus/DecodeRuntime 对齐的本地只读解码。 */
export const BMS_ALARM_DECODER_VERSION = 'Mike666wq/bms main · Alarm/DecodeStatus/DecodeRuntime · 1';

export interface BmsAlarmStateByte { state: number; hex: string; bits: string; alarms: string[]; runtime: string[]; unmappedBits: number[] }
export interface BmsAlarmPack {
  pack: number;
  cells: number[];
  temperatures: number[];
  chargeCurrent: number;
  totalVoltage: number;
  shortCircuit: number;
  shortCircuitCount: number;
  states: BmsAlarmStateByte[];
  reserved: number;
  alarms: string[];
  runtime: string[];
  unknownFlags: string[];
}
export type BmsAlarmDecode =
  | { status: 'decoded'; version: string; infoFlagOffset: 0 | 1; layout: 'single' | 'multi'; packs: BmsAlarmPack[]; rawHex: string }
  | { status: 'unknown'; version: string; reason: string; rawHex: string };

class Cursor {
  offset: number;
  constructor(private readonly bytes: number[], offset: number) { this.offset = offset; }
  u8() { if (this.offset >= this.bytes.length) throw new RangeError('truncated'); return this.bytes[this.offset++]; }
  take(count: number) { return Array.from({ length: count }, () => this.u8()); }
  get remaining() { return this.bytes.length - this.offset; }
}

const statusName = (value: number) => value === 0 ? '正常' : value === 1 ? '低于下限' : value === 2 ? '高于上限' : value === 0xf0 ? '其他错误' : `未知状态码 0x${hex(value)}`;
const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');
const knownAlarmStatus = (value: number) => value === 1 || value === 2 || value === 0xf0;
function stateNames(state: number, bits: number): string[] {
  let names: Array<string | null> | null = null;
  if (state === 1) names = ['单体过压', '单体欠压', '总压过压', '总压欠压', '充电过流', '放电过流1', '压差报警', '压差保护'];
  else if (state === 2) names = ['单体过压保护', '单体欠压保护', '总压过压保护', '总压欠压保护', '充电过流保护', '放电过流1保护', '放电过流2保护', '短路保护'];
  else if (state === 3 || state === 4) names = ['充电高温', '充电低温', '放电高温', '放电低温', '环境高温', '环境低温', 'MOS高温', 'MOS低温'];
  else if (state === 5) names = ['反接', 'SOC低', '充电MOS故障', '放电MOS故障', '电芯过温', '电芯欠温', null, null];
  else if (state >= 8 && state <= 11) names = Array.from({ length: 8 }, (_, bit) => `电芯故障 ${((state - 8) * 8) + bit + 1}`);
  else if (state === 14) names = ['放电MOS故障', '充电MOS故障', '前端芯片故障', '时钟故障', '数据存储故障', '参数存储故障', '高压保护', '预放MOS故障'];
  else if (state === 15) names = ['P+绝缘保护', 'P-绝缘保护', '电芯故障', '温度故障', '振动传感器故障', '限流板故障', null, null];
  return names ? names.filter((name, bit) => name && (bits & (1 << bit)) !== 0) as string[] : [];
}
function knownStateBits(state: number): Array<string | null> | null {
  if (state === 1) return ['单体过压', '单体欠压', '总压过压', '总压欠压', '充电过流', '放电过流1', '压差报警', '压差保护'];
  if (state === 2) return ['单体过压保护', '单体欠压保护', '总压过压保护', '总压欠压保护', '充电过流保护', '放电过流1保护', '放电过流2保护', '短路保护'];
  if (state === 3 || state === 4) return ['充电高温', '充电低温', '放电高温', '放电低温', '环境高温', '环境低温', 'MOS高温', 'MOS低温'];
  if (state === 5) return ['反接', 'SOC低', '充电MOS故障', '放电MOS故障', '电芯过温', '电芯欠温', '充电状态', '放电状态'];
  if (state === 6) return ['放电MOS状态', '充电MOS状态', null, '交流输入状态', null, '限流状态', null, null];
  if (state >= 8 && state <= 11) return Array.from({ length: 8 }, (_, bit) => `电芯故障 ${((state - 8) * 8) + bit + 1}`);
  if (state === 14) return ['放电MOS故障', '充电MOS故障', '前端芯片故障', '时钟故障', '数据存储故障', '参数存储故障', '高压保护', '预放MOS故障'];
  if (state === 15) return ['P+绝缘保护', 'P-绝缘保护', '电芯故障', '温度故障', '振动传感器故障', '限流板故障', null, null];
  return null;
}

function parseAt(bytes: number[], offset: number, targetPack: number, multi: boolean) {
  const c = new Cursor(bytes, offset);
  const marker = c.u8();
  if (multi ? marker < 1 : marker !== targetPack) throw new Error('unsupported');
  const count = multi ? marker : 1;
  if (count < 1 || count > 16 || (multi && targetPack > count)) throw new Error('unsupported');
  const packs: BmsAlarmPack[] = [];
  for (let i = 0; i < count; i++) {
    const pack = multi ? i + 1 : targetPack;
    const cellCount = c.u8(); if (cellCount < 1 || cellCount > 48) throw new Error('unsupported');
    const cells = c.take(cellCount).map(v => v); // Cells are status bytes, not inferred positions.
    const temperatureCount = c.u8(); if (temperatureCount > 32) throw new Error('unsupported');
    const temperatures = c.take(temperatureCount);
    const chargeCurrent = c.u8(), totalVoltage = c.u8(), shortCircuit = c.u8(), shortCircuitCount = c.u8();
    if (c.u8() !== 15) throw new Error('unsupported');
    const stateBytes = c.take(15), reserved = c.u8();
    const states = stateBytes.map((value, index) => {
      const state = index + 1, names = knownStateBits(state);
      return { state, hex: `0x${hex(value)}`, bits: value.toString(2).padStart(8, '0'), alarms: stateNames(state, value), runtime: state === 5 ? [value & 0x40 ? '正在充电' : '未充电', value & 0x80 ? '正在放电' : '未放电'] : state === 6 ? [value & 0x01 ? '放电 MOS · 开' : '放电 MOS · 关', value & 0x02 ? '充电 MOS · 开' : '充电 MOS · 关', value & 0x08 ? '交流输入 · 有' : '交流输入 · 无', value & 0x20 ? '限流 · 启用' : '限流 · 未启用'] : [], unmappedBits: Array.from({ length: 8 }, (_, bit) => bit).filter(bit => (value & (1 << bit)) !== 0 && (!names || names[bit] == null)) };
    });
    const alarms: string[] = [], unknownFlags: string[] = [];
    const addStatus = (label: string, value: number) => {
      if (value === 0) return;
      if (knownAlarmStatus(value)) alarms.push(`${label}：${statusName(value)}`);
      else unknownFlags.push(`${label} 未知状态码 0x${hex(value)}`);
    };
    cells.forEach((value, index) => addStatus(`电芯 ${index + 1}`, value));
    temperatures.forEach((value, index) => addStatus(`温度测点 ${index + 1}`, value));
    addStatus('充电电流', chargeCurrent);
    addStatus('总压', totalVoltage);
    alarms.push(
      ...(shortCircuit === 0 ? [] : [`短路状态：0x${hex(shortCircuit)}`]),
      ...states.flatMap(s => {
        const kind = s.state === 5 ? '状态' : s.state >= 8 && s.state <= 11 ? '故障' : s.state === 14 || s.state === 15 ? '故障/保护' : s.state % 2 === 0 ? '保护' : '告警';
        return s.alarms.map(name => `状态${s.state} ${kind}：${name}`);
      }),
    );
    unknownFlags.push(...states.flatMap(s => s.unmappedBits.map(bit => `状态${s.state} 位${bit} 未映射`)));
    packs.push({ pack, cells, temperatures, chargeCurrent, totalVoltage, shortCircuit, shortCircuitCount, states, reserved, alarms, runtime: states.flatMap(s => s.runtime), unknownFlags });
  }
  if (c.remaining !== 0) throw new Error('unsupported');
  return { packs, layout: multi ? 'multi' as const : 'single' as const };
}

/** Strictly accepts only complete known layouts at INFO offset 0 or 1. */
export function decodeBmsAlarm(payloadHex: string, targetPack: number): BmsAlarmDecode {
  const rawHex = typeof payloadHex === 'string' ? payloadHex : '';
  const unknown = (reason: string): BmsAlarmDecode => ({ status: 'unknown', version: BMS_ALARM_DECODER_VERSION, reason, rawHex });
  if (!Number.isInteger(targetPack) || targetPack < 1 || targetPack > 16) return unknown('目标 Pack 编号无效，告警状态未知。');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(rawHex)) return unknown('HEX 为空、截断或格式无效，告警状态未知。');
  const bytes = rawHex.match(/.{2}/g)!.map(pair => Number.parseInt(pair, 16));
  const matches: Array<{ offset: 0 | 1; result: ReturnType<typeof parseAt> }> = [];
  for (const offset of [0, 1] as const) {
    const marker = bytes[offset];
    const modes = marker === targetPack && marker > 1 ? [false, true] : [marker !== targetPack];
    for (const multi of modes) {
      try { matches.push({ offset, result: parseAt(bytes, offset, targetPack, multi) }); } catch { /* Try the other published INFO layout. */ }
    }
  }
  if (matches.length > 1) return unknown('告警载荷匹配多个完整布局，无法无歧义解码；已保留原始 HEX。');
  const match = matches[0];
  if (!match) return unknown('载荷截断或不符合已支持的完整告警结构；已保留原始 HEX。');
  return { status: 'decoded', version: BMS_ALARM_DECODER_VERSION, infoFlagOffset: match.offset, layout: match.result.layout, packs: match.result.packs, rawHex };
}

export function bmsAlarmPackSummary(pack: Pick<BmsAlarmPack, 'alarms' | 'unknownFlags'>) {
  if (pack.alarms.length) return `检测到 ${pack.alarms.length} 条告警或保护状态${pack.unknownFlags.length ? ' · 另含未知状态码或未映射状态位' : ''}`;
  if (pack.unknownFlags.length) return '含未知状态码或未映射状态位，告警状态部分未知';
  return '当前无已解码告警或保护状态';
}
