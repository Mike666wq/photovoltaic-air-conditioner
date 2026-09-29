import type { PreparedDataSource } from './dataSourcePipeline';

/** 浏览器持久缓存的数据库名、对象仓库名与版本，供诊断和后续迁移复用。 */
export const SOURCE_CACHE_DB_NAME = 'pv-ac-sim-source-cache';
export const SOURCE_CACHE_STORE_NAME = 'prepared-data-sources';
export const SOURCE_CACHE_DB_VERSION = 1;

export type SourceCacheOperation = 'open' | 'put' | 'get' | 'getMany' | 'remove' | 'clear';

export interface SourceCacheDiagnostic {
  operation: SourceCacheOperation;
  code: 'indexeddb-unavailable' | 'open-failed' | 'open-blocked' | 'operation-failed';
  message: string;
  timestamp: string;
}

export interface CachedSourcesResult {
  /** 按 keys 的输入顺序返回命中的数据源；重复 key 也会保留。 */
  found: PreparedDataSource[];
  /** 按 keys 的输入顺序返回未命中的 key；重复 key 也会保留。 */
  missingKeys: string[];
}

const memoryCache = new Map<string, PreparedDataSource>();
const diagnostics: SourceCacheDiagnostic[] = [];
const MAX_DIAGNOSTICS = 20;
let databasePromise: Promise<IDBDatabase | null> | null = null;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知 IndexedDB 错误';
}

function recordDiagnostic(
  operation: SourceCacheOperation,
  code: SourceCacheDiagnostic['code'],
  error: unknown,
): void {
  diagnostics.push({
    operation,
    code,
    message: errorMessage(error),
    timestamp: new Date().toISOString(),
  });
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
}

/** 返回诊断快照，调用方不能修改模块内部记录。 */
export function getSourceCacheDiagnostics(): SourceCacheDiagnostic[] {
  return diagnostics.map((item) => ({ ...item }));
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;

  const factory = globalThis.indexedDB;
  if (!factory) {
    recordDiagnostic('open', 'indexeddb-unavailable', '当前运行环境不提供 IndexedDB，已使用内存缓存');
    databasePromise = Promise.resolve(null);
    return databasePromise;
  }

  databasePromise = new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };

    try {
      const request = factory.open(SOURCE_CACHE_DB_NAME, SOURCE_CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SOURCE_CACHE_STORE_NAME)) {
          database.createObjectStore(SOURCE_CACHE_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        finish(database);
      };
      request.onerror = () => {
        recordDiagnostic('open', 'open-failed', request.error ?? 'IndexedDB 数据库打开失败');
        finish(null);
      };
      // 被其它页面的旧连接阻塞时不能让业务 API 一直等待，立即退回内存缓存。
      request.onblocked = () => {
        recordDiagnostic('open', 'open-blocked', 'IndexedDB 升级被其它页面连接阻塞，已使用内存缓存');
        finish(null);
      };
    } catch (error) {
      recordDiagnostic('open', 'open-failed', error);
      finish(null);
    }
  });

  return databasePromise;
}

function writeTransaction(
  database: IDBDatabase,
  operation: SourceCacheOperation,
  write: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    try {
      const transaction = database.transaction(SOURCE_CACHE_STORE_NAME, 'readwrite');
      transaction.oncomplete = () => finish();
      transaction.onerror = () => finish(transaction.error ?? `${operation} 事务失败`);
      transaction.onabort = () => finish(transaction.error ?? `${operation} 事务已中止`);
      write(transaction.objectStore(SOURCE_CACHE_STORE_NAME));
    } catch (error) {
      finish(error);
    }
  });
}

function readOneFromDatabase(database: IDBDatabase, key: string): Promise<PreparedDataSource | null> {
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(SOURCE_CACHE_STORE_NAME, 'readonly');
      const request = transaction.objectStore(SOURCE_CACHE_STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as PreparedDataSource | undefined) ?? null);
      request.onerror = () => reject(request.error ?? '读取缓存失败');
      transaction.onabort = () => reject(transaction.error ?? '读取缓存事务已中止');
    } catch (error) {
      reject(error);
    }
  });
}

function readManyFromDatabase(
  database: IDBDatabase,
  keys: readonly string[],
): Promise<Map<string, PreparedDataSource>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, PreparedDataSource>();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(found);
    };

    try {
      const transaction = database.transaction(SOURCE_CACHE_STORE_NAME, 'readonly');
      const store = transaction.objectStore(SOURCE_CACHE_STORE_NAME);
      for (const key of new Set(keys)) {
        const request = store.get(key);
        request.onsuccess = () => {
          const source = request.result as PreparedDataSource | undefined;
          if (source) found.set(key, source);
        };
      }
      transaction.oncomplete = () => finish();
      transaction.onerror = () => finish(transaction.error ?? '批量读取缓存失败');
      transaction.onabort = () => finish(transaction.error ?? '批量读取缓存事务已中止');
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * 批量写入缓存。先同步更新内存，再尝试 IndexedDB，因此即使浏览器存储不可用，
 * 当前页面会话也能立即恢复已经导入的数据源。
 */
export async function putCachedSources(sources: readonly PreparedDataSource[]): Promise<void> {
  for (const source of sources) memoryCache.set(source.id, source);
  if (!sources.length) return;

  const database = await openDatabase();
  if (!database) return;
  try {
    await writeTransaction(database, 'put', (store) => {
      for (const source of sources) store.put(source);
    });
  } catch (error) {
    recordDiagnostic('put', 'operation-failed', error);
  }
}

export async function putCachedSource(source: PreparedDataSource): Promise<void> {
  await putCachedSources([source]);
}

export async function getCachedSource(key: string): Promise<PreparedDataSource | null> {
  const memorySource = memoryCache.get(key);
  if (memorySource) return memorySource;

  const database = await openDatabase();
  if (!database) return null;
  try {
    const source = await readOneFromDatabase(database, key);
    if (source) memoryCache.set(source.id, source);
    return source;
  } catch (error) {
    recordDiagnostic('get', 'operation-failed', error);
    return null;
  }
}

export async function getCachedSources(keys: readonly string[]): Promise<CachedSourcesResult> {
  const unresolvedKeys = keys.filter((key) => !memoryCache.has(key));
  if (unresolvedKeys.length) {
    const database = await openDatabase();
    if (database) {
      try {
        const stored = await readManyFromDatabase(database, unresolvedKeys);
        for (const source of stored.values()) memoryCache.set(source.id, source);
      } catch (error) {
        recordDiagnostic('getMany', 'operation-failed', error);
      }
    }
  }

  const found: PreparedDataSource[] = [];
  const missingKeys: string[] = [];
  for (const key of keys) {
    const source = memoryCache.get(key);
    if (source) found.push(source);
    else missingKeys.push(key);
  }
  return { found, missingKeys };
}

export async function removeCachedSource(key: string): Promise<void> {
  memoryCache.delete(key);
  const database = await openDatabase();
  if (!database) return;
  try {
    await writeTransaction(database, 'remove', (store) => {
      store.delete(key);
    });
  } catch (error) {
    recordDiagnostic('remove', 'operation-failed', error);
  }
}

export async function clearSourceCache(): Promise<void> {
  memoryCache.clear();
  const database = await openDatabase();
  if (!database) return;
  try {
    await writeTransaction(database, 'clear', (store) => {
      store.clear();
    });
  } catch (error) {
    recordDiagnostic('clear', 'operation-failed', error);
  }
}
