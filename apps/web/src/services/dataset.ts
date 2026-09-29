/** 采集数据集的公共时间列识别与解析，供导入、回放和 M3 大屏共用。 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function parseDatasetTime(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  const text = raw.trim().replace(/\//g, '-');
  // 力控 / Excel 的无时区时间统一按北京时间解释，避免部署服务器时区改变图表分桶。
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second = '0'] = match;
    const parts = [+year, +month, +day, +hour, +minute, +second] as const;
    if (parts[0] < 1900 || parts[0] > 2200 || parts[1] < 1 || parts[1] > 12
      || parts[2] < 1 || parts[3] < 0 || parts[3] > 23 || parts[4] < 0 || parts[4] > 59
      || parts[5] < 0 || parts[5] > 59) return null;
    const localUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    const check = new Date(localUtc);
    if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() !== parts[1] - 1
      || check.getUTCDate() !== parts[2]) return null;
    return localUtc - SHANGHAI_OFFSET_MS;
  }
  // Excel 1900 日期系统序列值（含小数时间），按北京时间的无时区采样时间解释。
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (Number.isFinite(serial) && serial >= 1 && serial <= 100_000) {
      return Date.UTC(1899, 11, 30) + serial * 86_400_000 - SHANGHAI_OFFSET_MS;
    }
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 为重复或空表头生成稳定唯一键，避免转换 Record 时静默覆盖列。 */
export function normalizeDatasetHeaders(rawHeaders: string[]): string[] {
  const counts = new Map<string, number>();
  return rawHeaders.map((raw, index) => {
    const base = raw.trim() || `未命名列_${index + 1}`;
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return next === 1 ? base : `${base}_${next}`;
  });
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
