/// <reference types="vite/client" />
// M2-α：CSV / Excel / PDF 数据文件解析

import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { FORCE_CONTROL_PDF_HEADERS, isForceControlPdfExport } from '../data/pdfExportSchema';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

export interface ParsedData {
  filename: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
  format: 'csv' | 'xlsx' | 'pdf';
}

export async function parseFile(file: File): Promise<ParsedData> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    return parseCSV(file);
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseXLSX(file);
  }
  if (name.endsWith('.pdf')) {
    return parsePDF(file);
  }
  throw new Error('不支持的文件格式，请使用 .csv、.xlsx 或 .pdf');
}

async function parseXLSX(file: File): Promise<ParsedData> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  // 优先读时序 sheet 'real time data'（跳过 'BMS info' 设备元数据 sheet）
  const sheetName =
    workbook.SheetNames.find((n) => /real\s*time/i.test(n)) ?? workbook.SheetNames[0];
  if (!sheetName) {
    return {
      filename: file.name,
      headers: [],
      rows: [],
      rowCount: 0,
      format: 'xlsx',
    };
  }
  const sheet = workbook.Sheets[sheetName];
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
  });
  if (aoa.length === 0) {
    return {
      filename: file.name,
      headers: [],
      rows: [],
      rowCount: 0,
      format: 'xlsx',
    };
  }
  const headers = aoa[0].map((h) => String(h ?? '').trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < aoa.length; i++) {
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      // 数值/字符串统一 trim（BMS 报警状态 ' 无' 带前导空格 → '无'）
      row[headers[j]] = String(aoa[i][j] ?? '').trim();
    }
    rows.push(row);
  }
  return {
    filename: file.name,
    headers,
    rows,
    rowCount: rows.length,
    format: 'xlsx',
  };
}
async function parsePDF(file: File): Promise<ParsedData> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  interface Item {
    str: string;
    x: number;
    y: number;
    w: number;
    page: number;
  }
  interface Row {
    id: string;
    page: number;
    y: number;
    items: Item[];
  }
  const allItems: Item[] = [];
  const rowGroups = new Map<string, Row>();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    let tc;
    try {
      tc = await page.getTextContent();
    } catch (err) {
      console.error('[parsePDF] getTextContent 失败', err);
      throw new Error(
        'PDF 文本提取失败（Safari 兼容问题：若已注入 ReadableStream polyfill 仍复现，请换用 Chrome / Edge / Firefox 打开）',
      );
    }
    for (const it of tc.items as Array<{
      str?: string;
      transform: number[];
      width?: number;
    }>) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const item = {
        str,
        x,
        y,
        w: it.width || 0,
        page: p,
      };
      allItems.push(item);
      const rowY = Math.round(y / 2) * 2;
      const id = `${p}:${rowY}`;
      const row = rowGroups.get(id);
      if (row) {
        row.items.push(item);
      } else {
        rowGroups.set(id, { id, page: p, y: rowY, items: [item] });
      }
    }
  }
  if (allItems.length === 0) {
    return {
      filename: file.name,
      headers: [],
      rows: [],
      rowCount: 0,
      format: 'pdf',
    };
  }

  const tableRows = Array.from(rowGroups.values()).sort(
    (a, b) => a.page - b.page || b.y - a.y,
  );

  const rowCountFrequency = new Map<number, number>();
  for (const row of tableRows) {
    if (row.items.length < 2) continue;
    rowCountFrequency.set(
      row.items.length,
      (rowCountFrequency.get(row.items.length) || 0) + 1,
    );
  }
  let expectedColumnCount = 0;
  let expectedFrequency = -1;
  for (const [count, frequency] of rowCountFrequency) {
    if (
      frequency > expectedFrequency ||
      (frequency === expectedFrequency && count > expectedColumnCount)
    ) {
      expectedColumnCount = count;
      expectedFrequency = frequency;
    }
  }
  if (expectedColumnCount === 0) {
    expectedColumnCount = Math.max(...tableRows.map((row) => row.items.length));
  }

  interface ColumnCluster {
    center: number;
    sum: number;
    count: number;
    rowIds: Set<string>;
    completeRowIds: Set<string>;
  }
  const clusters: ColumnCluster[] = [];
  for (const row of tableRows) {
    for (const item of row.items) {
      const center = item.x + item.w / 2;
      let nearest: ColumnCluster | null = null;
      let nearestDistance = Infinity;
      for (const cluster of clusters) {
        const distance = Math.abs(center - cluster.center);
        if (distance <= 3 && distance < nearestDistance) {
          nearest = cluster;
          nearestDistance = distance;
        }
      }
      if (nearest) {
        nearest.sum += center;
        nearest.count += 1;
        nearest.center = nearest.sum / nearest.count;
        nearest.rowIds.add(row.id);
        if (row.items.length === expectedColumnCount) {
          nearest.completeRowIds.add(row.id);
        }
      } else {
        clusters.push({
          center,
          sum: center,
          count: 1,
          rowIds: new Set([row.id]),
          completeRowIds: new Set(
            row.items.length === expectedColumnCount ? [row.id] : [],
          ),
        });
      }
    }
  }

  const columnCenters = clusters
    .slice()
    .sort(
      (a, b) =>
        b.completeRowIds.size - a.completeRowIds.size ||
        b.rowIds.size - a.rowIds.size ||
        b.count - a.count ||
        a.center - b.center,
    )
    .slice(0, Math.min(expectedColumnCount, clusters.length))
    .sort((a, b) => a.center - b.center)
    .map((cluster) => cluster.center);
  if (columnCenters.length === 0) {
    return {
      filename: file.name,
      headers: [],
      rows: [],
      rowCount: 0,
      format: 'pdf',
    };
  }

  const getColIndex = (x: number): number => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < columnCenters.length; i++) {
      const distance = Math.abs(x - columnCenters[i]);
      if (distance < bestDistance) {
        bestIndex = i;
        bestDistance = distance;
      }
    }
    return bestIndex;
  };

  const mapRow = (items: Item[]): string[] => {
    const cells = Array.from({ length: columnCenters.length }, () => '');
    const append = (index: number, value: string) => {
      cells[index] = cells[index] ? `${cells[index]} ${value}` : value;
    };
    for (const item of items.slice().sort((a, b) => a.x - b.x)) {
      const right = item.x + Math.max(0, item.w);
      const covered: number[] = [];
      for (let i = 0; i < columnCenters.length; i++) {
        if (columnCenters[i] >= item.x - 1 && columnCenters[i] <= right + 1) {
          covered.push(i);
        }
      }
      const tokens = item.str.split(/\s+/).filter(Boolean);
      if (covered.length > 1 && tokens.length === covered.length) {
        for (let i = 0; i < covered.length; i++) {
          append(covered[i], tokens[i]);
        }
      } else {
        append(getColIndex(item.x + item.w / 2), item.str);
      }
    }
    return cells.map((cell) => cell.trim());
  };

  const headerRow = tableRows[0];
  const headerCells = mapRow(headerRow.items);
  const headerCounts = new Map<string, number>();
  const headers0 = headerCells.map((cell, index) => {
    const base = cell || `col_${index}`;
    const count = (headerCounts.get(base) || 0) + 1;
    headerCounts.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });

  // Bug 1 修复：合并"换行"造成的表头粘合（DU6.PV ZU6682.PV → 两列）
  // 仅当所有片段都像 PDF 列名才拆分（避免误伤 CSV 风格的合并列名）。
  const splitMergedHeaders = (headers: string[]): string[] => {
    const out: string[] = [];
    for (const h of headers) {
      if (h && h.includes(' ')) {
        const parts = h.split(/\s+/).filter(Boolean);
        if (parts.length > 1 && parts.every((p) => /^[A-Za-z]+\d*\.?PV$/i.test(p))) {
          out.push(...parts);
          continue;
        }
      }
      out.push(h);
    }
    return out;
  };
  // Bug 2 修复：修正 PDF 拼写错误 ZVW66822.PV → ZW66822.PV
  const normalizeHeader = (h: string): string => {
    let s = h.trim();
    if (/^ZVW66822/i.test(s)) s = s.replace(/^ZVW66822/i, 'ZW66822');
    return s;
  };
  const parsedHeaders = splitMergedHeaders(headers0).map(normalizeHeader);
  const firstDataCells = tableRows.find((row) => row.id !== headerRow.id && row.items.length >= expectedColumnCount)
    ? mapRow(tableRows.find((row) => row.id !== headerRow.id && row.items.length >= expectedColumnCount)!.items)
    : [];
  const forceControlSchema = isForceControlPdfExport(headerCells, firstDataCells);
  const headers = forceControlSchema ? [...FORCE_CONTROL_PDF_HEADERS] : parsedHeaders;

  const rows: Array<Record<string, string>> = [];
  for (const tableRow of tableRows) {
    if (tableRow.id === headerRow.id) continue;
    const cells = mapRow(tableRow.items);
    if (!cells.some((cell) => cell !== '')) continue;
    if (cells.every((cell, index) => cell === headerCells[index])) continue;
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i];
    }
    rows.push(row);
  }

  return {
    filename: file.name,
    headers,
    rows,
    rowCount: rows.length,
    format: 'pdf',
  };
}

async function parseCSV(file: File): Promise<ParsedData> {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return {
      filename: file.name,
      headers: [],
      rows: [],
      rowCount: 0,
      format: 'csv',
    };
  }
  // 剥离 UTF-8 BOM（Excel 保存的 CSV 常带 BOM）
  const firstLine = lines[0].replace(/^\uFEFF/, '');
  const headers = parseCSVLine(firstLine);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }
  return {
    filename: file.name,
    headers,
    rows,
    rowCount: rows.length,
    format: 'csv',
  };
}

/**
 * 解析单行 CSV（处理引号包裹字段、转义引号、字段内逗号）
 * 不支持多行字段（数据采集场景不会遇到）
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else {
      if (c === ',') {
        result.push(current);
        current = '';
      } else if (c === '"') {
        inQuotes = true;
      } else {
        current += c;
      }
    }
  }
  result.push(current);
  return result;
}
