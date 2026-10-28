export type ExperimentMeasurementState='no-authorized-points'|'no-observations'|'all-invalid'|'partial'|'all-valid';
export function experimentMeasurementStatus(total:number,observed:number,valid:number):{kind:ExperimentMeasurementState;label:string}{
  if(total<=0)return {kind:'no-authorized-points',label:'没有授权测点'};
  if(observed<=0)return {kind:'no-observations',label:'当前没有测点观测'};
  if(valid<=0)return {kind:'all-invalid',label:'已观测测点均无有效值'};
  if(valid>=total)return {kind:'all-valid',label:'全部授权测点质量有效'};
  return {kind:'partial',label:'部分测点异常或尚未采集'};
}
