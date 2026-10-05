import { sourceTrendLines, latestByChannel } from './realtimeSource';
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
export interface ExperimentSample {snapshot:ExperimentSnapshot;receivedAt:string;acceptedOrder:number}
export interface ExperimentTrendPoint {entryId:number;observedUtc:string;value:number|null;quality:string;unit:string;receivedAt:string;configVersion:string;acquisitionRound:number;connectionSessionId:string;source:ExperimentSource;sourceSegment?:number;equipmentId:string}
export const experimentTime=(time?:string|null)=>time&&Number.isFinite(Date.parse(time))?new Date(time).toLocaleString('zh-CN',{hour12:false}):'—';
const qualityLabels:Record<string,string>={good:'有效观测',timeout:'通信超时',protocol_exception:'协议异常',decode_error:'解码失败',error:'采集失败',unknown:'质量未知',stale:'旧数据'};
export function pointStatus(p:ExperimentPoint|undefined,mono=performance.now()) {
  if(!p)return {label:'未采集',value:'—',stale:false,good:false,expired:false,ageMs:null as number|null};
  const ageMs=Math.max(0,p.ageMs+Math.max(0,mono-(p.seenMono??mono)));
  const expired=ageMs>=3600000;
  const stale=p.quality==='stale';
  const good=p.quality==='good'&&!expired;
  return {label:expired?'短缓存已到期':qualityLabels[p.quality]??`未知质量：${p.quality}`,value:good?(p.value===null?(p.displayValue||'—'):String(p.value)):'—',stale,good,expired,ageMs};
}
export function experimentAgeLabel(p:ExperimentPoint|undefined,mono=performance.now()){
  if(!p)return '距采集时间未知';
  const seconds=Math.floor(pointStatus(p,mono).ageMs!/1000);
  if(seconds<60)return `距采集 ${seconds} 秒`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `距采集 ${minutes} 分钟`;
  return `距采集 ${Math.floor(minutes/60)} 小时`;
}
export function experimentChannel(sample:ExperimentSample){return `${sample.snapshot.source}/${sample.snapshot.equipmentId}`;}
export function experimentTrendKey(deviceId:string,selection:string){return `${deviceId}/${selection}`;}
export function buildExperimentTrendLines(title:string,unit:string,points:ExperimentTrendPoint[]){
  return sourceTrendLines(title, unit, points.map(point => ({
    time: point.observedUtc, value: point.quality === 'good' && point.unit === unit ? point.value : null,
    source: point.source, session: `${point.connectionSessionId}/${point.sourceSegment ?? 0}`,
  })));
}
export const latestExperimentSamples = (samples: ExperimentSample[]) => latestByChannel(samples, sample => sample.snapshot.equipmentId);
