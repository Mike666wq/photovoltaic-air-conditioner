import {experimentApi} from './experimentRealtimeApi';
import {bmsApi,BmsApiError} from './bmsRealtimeApi';
import {experimentCatalog,experimentTrendKey} from './experimentRealtimeTypes';
import {useExperimentRealtimeStore as store} from '../store/experimentRealtime';
import type {ExperimentSample} from './experimentRealtimeTypes';
import type {ViewerLease} from './bmsRealtimeTypes';

const trendableSelections=new Set(experimentCatalog.points.filter(p=>p.metadata.Group!=='运行状态'&&p.metadata.Group!=='诊断').map(p=>`${p.equipmentId}/${p.id}`));
const historySelections=(selection:string)=>trendableSelections.has(selection)?[selection]:[];
const pageQueues = new WeakMap<object, Map<string, Promise<void>>>();
function pageQueue(api: object, pageId?: string) {
  let queues = pageQueues.get(api);
  if (!queues) { queues = new Map(); pageQueues.set(api, queues); }
  const key = pageId ?? 'legacy';
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = queues!.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      const tail = current.then(() => {}, () => {});
      queues!.set(key, tail);
      void tail.then(() => { if (queues!.get(key) === tail) queues!.delete(key); });
      return current;
    },
  };
}
async function boundedRelease(release: () => Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    release().then(() => true, () => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

/** 临时停止时保留一小时历史，SSE更新仅按游标拉取新增记录。 */
export class ExperimentRealtimeController {
  private generation=0;private events:EventSource|null=null;private timer:ReturnType<typeof setTimeout>|undefined;private retry:ReturnType<typeof setTimeout>|undefined;private abort:AbortController|null=null;private refreshTimer:ReturnType<typeof setTimeout>|undefined;private retryCount=0;private pageId?:string;private cursors=new Map<string,string|null>();private fetching=new Map<string,Promise<void>>();private permissionRevoked?:(deviceId:string)=>void;
  constructor(private api=experimentApi,private openEvents=(url:string)=>new EventSource(url),private releaseWaitMs=5500){}
  setPermissionRevokedHandler(handler?:(deviceId:string)=>void){this.permissionRevoked=handler;}
  stop(phase:'idle'|'paused'|'expired'|'unauthorized'='idle'){this.generation++;this.cleanup(phase);}
  private cleanup(phase:'idle'|'paused'|'expired'|'unauthorized'|'reconnecting'){
    this.abort?.abort();this.abort=null;clearTimeout(this.timer);clearTimeout(this.retry);clearTimeout(this.refreshTimer);this.events?.close();this.events=null;
    const lease=store.getState().lease;store.setState({phase,lease:null,websiteConnected:false});if(lease){const queue=pageQueue(this.api,this.pageId);void queue.run(()=>boundedRelease(()=>this.api.release(lease.viewerId),this.releaseWaitMs).then(()=>{}));}
  }
  async start(pageId?:string){this.stop();this.retryCount=0;this.pageId=pageId;await this.connect(this.generation);}
  private async connect(g:number){
    const s=store.getState(),device=s.devices.find(d=>d.deviceId===s.deviceId),allowedEquipment=device?.allowedEquipment;if(!allowedEquipment?.length)return;
    const abort=new AbortController();this.abort=abort;const pageId=this.pageId;store.setState({phase:'connecting',error:''});
    try{const lease=await pageQueue(this.api,pageId).run(async()=>{
      if(g!==this.generation||abort.signal.aborted)return null;
      const created=await this.api.create(s.deviceId,allowedEquipment,historySelections(s.selection),abort.signal,pageId);
      if(g!==this.generation||abort.signal.aborted){await boundedRelease(()=>this.api.release(created.viewerId),this.releaseWaitMs);return null;}
      store.setState({lease:created,phase:'watching'});return created;
    });if(!lease||g!==this.generation)return;
      this.renew(lease,g);await this.bootstrap(g);if(g===this.generation)this.subscribe(lease,g);
    }catch(e){if(g===this.generation)this.fail(e);}
  }
  private fail(e:unknown){
    if(e instanceof BmsApiError&&[401,403].includes(e.status)){this.stop('unauthorized');if(e.status===401){store.setState({identity:null});void bmsApi.session().catch(()=>{});}store.setState({error:e.message});if(e.status===403&&e.code==='DEVICE_FORBIDDEN')this.permissionRevoked?.(store.getState().deviceId);return;}
    this.scheduleReconnect(e);
  }
  private scheduleReconnect(error:unknown){
    if(this.retryCount>=8){this.stop('expired');store.setState({error:'自动重连已达8次，请检查网络后手动开始观测。'});return;}
    this.generation++;const g=this.generation;this.cleanup('reconnecting');const delay=Math.min(30000,1000*2**Math.min(this.retryCount++,5));store.setState({error:error instanceof Error?error.message:'实验数据连接中断，正在重连'});this.retry=setTimeout(()=>{if(g===this.generation)void this.connect(g);},delay);
  }
  private renew(lease:ViewerLease,g:number){clearTimeout(this.timer);this.timer=setTimeout(async()=>{if(g!==this.generation)return;const s=store.getState(),d=s.devices.find(d=>d.deviceId===s.deviceId),queue=pageQueue(this.api,this.pageId);try{const next=await queue.run(()=>this.api.renew(lease.viewerId,d?.allowedEquipment??[],historySelections(s.selection)));if(g!==this.generation)return;store.setState({lease:next});this.renew(next,g);}catch(e){if(g===this.generation)this.fail(e);}},lease.renewAfterSeconds*1000);}
  async updateHistorySelection(selection:string){const g=this.generation,s=store.getState(),lease=s.lease,d=s.devices.find(d=>d.deviceId===s.deviceId),allowedEquipment=d?.allowedEquipment;if(!lease||!allowedEquipment?.length)return;try{const next=await pageQueue(this.api,this.pageId).run(()=>this.api.renew(lease.viewerId,allowedEquipment,historySelections(selection)));if(g!==this.generation||store.getState().selection!==selection)return;store.setState({lease:next});this.renew(next,g);}catch(e){if(g===this.generation)this.fail(e);}}
  async refreshTrend(replace=false){const s=store.getState();return this.refreshTrendSeries([s.selection],replace);}
  async refreshTrendSeries(selections:string[],replace=false){const g=this.generation;await Promise.all([...new Set(selections)].map(selection=>this.loadTrend(selection,g,replace)));}
  private async loadTrend(selection:string,g:number,replace:boolean){
    const s=store.getState();if(g!==this.generation||!s.lease||!trendableSelections.has(selection))return;
    const key=experimentTrendKey(s.deviceId,selection),requestKey=`${g}/${key}`,existing=this.fetching.get(requestKey);if(existing){await existing;return;}
    const [equipmentId,pointId]=selection.split('/');if(!equipmentId||!pointId)return;
    const task=(async()=>{let cursor=replace?null:(this.cursors.get(key)??null);let first=true;
      do{const page=await this.api.trend(s.deviceId,equipmentId,pointId,cursor);if(g!==this.generation||key!==experimentTrendKey(store.getState().deviceId,selection))return;
        store.getState().appendTrend(key,page.points,replace&&first);cursor=page.nextCursor;first=false;if(!page.hasMore)break;
      }while(true);
      if(cursor)this.cursors.set(key,cursor);else if(replace)this.cursors.delete(key);
    })().catch(error=>{if(g===this.generation)this.fail(error);}).finally(()=>{this.fetching.delete(requestKey);});
    this.fetching.set(requestKey,task);await task;
  }
  private async bootstrap(g:number){
    const s=store.getState(),latest=await this.api.latest(s.deviceId);if(g!==this.generation)return;
    store.setState({websiteConnected:true,devices:s.devices.map(d=>d.deviceId===s.deviceId?{...d,online:latest.online,lastHeartbeatAt:latest.lastHeartbeatAt}:d)});for(const sample of latest.snapshots)store.getState().accept(sample);
    const equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);
    if(equipment.has(s.selection.split('/')[0])) await this.refreshTrendSeries([s.selection]);
  }
  private subscribe(lease:ViewerLease,g:number){
    this.events?.close();const events=this.openEvents(`/api/experiment/events?viewerId=${encodeURIComponent(lease.viewerId)}`);this.events=events;
    events.onopen=()=>{if(g!==this.generation)return;this.retryCount=0;store.setState({phase:'watching',websiteConnected:true,error:''});const s=store.getState(),equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);if(equipment.has(s.selection.split('/')[0]))void this.refreshTrendSeries([s.selection]);};
    events.addEventListener('snapshot',event=>{if(g!==this.generation)return;try{store.getState().accept(JSON.parse((event as MessageEvent).data) as ExperimentSample);if(!this.refreshTimer)this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;const s=store.getState(),equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);if(equipment.has(s.selection.split('/')[0]))void this.refreshTrendSeries([s.selection]);},1200);}catch{this.fail(new Error('实验采样响应无效'));}});
    events.addEventListener('trend-backfill',()=>{if(g!==this.generation)return;const s=store.getState(),equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);if(equipment.has(s.selection.split('/')[0]))void this.refreshTrendSeries([s.selection]);});
    events.addEventListener('device-status',event=>{if(g!==this.generation)return;try{const d=JSON.parse((event as MessageEvent).data);if(d.viewing===false){this.fail(new BmsApiError(410,'VIEWER_EXPIRED','观看租约结束，正在重新连接'));return;}store.setState({devices:store.getState().devices.map(old=>old.deviceId===d.deviceId?{...old,online:d.online,lastHeartbeatAt:d.lastHeartbeatAt}:old)});}catch{this.fail(new Error('实验设备状态无效'));}});
    events.addEventListener('permission-revoked',event=>{if(g!==this.generation)return;try{const data=JSON.parse((event as MessageEvent).data) as {deviceId?:string},deviceId=store.getState().deviceId;if(!deviceId||data.deviceId!==deviceId)return;this.stop('unauthorized');store.setState({error:'管理员已撤销此设备的观测权限。'});this.permissionRevoked?.(deviceId);}catch{this.fail(new Error('权限变更通知无效'));}});
    events.addEventListener('cache-status',event=>{if(g===this.generation){try{store.setState({cacheStatus:JSON.parse((event as MessageEvent).data)});}catch{}}});
    events.addEventListener('cache-capacity',event=>{if(g===this.generation){try{store.setState({cacheStatus:JSON.parse((event as MessageEvent).data),capacityWarning:true});}catch{}}});
    events.addEventListener('cache-cleared',()=>{if(g===this.generation){this.cursors.clear();store.getState().clearData();}});
    events.onerror=()=>{if(g===this.generation)this.scheduleReconnect(new Error('网站连接中断，正在重新申请观看租约'));};
  }
}
