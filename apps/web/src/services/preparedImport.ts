import { prepareDataSource, type PreparedDataSource } from './dataSourcePipeline';

export type ImportPreparationStage = 'reading' | 'parsing' | 'quality';

type ProgressListener = (stage: ImportPreparationStage) => void;

type ImportWorkerResponse =
  | { type: 'progress'; stage: 'parsing' | 'quality' }
  | { type: 'result'; prepared: PreparedDataSource }
  | { type: 'error'; message: string };

async function prepareXlsxInWorker(
  file: File,
  id: string,
  onProgress?: ProgressListener,
): Promise<PreparedDataSource> {
  onProgress?.('reading');
  const buffer = await file.arrayBuffer();
  onProgress?.('parsing');

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/dataImportWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.stage);
        return;
      }
      finish();
      if (message.type === 'result') resolve(message.prepared);
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'Excel 后台解析线程异常'));
    };
    worker.postMessage({ id, filename: file.name, buffer }, [buffer]);
  });
}

/**
 * 大屏导入入口：Excel 的解压、行转换和质量检测全部在 Worker 中完成。
 * CSV/PDF 继续复用既有解析器，但同样只生成一次 PreparedDataSource。
 */
export async function prepareFileForImport(
  file: File,
  id: string,
  onProgress?: ProgressListener,
): Promise<PreparedDataSource> {
  const lowerName = file.name.toLowerCase();
  if ((lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && typeof Worker !== 'undefined') {
    return prepareXlsxInWorker(file, id, onProgress);
  }

  onProgress?.('reading');
  const { parseFile } = await import('./injectionParser');
  onProgress?.('parsing');
  const parsed = await parseFile(file);
  onProgress?.('quality');
  return prepareDataSource({
    id,
    filename: parsed.filename,
    format: parsed.format,
    headers: parsed.headers,
    rows: parsed.rows,
  });
}
