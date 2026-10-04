import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../scripts/realtime/fixtures/snapshot-v1.json';
import { bmsNumber, bmsTime, sampleStale, sampleExpired, clockSkew } from './bmsRealtimeTypes';
import type { BmsSample, BmsSnapshot } from './bmsRealtimeTypes';
import { useBmsRealtimeStore as store } from '../store/bmsRealtime';
import { BmsRealtimeController } from './bmsRealtimeController';
import { bmsApi, BmsApiError } from './bmsRealtimeApi';
const item = (patch: Partial<BmsSnapshot> = {}): BmsSample => ({ snapshot: { ...fixture, ...patch } as BmsSnapshot, receivedAt: '2026-10-03T08:00:00Z', stale: false });
const lease = { viewerId: 'fixture-viewer', expiresAt: '2026-10-03T08:00:45Z', renewAfterSeconds: 15 };
beforeEach(() => { store.getState().reset(); store.setState({ deviceId: 'lab-bms-01', pack: 1 }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const flushQueue = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe('BMS显示口径与有界状态', () => {
  it('按协议转换单位，保留负值、0和缺失；上海时区没有重复偏移', () => {
    expect(bmsNumber(5331,100)).toBe('53.31'); expect(bmsNumber(-102,100)).toBe('-1.02'); expect(bmsNumber(8878,100)).toBe('88.78');
    expect(bmsNumber(0,100)).toBe('0.00'); expect(bmsNumber(undefined)).toBe('—');
    expect(bmsTime('2026-10-02T08:00:00.123Z')).toContain('16:00:00');
    const s=item({temperaturesCelsius:[-5],alarmObservationAvailable:false,alarmObservation:null}); store.getState().accept(s);
    expect(store.getState().samples[0].snapshot.temperaturesCelsius).toEqual([-5]); expect(store.getState().samples[0].snapshot.alarmObservation).toBeNull();
  });
  it('重复/乱序不追加，模拟来源保留标识，不接其他设备或Pack', () => {
    store.getState().accept(item()); store.getState().accept(item()); store.getState().accept(item({sequence:11}));
    expect(store.getState().trends.current).toEqual([]); // SSE latest样本与服务端趋势缓存各司其职。
    store.getState().accept(item({deviceId:'other',sequence:20})); store.getState().accept(item({pack:2,sequence:20}));
    expect(store.getState().samples).toHaveLength(1);
    store.getState().accept(item({source:'simulation',sequence:13}));
    expect(store.getState().samples.some((p)=>p.snapshot.source==='simulation')).toBe(false);
    store.getState().clearData();store.setState({source:'simulation'});store.getState().accept(item({source:'simulation',sequence:13}));
    expect(store.getState().samples.some((p)=>p.snapshot.source==='simulation')).toBe(true);
  });
  it('历史缓存与低频新鲜度、时间偏差分开', () => {
    const s=item(); expect(sampleStale(s,Date.parse(s.receivedAt)+16000)).toBe(true);
    expect(sampleStale(item({periodSeconds:120}),Date.parse(s.receivedAt)+60000)).toBe(false);
    expect(sampleStale({...s,stale:true},Date.parse(s.receivedAt))).toBe(true); expect(clockSkew(s)).toBe(true);
    expect(sampleExpired(s,Date.parse(s.receivedAt)+599999)).toBe(false); expect(sampleExpired(s,Date.parse(s.receivedAt)+600000)).toBe(true);
  });
  it('保留完整小时趋势，不因新连接会话清除服务端观测；清理和reset不碰仿真store', () => {
    const start=Date.now()-3599000;const observed=Array.from({length:701},(_,i)=>({entryId:i+1,capturedUtc:new Date(start+i*3000).toISOString(),receivedAt:new Date().toISOString(),sequence:i+1,connectionSessionId:'session-a',value:i,source:'serial' as const,address:1}));
    store.getState().appendTrend('voltage',observed,true);
    expect(store.getState().trends.voltage).toHaveLength(701);
    store.getState().accept(item({connectionSessionId:'new-session',address:2,sequence:1})); expect(store.getState().trends.voltage).toHaveLength(701);
    store.getState().appendTrend('voltage',[{...observed[0],entryId:702,connectionSessionId:'session-b'},{...observed[0],entryId:702,connectionSessionId:'session-b'}]);store.getState().appendTrend('voltage',[{...observed[0],entryId:702,connectionSessionId:'session-b'}]);expect(store.getState().trends.voltage).toHaveLength(702);
    expect(store.getState().channel).toBe('serial/2/1');
    store.getState().clearData(); expect(store.getState().samples).toEqual([]); expect(store.getState().trends.current).toEqual([]);
  });
});
function fakeApi() {
  return { ...bmsApi, create:vi.fn().mockResolvedValue(lease), release:vi.fn().mockResolvedValue(undefined), renew:vi.fn().mockResolvedValue(lease), latest:vi.fn().mockResolvedValue({online:true,lastHeartbeatAt:null,packs:[]}), trend:vi.fn().mockResolvedValue({points:[]}) };
}
it('停止观看关闭SSE、清除续期计时并释放租约；连接前无观看副作用', async () => {
  vi.useFakeTimers(); const api=fakeApi(); const source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource;
  const controller=new BmsRealtimeController(api,()=>source);
  expect(api.create).not.toHaveBeenCalled(); await controller.start(); expect(api.create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); expect(api.renew).toHaveBeenCalledTimes(1);
  controller.stop('paused'); await flushQueue(); expect(source.close).toHaveBeenCalled(); expect(api.release).toHaveBeenCalledWith('fixture-viewer');
  await vi.advanceTimersByTimeAsync(60000); expect(api.renew).toHaveBeenCalledTimes(1); expect(store.getState().phase).toBe('paused'); expect(store.getState().lease).toBeNull();
});
it('停止过程中迟到的租约不会建立SSE或遗留观看者', async () => {
  const api=fakeApi(); let resolve!: (v: typeof lease)=>void;
  api.create.mockReturnValue(new Promise((r)=>{resolve=r;})); const open=vi.fn(); const controller=new BmsRealtimeController(api,open);
  const started=controller.start(); await flushQueue();expect(api.create).toHaveBeenCalledOnce();controller.stop(); resolve(lease); await started;
  expect(open).not.toHaveBeenCalled(); expect(api.release).toHaveBeenCalledWith(lease.viewerId); expect(store.getState().phase).toBe('idle');
});

it('释放请求未完成时，快速切Pack/来源会先释放旧租约再创建新租约',async()=>{
  const api=fakeApi(),order:string[]=[];let finishRelease!:()=>void;
  api.create.mockImplementation(async(...args)=>{order.push(`create:${String(args[1])}:${String(args[3])}`);return {...lease,viewerId:`viewer-${api.create.mock.calls.length}`};});
  api.release.mockImplementation(()=>{order.push('release-start');return new Promise<void>(resolve=>{finishRelease=()=>{order.push('release-done');resolve();};});});
  const source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource,controller=new BmsRealtimeController(api,()=>source);
  await controller.start('logical-page');controller.stop();await flushQueue();store.setState({pack:2,source:'simulation'});
  const restart=controller.start('logical-page');await flushQueue();expect(api.create).toHaveBeenCalledTimes(1);finishRelease();await restart;
  expect(order).toEqual(['create:1:serial','release-start','release-done','create:2:simulation']);api.release.mockResolvedValue(undefined);controller.stop();
});

it('释放等待期间再次停止会取消排队创建；迟到create租约先释放再允许下一租约',async()=>{
  const api=fakeApi(),order:string[]=[];let finishCreate!:(value:typeof lease)=>void;
  api.create.mockImplementationOnce(()=>{order.push('create-pending');return new Promise(resolve=>{finishCreate=resolve;});}).mockImplementation(async()=>{order.push('create-next');return lease;});
  api.release.mockImplementation(async(id)=>{order.push(`release:${id}`);});
  const source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource,controller=new BmsRealtimeController(api,()=>source);
  const first=controller.start('logical-page');await flushQueue();expect(api.create).toHaveBeenCalledTimes(1);controller.stop();const second=controller.start('logical-page');
  finishCreate({...lease,viewerId:'late-viewer'});await Promise.all([first,second]);
  expect(order).toEqual(['create-pending','release:late-viewer','create-next']);

  let finishRelease!:()=>void;api.release.mockImplementation(()=>new Promise<void>(resolve=>{finishRelease=resolve;}));controller.stop();await flushQueue();const queued=controller.start('logical-page');controller.stop();finishRelease();await queued;
  expect(store.getState().phase).toBe('idle');
});

it('DELETE网络请求卡住时等待有上限，后续租约仍可退避恢复',async()=>{
  const api=fakeApi();api.release.mockImplementation(()=>new Promise<void>(()=>{}));
  const source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource,controller=new BmsRealtimeController(api,()=>source,20);
  await controller.start('bounded-release');controller.stop();const restart=controller.start('bounded-release');await restart;
  expect(api.create).toHaveBeenCalledTimes(2);api.release.mockResolvedValue(undefined);controller.stop();
});
it('释放遇到网络错误后，PAGE_MODULE_EXISTS按退避重试并恢复',async()=>{
  const api=fakeApi(),source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource,controller=new BmsRealtimeController(api,()=>source);
  await controller.start('retry-page');let attempts=0;api.create.mockImplementation(async()=>{attempts++;if(attempts===1)throw new BmsApiError(409,'PAGE_MODULE_EXISTS','页面模块仍有租约');return lease;});api.release.mockRejectedValue(new Error('网络中断'));vi.useFakeTimers();
  const restarted=controller.start('retry-page');await restarted;expect(attempts).toBe(1);expect(store.getState().phase).toBe('reconnecting');await vi.advanceTimersByTimeAsync(1000);
  expect(attempts).toBe(2);expect(store.getState().phase).toBe('watching');api.release.mockResolvedValue(undefined);controller.stop();
});

it('历史趋势顺序读取全部游标页并合并观测',async()=>{
  const api=fakeApi();const now=new Date().toISOString();
  api.trend.mockImplementation(async(_device,_pack,metric,_source,cursor)=>cursor
    ?{points:[{entryId:2,capturedUtc:now,receivedAt:now,sequence:2,connectionSessionId:'s2',value:2,source:'serial',address:1}],nextCursor:null,hasMore:false}
    :{points:[{entryId:1,capturedUtc:now,receivedAt:now,sequence:1,connectionSessionId:'s1',value:1,source:'serial',address:1}],nextCursor:'cursor-1',hasMore:true});
  const source={close:vi.fn(),addEventListener:vi.fn(),onopen:null,onerror:null} as unknown as EventSource;
  const controller=new BmsRealtimeController(api,()=>source);await controller.start('page-history');
  expect(api.trend).toHaveBeenCalledWith('lab-bms-01',1,'voltage','serial','cursor-1');
  expect(store.getState().trends.voltage.map(p=>p.entryId)).toEqual([1,2]);controller.stop();
});

it('会话失效返回登录态，并重新获取CSRF登录挑战', async () => {
  const api=fakeApi(); api.create.mockRejectedValue(new BmsApiError(401,'AUTH_REQUIRED','请登录观看账户'));
  api.session=vi.fn().mockResolvedValue(null); store.setState({identity:{username:'fixture',role:'viewer'}});
  const controller=new BmsRealtimeController(api,vi.fn()); await controller.start();
  expect(store.getState().identity).toBeNull();expect(store.getState().phase).toBe('unauthorized');expect(api.session).toHaveBeenCalledTimes(1);
});
