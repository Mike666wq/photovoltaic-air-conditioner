import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealtimeApi } from './routes.mjs';
import { loadConfig, tokenHash, passwordHash } from './auth.mjs';

const origin='https://example.test', bootstrapToken='disposable-fixture-bootstrap-32bytes-long', password='fixture-password-12-characters';
const deviceInput={deviceId:'fixture-device',alias:'本机夹具（非实测）',allowedAddresses:[1],allowedPacks:[1,2],allowSimulation:true};
async function harness(t, envOverrides={}, initial) {
  const dir=mkdtempSync(join(tmpdir(),'pv-bms-reg-'));
  const key=join(dir,'bootstrap.key');writeFileSync(key,bootstrapToken,{mode:0o600});
  const env={BMS_REALTIME_ENABLED:'1',BMS_REALTIME_REGISTRY_DIR:join(dir,'storage'),BMS_REALTIME_PUBLIC_ORIGIN:origin,BMS_REALTIME_BOOTSTRAP_TOKEN_FILE:key,...envOverrides};
  if(initial){env.BMS_DEVICES_FILE=join(dir,'devices.json');env.BMS_VIEWER_CREDENTIALS_FILE=join(dir,'users.json');writeFileSync(env.BMS_DEVICES_FILE,JSON.stringify({devices:initial.devices}));writeFileSync(env.BMS_VIEWER_CREDENTIALS_FILE,JSON.stringify({users:initial.users}));}
  const api=createRealtimeApi({config:loadConfig(env)});
  const server=createServer(async(req,res)=>{if(!await api.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{api.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
  const root=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,method='GET',body,headers={})=>{
    const res=await fetch(root+'/api/realtime'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    return{status:res.status,headers:res.headers,body:res.status===204?null:await res.json()};
  };
  const guest=async()=>{const g=await call('/auth/session');return{Cookie:g.headers.get('set-cookie').split(';')[0],Origin:origin,'X-Bms-Csrf':g.body.csrfToken};};
  const signed=(res)=>{const headers={Cookie:res.headers.get('set-cookie').split(';')[0],Origin:origin,'X-Bms-Csrf':res.body.csrfToken};return{headers,call:(p,m,b)=>call(p,m,b,headers)};};
  const setup=async()=>{const res=await call('/setup/bootstrap','POST',{username:'fixture-admin',password,bootstrapToken},await guest());assert.equal(res.status,201);return signed(res);};
  const login=async(username)=>{const res=await call('/auth/login','POST',{username,password},await guest());assert.equal(res.status,200);return signed(res);};
  return{api,env,dir,call,guest,setup,login,file:join(env.BMS_REALTIME_REGISTRY_DIR??join(dir,'storage'),'registry.json')};
}
test('公开接入状态不泄露配置；关闭模块仍能说明初始化流程',async(t)=>{
  const dangerous = {BMS_REALTIME_ENABLED:'1', BMS_REALTIME_PUBLIC_ORIGIN:origin};
  for (const directory of ['/tmp/fixture-public', '/tmp/fixture-public/child']) assert.throws(()=>loadConfig({...dangerous, SCENARIOS_DIR:'/tmp/fixture-public', BMS_REALTIME_REGISTRY_DIR:directory}), /注册存储必须独立/);
  const h=await harness(t,{BMS_REALTIME_ENABLED:'0'});const s=await h.call('/setup/status');
  assert.equal(s.status,200);assert.equal(s.body.enabled,false);assert.equal(s.body.bootstrapAvailable,false);assert.equal((await h.call('/setup/bootstrap','POST',{})).status,503);
});
test('首次管理员初始化需要密钥、Cookie、Origin与CSRF，完成后关闭初始化',async(t)=>{
  const h=await harness(t);const s=await h.call('/setup/status');assert.equal(s.body.bootstrapAvailable,true);
  const body={username:'fixture-admin',password,bootstrapToken};
  assert.equal((await h.call('/setup/bootstrap','POST',body)).status,401);
  const guest=await h.guest();assert.equal((await h.call('/setup/bootstrap','POST',body,{...guest,Origin:'https://foreign.test'})).status,403);
  assert.equal((await h.call('/setup/bootstrap','POST',{...body,bootstrapToken:'invalid'},guest)).body.error.code,'BOOTSTRAP_INVALID');
  const admin=await h.setup();assert.equal((await admin.call('/admin/registry')).status,200);
  assert.equal((await h.call('/setup/status')).body.bootstrapAvailable,false);
  assert.equal((await h.call('/setup/bootstrap','POST',body,await h.guest())).body.error.code,'ALREADY_INITIALIZED');
  const stored=readFileSync(h.file,'utf8');assert(!stored.includes(password));assert(!stored.includes(bootstrapToken));assert.equal(statSync(h.file).mode&0o777,0o600);
});
test('初始化并发只创建一个管理员，注册文件可在服务重启后恢复',async(t)=>{
  const h=await harness(t);const body={username:'fixture-admin',password,bootstrapToken};
  const result=await Promise.all([h.call('/setup/bootstrap','POST',body,await h.guest()),h.call('/setup/bootstrap','POST',body,await h.guest())]);
  assert.deepEqual(result.map(r=>r.status).sort(),[201,409]);
  const restored=loadConfig(h.env);assert.equal(restored.users.length,1);assert.equal(restored.users[0].role,'admin');
  const api=createRealtimeApi({config:restored});api.close();
});
test('管理员注册设备和观看账户；读取不返回散列或令牌，权限限制生效',async(t)=>{
  const h=await harness(t);const admin=await h.setup();
  assert.equal((await h.call('/admin/devices','POST',deviceInput)).status,401);
  assert.equal((await h.call('/admin/devices','POST',deviceInput,{...admin.headers,'X-Bms-Csrf':'wrong'})).status,403);
  const created=await admin.call('/admin/devices','POST',deviceInput);assert.equal(created.status,201);assert(created.body.deviceToken.length>=32);
  assert.equal((await admin.call('/devices')).body.devices.length,1);
  assert.equal((await admin.call('/admin/devices','POST',deviceInput)).status,409);
  const user=await admin.call('/admin/users','POST',{username:'fixture-viewer',password,devices:[deviceInput.deviceId]});assert.equal(user.status,201);
  assert.equal((await admin.call('/admin/users','POST',{username:'another-admin',password,role:'admin',devices:[deviceInput.deviceId]})).status,403);
  const viewer=await h.login('fixture-viewer');assert.equal((await viewer.call('/admin/registry')).status,403);assert.equal((await viewer.call('/admin/devices','POST',{...deviceInput,deviceId:'other'})).status,403);
  assert.equal((await viewer.call('/devices')).body.devices[0].allowedAddresses[0],1);
  const publicData=JSON.stringify((await admin.call('/admin/registry')).body);for(const secret of ['passwordHash','deviceTokenHash',created.body.deviceToken,password])assert(!publicData.includes(secret));
  const persisted=loadConfig(h.env);assert.equal(persisted.devices[0].deviceTokenHash,tokenHash(created.body.deviceToken));assert.equal(persisted.users[1].role,'viewer');assert(!readFileSync(h.file,'utf8').includes(created.body.deviceToken));
});
test('令牌轮换立即拒绝旧令牌，撤销观看并清缓存，新令牌可正常心跳',async(t)=>{
  const h=await harness(t);const admin=await h.setup();const created=(await admin.call('/admin/devices','POST',deviceInput)).body;
  const viewer=(await admin.call('/viewers','POST',{deviceId:deviceInput.deviceId,packs:[1]})).body;
  const beat=(token)=>h.call('/heartbeat','POST',{deviceId:deviceInput.deviceId,alias:'fixture'},{Authorization:'Bearer '+token});
  assert((await beat(created.deviceToken)).body.subscriptionId);
  assert.equal((await admin.call('/admin/devices/fixture-device/token','POST',{})).status,400);
  const rotated=await admin.call('/admin/devices/fixture-device/token','POST',{confirmDeviceId:deviceInput.deviceId});assert.equal(rotated.status,200);assert.notEqual(rotated.body.deviceToken,created.deviceToken);
  assert.equal((await beat(created.deviceToken)).status,401);assert.equal((await beat(rotated.body.deviceToken)).body.leaseSeconds,0);
  assert.equal((await admin.call('/viewers/'+viewer.viewerId,'PUT',{packs:[1]})).status,410);assert.equal((await admin.call('/devices/fixture-device/latest')).body.packs.length,0);
});
test('并发同编号注册不会覆盖，非法范围/用户名/权限和设备配额明确拒绝',async(t)=>{
  const h=await harness(t,{BMS_REALTIME_MAX_DEVICES:'1'});const admin=await h.setup();
  for(const patch of [{deviceId:'bad/id'},{allowedAddresses:[0]},{allowedPacks:[17]},{allowedAddresses:Array(17).fill(1)},{allowSimulation:'true'}])assert.equal((await admin.call('/admin/devices','POST',{...deviceInput,...patch})).status,400);
  const pairs=await Promise.all([admin.call('/admin/devices','POST',deviceInput),admin.call('/admin/devices','POST',deviceInput)]);assert.deepEqual(pairs.map(r=>r.status).sort(),[201,409]);
  assert.equal((await admin.call('/admin/devices','POST',{...deviceInput,deviceId:'second'})).body.error.code,'DEVICE_LIMIT');
  for(const body of [{username:'x',password,devices:['fixture-device']},{username:'valid',password:'short',devices:['fixture-device']},{username:'valid',password,devices:['missing']}])assert.equal((await admin.call('/admin/users','POST',body)).status,400);
});
test('注册落盘失败不提交内存状态，恢复存储后仍可注册',async(t)=>{
  const h=await harness(t);const admin=await h.setup();const dir=h.env.BMS_REALTIME_REGISTRY_DIR;
  renameSync(dir,dir+'.backup');writeFileSync(dir,'fixture-blocked-storage');
  assert.equal((await admin.call('/admin/devices','POST',deviceInput)).status,503);assert.equal((await admin.call('/devices')).body.devices.length,0);
  rmSync(dir);renameSync(dir+'.backup',dir);
  assert.equal((await admin.call('/admin/devices','POST',deviceInput)).status,201);
});
test('旧只读注册文件仍可登录和观看，网页写入明确要求持久化目录',async(t)=>{
  const initial={devices:[],users:[{username:'fixture-admin',passwordHash:await passwordHash(password),role:'admin',devices:[]}]};
  const h=await harness(t,{BMS_REALTIME_REGISTRY_DIR:undefined},initial);const admin=await h.login('fixture-admin');
  assert.equal((await h.call('/setup/status')).body.writable,false);assert.equal((await admin.call('/admin/devices','POST',deviceInput)).body.error.code,'REGISTRY_READ_ONLY');
});

test('仅管理员可确认删除设备；撤销令牌、观看、缓存和全部授权，重启不恢复', async(t)=>{
  const h=await harness(t); const admin=await h.setup();
  const created=(await admin.call('/admin/devices','POST',deviceInput)).body;
  await admin.call('/admin/users','POST',{username:'fixture-viewer',password,devices:[deviceInput.deviceId]});
  const viewer=await h.login('fixture-viewer');
  const lease=(await viewer.call('/viewers','POST',{deviceId:deviceInput.deviceId,packs:[1]})).body;
  const path='/admin/devices/'+deviceInput.deviceId;
  const confirmation={confirmDeviceId:deviceInput.deviceId};
  assert.equal((await viewer.call(path,'DELETE',confirmation)).status,403);
  assert.equal((await h.call(path,'DELETE',confirmation,{...admin.headers,'X-Bms-Csrf':'invalid'})).status,403);
  assert.equal((await admin.call(path,'DELETE',{})).status,400);
  assert.equal((await admin.call(path,'DELETE',confirmation)).status,204);
  assert.equal((await h.call('/heartbeat','POST',{deviceId:deviceInput.deviceId,alias:'fixture'},{Authorization:'Bearer '+created.deviceToken})).status,401);
  assert.equal((await viewer.call('/viewers/'+lease.viewerId,'PUT',{packs:[1]})).status,410);
  assert.equal((await viewer.call('/devices')).body.devices.length,0);
  assert.equal((await admin.call('/devices')).body.devices.length,0);
  assert(!h.api.state.devices.has(deviceInput.deviceId));
  const restored=loadConfig(h.env); assert.equal(restored.devices.length,0); assert(restored.users.every(u=>u.devices.length===0));
  assert.equal((await admin.call(path,'DELETE',confirmation)).status,404);
  const recreated=(await admin.call('/admin/devices','POST',deviceInput)).body;
  assert.notEqual(recreated.deviceToken,created.deviceToken);
  assert.equal((await viewer.call('/devices')).body.devices.length,0); // 同编号重建不自动恢复旧观看用户权限。
});
