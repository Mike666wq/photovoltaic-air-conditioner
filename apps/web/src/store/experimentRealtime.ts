import {create} from 'zustand';
import type {BmsDevice,BmsIdentity,MonitoringCacheStatus,ViewerLease} from '../services/bmsRealtimeTypes';
import {experimentChannel} from '../services/experimentRealtimeTypes';
import type {ExperimentPoint,ExperimentSample,ExperimentSource,ExperimentTrendPoint} from '../services/experimentRealtimeTypes';
interface ExperimentRealtime {
  identity:BmsIdentity|null;devices:BmsDevice[];deviceId:string;source:ExperimentSource;lease:ViewerLease|null;phase:'idle'|'connecting'|'watching'|'reconnecting'|'paused'|'expired'|'unauthorized';error:string;websiteConnected:boolean;samples:Record<string,ExperimentSample>;lastGoodByPoint:Record<string,ExperimentPoint>;trend:ExperimentTrendPoint[];trendByPoint:Record<string,ExperimentTrendPoint[]>;selection:string;session:string;cacheStatus:MonitoringCacheStatus|null;capacityWarning:boolean;
  accept:(sample:ExperimentSample)=>void;appendTrend:(key:string,points:ExperimentTrendPoint[],replace?:boolean)=>void;clearTrend:(key:string)=>void;clearData:()=>void;reset:()=>void;
}
export const experimentTrendKey=(deviceId:string,source:ExperimentSource,selection:string)=>`${deviceId}/${source}/${selection}`;
const initial=()=>({identity:null,devices:[],deviceId:'',source:'serial' as const,lease:null,phase:'idle' as const,error:'',websiteConnected:false,samples:{},lastGoodByPoint:{},trend:[],trendByPoint:{},selection:'PLC/T0',session:'',cacheStatus:null,capacityWarning:false});
export const useExperimentRealtimeStore=create<ExperimentRealtime>((set,get)=>({...initial(),
  accept(sample){
    const current=get();if(sample.snapshot.deviceId!==current.deviceId||sample.snapshot.source!==current.source)return;
    const s=sample.snapshot,channel=experimentChannel(sample),previous=current.samples[channel];
    if(current.session===s.connectionSessionId&&previous&&s.sequence<previous.snapshot.sequence)return;
    const samples=current.session!==s.connectionSessionId?{}:{...current.samples};
    const lastGoodByPoint={...current.lastGoodByPoint};
    const points=s.points.map(p=>{
      const seen={...p,seenMono:performance.now()};
      if(p.quality==='good'){
        const key=`${s.source}/${s.equipmentId}/${p.id}`,previousGood=lastGoodByPoint[key];
        if(!previousGood||Date.parse(p.observedUtc)>Date.parse(previousGood.observedUtc))lastGoodByPoint[key]=seen;
      }
      return seen;
    });
    samples[channel]={...sample,snapshot:{...s,points}};
    set({samples,lastGoodByPoint,session:s.connectionSessionId,devices:current.devices.map(d=>d.deviceId===s.deviceId?{...d,online:true}:d)});
  },
  appendTrend(key,points,replace=false){set(state=>{const floor=Date.now()-3600000,base=replace?[]:state.trendByPoint[key]??[],seen=new Set(base.map(p=>p.entryId)),added=points.filter(p=>{if(seen.has(p.entryId)||Date.parse(p.observedUtc)<floor)return false;seen.add(p.entryId);return true;});const series=base.concat(added).filter(p=>Date.parse(p.observedUtc)>=floor).sort((a,b)=>a.entryId-b.entryId);const trend=key===experimentTrendKey(state.deviceId,state.source,state.selection)?series:state.trend;return {trend,trendByPoint:{...state.trendByPoint,[key]:series}};});},
  clearTrend(key){set(state=>{const trendByPoint={...state.trendByPoint};delete trendByPoint[key];return {trendByPoint,trend:key===experimentTrendKey(state.deviceId,state.source,state.selection)?[]:state.trend};});},
  clearData(){set({samples:{},lastGoodByPoint:{},trend:[],trendByPoint:{},session:'',capacityWarning:false});},reset(){set(initial());},
}));
