// @ts-nocheck -- Node-only 导入链路验收；生产 tsconfig 不引入 @types/node，Vitest 运行时提供 Node API。
//
// 设计约束：真实实验数据是「用户每次运行后自行上传」的，列名/列数/采样率逐次不同，
// data/ 目录也在 .gitignore 中（真实文件不进仓库）。因此本文件不得依赖 data/ 里的任何文件，
// 否则 CI 必然 ENOENT 失败。所有验收均使用 xlsx 现场生成的同构夹具，不读取 data/。
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseFile } from './injectionParser';
import { prepareDataSource } from './dataSourcePipeline';
import { buildPlaybackSession } from './playbackSession';
import { buildOperationalDiagnostics } from './operationalDiagnostics';

/** 把对象数组写成 xlsx 二进制，模拟力控导出的工作簿。 */
function buildWorkbook(rows: Record<string, string | number>[], sheetName: string): Uint8Array {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** 北京时间无时区采样戳，与 parseDatasetTime 的约定一致。 */
function stamp(base: number, offsetMs: number): string {
  const d = new Date(base + offsetMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const T0 = Date.UTC(2026, 6, 17, 8, 0, 0);

/** 热工/电表表：力控导出的 18 通道（T0~T5 温度 + D 直流 + DU 市电 + Z 光伏）。 */
function thermalRows(count: number, stepMs: number, start = T0) {
  return Array.from({ length: count }, (_, i) => ({
    '序号': i + 1,
    '采样时刻': stamp(start, i * stepMs),
    'T0.PV': (21 + Math.sin(i / 6) * 3).toFixed(2),
    'T1.PV': (29 + Math.sin(i / 6) * 2).toFixed(2),
    'T2.PV': (30 + Math.sin(i / 6) * 2).toFixed(2),
    'T3.PV': (25 + Math.sin(i / 6) * 2).toFixed(2),
    'T4.PV': (42 + Math.sin(i / 6) * 2).toFixed(2),
    'T5.PV': (46 + Math.sin(i / 6) * 2).toFixed(2),
    'D1.PV': '218.4', 'D2.PV': '12.5', 'D3.PV': '2.71', 'D6.PV': '0.99',
    'DU1.PV': '220.1', 'DU2.PV': '0', 'DU3.PV': '0', 'DU6.PV': '0.99',
    'ZU6682.PV': '31.2', 'ZI6682.PV': '0.14', 'ZW66822.PV': '4.36',
  }));
}

/** 电池 BMS 表：2 秒一采，与热工表时间窗重叠。 */
function bmsRows(count: number, stepMs: number, start = T0) {
  return Array.from({ length: count }, (_, i) => ({
    '采样时刻': stamp(start, i * stepMs),
    '电压(V)': '52.4', '电流(A)': '1.85', 'SOC(%)': '78.2',
    '剩余容量(Ah)': '96.5', '环境温度': '26.4',
  }));
}

async function ingest(id: string, name: string, rows: Record<string, string | number>[], sheet: string) {
  const parsed = await parseFile(new File([buildWorkbook(rows, sheet)], name));
  return prepareDataSource({
    id, filename: parsed.filename, format: parsed.format,
    headers: parsed.headers, rows: parsed.rows,
  });
}

describe('导入链路验收（自包含夹具）', () => {
  it('热工表识别为 thermal-electrical，BMS 表识别为 battery-bms', async () => {
    const thermal = await ingest('fx-thermal', '热工.xlsx', thermalRows(6, 120_000), 'Sheet1');
    const bms = await ingest('fx-bms', 'BMS.xlsx', bmsRows(320, 2_000), 'real time data');

    expect(thermal.profile.kind).toBe('thermal-electrical');
    expect(thermal.profile.label).toBe('热工/电表数据');
    expect(bms.profile.kind).toBe('battery-bms');
    expect(bms.profile.label).toBe('电池 BMS 数据');
    expect(thermal.quality.invalidRows).toBe(0);
    expect(bms.quality.invalidRows).toBe(0);
    // 原始行必须原样保留，整理层只加元数据
    expect(thermal.rows).toHaveLength(6);
    expect(bms.rows).toHaveLength(320);
  });

  it('不同采样率的两个源建立严格同步交集帧，且时间严格递增', async () => {
    const thermal = await ingest('fx-thermal', '热工.xlsx', thermalRows(6, 120_000), 'Sheet1');
    const bms = await ingest('fx-bms', 'BMS.xlsx', bmsRows(320, 2_000), 'real time data');
    const session = buildPlaybackSession({
      sources: [thermal, bms],
      anchorSourceId: thermal.id,
      toleranceMs: 2_000,
    });

    expect(session.frames.length).toBe(6);
    const stamps = session.frames.map((frame) => frame.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(stamps.length);
    for (const frame of session.frames) {
      expect(Object.keys(frame.samples).sort()).toEqual(['fx-bms', 'fx-thermal']);
    }
  });

  it('容差收紧到 0 时错位采样不产生帧，放宽后可重新对齐', async () => {
    // BMS 偏移 5 秒：±2s 无交集，±10s 可对齐
    const thermal = await ingest('fx-thermal', '热工.xlsx', thermalRows(4, 120_000), 'Sheet1');
    const bms = await ingest('fx-bms', 'BMS.xlsx', bmsRows(240, 2_000, T0 + 5_000), 'real time data');

    const strict = buildPlaybackSession({ sources: [thermal, bms], anchorSourceId: thermal.id, toleranceMs: 0 });
    const loose = buildPlaybackSession({ sources: [thermal, bms], anchorSourceId: thermal.id, toleranceMs: 10_000 });
    expect(strict.frames).toHaveLength(0);
    expect(loose.frames.length).toBeGreaterThan(0);
  });

  it('温度通道混入电压级数值时整行隔离并报告，原始行不删除', async () => {
    // 复现真实导出中观察到的列错位：T4.PV 送水温度里出现 220.4
    const rows = thermalRows(4, 120_000);
    (rows[2] as Record<string, string>)['T4.PV'] = '220.4';
    (rows[2] as Record<string, string>)['DU6.PV'] = '';
    const source = await ingest('fx-bad', '热工错位.xlsx', rows, 'Sheet1');

    expect(source.quality.invalidRows).toBe(1);
    expect(source.quality.validRows).toBe(3);
    expect(source.quality.issueCounts.temperature_voltage_misalignment).toBe(1);
    // 隔离不等于删除
    expect(source.rows).toHaveLength(4);
    const bad = source.processedRows.find((row) => !row.valid);
    expect(bad.invalidFields).toContain('T4.PV');
    expect(bad.issues.some((issue) => issue.code === 'missing_field' && issue.field === 'DU6.PV')).toBe(true);
  });

  it('电压级数值落到功率列时按量纲拦截（列左移盲区）', async () => {
    const rows = thermalRows(3, 120_000);
    // D3.PV = system_active_power（kW），被塞进 220.4 这个电压级数值
    (rows[1] as Record<string, string>)['D3.PV'] = '220.4';
    const source = await ingest('fx-range', '功率错位.xlsx', rows, 'Sheet1');

    expect(source.quality.issueCounts.value_out_of_range).toBe(1);
    const bad = source.processedRows.find((row) => !row.valid);
    expect(bad.invalidFields).toContain('D3.PV');
    expect(bad.issues.some((i) => i.code === 'value_out_of_range' && i.field === 'D3.PV')).toBe(true);
  });

  it('电压列的合法高压读数不被量程检查误杀', async () => {
    // DU1.PV = grid_voltage，220.1V 与直流母线 1000V 都是合法值
    const rows = thermalRows(3, 120_000);
    (rows[0] as Record<string, string>)['DU1.PV'] = '220.1';
    (rows[1] as Record<string, string>)['D1.PV'] = '1000';
    (rows[2] as Record<string, string>)['D2.PV'] = '32.5';
    const source = await ingest('fx-ok', '合法量程.xlsx', rows, 'Sheet1');
    expect(source.quality.invalidRows).toBe(0);
    expect(source.quality.issueCounts.value_out_of_range ?? 0).toBe(0);
  });

  it('未确认计量口径时不生成伪能量平衡告警', async () => {
    const thermal = await ingest('fx-thermal', '热工.xlsx', thermalRows(6, 120_000), 'Sheet1');
    const bms = await ingest('fx-bms', 'BMS.xlsx', bmsRows(320, 2_000), 'real time data');
    const session = buildPlaybackSession({
      sources: [thermal, bms],
      anchorSourceId: thermal.id,
      toleranceMs: 2_000,
    });

    const diagnostics = buildOperationalDiagnostics(session.frames, 'positive-charge');
    expect(diagnostics.energyBalanceStatus).toBe('needs-configuration');
    expect(diagnostics.events.some((event) => event.code === 'energy_balance')).toBe(false);
    expect(diagnostics.frameCount).toBe(session.frames.length);
  });
});
