import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRealtimeApi } from './routes.mjs';
import { passwordHash, tokenHash } from './auth.mjs';
import { validateSnapshot } from './contract.mjs';
import { RealtimeState } from './state.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/snapshot-v1.json', import.meta.url)));
const token = 'fixture-only-device-token-32-bytes-long';
const device = { deviceId: 'lab-bms-01', alias: '实验室 BMS', allowedPacks: [1,2], allowedAddresses: [1,2], deviceTokenHash: tokenHash(token), allowSimulation: false };
const hash = await passwordHash('fixture-viewer-password');
const config = { enabled: true, devices: [device], users: [{ username: 'operator', passwordHash: hash, devices: [device.deviceId], role: 'admin' }, { username: 'observer', passwordHash: hash, devices: [device.deviceId], role: 'viewer' }, { username: 'other', passwordHash: hash, devices: [] }], publicOrigin: 'https://example.test' };
const sample = (patch = {}) => ({ ...structuredClone(fixture), capturedUtc: '2026-10-03T08:00:01.000Z', ...patch });
async function harness(t, overrides = {}) {
  let mono = 1000;
  const api = createRealtimeApi({ config: { ...config, ...overrides }, clocks: { now: () => mono, wall: () => Date.parse('2026-10-03T08:00:00Z') + mono } });
  const server = createServer(async (req, res) => { if (!(await api.handle(req, res))) { res.writeHead(404); res.end('outside'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); });
  const call = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(root + '/api/realtime' + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
  };
  const login = async (username = 'operator') => {
    const guest = await call('/auth/session'); const cookie = guest.headers.get('set-cookie').split(';')[0];
    const res = await call('/auth/login', 'POST', { username, password: 'fixture-viewer-password' }, { Cookie: cookie, Origin: config.publicOrigin, 'X-Bms-Csrf': guest.body.csrfToken });
    assert.equal(res.status, 200);
    const headers = { Cookie: res.headers.get('set-cookie').split(';')[0], Origin: config.publicOrigin, 'X-Bms-Csrf': res.body.csrfToken };
    return { headers, call: (p,m,b) => call(p,m,b,headers) };
  };
  const deviceHeaders = { Authorization: `Bearer ${token}` };
  const beat = () => call('/heartbeat', 'POST', { deviceId: device.deviceId, alias: device.alias }, deviceHeaders);
  const send = (id, snapshot = sample()) => call('/snapshots', 'POST', { subscriptionId: id, snapshot }, deviceHeaders);
  return { api, root, call, login, beat, send, deviceHeaders, advance: (ms) => mono += ms };
}
async function viewing(h, selected = [1], username) {
  const user = await h.login(username); const viewer = (await user.call('/viewers', 'POST', { deviceId: device.deviceId, packs: selected })).body;
  return { user, viewer, lease: (await h.beat()).body };
}
test('模块默认关闭JSON503，其他路径正常，未知API不返回HTML', async (t) => {
  const h = await harness(t, { enabled: false }); assert.equal((await h.call('/devices')).status, 503); assert.equal((await fetch(h.root + '/')).status, 404);
  const enabled = await harness(t); assert.equal((await enabled.call('/missing')).status, 404);
});
test('无观看仅心跳；创建、采样、转换与同租约续期', async (t) => {
  const h = await harness(t); assert.deepEqual((await h.beat()).body, { subscriptionId: '', leaseSeconds: 0, requestedPacks: [] });
  const { user, lease } = await viewing(h); assert.equal(lease.leaseSeconds, 45); assert.deepEqual(lease.requestedPacks, [1]);
  assert.deepEqual((await user.call('/devices/lab-bms-01/latest')).body.packs, []);
  assert.equal((await h.send(lease.subscriptionId)).status, 200);
  const latest = (await user.call('/devices/lab-bms-01/latest')).body.packs[0];
  assert.equal(latest.snapshot.currentCentiamps, -102); assert.equal(latest.receivedAt, '2026-10-03T08:00:01.000Z'); assert.equal(latest.stale, false);
  const trend = (await user.call('/devices/lab-bms-01/trend?pack=1&metric=current')).body.points[0];
  assert.equal(trend.value, -1.02);
  assert.equal(trend.periodSeconds, fixture.periodSeconds, 'HTTP趋势响应应逐点保留采集周期');
  assert.equal((await h.beat()).body.subscriptionId, lease.subscriptionId);
});
test('多观看者并集、所有权、续期、释放、过期、新租约', async (t) => {
  const h = await harness(t); const a = await viewing(h); const b = await viewing(h, [2], 'observer');
  assert.deepEqual(b.lease.requestedPacks, [1,2]);
  assert.equal((await a.user.call(`/viewers/${b.viewer.viewerId}`, 'PUT', { packs: [1] })).status, 403);
  await a.user.call(`/viewers/${a.viewer.viewerId}`, 'PUT', { packs: [2] }); assert.deepEqual((await h.beat()).body.requestedPacks, [2]);
  await b.user.call(`/viewers/${b.viewer.viewerId}`, 'DELETE'); await a.user.call(`/viewers/${a.viewer.viewerId}`, 'DELETE');
  assert.equal((await h.send(a.lease.subscriptionId, sample({pack:2}))).status, 409); assert.equal((await h.beat()).body.leaseSeconds, 0);
  assert.equal((await a.user.call(`/viewers/${a.viewer.viewerId}`, 'DELETE')).status, 204);
  const c = await viewing(h); assert.notEqual(c.lease.subscriptionId, a.lease.subscriptionId); h.advance(45001);
  assert.equal((await c.user.call(`/viewers/${c.viewer.viewerId}`, 'PUT', { packs: [1] })).status, 410); assert.equal((await h.send(c.lease.subscriptionId)).status, 409);
});
test('重复幂等、跨Pack乱序、旧会话迟到与并发会话拒绝', async (t) => {
  const h = await harness(t); const {user,lease} = await viewing(h,[1,2]);
  for (const s of [sample({sequence:20}),sample({sequence:20}),sample({sequence:19,pack:2}),sample({sequence:18})]) assert.equal((await h.send(lease.subscriptionId,s)).status,200);
  const rows = (await user.call('/devices/lab-bms-01/latest')).body.packs; assert.equal(rows.length,2); assert.equal(rows.find((p)=>p.snapshot.pack===1).snapshot.sequence,20);
  assert.equal((await user.call('/devices/lab-bms-01/trend?pack=1&metric=voltage')).body.points.length,1);
  assert.equal((await h.send(lease.subscriptionId,sample({connectionSessionId:'other-session',sequence:1}))).body.error.code,'SESSION_CONFLICT');
  h.advance(45001); const next = await viewing(h); assert.equal((await h.send(next.lease.subscriptionId,sample({connectionSessionId:'new-session',sequence:1}))).status,200);
  assert.equal((await h.send(next.lease.subscriptionId)).body.error.code,'SESSION_RETIRED');
});
test('401/403/409/422/400与字段边界，无越权设备', async (t) => {
  const h=await harness(t, { system: { name: 'legacy', bmsDeviceId: device.deviceId, experimentDeviceId: null, allowSimulation: false } }); const {lease}=await viewing(h);
  assert.equal((await h.call('/heartbeat','POST',{deviceId:device.deviceId,alias:''})).status,401); assert.equal((await h.call('/devices')).status,401);
  assert.equal((await h.call('/heartbeat','POST',{deviceId:'wrong',alias:''},h.deviceHeaders)).status,403);
  for (const [patch,status] of [[{pack:2},403],[{address:3},403],[{schemaVersion:2},422],[{source:'invalid'},400],[{voltageCentivolts:'5331'},400],[{capturedUtc:'2026-02-30T00:00:00Z'},400],[{cellsMillivolts:Array(49).fill(3333)},400],[{temperaturesCelsius:Array(33).fill(20)},400]]) assert.equal((await h.send(lease.subscriptionId,sample(patch))).status,status);
  assert.equal((await h.send(lease.subscriptionId,sample({source:'simulation',sequence:20}))).status,200); // device.allowSimulation=false不再阻断云端接收。
  const latest=(await h.login('observer')).call;
  const simulatedLatest=(await latest('/devices/lab-bms-01/latest?source=simulation')).body.packs[0];
  assert.equal(simulatedLatest.snapshot.source,'simulation');assert.equal(typeof simulatedLatest.acceptedOrder,'number');
  assert.equal((await h.send('old-lease')).status,409);
  const other=await h.login('other'); assert.equal((await other.call('/devices')).body.devices.length,0); assert.equal((await other.call('/devices/lab-bms-01/latest')).status,403);
});
test('可选间隔、48电芯/32温度、负温度、原始百分比与告警', () => {
  const s=sample({cellsMillivolts:Array(48).fill(3333),temperaturesCelsius:Array(32).fill(-5),socPercent:120}); delete s.periodSeconds;
  assert.equal(validateSnapshot({subscriptionId:'lease',snapshot:s},device).socPercent,120);
  const alarm={observedUtc:'2026-10-02T07:59:58.000Z',acquisitionRound:7,pack:1,payloadHex:'00AB'};
  assert.equal(validateSnapshot({subscriptionId:'lease',snapshot:{...s,alarmObservationAvailable:true,alarmObservation:alarm}},device).alarmObservation.observedUtc,alarm.observedUtc);
  assert.throws(()=>validateSnapshot({subscriptionId:'lease',snapshot:{...s,alarmObservation:{}}},device));
  assert.throws(()=>validateSnapshot({subscriptionId:'lease',snapshot:{...s,alarmObservationAvailable:true,alarmObservation:{...alarm,payloadHex:'ABC'}}},device));
});
test('Cookie、CSRF/Origin、管理员清理、登出撤销', async (t) => {
  const h=await harness(t); const guest=await h.call('/auth/session'); assert.match(guest.headers.get('set-cookie'),/HttpOnly/); assert.match(guest.headers.get('set-cookie'),/Secure/);
  const {user,lease}=await viewing(h);
  assert.equal((await h.call('/viewers','POST',{deviceId:device.deviceId,packs:[1]},{...user.headers,Origin:'https://evil.test'})).status,403);
  assert.equal((await h.call('/viewers','POST',{deviceId:device.deviceId,packs:[1]},{Cookie:user.headers.Cookie,Origin:config.publicOrigin})).status,403);
  await h.send(lease.subscriptionId); const viewer=await h.login('observer'); assert.equal((await viewer.call('/devices/lab-bms-01/cache','DELETE')).status,403);
  assert.equal((await user.call('/devices/lab-bms-01/cache','DELETE')).status,204); assert.equal((await user.call('/devices/lab-bms-01/latest')).body.packs.length,0);
  await user.call('/auth/logout','POST'); assert.equal((await h.beat()).body.leaseSeconds,0); assert.equal((await user.call('/devices')).status,401);
});
test('SSE bootstrap带stale，鉴权和租约到期关闭连接', async (t) => {
  const h=await harness(t); const {user,lease,viewer}=await viewing(h); await h.send(lease.subscriptionId); h.advance(16000);
  const abort=new AbortController(); t.after(()=>abort.abort());
  const res=await fetch(h.root+'/api/realtime/events?viewerId='+viewer.viewerId,{headers:user.headers,signal:abort.signal});
  assert.equal(res.status,200); assert.equal(res.headers.get('x-accel-buffering'),'no');
  const reader=res.body.getReader(); let text=''; while(!text.includes('event: snapshot')) { const part=await reader.read(); assert.equal(part.done,false); text+=new TextDecoder().decode(part.value); } assert.match(text,/event: snapshot/); assert.match(text,/"stale":true/);
  assert.equal((await h.call('/events?viewerId='+viewer.viewerId)).status,401); const other=await h.login('observer'); assert.equal((await other.call('/events?viewerId='+viewer.viewerId)).status,403);
  h.advance(30000); h.api.state.sweep(); const ended=await reader.read(); if(!ended.done) assert.match(new TextDecoder().decode(ended.value),/VIEWER_EXPIRED/); abort.abort();
});
test('非JSON、含chunked的64KiB限额与观看配额429', async (t) => {
  const h=await harness(t);
  const plain=await fetch(h.root+'/api/realtime/heartbeat',{method:'POST',headers:{...h.deviceHeaders,'Content-Type':'text/plain'},body:'{}'}); assert.equal(plain.status,400);
  assert.equal((await h.call('/heartbeat','POST',{deviceId:device.deviceId,alias:'x'.repeat(65536)},h.deviceHeaders)).status,413);
  const chunked=await new Promise((resolve,reject)=>{const req=httpRequest(h.root+'/api/realtime/heartbeat',{method:'POST',headers:{...h.deviceHeaders,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},(res)=>{let body='';res.on('data',(c)=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));}); req.on('error',reject);req.write('x'.repeat(33000));req.end('x'.repeat(33000));}); assert.equal(chunked.status,413); assert.equal(chunked.body.error.code,'BODY_TOO_LARGE');
  const user=await h.login(); for(let i=0;i<4;i++) assert.equal((await user.call('/viewers','POST',{deviceId:device.deviceId,packs:[1]})).status,201);
  assert.equal((await user.call('/viewers','POST',{deviceId:device.deviceId,packs:[1]})).status,429);
});
test('每Pack点数/时间边界，停止观看清趋势，TTL使用单调时钟', () => {
  let mono=0;let wall=Date.parse('2026-10-03T08:00:00Z'); const state=new RealtimeState({...config,maxPoints:3},{now:()=>mono,wall:()=>wall});
  const viewer=state.createViewer('owner',device.deviceId,[1]); const lease=state.heartbeat(device.deviceId);
  for(let i=1;i<=6;i++){mono++;state.accept(device.deviceId,lease.subscriptionId,sample({address:i%2+1,sequence:i}));}
  assert.equal(state.trend(device.deviceId,1,'voltage',600).points.length,6);wall+=86400000;assert.equal(state.heartbeat(device.deviceId).subscriptionId,lease.subscriptionId);
  state.release(viewer.viewerId,'owner');assert.equal(state.trend(device.deviceId,1,'voltage',600).points.length,6);mono+=3600001;assert.equal(state.latest(device.deviceId,[1]).packs.length,0);assert.equal(state.trend(device.deviceId,1,'voltage',600).points.length,0);
});

test('默认实时钟共享performance基准且缓存满时拒绝快照不改latest与水位', () => {
  const real = new RealtimeState({ ...config, devices: [device] });
  const viewer = real.createViewer('owner', device.deviceId, [1]); const lease = real.heartbeat(device.deviceId);
  const live = sample({ capturedUtc: new Date().toISOString(), sequence: 1 });
  assert.equal(real.accept(device.deviceId, lease.subscriptionId, live).accepted, true);
  assert.equal(real.trend(device.deviceId, 1, 'voltage', 10).points.length, 1);

  let mono = 1000; const wall = Date.parse('2026-10-03T08:00:00Z');
  const limited = new RealtimeState({ ...config, devices: [device], maxCachePoints: 1, maxCacheBytes: 1024 }, { now: () => mono, wall: () => wall + mono });
  limited.createViewer('owner', device.deviceId, [1]); const limitedLease = limited.heartbeat(device.deviceId);
  const first = sample({ capturedUtc: new Date(wall + mono).toISOString(), sequence: 1 });
  limited.accept(device.deviceId, limitedLease.subscriptionId, first);
  const previousWatermarks = structuredClone([...limited.device(device.deviceId).watermarks]);
  assert.throws(() => limited.accept(device.deviceId, limitedLease.subscriptionId, sample({ capturedUtc: new Date(wall + mono + 1).toISOString(), sequence: 2 })), error => error.code === 'CACHE_CAPACITY_EXCEEDED');
  assert.equal(limited.device(device.deviceId).currentSession, first.connectionSessionId);
  assert.deepEqual([...limited.device(device.deviceId).watermarks], previousWatermarks);
  assert.equal(limited.latest(device.deviceId, [1]).packs[0].snapshot.sequence, 1);
  real.release(viewer.viewerId, 'owner');
});

test('SSE按Pack过滤，重复viewer连接会替换旧连接', async (t) => {
  const h=await harness(t);const a=await viewing(h,[1]);const b=await viewing(h,[2],'observer');
  const abort=new AbortController(); t.after(()=>abort.abort());
  const url=h.root+'/api/realtime/events?viewerId='+a.viewer.viewerId;
  const res=await fetch(url,{headers:a.user.headers,signal:abort.signal});const reader=res.body.getReader();await reader.read();
  await h.send(b.lease.subscriptionId,sample({pack:2,sequence:30}));await h.send(b.lease.subscriptionId,sample({pack:1,sequence:31}));
  let data='';while(!data.includes('\"pack\":1')){const part=await reader.read();assert.equal(part.done,false);data+=new TextDecoder().decode(part.value);}assert.match(data,/"pack":1/);assert.doesNotMatch(data,/"pack":2/);
  for(let i=0;i<3;i++)assert.equal((await fetch(url,{headers:a.user.headers,signal:abort.signal})).status,200);
  // 同一租约的浏览器EventSource重连替换旧流，不累加连接配额。
  assert.equal((await fetch(url,{headers:a.user.headers,signal:abort.signal})).status,200);abort.abort();
});
test('慢SSE消费者的写缓冲有硬上限，终止后不再写入', async () => {
  const {writeSse}=await import('./routes.mjs');let writes=0;
  const sink={writableLength:65530,writableEnded:false,destroyed:false,write(){writes++;}};
  assert.equal(writeSse(sink,'snapshot',{value:5331}),false);assert.equal(writes,0);
  sink.writableLength=0;assert.equal(writeSse(sink,'snapshot',{value:5331}),true);assert.equal(writes,1);
  sink.writableEnded=true;assert.equal(writeSse(sink,'snapshot',{value:0}),false);assert.equal(writes,1);
});
