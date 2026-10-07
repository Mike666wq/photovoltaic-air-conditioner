import { RealtimeState } from './state.mjs';
import { assert } from './contract.mjs';

/** 实验测点按真实观测时间保留一小时，和BMS共用全局容量协调器。 */
export class ExperimentState extends RealtimeState {
  info(d) { return { deviceId: d.registration.deviceId, alias: d.registration.alias, module: 'experiment', allowedPacks: [], allowedAddresses: [], allowedEquipment: d.registration.allowedEquipment, allowSimulation: d.registration.allowSimulation, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt }; }
  heartbeat(id) {
    const r = super.heartbeat(id), requestedHistoryPoints = this.requestedHistory(id); const { requestedPacks, ...rest } = r;
    return rest.leaseSeconds <= 0 || requestedHistoryPoints == null ? { ...rest, requestedDevices: requestedPacks } : { ...rest, requestedDevices: requestedPacks, requestedHistoryPoints };
  }
  dto(item) {
    const now = this.now();
    const points = item.snapshot.points.filter(p => (item.pointMeta.get(p.id)?.expiresAt ?? 0) > now).map(p => {
      const meta = item.pointMeta.get(p.id); return { ...p, receivedAt: meta.receivedAt ?? item.receivedAt, ageMs: meta.initialAge + Math.max(0, now - meta.mono) };
    });
    return { snapshot: { ...item.snapshot, points }, receivedAt: item.receivedAt, acceptedOrder: item.acceptedOrder };
  }
  _pointEntryKey(deviceId, snapshot, point) {
    const fingerprint = JSON.stringify([point.quality, point.value, point.rawValue, point.displayValue, point.unit, point.description]);
    return this.coordinator.entryKey(deviceId, snapshot.source, snapshot.equipmentId, point.id, snapshot.acquisitionSessionId, point.configVersion, point.acquisitionRound, point.observedUtc, fingerprint);
  }
  backfill(id, subscriptionId, points) {
    this.sweep(); const d = this.device(id), now = this.now(), receivedAt = this.iso();
    assert(d.lease?.id === subscriptionId && d.lease.until > now, 409, 'LEASE_EXPIRED', '观看租约已失效');
    const ordered = [...points].sort((a, b) => Date.parse(a.observedUtc) - Date.parse(b.observedUtc) || a.acquisitionRound - b.acquisitionRound || a.id.localeCompare(b.id));
    const pending = ordered.map((p) => {
      assert(this.acceptedFor(id, p.source, p.equipmentId), 403, 'EQUIPMENT_FORBIDDEN', '历史回填包含当前未观看的实验仪器或来源');
      const age = this.backfillAge(p.observedUtc, d.lease), expiresAt = now + this.config.cacheMs - age;
      const signature = this.coordinator.hash(JSON.stringify([p.source,p.equipmentId,p.id,p.connectionSessionId,p.acquisitionSessionId,p.observedUtc,p.value,p.quality,p.unit,p.configVersion,p.acquisitionRound]));
      const cacheKey = this.coordinator.entryKey(id, 'experiment-backfill', signature);
      return { p, expiresAt, cacheKey };
    });
    const unique = [...new Map(pending.map(item => [item.cacheKey, item])).values()];
    const entryIds = this.coordinator.reserve(unique.map(item => ({ key: item.cacheKey, expiresAt: item.expiresAt })));
    let added = 0;
    for (const item of unique) {
      const entryId = entryIds.get(item.cacheKey); if (!entryId) continue;
      const p = item.p, channel = `${p.source}/${p.equipmentId}`, ringKey = `${p.connectionSessionId}/${channel}/${p.id}`;
      const ring = d.rings.get(ringKey) ?? { items: [], head: 0 };
      ring.items.push({ entryId, cacheKey: item.cacheKey, expiresAt: item.expiresAt, receivedAt, observedUtc: p.observedUtc, connectionSessionId: p.connectionSessionId, sourceSegment: 0, source: p.source, equipmentId: p.equipmentId, point: { id: p.id, value: p.value, quality: p.quality, unit: p.unit, configVersion: p.configVersion, acquisitionRound: p.acquisitionRound } });
      d.rings.set(ringKey, ring); added++;
    }
    if (added) this.emit('trend-backfill', id, { deviceId: id, module: 'experiment', added });
    return { accepted: true, added };
  }
  accept(id, subscriptionId, s) {
    const d = this.device(id), now = this.now();
    assert(d.lease?.id === subscriptionId && d.lease.until > now, 409, 'LEASE_EXPIRED', '观看租约已失效');
    assert(this.acceptedFor(id, s.source, s.equipmentId), 403, 'EQUIPMENT_FORBIDDEN', '当前未观看此仪器或来源');
    const channel = `${s.source}/${s.equipmentId}`, watermarkKey = `${s.connectionSessionId}/${channel}`;
    const watermark = d.watermarks.get(watermarkKey);
    if (watermark && s.sequence <= watermark.sequence) return { accepted: true };
    const newSession = d.currentSession !== s.connectionSessionId;
    if (newSession) {
      assert(!d.retired.has(s.connectionSessionId), 409, 'SESSION_RETIRED', '采集会话已退役');
    } else assert(d.acquisitionSession === s.acquisitionSessionId, 409, 'SESSION_CONFLICT', '采集会话变化需要新的连接会话');

    const previous = d.latest.get(channel);
    const currentEquipment = [...d.latest.values()].filter(item => item.snapshot.equipmentId === s.equipmentId).sort((a, b) => b.acceptedOrder - a.acceptedOrder)[0];
    const sourceChanged = !!currentEquipment && currentEquipment.snapshot.source !== s.source;
    const sourceSegment = (currentEquipment?.sourceSegment ?? 0) + (sourceChanged ? 1 : 0);
    const receivedAt = this.iso();
    const previousLive = new Map((previous?.snapshot.points ?? []).filter(p => (previous.pointMeta.get(p.id)?.expiresAt ?? 0) > now).map(p => [p.id, p]));
    const sameSession = previous?.snapshot.connectionSessionId === s.connectionSessionId && previous?.snapshot.acquisitionSessionId === s.acquisitionSessionId;
    const oldPoints = sameSession && !sourceChanged ? previousLive : new Map();
    const oldMeta = new Map([...oldPoints.keys()].map(pointId => [pointId, previous.pointMeta.get(pointId)]));
    const nextPoints = new Map(oldPoints), pointMeta = new Map(oldMeta), pending = [];
    for (const p of s.points) {
      const mostRecent = previousLive.get(p.id);
      if (mostRecent && Date.parse(p.observedUtc) < Date.parse(mostRecent.observedUtc)) continue;
      if (mostRecent && p.observedUtc === mostRecent.observedUtc && p.acquisitionRound === mostRecent.acquisitionRound && p.configVersion === mostRecent.configVersion && p.quality === mostRecent.quality && p.value === mostRecent.value && p.rawValue === mostRecent.rawValue && p.displayValue === mostRecent.displayValue && p.unit === mostRecent.unit) {
        // 来源返回时仅保留本次实际携带的点，不把该来源上一次遗漏点补回来。
        if (sourceChanged) { nextPoints.set(p.id, p); pointMeta.set(p.id, previous.pointMeta.get(p.id)); }
        continue;
      }
      const initialAge = Math.max(0, this.wall() - Date.parse(p.observedUtc), Date.parse(s.capturedUtc) - Date.parse(p.observedUtc));
      const expiresAt = now + this.config.cacheMs - initialAge;
      const cacheKey = this._pointEntryKey(id, s, p);
      pending.push({ p, initialAge, expiresAt, cacheKey });
      if (expiresAt > now) {
        nextPoints.set(p.id, p); pointMeta.set(p.id, { mono: now, initialAge, expiresAt, cacheKey, receivedAt });
      }
    }
    const entryIds = this.coordinator.reserve(pending.filter(p => p.expiresAt > now).map(p => ({ key: p.cacheKey, expiresAt: p.expiresAt })));
    // 容量检查在切换采集会话、水位和latest之前完成，失败不会部分提交。
    if (newSession) {
      if (d.currentSession) { if (d.retired.size >= 32) d.retired.delete(d.retired.keys().next().value); d.retired.set(d.currentSession, now + this.config.cacheMs); }
      d.currentSession = s.connectionSessionId; d.acquisitionSession = s.acquisitionSessionId;
    }
    d.sessionSeen = now; d.watermarks.set(watermarkKey, { sequence: s.sequence, mono: now - Math.max(0, this.wall() - Date.parse(s.capturedUtc)) });
    let added = 0;
    for (const item of pending) {
      if (item.expiresAt <= now || !entryIds.has(item.cacheKey)) continue;
      const ringKey = `${s.connectionSessionId}/${channel}/${item.p.id}`, ring = d.rings.get(ringKey) ?? { items: [], head: 0 };
      ring.items.push({ entryId: entryIds.get(item.cacheKey), cacheKey: item.cacheKey, expiresAt: item.expiresAt, receivedAt, observedUtc: item.p.observedUtc, connectionSessionId: s.connectionSessionId, sourceSegment, source: s.source, equipmentId: s.equipmentId, point: item.p });
      d.rings.set(ringKey, ring); added++;
    }
    if (added || (sourceChanged && nextPoints.size)) {
      const livePoints = [...nextPoints.values()].filter(p => (pointMeta.get(p.id)?.expiresAt ?? 0) > now);
      const item = { sourceSegment, snapshot: { ...s, points: livePoints }, receivedAt, mono: now, pointMeta, expiresAt: Math.max(...[...pointMeta.values()].map(meta => meta.expiresAt)), acceptedOrder: this.coordinator.allocateAcceptedOrder() };
      d.latest.set(channel, item); this.emit('snapshot', id, this.dto(item));
    }
    return { accepted: true };
  }
  latest(id, selected, source = null) {
    this.sweep(); const d = this.device(id);
    return { deviceId: id, online: this.online(d), lastHeartbeatAt: d.lastHeartbeatAt, snapshots: [...d.latest.values()].filter(item => selected.includes(item.snapshot.equipmentId) && (source == null || item.snapshot.source === source)).map(item => this.dto(item)) };
  }
  trend(id, equipmentId, pointId, source, limit, cursor = null) {
    this.sweep(); const d = this.device(id);
    assert(source == null || ['serial', 'simulation'].includes(source), 400, 'SOURCE_INVALID', '数据来源无效');
    return this.trendPage(d, item => item.expiresAt > this.now() && this.coordinator.hasKey(item.cacheKey) && (source == null || item.source === source) && item.equipmentId === equipmentId && item.point.id === pointId, item => ({ observedUtc: item.observedUtc, value: item.point.quality === 'good' ? item.point.value : null, quality: item.point.quality, unit: item.point.unit, receivedAt: item.receivedAt, configVersion: item.point.configVersion, acquisitionRound: item.point.acquisitionRound, connectionSessionId: item.connectionSessionId, source: item.source, sourceSegment: item.sourceSegment, equipmentId: item.equipmentId }), limit, cursor);
  }
  _releaseRings(d, filter = () => true) {
    const released = [];
    for (const [key, ring] of d.rings) if (filter(key)) { for (let i = ring.head; i < ring.items.length; i++) released.push(ring.items[i].cacheKey); d.rings.delete(key); }
    this.coordinator.release(released);
  }
  clearSource(id, source) {
    const d = this.devices.get(id); if (!d) return;
    this._releaseRings(d, key => key.includes(`/${source}/`));
    for (const [key, item] of d.latest) if (item.snapshot.source === source) d.latest.delete(key);
    for (const key of [...d.watermarks.keys()]) if (key.includes(`/${source}/`)) d.watermarks.delete(key);
    this.emit('cache-cleared', id, { deviceId: id, source });
  }
}
