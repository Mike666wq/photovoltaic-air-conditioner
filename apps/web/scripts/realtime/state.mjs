import { performance } from 'node:perf_hooks';
import { opaque } from './auth.mjs';
import { assert } from './contract.mjs';

// 单进程、短缓存；发布必须Recreate，多个副本需要共享状态实现。
export class RealtimeState {
  constructor(config, clocks = {}) {
    this.config = { cacheMs: 600000, maxPoints: 600, viewerMs: 45000, maxViewers: 4, ...config };
    this.now = clocks.now ?? (() => performance.now());
    this.wall = clocks.wall ?? (() => Date.now());
    this.devices = new Map(config.devices.map((d) => [d.deviceId, { registration: d, heartbeat: -Infinity, lastHeartbeatAt: null, lease: null, currentSession: null, sessionSeen: -Infinity, retired: new Map(), sequences: new Set(), latest: new Map(), rings: new Map(), watermarks: new Map() }]));
    this.viewers = new Map(); this.listeners = new Set();
  }
  iso(ms = 0) { return new Date(this.wall() + ms).toISOString(); }
  emit(type, deviceId, payload) { for (const f of this.listeners) f(type, deviceId, payload); }
  device(id) { const d = this.devices.get(id); assert(d, 404, 'DEVICE_NOT_FOUND', '设备不存在'); return d; }
  online(d) { return this.now() - d.heartbeat < 45000; }
  info(d) { return { deviceId: d.registration.deviceId, alias: d.registration.alias, allowedPacks: d.registration.allowedPacks, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt }; }
  active(id) { return [...this.viewers.values()].filter((v) => v.deviceId === id && v.until > this.now()); }
  requested(id) { return [...new Set(this.active(id).flatMap((v) => v.packs))].sort((a, b) => a - b); }
  sweep() {
    const now = this.now();
    for (const [id, v] of this.viewers) {
      if (v.until <= now) { this.viewers.delete(id); this.emit('viewer-ended', v.deviceId, { viewerId: id }); }
    }
    for (const [id, d] of this.devices) {
      if (!this.active(id).length) { d.lease = null; d.rings.clear(); }
      for (const [k, item] of d.latest) if (now - item.mono >= this.config.cacheMs) d.latest.delete(k);
      for (const [k, ring] of d.rings) {
        const kept = ring.filter((p) => now - p.mono < this.config.cacheMs).slice(-this.config.maxPoints);
        if (kept.length) d.rings.set(k, kept); else d.rings.delete(k);
      }
      for (const [k, until] of d.retired) if (until <= now) d.retired.delete(k);
      for (const [k, w] of d.watermarks) if (now - w.mono >= this.config.cacheMs) d.watermarks.delete(k);
      const online = this.online(d);
      if (d.lastOnline !== online) { d.lastOnline = online; this.emit('device-status', id, this.info(d)); }
    }
  }
  createViewer(owner, deviceId, selected, principal = owner) {
    this.sweep(); this.device(deviceId);
    assert([...this.viewers.values()].filter((v) => v.principal === principal).length < this.config.maxViewers, 429, 'VIEWER_LIMIT', '观看连接数已达上限');
    assert(this.viewers.size < this.devices.size * 16 + 16, 429, 'VIEWER_LIMIT', '服务观看连接数已达上限');
    const viewerId = opaque();
    this.viewers.set(viewerId, { viewerId, owner, principal, deviceId, packs: selected, until: this.now() + this.config.viewerMs });
    return this.viewerReply(this.viewers.get(viewerId));
  }
  viewerReply(v) { return { viewerId: v.viewerId, expiresAt: this.iso(Math.max(0, v.until - this.now())), renewAfterSeconds: Math.min(15, Math.max(1, Math.floor(this.config.viewerMs / 3000))) }; }
  viewer(id, owner) {
    this.sweep(); const v = this.viewers.get(id);
    assert(v, 410, 'VIEWER_EXPIRED', '观看租约已过期');
    assert(v.owner === owner, 403, 'VIEWER_FORBIDDEN', '不能访问其他用户的观看租约'); return v;
  }
  renew(id, owner, selected) {
    const v = this.viewer(id, owner); v.packs = selected; v.until = this.now() + this.config.viewerMs;
    return this.viewerReply(v);
  }
  release(id, owner) {
    const v = this.viewers.get(id);
    if (!v) return;
    assert(v.owner === owner, 403, 'VIEWER_FORBIDDEN', '不能操作其他用户的观看租约');
    this.viewers.delete(id); this.emit('viewer-ended', v.deviceId, { viewerId: id }); this.sweep();
  }
  heartbeat(id) {
    this.sweep(); const d = this.device(id); d.heartbeat = this.now(); d.lastHeartbeatAt = this.iso();
    this.emit('device-status', id, this.info(d));
    const active = this.active(id); const requestedPacks = this.requested(id);
    const remaining = active.length ? Math.floor((Math.max(...active.map((v) => v.until)) - this.now()) / 1000) : 0;
    const leaseSeconds = Math.min(45, remaining);
    if (leaseSeconds <= 0) { d.lease = null; return { subscriptionId: '', leaseSeconds: 0, requestedPacks: [] }; }
    const subscriptionId = d.lease && d.lease.until > this.now() ? d.lease.id : opaque();
    d.lease = { id: subscriptionId, until: this.now() + leaseSeconds * 1000 };
    return { subscriptionId, leaseSeconds, requestedPacks };
  }
  accept(id, subscriptionId, s) {
    this.sweep(); const d = this.device(id); const now = this.now();
    assert(d.lease?.id === subscriptionId && d.lease.until > now, 409, 'LEASE_EXPIRED', '观看租约已失效');
    assert(this.requested(id).includes(s.pack), 403, 'PACK_FORBIDDEN', '当前未观看此Pack');
    if (d.currentSession !== s.connectionSessionId) {
      assert(!d.retired.has(s.connectionSessionId), 409, 'SESSION_RETIRED', '采集会话已退役');
      assert(!d.currentSession || now - d.sessionSeen >= 45000, 409, 'SESSION_CONFLICT', '设备存在活跃采集会话，请等待原会话失效');
      if (d.currentSession) {
        if (d.retired.size >= 32) d.retired.delete(d.retired.keys().next().value);
        d.retired.set(d.currentSession, now + this.config.cacheMs);
      }
      d.currentSession = s.connectionSessionId; d.latest.clear(); d.rings.clear(); d.watermarks.clear(); d.sequences.clear();
      this.emit('cache-cleared', id, { deviceId: id, reason: 'session-changed' });
    }
    // 水位按source/address/pack区分，Pack2序号较低不因Pack1的高序号被误删。
    const key = `${s.source}/${s.address}/${s.pack}`;
    if (d.sequences.has(s.sequence)) return { accepted: true };
    const watermark = d.watermarks.get(key);
    if (watermark && s.sequence <= watermark.sequence) return { accepted: true };
    d.sessionSeen = now;
    const item = { snapshot: s, receivedAt: this.iso(), mono: now };
    d.watermarks.set(key, { sequence: s.sequence, mono: now });
    d.sequences.add(s.sequence); if (d.sequences.size > 1024) d.sequences.delete(d.sequences.values().next().value);
    d.latest.set(key, item);
    // 趋势只保存需要的三项，不重复存储每次电芯/温度/告警大数组。
    const ring = d.rings.get(key) ?? [];
    const compact = Object.fromEntries(['deviceId', 'source', 'address', 'pack', 'sequence', 'connectionSessionId', 'capturedUtc', 'voltageCentivolts', 'currentCentiamps', 'socPercent'].map((name) => [name, s[name]]));
    ring.push({ ...item, snapshot: compact });
    d.rings.set(key, ring.filter((p) => now - p.mono < this.config.cacheMs).slice(-this.config.maxPoints));
    const packPoints = [...d.rings.values()].flat().filter((p) => p.snapshot.pack === s.pack).sort((a, b) => a.mono - b.mono);
    const discard = new Set(packPoints.slice(0, Math.max(0, packPoints.length - this.config.maxPoints)));
    for (const [k, points] of d.rings) d.rings.set(k, points.filter((p) => !discard.has(p)));
    this.emit('snapshot', id, this.publicItem(item));
    return { accepted: true };
  }
  publicItem(item) {
    const s = item.snapshot; const d = this.device(s.deviceId);
    const staleMs = Math.min(this.config.cacheMs, Math.max(15000, (s.periodSeconds ?? 15) * 3000));
    return { snapshot: s, receivedAt: item.receivedAt, stale: !this.online(d) || this.now() - item.mono >= staleMs };
  }
  latest(id, selected) { this.sweep(); const d = this.device(id); return { deviceId: id, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt, packs: [...d.latest.values()].filter((p) => selected.includes(p.snapshot.pack)).map((p) => this.publicItem(p)) }; }
  trend(id, pack, metric, limit) {
    this.sweep(); const d = this.device(id);
    const measure = { voltage: (s) => s.voltageCentivolts / 100, current: (s) => s.currentCentiamps / 100, soc: (s) => s.socPercent }[metric];
    assert(measure, 400, 'METRIC_INVALID', '只支持总压、电流和SOC短趋势');
    const points = [...d.rings.values()].flat().filter((p) => p.snapshot.pack === pack).sort((a, b) => a.mono - b.mono).slice(-limit);
    return { points: points.map((p) => ({ capturedUtc: p.snapshot.capturedUtc, value: measure(p.snapshot), receivedAt: p.receivedAt, sequence: p.snapshot.sequence, connectionSessionId: p.snapshot.connectionSessionId, source: p.snapshot.source, address: p.snapshot.address })) };
  }
  clear(id) {
    const d = this.device(id); d.latest.clear(); d.rings.clear(); d.watermarks.clear(); d.sequences.clear();
    this.emit('cache-cleared', id, { deviceId: id });
  }
}
