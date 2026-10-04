import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { opaque, validateConfig } from './auth.mjs';
import { assert } from './contract.mjs';

/** 单进程写队列；落盘成功后才更新运行态，凭据只保存散列。 */
export class RegistryStore {
  constructor(config, onCommit) { this.config = config; this.onCommit = onCommit; this.queue = Promise.resolve(); this.pending = 0; }
  get writable() { return !!this.config.registryDir; }
  mutate(change) {
    assert(this.writable, 503, 'REGISTRY_READ_ONLY', '当前注册配置只读，请管理员配置持久化注册存储');
    assert(this.pending < 8, 429, 'REGISTRY_BUSY', '注册操作繁忙，请稍后再试'); this.pending++;
    const result = this.queue.then(async () => {
      const next = structuredClone({ devices: this.config.devices, users: this.config.users, system: this.config.system });
      const value = change(next);
      validateConfig({ ...this.config, ...next });
      const content = JSON.stringify({ version: 2, ...next });
      assert(Buffer.byteLength(content) <= 1048576, 413, 'REGISTRY_TOO_LARGE', '注册存储已达容量上限');
      const dir = this.config.registryDir; const temporary = join(dir, `.${opaque()}.tmp`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let file;
      try {
        file = await open(temporary, 'wx', 0o600); await file.writeFile(content); await file.sync(); await file.close(); file = null;
        await rename(temporary, join(dir, 'registry.json'));
      } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
      this.config.devices = next.devices; this.config.users = next.users; this.config.system = next.system; this.onCommit(next.devices, next.system, next.users);
      return value;
    });
    this.queue = result.catch(() => {});
    return result.finally(() => { this.pending--; });
  }
}
