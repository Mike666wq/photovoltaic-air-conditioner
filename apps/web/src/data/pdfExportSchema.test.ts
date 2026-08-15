import { describe, expect, it } from 'vitest';
import { FORCE_CONTROL_PDF_HEADERS, isForceControlPdfExport } from './pdfExportSchema';

describe('力控 PDF 导出列序校正', () => {
  it('仅对具有温度、电表、序号和采样时间特征的已知导出启用固定列序', () => {
    expect(isForceControlPdfExport(
      ['序号', '采样时刻', 'T0.PV', 'T1.PV', 'DU1.PV', 'ZVI6682.PZV'],
      ['31', '2026/07/14 09:30:00', ...Array(17).fill('0')],
    )).toBe(true);
    expect(FORCE_CONTROL_PDF_HEADERS[FORCE_CONTROL_PDF_HEADERS.length - 1]).toBe('ZW66822.PV');
  });

  it('不会将其他 PDF 表格误识别为力控导出', () => {
    expect(isForceControlPdfExport(['日期', '温度', '功率'], ['1', '2026/07/14 09:30:00', '1'])).toBe(false);
  });
});
