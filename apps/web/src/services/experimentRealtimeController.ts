import {experimentApi} from './experimentRealtimeApi';
import {bmsApi,BmsApiError} from './bmsRealtimeApi';
import {experimentCatalog} from './experimentRealtimeTypes';
import {experimentTrendKey,useExperimentRealtimeStore as store} from '../store/experimentRealtime';
import type {ExperimentSample} from './experimentRealtimeTypes';
import type {ViewerLease} from './bmsRealtimeTypes';

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
  private generation=0;private events:EventSource|null=null;private timer:ReturnType<typeof setTimeout>|undefined;private retry:ReturnType<typeof setTimeout>|undefined;private abort:AbortController|null=null;private refreshTimer:ReturnType<typeof setTimeout>|undefined;private retryCount=0;private pageId?:string;private cursors=new Map<string,string|null>();private fetching=new Map<string,Promise<void>>();
  constructor(private api=experimentApi,private openEvents=(url:string)=>new EventSource(url),private releaseWaitMs=5500){}
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
      const created=await this.api.create(s.deviceId,allowedEquipment,abort.signal,s.source,pageId);
      if(g!==this.generation||abort.signal.aborted){await boundedRelease(()=>this.api.release(created.viewerId),this.releaseWaitMs);return null;}
      store.setState({lease:created,phase:'watching'});return created;
    });if(!lease||g!==this.generation)return;
      this.renew(lease,g);await this.bootstrap(g);if(g===this.generation)this.subscribe(lease,g);
    }catch(e){if(g===this.generation)this.fail(e);}
  }
  private fail(e:unknown){
    if(e instanceof BmsApiError&&[401,403].includes(e.status)){this.stop('unauthorized');if(e.status===401){store.setState({identity:null});void bmsApi.session().catch(()=>{});}store.setState({error:e.message});return;}
    this.scheduleReconnect(e);
  }
  private scheduleReconnect(error:unknown){
    this.generation++;const g=this.generation;this.cleanup('reconnecting');const delay=Math.min(30000,1000*2**Math.min(this.retryCount++,5));store.setState({error:error instanceof Error?error.message:'实验数据连接中断，正在重连'});this.retry=setTimeout(()=>{if(g===this.generation)void this.connect(g);},delay);
  }
  private renew(lease:ViewerLease,g:number){clearTimeout(this.timer);this.timer=setTimeout(async()=>{if(g!==this.generation)return;const s=store.getState(),d=s.devices.find(d=>d.deviceId===s.deviceId);try{const next=await this.api.renew(lease.viewerId,d?.allowedEquipment??[],s.source);if(g!==this.generation)return;store.setState({lease:next});this.renew(next,g);}catch(e){if(g===this.generation)this.fail(e);}},lease.renewAfterSeconds*1000);}
  async refreshTrend(replace=false){const s=store.getState();return this.refreshTrendSeries([s.selection],replace);}
  async refreshTrendSeries(selections:string[],replace=false){const g=this.generation;await Promise.all([...new Set(selections)].map(selection=>this.loadTrend(selection,g,replace)));}
  private async loadTrend(selection:string,g:number,replace:boolean){
    const s=store.getState();if(g!==this.generation||!s.lease)return;
    const key=experimentTrendKey(s.deviceId,s.source,selection),existing=this.fetching.get(key);if(existing){await existing;return;}
    const [equipmentId,pointId]=selection.split('/');if(!equipmentId||!pointId)return;
    const task=(async()=>{let cursor=replace?null:(this.cursors.get(key)??null);let first=true;
      do{const page=await this.api.trend(s.deviceId,equipmentId,pointId,s.source,cursor);if(g!==this.generation||key!==experimentTrendKey(store.getState().deviceId,store.getState().source,selection))return;
        store.getState().appendTrend(key,page.points,replace&&first);cursor=page.nextCursor;first=false;if(!page.hasMore)break;
      }while(true);
      if(cursor)this.cursors.set(key,cursor);else if(replace)this.cursors.delete(key);
    })().catch(error=>{if(g===this.generation)this.fail(error);}).finally(()=>{this.fetching.delete(key);});
    this.fetching.set(key,task);await task;
  }
  private async bootstrap(g:number){
    const s=store.getState(),latest=await this.api.latest(s.deviceId,s.source);if(g!==this.generation)return;
    store.setState({websiteConnected:true,devices:s.devices.map(d=>d.deviceId===s.deviceId?{...d,online:latest.online,lastHeartbeatAt:latest.lastHeartbeatAt}:d)});for(const sample of latest.snapshots)store.getState().accept(sample);
    const equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);
    const primary=experimentCatalog.points.filter(p=>(p.metadata.Group==='温度'||p.metadata.Group==='太阳能')&&equipment.has(p.equipmentId)).map(p=>`${p.equipmentId}/${p.id}`);
    await this.refreshTrendSeries([...primary,...(equipment.has(s.selection.split('/')[0])?[s.selection]:[])]);
  }
  private subscribe(lease:ViewerLease,g:number){
    this.events?.close();const source=store.getState().source;const events=this.openEvents(`/api/experiment/events?viewerId=${encodeURIComponent(lease.viewerId)}&source=${source}`);this.events=events;
    events.onopen=()=>{if(g===this.generation){this.retryCount=0;store.setState({phase:'watching',websiteConnected:true,error:''});}};
    events.addEventListener('snapshot',event=>{if(g!==this.generation)return;try{store.getState().accept(JSON.parse((event as MessageEvent).data) as ExperimentSample);if(!this.refreshTimer)this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;const s=store.getState(),equipment=new Set(s.devices.find(d=>d.deviceId===s.deviceId)?.allowedEquipment??[]);const primary=experimentCatalog.points.filter(p=>(p.metadata.Group==='温度'||p.metadata.Group==='太阳能')&&equipment.has(p.equipmentId)).map(p=>`${p.equipmentId}/${p.id}`);void this.refreshTrendSeries([...primary,...(equipment.has(s.selection.split('/')[0])?[s.selection]:[])]);},1200);}catch{this.fail(new Error('实验采样响应无效'));}});
    events.addEventListener('device-status',event=>{if(g!==this.generation)return;try{const d=JSON.parse((event as MessageEvent).data);if(d.viewing===false){this.fail(new BmsApiError(410,'VIEWER_EXPIRED','观看租约结束，正在重新连接'));return;}store.setState({devices:store.getState().devices.map(old=>old.deviceId===d.deviceId?{...old,online:d.online,lastHeartbeatAt:d.lastHeartbeatAt}:old)});}catch{this.fail(new Error('实验设备状态无效'));}});
    events.addEventListener('cache-status',event=>{if(g===this.generation){try{store.setState({cacheStatus:JSON.parse((event as MessageEvent).data)});}catch{}}});
    events.addEventListener('cache-capacity',event=>{if(g===this.generation){try{store.setState({cacheStatus:JSON.parse((event as MessageEvent).data),capacityWarning:true});}catch{}}});
    events.addEventListener('cache-cleared',()=>{if(g===this.generation){this.cursors.clear();store.getState().clearData();}});
    events.onerror=()=>{if(g===this.generation)this.scheduleReconnect(new Error('网站连接中断，正在重新申请观看租约'));};
  }
}
