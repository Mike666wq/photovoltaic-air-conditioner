import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {experimentCatalog,pointStatus} from './experimentRealtimeTypes';
import type {ExperimentPoint,ExperimentSample} from './experimentRealtimeTypes';
import {useExperimentRealtimeStore as store} from '../store/experimentRealtime';
import {useBmsRealtimeStore} from '../store/bmsRealtime';
import {ExperimentRealtimeController} from './experimentRealtimeController';
import {experimentApi} from './experimentRealtimeApi';
import {bmsApi,BmsApiError} from './bmsRealtimeApi';
import {connectionInstructions} from './bmsRegistration';
const point:ExperimentPoint={id:'T0',description:'相变1',unit:'℃',value:25.125,rawValue:25.125,displayValue:'25.125',quality:'good',observedUtc:'2026-10-03T08:00:00.0000000Z',acquisitionRound:1,configVersion:'catalog-1',addressZeroBased:125,registerCount:2,decodeMode:'FLOAT ABCD',receivedAt:'2026-10-03T08:00:00Z',ageMs:0,seenMono:100};
const sample=(patch:Partial<ExperimentSample['snapshot']>={}):ExperimentSample=>({snapshot:{schemaVersion:1,module:'experiment',deviceId:'fixture',connectionSessionId:'fixture-session',acquisitionSessionId:'fixture-acquisition',sequence:1,capturedUtc:'2026-10-03T08:00:00Z',source:'serial',equipmentId:'PLC',slave:2,points:[point],...patch},receivedAt:'2026-10-03T08:00:00Z'});
const lease={viewerId:'fixture-lease',expiresAt:'2026-10-03T08:00:45Z',renewAfterSeconds:15};
beforeEach(()=>{store.getState().reset();store.setState({deviceId:'fixture',devices:[{deviceId:'fixture',module:'experiment',alias:'夹具',allowedEquipment:['PLC'],allowedPacks:[],online:true,lastHeartbeatAt:null}]});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();store.getState().reset();});
const flushQueue=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
it('预置37点按六类完整归档，七温度优先；未核准倍率保持工程原值',()=>{expect(experimentCatalog.points).toHaveLength(37);expect(experimentCatalog.points.filter(p=>p.metadata.Group==='温度')).toHaveLength(7);expect([...new Set(experimentCatalog.points.map(p=>p.metadata.Group))].sort()).toEqual(['市电','太阳能','实验电表','温度','运行状态','诊断'].sort());expect(pointStatus({...point,value:1.2,unit:'W · 倍率待核准'},100).value).toBe('1.2');});
it('未采集、真零、RAW/null、失败和未知质量不混淆',()=>{
 expect(pointStatus(undefined,100).value).toBe('—');expect(pointStatus({...point,value:0},100).value).toBe('0');expect(pointStatus({...point,value:null,displayValue:'U16=0 / I16=0'},100).value).toBe('U16=0 / I16=0');
 expect(pointStatus({...point,quality:'timeout',value:null},100)).toMatchObject({value:'—',label:'通信超时',good:false});expect(pointStatus({...point,quality:'vendor-unknown'},100)).toMatchObject({value:'—',label:'未知质量：vendor-unknown',good:false});
});
it('逐点30秒自动过期，不依赖新消息或浏览器壁钟',()=>{expect(pointStatus(point,30099).good).toBe(true);expect(pointStatus(point,30100)).toMatchObject({stale:true,good:false,value:'—'});expect(pointStatus({...point,ageMs:30000},100).stale).toBe(true);});
it('实测/模拟与仪器分区，低序号不覆盖，新会话清旧数据且不改变BMS',()=>{
 const bms=useBmsRealtimeStore.getState();store.getState().accept(sample());store.getState().accept(sample({source:'simulation',sequence:2}));store.getState().accept(sample({equipmentId:'DS666',sequence:1}));expect(Object.keys(store.getState().samples)).toHaveLength(2);
 store.getState().accept(sample({sequence:0,points:[{...point,value:999}]}));expect(store.getState().samples['serial/PLC'].snapshot.points[0].value).toBe(25.125);store.getState().accept(sample({deviceId:'other'}));expect(Object.keys(store.getState().samples)).toHaveLength(2);store.setState({source:'simulation'});store.getState().accept(sample({source:'simulation',sequence:2}));expect(Object.keys(store.getState().samples)).toHaveLength(3);store.getState().accept(sample({connectionSessionId:'new-session',source:'simulation'}));expect(Object.keys(store.getState().samples)).toHaveLength(1);expect(useBmsRealtimeStore.getState()).toBe(bms);
});
it('无效和过期的新快照保留最后有效值及实际观测时间',()=>{
 store.getState().accept(sample());store.getState().accept(sample({sequence:2,points:[{...point,value:null,displayValue:'—',quality:'timeout',observedUtc:'2026-10-03T08:00:30Z'}]}));
 const last=store.getState().lastGoodByPoint['serial/PLC/T0'];expect(last.value).toBe(25.125);expect(last.observedUtc).toBe(point.observedUtc);
 store.getState().accept(sample({connectionSessionId:'older-session',capturedUtc:'2026-10-03T07:59:00Z',points:[{...point,value:10,observedUtc:'2026-10-03T07:59:00Z'}]}));expect(store.getState().lastGoodByPoint['serial/PLC/T0'].value).toBe(25.125);
});
it('趋势分页中重复entryId只保留一条观测',()=>{
 const trendPoint={entryId:1,observedUtc:new Date().toISOString(),value:25,quality:'good',unit:'℃',receivedAt:new Date().toISOString(),configVersion:'c1',acquisitionRound:1,connectionSessionId:'s1'};
 store.getState().appendTrend('fixture/serial/PLC/T0',[trendPoint,trendPoint],true);store.getState().appendTrend('fixture/serial/PLC/T0',[trendPoint]);expect(store.getState().trendByPoint['fixture/serial/PLC/T0']).toHaveLength(1);
});
function fakeApi(){return {...experimentApi,create:vi.fn().mockResolvedValue(lease),release:vi.fn().mockResolvedValue(undefined),renew:vi.fn().mockResolvedValue(lease),latest:vi.fn().mockResolvedValue({online:true,lastHeartbeatAt:null,snapshots:[]}),trend:vi.fn().mockResolvedValue({points:[],nextCursor:null,hasMore:false})};}
it('挂载不自动观看；停止时清SSE/续期/租约，迟到租约会被释放',async()=>{
 vi.useFakeTimers();const api=fakeApi(),source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);expect(api.create).not.toHaveBeenCalled();await controller.start('same-monitor-page');expect(api.create).toHaveBeenCalledWith('fixture',['PLC'],expect.any(AbortSignal),'serial','same-monitor-page');await vi.advanceTimersByTimeAsync(15000);expect(api.renew).toHaveBeenCalledTimes(1);controller.stop('paused');expect(source.close).toHaveBeenCalled();await vi.advanceTimersByTimeAsync(60000);expect(api.renew).toHaveBeenCalledTimes(1);expect(store.getState().phase).toBe('paused');
 let resolve!:(value:typeof lease)=>void;api.create.mockReturnValue(new Promise(r=>{resolve=r;}));const started=controller.start();controller.stop();resolve(lease);await started;expect(api.release).toHaveBeenCalledWith(lease.viewerId);
});
it('释放未完成时快速切实测/模拟来源会先释放旧租约再创建新租约',async()=>{
 const api=fakeApi(),order:string[]=[];let finishRelease!:()=>void;
 api.create.mockImplementation(async(_id,_equipment,_signal,source)=>{order.push(`create:${source}`);return {...lease,viewerId:`viewer-${api.create.mock.calls.length}`};});
 api.release.mockImplementation(()=>{order.push('release-start');return new Promise<void>(resolve=>{finishRelease=()=>{order.push('release-done');resolve();};});});
 const source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);
 await controller.start('logical-page');controller.stop();await flushQueue();store.setState({source:'simulation'});const restart=controller.start('logical-page');await flushQueue();expect(api.create).toHaveBeenCalledTimes(1);finishRelease();await restart;
 expect(order).toEqual(['create:serial','release-start','release-done','create:simulation']);api.release.mockResolvedValue(undefined);controller.stop();
});
it('停止时create尚未返回的迟到租约先释放；正在队列等待的start可被取消',async()=>{
 const api=fakeApi(),order:string[]=[];let finishCreate!:(value:typeof lease)=>void;
 api.create.mockImplementationOnce(()=>{order.push('create-pending');return new Promise(resolve=>{finishCreate=resolve;});}).mockImplementation(async()=>{order.push('create-next');return lease;});
 api.release.mockImplementation(async(id)=>{order.push(`release:${id}`);});
 const source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);
 const first=controller.start('logical-page');await flushQueue();expect(api.create).toHaveBeenCalledTimes(1);controller.stop();const second=controller.start('logical-page');finishCreate({...lease,viewerId:'late-viewer'});await Promise.all([first,second]);
 expect(order).toEqual(['create-pending','release:late-viewer','create-next']);controller.stop();
});
it('DELETE网络请求卡住时等待有上限，后续实验租约仍可恢复',async()=>{
 const api=fakeApi();api.release.mockImplementation(()=>new Promise<void>(()=>{}));
 const source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source,20);
 await controller.start('bounded-release');controller.stop();const restart=controller.start('bounded-release');await restart;
 expect(api.create).toHaveBeenCalledTimes(2);api.release.mockResolvedValue(undefined);controller.stop();
});
it('过期观看以退避创建新租约；401清身份并取新的同源CSRF挑战',async()=>{
 vi.useFakeTimers();const api=fakeApi(),source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);api.renew.mockRejectedValue(new BmsApiError(410,'VIEWER_EXPIRED','观看过期'));await controller.start('page');await vi.advanceTimersByTimeAsync(15000);expect(store.getState().phase).toBe('reconnecting');await vi.advanceTimersByTimeAsync(1000);expect(api.create).toHaveBeenCalledTimes(2);expect(store.getState().phase).toBe('watching');controller.stop();
 const session=vi.spyOn(bmsApi,'session').mockResolvedValue(null);api.create.mockRejectedValue(new BmsApiError(401,'AUTH_REQUIRED','登录过期'));store.setState({identity:{username:'fixture',role:'viewer'}});await controller.start();expect(store.getState().identity).toBeNull();expect(session).toHaveBeenCalledOnce();
});
it('切换测点后迟到曲线不能覆盖当前选择',async()=>{
 const api=fakeApi(),source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);store.setState({lease,selection:'PLC/T0'});let resolve!:(value:{points:never[];nextCursor:null;hasMore:false})=>void;api.trend.mockReturnValueOnce(new Promise(r=>{resolve=r;}));const earlier=controller.refreshTrend();store.setState({selection:'PLC/T1'});await controller.refreshTrend();resolve({points:[],nextCursor:null,hasMore:false});await earlier;expect(store.getState().selection).toBe('PLC/T1');expect(api.trend).toHaveBeenLastCalledWith('fixture','PLC','T1','serial',null);controller.stop();
});
it('实验趋势完整读取全部游标页并按entryId保留观测',async()=>{
 const api=fakeApi(),now=new Date().toISOString();api.trend.mockImplementation(async(_device,equipmentId,pointId,_source,cursor)=>cursor
  ?{points:[{entryId:2,observedUtc:now,value:2,quality:'good',unit:'℃',receivedAt:now,configVersion:'c1',acquisitionRound:1,connectionSessionId:'s2'}],nextCursor:null,hasMore:false}
  :{points:[{entryId:1,observedUtc:now,value:1,quality:'good',unit:'℃',receivedAt:now,configVersion:'c1',acquisitionRound:1,connectionSessionId:'s1'}],nextCursor:'cursor-1',hasMore:true});
 const source={close:vi.fn(),addEventListener:vi.fn()} as unknown as EventSource,controller=new ExperimentRealtimeController(api,()=>source);await controller.start('page-history');
 expect(api.trend).toHaveBeenCalledWith('fixture','PLC','T0','serial','cursor-1');expect(store.getState().trendByPoint['fixture/serial/PLC/T0'].map(p=>p.entryId)).toEqual([1,2]);controller.stop();
});
it('实验配置说明使用独立路由，明确Endpoint、DPAPI及本地记录边界',()=>{
 const text=connectionInstructions({device:{deviceId:'fixture',module:'experiment',alias:'夹具',allowedEquipment:['PLC'],allowedPacks:[],online:false,lastHeartbeatAt:null},deviceToken:'disposable-token'},'https://example.test');expect(text).toContain('/api/experiment/heartbeat');expect(text).toContain('settings/cloud.txt');expect(text).toContain('DPAPI');expect(text).toContain('disposable-token');expect(text).toContain('网页登录密码不能作为上传令牌');
});
