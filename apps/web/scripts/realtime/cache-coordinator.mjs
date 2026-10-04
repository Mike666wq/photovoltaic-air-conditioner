import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assert } from './contract.mjs';

/** 跨BMS与实验模块共享的1小时点预算、观测租约和无观看保留窗口。 */
export class CacheCoordinator {
  constructor(config, clocks = {}) {
    this.ttlMs = config.cacheMs ?? 3600000;
    this.maxPoints = config.maxCachePoints ?? 500000;
    this.maxBytes = config.maxCacheBytes ?? 134217728;
    // 容量诊断按较保守的每点预算估算，不代表进程RSS精确值。
    this.pointBytes = 1024;
    this.now = clocks.now ?? (() => performance.now());
    this.entries = new Map(); this.heap = []; this.usedBytes = 0;
    this.nextEntryId = 1; this.nextAcceptedOrder = 1;
    this.watchers = new Map(); this.deviceRetainUntil = new Map(); this.listeners = new Set();
  }
  hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
  status() {
    return { usedPoints: this.entries.size, maxPoints: this.maxPoints, estimatedBytes: this.usedBytes, maxEstimatedBytes: this.maxBytes, pointBudgetBytes: this.pointBytes, retentionSeconds: Math.floor(this.ttlMs / 1000) };
  }
  changed() { const status = this.status(); for (const listener of this.listeners) listener(status); }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  hasKey(key) { return this.entries.has(key); }
  allocateAcceptedOrder() { return this.nextAcceptedOrder++; }
  _less(a, b) { return a.expiresAt < b.expiresAt || (a.expiresAt === b.expiresAt && a.key < b.key); }
  _push(node) {
    const heap = this.heap; heap.push(node); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this._less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
  }
  _pop() {
    const heap = this.heap; const first = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && this._less(heap[l], heap[m])) m = l; if (r < heap.length && this._less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
    return first;
  }
  sweep(now = this.now()) {
    let changed = false; const expiredWatchers = new Map();
    while (this.heap.length && this.heap[0].expiresAt <= now) {
      const node = this._pop();
      if (this.entries.get(node.key) !== node.expiresAt) continue;
      this.entries.delete(node.key); this.usedBytes -= this.pointBytes; changed = true;
    }
    for (const [id, w] of this.watchers) if (w.until <= now) { this.watchers.delete(id); expiredWatchers.set(w.deviceId, Math.max(expiredWatchers.get(w.deviceId) ?? 0, w.until)); }
    this._refreshRetention(now, expiredWatchers);
    for (const [id, until] of this.deviceRetainUntil) if (until <= now) this.deviceRetainUntil.delete(id);
    if (changed) this.changed();
  }
  reserve(entries) {
    const now = this.now(); this.sweep(now);
    const additions = new Map();
    for (const item of entries) if (item.expiresAt > now && !this.entries.has(item.key)) additions.set(item.key, item.expiresAt);
    const count = this.entries.size + additions.size;
    const bytes = this.usedBytes + additions.size * this.pointBytes;
    assert(count <= this.maxPoints && bytes <= this.maxBytes, 503, 'CACHE_CAPACITY_EXCEEDED', '实时缓存容量已达上限，请稍后重试');
    const ids = new Map();
    for (const [key, expiresAt] of additions) { this.entries.set(key, expiresAt); this.usedBytes += this.pointBytes; this._push({ key, expiresAt }); ids.set(key, this.nextEntryId++); }
    if (additions.size) this.changed();
    return ids;
  }
  release(keys) {
    let changed = false;
    for (const key of keys) if (this.entries.has(key)) { this.entries.delete(key); this.usedBytes -= this.pointBytes; changed = true; }
    if (this.heap.length > this.entries.size * 2 + 1024) {
      this.heap = [];
      for (const [key, expiresAt] of this.entries) this._push({ key, expiresAt });
    }
    if (changed) this.changed();
  }
  viewerStarted(viewer, now = this.now()) { this.watchers.set(viewer.viewerId, { deviceId: viewer.deviceId, until: viewer.until }); this._refreshRetention(now); }
  viewerRenewed(viewer, now = this.now()) { this.viewerStarted(viewer, now); }
  viewerEnded(viewerId, now = this.now()) {
    const watcher = this.watchers.get(viewerId); this.watchers.delete(viewerId);
    this._refreshRetention(now, watcher ? new Map([[watcher.deviceId, now]]) : new Map());
  }
  _refreshRetention(now, endedAt = new Map()) {
    const byDevice = new Map();
    for (const w of this.watchers.values()) if (w.until > now) byDevice.set(w.deviceId, Math.max(byDevice.get(w.deviceId) ?? 0, w.until));
    this._wasActiveByDevice ??= new Set();
    for (const id of new Set([...this._wasActiveByDevice, ...byDevice.keys()])) {
      const until = byDevice.get(id);
      if (until) this.deviceRetainUntil.set(id, until + this.ttlMs);
      else if (this._wasActiveByDevice.has(id)) this.deviceRetainUntil.set(id, (endedAt.get(id) ?? now) + this.ttlMs);
    }
    this._wasActiveByDevice = new Set(byDevice.keys());
  }
  retained(deviceId, now = this.now()) {
    return (this.deviceRetainUntil.get(deviceId) ?? 0) > now;
  }
  entryKey(deviceId, ...parts) { return `${deviceId}/${parts.join('/')}`; }
}
