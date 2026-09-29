import * as XLSX from 'xlsx';
import { prepareDataSource, type PreparedDataSource } from '../services/dataSourcePipeline';
import { normalizeDatasetHeaders } from '../services/dataset';

interface ImportWorkerRequest {
  id: string;
  filename: string;
  buffer: ArrayBuffer;
}

type ImportWorkerResponse =
  | { type: 'progress'; stage: 'parsing' | 'quality' }
  | { type: 'result'; prepared: PreparedDataSource }
  | { type: 'error'; message: string };

interface ImportWorkerScope {
  postMessage: (message: ImportWorkerResponse) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<ImportWorkerRequest>) => void) => void;
}

const workerScope = globalThis as unknown as ImportWorkerScope;

function parseWorkbook(request: ImportWorkerRequest): PreparedDataSource {
  workerScope.postMessage({ type: 'progress', stage: 'parsing' });
  const workbook = XLSX.read(request.buffer, { type: 'array' });
  // BMS 工作簿优先 real time data，跳过 BMS info 等设备元数据页。
  const sheetName = workbook.SheetNames.find((name) => /real\s*time/i.test(name)) ?? workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 工作簿中没有可读取的工作表');
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
  });
  if (!aoa.length) throw new Error(`工作表“${sheetName}”没有数据`);

  const headers = normalizeDatasetHeaders(aoa[0].map((cell) => String(cell ?? '').trim()));
  const rows: Array<Record<string, string>> = new Array(Math.max(0, aoa.length - 1));
  for (let rowIndex = 1; rowIndex < aoa.length; rowIndex++) {
    const sourceRow = aoa[rowIndex];
    const row: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      // 数值和字符串统一转成项目既有的字符串行格式；报警值前导空格一并去除。
      row[headers[columnIndex]] = String(sourceRow[columnIndex] ?? '').trim();
    }
    rows[rowIndex - 1] = row;
  }

  workerScope.postMessage({ type: 'progress', stage: 'quality' });
  return prepareDataSource({
    id: request.id,
    filename: request.filename,
    format: 'xlsx',
    headers,
    rows,
  });
}

workerScope.addEventListener('message', (event) => {
  try {
    workerScope.postMessage({ type: 'result', prepared: parseWorkbook(event.data) });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Excel 文件无法解析',
    });
  }
});
