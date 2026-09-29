import { prepareDataSource, type PreparedDataSource } from './dataSourcePipeline';

export type ImportPreparationStage = 'reading' | 'parsing' | 'quality';

type ProgressListener = (stage: ImportPreparationStage) => void;

type ImportWorkerResponse =
  | { type: 'progress'; stage: 'parsing' | 'quality' }
  | { type: 'result'; prepared: PreparedDataSource }
  | { type: 'error'; message: string };

/** 单个文件的解析上限；超大工作簿超过 2 分钟视为卡死。 */
const WORKER_TIMEOUT_MS = 120_000;

async function prepareXlsxInWorker(
  file: File,
  id: string,
  onProgress?: ProgressListener,
  signal?: { aborted: boolean },
): Promise<PreparedDataSource> {
  onProgress?.('reading');
  const buffer = await file.arrayBuffer();
  onProgress?.('parsing');

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/dataImportWorker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      worker.terminate();
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      finish();
      fn();
    };

    // 此前只有 onmessage / onerror 两个出口：worker 若因内存限制被杀、
    // 或被 CSP 拦截而永不回调，Promise 永远 pending ——
    // 而 ImportDataDialog 在 progress 非空时禁用关闭按钮、遮罩点击也 return，
    // 用户既不能取消也不能关闭，只能刷新，已选文件和容差全部丢失。
    timer = setTimeout(() => settle(() => reject(new Error(
      `解析超时（超过 ${WORKER_TIMEOUT_MS / 1000} 秒未完成）。文件可能过大，请拆分后重试。`,
    ))), WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.stage);
        return;
      }
      if (message.type === 'result') settle(() => resolve(message.prepared));
      else settle(() => reject(new Error(message.message)));
    };
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'Excel 后台解析线程异常')));
    };
    // 消息无法反序列化时只会触发 messageerror 而非 error
    worker.onmessageerror = () => {
      settle(() => reject(new Error('解析结果无法传递，可能是文件过大导致内存不足')));
    };

    if (signal?.aborted) {
      settle(() => reject(new Error('已取消导入')));
      return;
    }
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
  signal?: { aborted: boolean },
): Promise<PreparedDataSource> {
  const lowerName = file.name.toLowerCase();
  if ((lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && typeof Worker === 'undefined') {
    throw new Error('当前环境不支持 Web Worker，无法解析 Excel');
  }
  if ((lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) && typeof Worker !== 'undefined') {
    return prepareXlsxInWorker(file, id, onProgress, signal);
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
