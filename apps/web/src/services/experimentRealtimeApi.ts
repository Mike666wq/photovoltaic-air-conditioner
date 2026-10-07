import {request} from './bmsRealtimeApi';
import type {TrendPage} from './bmsRealtimeApi';
import type {BmsDevice,ViewerLease} from './bmsRealtimeTypes';
import type {ExperimentSample,ExperimentSource,ExperimentTrendPoint} from './experimentRealtimeTypes';
const call=<T,>(path:string,method='GET',body?:unknown,signal?:AbortSignal,keepalive=false)=>request<T>(path,method,body,signal,keepalive);
// 共用同源会话与CSRF实现；请求路径扩展由统一request的绝对模块路径处理。
export const experimentApi={
  devices:()=>call<{devices:BmsDevice[]}>('/experiment/devices'),
  create:(deviceId:string,equipmentIds:string[],historySelections:string[],signal?:AbortSignal,pageId?:string)=>call<ViewerLease>('/experiment/viewers','POST',{deviceId,equipmentIds,historySelections,...(pageId?{pageId}:{})},signal),
  renew:(id:string,equipmentIds:string[],historySelections:string[])=>call<ViewerLease>(`/experiment/viewers/${encodeURIComponent(id)}`,'PUT',{equipmentIds,historySelections}),
  release:(id:string)=>call<void>(`/experiment/viewers/${encodeURIComponent(id)}`,'DELETE',undefined,undefined,true),
  latest:(id:string)=>call<{online:boolean;lastHeartbeatAt:string|null;snapshots:ExperimentSample[]}>(`/experiment/devices/${encodeURIComponent(id)}/latest`),
  trend:(id:string,equipmentId:string,pointId:string,cursor?:string|null)=>call<TrendPage<ExperimentTrendPoint>>(`/experiment/devices/${encodeURIComponent(id)}/trend?equipmentId=${encodeURIComponent(equipmentId)}&pointId=${encodeURIComponent(pointId)}&limit=2000${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`),
  clear:(id:string)=>call<void>(`/experiment/devices/${encodeURIComponent(id)}/cache`,'DELETE'),
};
