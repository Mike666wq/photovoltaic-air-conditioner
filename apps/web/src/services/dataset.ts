/** 采集数据集的公共时间列识别与解析，供导入、回放和 M3 大屏共用。 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function parseDatasetTime(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  const text = raw.trim().replace(/\//g, '-');
  // 力控 / Excel 的无时区时间统一按北京时间解释，避免部署服务器时区改变图表分桶。
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second = '0'] = match;
    return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) - SHANGHAI_OFFSET_MS;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function detectTimeColumn(
  headers: string[],
  rows: Array<Record<string, string>>,
): string | undefined {
  for (const header of headers) {
    if (!/(时间|时刻|采样|date|time|timestamp)/i.test(header)) continue;
    if (rows.some((row) => parseDatasetTime(row[header]) != null)) return header;
  }
  return undefined;
}
