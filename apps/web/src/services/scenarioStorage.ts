import type { PersistedDocument } from '../data/saveSchema';

export interface ScenarioFile {
  name: string;
  savedAt: string;
  size: number;
}

export interface ScenarioStorageError extends Error {
  status?: number;
}

function makeError(message: string, status?: number): ScenarioStorageError {
  const err = new Error(message) as ScenarioStorageError;
  err.status = status;
  err.name = 'ScenarioStorageError';
  return err;
}

// 网络错误（TypeError / AbortError）重试 + 10s 超时；HTTP 状态错误不重试
async function fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      lastError = err;
      if (err instanceof TypeError || (err instanceof Error && err.name === 'AbortError')) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function handleResponse<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = (body && (body.error || body.message)) || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw makeError(
      `${action} 失败 (HTTP ${res.status}): ${detail || res.statusText}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

export async function list(): Promise<ScenarioFile[]> {
  let res: Response;
  try {
    res = await fetchWithRetry('/scenarios/list', { method: 'GET' });
  } catch (err) {
    console.error('scenarioStorage.list:', err);
    throw makeError(`无法访问 /scenarios/list：${(err as Error).message}`);
  }
  return handleResponse<ScenarioFile[]>(res, '列出场景');
}

export async function load(name: string): Promise<PersistedDocument> {
  if (!name || name.includes('/') || name.includes('..')) {
    throw makeError(`非法文件名：${name}`);
  }
  let res: Response;
  try {
    res = await fetchWithRetry('/scenarios/' + encodeURIComponent(name), { method: 'GET' });
  } catch (err) {
    console.error(`scenarioStorage.load: ${name}`, err);
    throw makeError(`无法访问 ${name}：${(err as Error).message}`);
  }
  if (res.status === 404) {
    throw makeError(`场景文件不存在：${name}`, 404);
  }
  if (!res.ok) {
    throw makeError(
      `加载场景失败 (HTTP ${res.status}): ${res.statusText}`,
      res.status,
    );
  }
  return res.json() as Promise<PersistedDocument>;
}

export async function save(name: string, doc: PersistedDocument): Promise<void> {
  if (!name || name.includes('/') || name.includes('..')) {
    throw makeError(`非法文件名：${name}`);
  }
  if (!name.endsWith('.json')) {
    throw makeError('文件名必须以 .json 结尾');
  }
  const body = JSON.stringify(doc, null, 2);
  let res: Response;
  try {
    res = await fetchWithRetry('/scenarios/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    console.error(`scenarioStorage.save: ${name}`, err);
    throw makeError(`无法写入 ${name}：${(err as Error).message}`);
  }
  await handleResponse<{ ok: boolean }>(res, `保存 ${name}`);
}

export async function remove(name: string): Promise<void> {
  if (!name || name.includes('/') || name.includes('..')) {
    throw makeError(`非法文件名：${name}`);
  }
  let res: Response;
  try {
    res = await fetchWithRetry('/scenarios/' + encodeURIComponent(name), {
      method: 'DELETE',
    });
  } catch (err) {
    console.error(`scenarioStorage.remove: ${name}`, err);
    throw makeError(`无法删除 ${name}：${(err as Error).message}`);
  }
  await handleResponse<{ ok: boolean }>(res, `删除 ${name}`);
}
