import { sourceTrendLines, latestByChannel } from './realtimeSource';
import contract from '../../shared/experiment/point-contract.json';
export const experimentCatalog = contract;
export const EXPERIMENT_EQUIPMENT = ['DS666','PLC','DDSU666','DJSF6682'];
export type ExperimentSource = 'serial' | 'simulation';
export type PointDefinition = typeof contract.points[number];
export interface ExperimentPoint {
  id:string;description:string;unit:string;value:number|null;rawValue:number|null;displayValue:string|null;quality:string;observedUtc:string;acquisitionRound:number;configVersion:string;addressZeroBased:number;registerCount:number;decodeMode:string;
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
  // ageMs 是采样年龄；短缓存淘汰依据本机接收后的缓存年龄，不可把旧的 good 观测改成无效。
  const receivedAt=Date.parse(p.receivedAt);
  const cacheAgeMs=Math.max(0,Number.isFinite(receivedAt)?Date.now()-receivedAt:0)+Math.max(0,mono-(p.seenMono??mono));
  const expired=cacheAgeMs>=3600000;
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
    time: point.observedUtc, value: point.quality === 'good' && normalizeExperimentUnit(point.unit, unit) === unit ? point.value : null,
    source: point.source, session: `${point.connectionSessionId}/${point.sourceSegment ?? 0}`,
  })));
}
/** 历史客户端曾把倍率提示拼入unit；只规范网页标签，原始上传值保持不变。 */
export function normalizeExperimentUnit(value:string|undefined, canonical:string){
  if(!value)return canonical;
  if(value===canonical || value.startsWith(`${canonical} · `))return canonical;
  return value;
}
const twoDecimalUnits=new Set(['V','A','W','var','VA','kW','kvar','kVA']);
/** 只格式化页面文字，调用方的工程值和原始报文保持不变。 */
export function formatExperimentDisplayValue(value:string|number|null|undefined,unit:string){
  if(value==null)return '—';
  if(!twoDecimalUnits.has(unit))return String(value);
  const numeric=typeof value==='number'?value:Number(value);
  return Number.isFinite(numeric)?numeric.toFixed(2):String(value);
}
export function experimentDimension(definition:PointDefinition){
  return definition.metadata.Unit ? `unit/${definition.metadata.Unit}` : `quantity/${definition.metadata.Label}`;
}
export const latestExperimentSamples = (samples: ExperimentSample[]) => latestByChannel(samples, sample => sample.snapshot.equipmentId);
/** 只按具体测点的原始观测时刻排序；不使用心跳或快照组装时间替代。 */
export function latestExperimentObservation(samples:ExperimentSample[]){
  let latest:{sample:ExperimentSample;point:ExperimentPoint}|undefined;
  for(const sample of samples)for(const point of sample.snapshot.points){
    if(!Number.isFinite(Date.parse(point.observedUtc)))continue;
    if(!latest||Date.parse(point.observedUtc)>Date.parse(latest.point.observedUtc))latest={sample,point};
  }
  return latest;
}
