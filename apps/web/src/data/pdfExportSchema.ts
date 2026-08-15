/**
 * 力控历史导出（PDF）的稳定数据列顺序。
 *
 * 真实文件在末三列表头处会出现粘连、错字（例如 `ZVI6682.PZV`），但每条数据行
 * 仍严格遵循此顺序。因此仅在“序号 + 采样时刻 + T0..DU6”特征齐全时使用本表；
 * 未命中时仍由通用 PDF 解析器保留原始表头，避免误处理未来的 PDF 格式。
 */
export const FORCE_CONTROL_PDF_HEADERS = [
  '序号', '采样时刻',
  'T0.PV', 'T1.PV', 'T2.PV', 'T3.PV', 'T4.PV', 'T5.PV',
  'D1.PV', 'D2.PV', 'D3.PV', 'D6.PV',
  'DU1.PV', 'DU2.PV', 'DU3.PV', 'DU6.PV',
  'ZU6682.PV', 'ZI6682.PV', 'ZW66822.PV',
] as const;

/** 只对与已知力控导出特征完全吻合的表格启用固定列序。 */
export function isForceControlPdfExport(headerCells: string[], sampleCells: string[]): boolean {
  const headerText = headerCells.join(' ');
  const hasThermalAndMeter = /T0\.?(PV)?/i.test(headerText) && /DU1\.?(PV)?/i.test(headerText);
  const hasTimestamp = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}/.test(sampleCells[1] ?? '');
  const hasSequence = /^\d+$/.test(sampleCells[0] ?? '');
  return hasThermalAndMeter && hasTimestamp && hasSequence && sampleCells.length >= FORCE_CONTROL_PDF_HEADERS.length;
}
