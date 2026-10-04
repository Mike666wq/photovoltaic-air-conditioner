import { performance } from 'node:perf_hooks';
import { opaque } from './auth.mjs';
import { CacheCoordinator } from './cache-coordinator.mjs';
import { assert } from './contract.mjs';

// 每个观测保留一小时；全局容量由跨模块协调器原子预留。
export class RealtimeState {
  constructor(config, clocks = {}) {
    this.config = { cacheMs: 3600000, maxPoints: 600, viewerMs: 45000, maxViewers: 4, maxViewerLeases: 40, ...config };
    this.now = clocks.now ?? (() => performance.now()); this.wall = clocks.wall ?? (() => Date.now());
    this.coordinator = config.coordinator ?? new CacheCoordinator(this.config, clocks);
    this.devices = new Map(); this.viewers = new Map(); this.listeners = new Set(); this.lastDeepPrune = -Infinity;
    this.syncRegistrations(config.devices);
  }
  syncRegistrations(registrations) {
    const ids = new Set(registrations.map(d => d.deviceId));
    for (const id of this.devices.keys()) if (!ids.has(id)) {
      for (const viewer of [...this.viewers.values()]) if (viewer.deviceId === id) this.release(viewer.viewerId, viewer.owner);
      this.clearData(id); this.devices.delete(id);
    }
    for (const registration of registrations) {
      const old = this.devices.get(registration.deviceId);
      if (old && old.registration.deviceTokenHash === registration.deviceTokenHash) { old.registration = registration; continue; }
      if (old) {
        for (const viewer of [...this.viewers.values()]) if (viewer.deviceId === registration.deviceId) this.release(viewer.viewerId, viewer.owner);
        this.clearData(registration.deviceId); this.emit('cache-cleared', registration.deviceId, { deviceId: registration.deviceId, reason: 'token-rotated' });
      }
      this.devices.set(registration.deviceId, this.newDevice(registration));
    }
  }
  newDevice(registration) { return { registration, heartbeat: -Infinity, lastHeartbeatAt: null, lastOnline: false, lease: null, currentSession: null, sessionSeen: -Infinity, retired: new Map(), latest: new Map(), rings: new Map(), watermarks: new Map() }; }
  iso(ms = 0) { return new Date(this.wall() + ms).toISOString(); }
  emit(type, deviceId, payload) { for (const f of this.listeners) f(type, deviceId, payload); }
  device(id) { const d = this.devices.get(id); assert(d, 404, 'DEVICE_NOT_FOUND', '设备不存在'); return d; }
  online(d) { return this.now() - d.heartbeat < 45000; }
  info(d) { return { deviceId: d.registration.deviceId, alias: d.registration.alias, allowedPacks: d.registration.allowedPacks, allowedAddresses: d.registration.allowedAddresses, allowSimulation: d.registration.allowSimulation, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt }; }
  active(id) { return [...this.viewers.values()].filter(v => v.deviceId === id && v.until > this.now()); }
  requested(id) { return [...new Set(this.active(id).flatMap(v => v.packs))].sort((a, b) => a - b); }
  sweep(now = this.now()) {
    this.coordinator.sweep(now);
    for (const [id, v] of this.viewers) if (v.until <= now) { this.viewers.delete(id); this.coordinator.viewerEnded(id, v.until); this.emit('viewer-ended', v.deviceId, { viewerId: id }); }
    for (const [id, d] of this.devices) {
      if (!this.active(id).length) d.lease = null;
      for (const [key, item] of d.latest) if (item.expiresAt <= now) d.latest.delete(key);
      for (const [key, ring] of d.rings) {
        while (ring.head < ring.items.length && ring.items[ring.head].expiresAt <= now) ring.head++;
        if (ring.head === ring.items.length) d.rings.delete(key);
        else if (ring.head >= 256 && ring.head * 2 >= ring.items.length) { ring.items.splice(0, ring.head); ring.head = 0; }
        else if (now - this.lastDeepPrune >= 60000 && ring.head < ring.items.length) { ring.items = ring.items.slice(ring.head).filter(item => item.expiresAt > now); ring.head = 0; if (!ring.items.length) d.rings.delete(key); }
      }
      for (const [k, until] of d.retired) if (until <= now) d.retired.delete(k);
      for (const [k, w] of d.watermarks) if (now - w.mono >= this.config.cacheMs) d.watermarks.delete(k);
      const online = this.online(d); if (d.lastOnline !== online) { d.lastOnline = online; this.emit('device-status', id, this.info(d)); }
      if (!this.coordinator.retained(id, now) && !this.active(id).length) this.clearData(id);
    }
    if (now - this.lastDeepPrune >= 60000) this.lastDeepPrune = now;
  }
  createViewer(owner, deviceId, selected, principal = owner, source = null, pageId = opaque()) {
    this.sweep(); this.device(deviceId);
    const activePages = new Set([...this.viewers.values()].filter(v => v.principal === principal && v.until > this.now()).map(v => v.pageId));
    assert(activePages.has(pageId) || activePages.size < this.config.maxViewers, 429, 'VIEWER_LIMIT', '观看页面数已达上限');
    assert(this.viewers.size < this.config.maxViewerLeases, 429, 'VIEWER_LIMIT', '服务观看连接数已达上限');
    const viewerId = opaque(), sources = source == null ? null : [source];
    const viewer = { viewerId, owner, principal, pageId, deviceId, packs: selected, sources, until: this.now() + this.config.viewerMs };
    this.viewers.set(viewerId, viewer); this.coordinator.viewerStarted(viewer);
    return this.viewerReply(viewer);
  }
  viewerReply(v) { return { viewerId: v.viewerId, expiresAt: this.iso(Math.max(0, v.until - this.now())), renewAfterSeconds: Math.min(15, Math.max(1, Math.floor(this.config.viewerMs / 3000))) }; }
  viewer(id, owner) {
    this.sweep(); const v = this.viewers.get(id); assert(v, 410, 'VIEWER_EXPIRED', '观看租约已过期');
    assert(v.owner === owner, 403, 'VIEWER_FORBIDDEN', '不能访问其他用户的观看租约'); return v;
  }
  renew(id, owner, selected, source) {
    const v = this.viewer(id, owner); v.packs = selected; if (source !== undefined) v.sources = source == null ? null : [source]; v.until = this.now() + this.config.viewerMs;
    this.coordinator.viewerRenewed(v); return this.viewerReply(v);
  }
  release(id, owner) {
    const v = this.viewers.get(id); if (!v) return;
    assert(v.owner === owner, 403, 'VIEWER_FORBIDDEN', '不能操作其他用户的观看租约');
    this.viewers.delete(id); this.coordinator.viewerEnded(id, this.now()); this.emit('viewer-ended', v.deviceId, { viewerId: id });
    if (!this.active(v.deviceId).length) this.device(v.deviceId).lease = null;
  }
  heartbeat(id) {
    this.sweep(); const d = this.device(id); d.heartbeat = this.now(); d.lastHeartbeatAt = this.iso(); this.emit('device-status', id, this.info(d));
    const active = this.active(id), requestedPacks = this.requested(id);
    const remaining = active.length ? Math.floor((Math.max(...active.map(v => v.until)) - this.now()) / 1000) : 0;
    const leaseSeconds = Math.min(45, remaining);
    if (leaseSeconds <= 0) { d.lease = null; return { subscriptionId: '', leaseSeconds: 0, requestedPacks: [] }; }
    const subscriptionId = d.lease && d.lease.until > this.now() ? d.lease.id : opaque();
    d.lease = { id: subscriptionId, until: this.now() + leaseSeconds * 1000 };
    return { subscriptionId, leaseSeconds, requestedPacks };
  }
  acceptedFor(id, _source, selected) { return this.active(id).some(v => v.packs.includes(selected)); }
  accept(id, subscriptionId, s) {
    const d = this.device(id), now = this.now();
    assert(d.lease?.id === subscriptionId && d.lease.until > now, 409, 'LEASE_EXPIRED', '观看租约已失效');
    assert(this.acceptedFor(id, s.source, s.pack), 403, 'PACK_FORBIDDEN', '当前未观看此Pack或来源');
    const newSession = d.currentSession !== s.connectionSessionId;
    if (newSession) {
      assert(!d.retired.has(s.connectionSessionId), 409, 'SESSION_RETIRED', '采集会话已退役');
      assert(!d.currentSession || now - d.sessionSeen >= 45000, 409, 'SESSION_CONFLICT', '设备存在活跃采集会话，请等待原会话失效');
    }
    const channel = `${s.source}/${s.address}/${s.pack}`, watermarkKey = `${s.connectionSessionId}/${channel}`;
    const watermark = d.watermarks.get(watermarkKey);
    if (watermark && s.sequence <= watermark.sequence) return { accepted: true };
    const observed = Date.parse(s.capturedUtc), age = Math.max(0, this.wall() - observed), expiresAt = now + this.config.cacheMs - age;
    const cacheKey = this.coordinator.entryKey(id, s.connectionSessionId, channel, s.sequence);
    const entries = expiresAt > now ? [{ key: cacheKey, expiresAt }] : [];
    const entryIds = this.coordinator.reserve(entries); // 超容量时以下会话、水位和latest字段都不变。
    if (newSession) {
      if (d.currentSession) { if (d.retired.size >= 32) d.retired.delete(d.retired.keys().next().value); d.retired.set(d.currentSession, now + this.config.cacheMs); }
      d.currentSession = s.connectionSessionId;
    }
    d.sessionSeen = now; d.watermarks.set(watermarkKey, { sequence: s.sequence, mono: now });
    if (expiresAt > now && entryIds.has(cacheKey)) {
      const item = { snapshot: s, receivedAt: this.iso(), mono: now, expiresAt, entryId: entryIds.get(cacheKey), acceptedOrder: this.coordinator.allocateAcceptedOrder(), cacheKey };
      d.latest.set(channel, item);
      const ringKey = `${channel}/${s.connectionSessionId}`, ring = d.rings.get(ringKey) ?? { items: [], head: 0 };
      const compact = Object.fromEntries(['deviceId', 'source', 'address', 'pack', 'sequence', 'connectionSessionId', 'capturedUtc', 'periodSeconds', 'voltageCentivolts', 'currentCentiamps', 'socPercent'].filter(name => name in s).map(name => [name, s[name]]));
      ring.items.push({ ...item, snapshot: compact }); d.rings.set(ringKey, ring);
      this.emit('snapshot', id, this.publicItem(item));
    }
    return { accepted: true };
  }
  publicItem(item) {
    const s = item.snapshot, d = this.device(s.deviceId);
    const staleMs = Math.min(this.config.cacheMs, Math.max(15000, (s.periodSeconds ?? 15) * 3000));
    const age = Math.max(0, this.wall() - Date.parse(s.capturedUtc), this.now() - item.mono);
    return { snapshot: s, receivedAt: item.receivedAt, stale: !this.online(d) || age >= staleMs, acceptedOrder: item.acceptedOrder };
  }
  latest(id, selected, source = null) {
    this.sweep(); const d = this.device(id);
    return { deviceId: id, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt, packs: [...d.latest.values()].filter(p => selected.includes(p.snapshot.pack) && (source == null || p.snapshot.source === source)).map(p => this.publicItem(p)) };
  }
  trend(id, pack, metric, limit, source = null, cursor = null) {
    this.sweep(); const d = this.device(id);
    const measure = { voltage: s => s.voltageCentivolts / 100, current: s => s.currentCentiamps / 100, soc: s => s.socPercent }[metric];
    assert(measure, 400, 'METRIC_INVALID', '只支持总压、电流和SOC短趋势');
    return this.trendPage(d, p => p.expiresAt > this.now() && this.coordinator.hasKey(p.cacheKey) && p.snapshot.pack === pack && (source == null || p.snapshot.source === source), p => ({ capturedUtc: p.snapshot.capturedUtc, value: measure(p.snapshot), receivedAt: p.receivedAt, sequence: p.snapshot.sequence, connectionSessionId: p.snapshot.connectionSessionId, source: p.snapshot.source, address: p.snapshot.address, ...(p.snapshot.periodSeconds == null ? {} : { periodSeconds: p.snapshot.periodSeconds }) }), limit, cursor);
  }
  trendPage(d, accepts, project, limit, cursor) {
    const after = cursor == null ? 0 : Number(cursor); assert(Number.isSafeInteger(after) && after >= 0, 400, 'CURSOR_INVALID', '趋势游标无效');
    const heap = [], before = (a, b) => a.item.entryId < b.item.entryId;
    const push = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!before(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    const pop = () => { const first = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && before(heap[l], heap[m])) m = l; if (r < heap.length && before(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return first; };
    for (const ring of d.rings.values()) {
      let lo = ring.head, hi = ring.items.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ring.items[mid].entryId <= after) lo = mid + 1; else hi = mid; }
      while (lo < ring.items.length && !accepts(ring.items[lo])) lo++;
      if (lo < ring.items.length) push({ ring, index: lo, item: ring.items[lo] });
    }
    const points = [];
    while (heap.length && points.length < limit) {
      const current = pop(); points.push({ entryId: current.item.entryId, ...project(current.item) });
      let next = current.index + 1; while (next < current.ring.items.length && !accepts(current.ring.items[next])) next++;
      if (next < current.ring.items.length) push({ ring: current.ring, index: next, item: current.ring.items[next] });
    }
    const hasMore = heap.length > 0;
    return { points, nextCursor: points.length ? String(points.at(-1).entryId) : null, hasMore };
  }
  _releaseRings(d, filter = () => true) {
    const released = [];
    for (const [key, ring] of d.rings) if (filter(key)) { for (let i = ring.head; i < ring.items.length; i++) released.push(ring.items[i].cacheKey); d.rings.delete(key); }
    this.coordinator.release(released);
  }
  clearSource(id, source) {
    const d = this.devices.get(id); if (!d) return;
    this._releaseRings(d, key => key.startsWith(`${source}/`));
    for (const [key, item] of d.latest) if (item.snapshot.source === source) d.latest.delete(key);
    for (const key of [...d.watermarks.keys()]) if (key.includes(`/${source}/`)) d.watermarks.delete(key);
    this.emit('cache-cleared', id, { deviceId: id, source });
  }
  clearData(id) {
    const d = this.devices.get(id); if (!d) return;
    this._releaseRings(d); d.latest.clear(); d.watermarks.clear();
  }
  clear(id) { this.clearData(id); this.emit('cache-cleared', id, { deviceId: id }); }
}
