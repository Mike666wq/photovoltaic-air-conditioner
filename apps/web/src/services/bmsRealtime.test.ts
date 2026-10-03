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
    expect(store.getState().trends.current.map((p)=>p.value)).toEqual([-1.02]);
    store.getState().accept(item({deviceId:'other',sequence:20})); store.getState().accept(item({pack:2,sequence:20}));
    expect(store.getState().samples).toHaveLength(1);
    store.getState().accept(item({source:'simulation',sequence:13}));
    expect(store.getState().samples.some((p)=>p.snapshot.source==='simulation')).toBe(true);
  });
  it('历史缓存与低频新鲜度、时间偏差分开', () => {
    const s=item(); expect(sampleStale(s,Date.parse(s.receivedAt)+16000)).toBe(true);
    expect(sampleStale(item({periodSeconds:120}),Date.parse(s.receivedAt)+60000)).toBe(false);
    expect(sampleStale({...s,stale:true},Date.parse(s.receivedAt))).toBe(true); expect(clockSkew(s)).toBe(true);
    expect(sampleExpired(s,Date.parse(s.receivedAt)+599999)).toBe(false); expect(sampleExpired(s,Date.parse(s.receivedAt)+600000)).toBe(true);
  });
  it('点数有限，切换会话清旧趋势，清理和reset不碰仿真store', () => {
    for(let i=1;i<=700;i++) store.getState().accept(item({sequence:i}));
    expect(store.getState().trends.voltage).toHaveLength(600);
    store.getState().accept(item({connectionSessionId:'new-session',address:2,sequence:1})); expect(store.getState().trends.voltage).toHaveLength(1);
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
  controller.stop('paused'); expect(source.close).toHaveBeenCalled(); expect(api.release).toHaveBeenCalledWith('fixture-viewer');
  await vi.advanceTimersByTimeAsync(60000); expect(api.renew).toHaveBeenCalledTimes(1); expect(store.getState().phase).toBe('paused'); expect(store.getState().lease).toBeNull();
});
it('停止过程中迟到的租约不会建立SSE或遗留观看者', async () => {
  const api=fakeApi(); let resolve!: (v: typeof lease)=>void;
  api.create.mockReturnValue(new Promise((r)=>{resolve=r;})); const open=vi.fn(); const controller=new BmsRealtimeController(api,open);
  const started=controller.start(); controller.stop(); resolve(lease); await started;
  expect(open).not.toHaveBeenCalled(); expect(api.release).toHaveBeenCalledWith(lease.viewerId); expect(store.getState().phase).toBe('idle');
});

it('会话失效返回登录态，并重新获取CSRF登录挑战', async () => {
  const api=fakeApi(); api.create.mockRejectedValue(new BmsApiError(401,'AUTH_REQUIRED','请登录观看账户'));
  api.session=vi.fn().mockResolvedValue(null); store.setState({identity:{username:'fixture',role:'viewer'}});
  const controller=new BmsRealtimeController(api,vi.fn()); await controller.start();
  expect(store.getState().identity).toBeNull();expect(store.getState().phase).toBe('unauthorized');expect(api.session).toHaveBeenCalledTimes(1);
});
