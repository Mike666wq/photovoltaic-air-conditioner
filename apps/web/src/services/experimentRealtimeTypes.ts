import contract from '../../shared/experiment/point-contract.json';
export const experimentCatalog = contract;
export const EXPERIMENT_EQUIPMENT = ['DS666','PLC','DDSU666','DJSF6682'];
export type ExperimentSource = 'serial' | 'simulation';
export type PointDefinition = typeof contract.points[number];
export interface ExperimentPoint {
  id:string;description:string;unit:string;value:number|null;rawValue:number|null;displayValue:string;quality:string;observedUtc:string;acquisitionRound:number;configVersion:string;addressZeroBased:number;registerCount:number;decodeMode:string;
  receivedAt:string;ageMs:number;seenMono?:number;
}
export interface ExperimentSnapshot {schemaVersion:1;module:'experiment';deviceId:string;connectionSessionId:string;acquisitionSessionId:string;sequence:number;capturedUtc:string;source:ExperimentSource;equipmentId:string;slave:number;points:ExperimentPoint[]}
export interface ExperimentSample {snapshot:ExperimentSnapshot;receivedAt:string}
export interface ExperimentTrendPoint {entryId:number;observedUtc:string;value:number|null;quality:string;unit:string;receivedAt:string;configVersion:string;acquisitionRound:number;connectionSessionId:string;source?:ExperimentSource}
export const experimentTime=(time?:string|null)=>time&&Number.isFinite(Date.parse(time))?new Date(time).toLocaleString('zh-CN',{hour12:false}):'—';
const qualityLabels:Record<string,string>={good:'有效观测',timeout:'通信超时',protocol_exception:'协议异常',decode_error:'解码失败',error:'采集失败',unknown:'质量未知',stale:'旧数据'};
export function pointStatus(p:ExperimentPoint|undefined,mono=performance.now()) {
  if(!p)return {label:'未采集',value:'—',stale:false,good:false};
  const age=p.ageMs+Math.max(0,mono-(p.seenMono??mono));
  const stale=p.quality==='stale'||age>=30000;
  const good=p.quality==='good'&&!stale;
  return {label:stale?'旧数据 · 已过期':qualityLabels[p.quality]??`未知质量：${p.quality}`,value:good?(p.value===null?(p.displayValue||'—'):String(p.value)):'—',stale,good};
}
export function experimentChannel(sample:ExperimentSample){return `${sample.snapshot.source}/${sample.snapshot.equipmentId}`;}
