import { create } from 'zustand';
import { sampleKey } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsIdentity, BmsMetric, BmsSample, TrendPoint, ViewerLease, MonitoringCacheStatus } from '../services/bmsRealtimeTypes';

export type ViewingPhase = 'idle' | 'connecting' | 'watching' | 'reconnecting' | 'expired' | 'paused' | 'unauthorized';
type Trends = Record<BmsMetric, TrendPoint[]>;
interface RealtimeStore {
  identity: BmsIdentity | null; devices: BmsDevice[]; deviceId: string; pack: number; channel: string;
  phase: ViewingPhase; lease: ViewerLease | null; samples: BmsSample[]; trends: Trends; source:'serial'|'simulation'; error: string; websiteConnected: boolean; cacheStatus:MonitoringCacheStatus|null; capacityWarning:boolean;
  accept: (sample: BmsSample) => void; appendTrend:(metric:BmsMetric,points:TrendPoint[],replace?:boolean)=>void; clearData: () => void; reset: () => void;
}
const emptyData = () => ({ samples: [] as BmsSample[], trends: { voltage: [], current: [], soc: [] } as Trends });
const initial = () => ({ identity: null, devices: [], deviceId: '', pack: 1, channel: '', source:'serial' as const, phase: 'idle' as ViewingPhase, lease: null, error: '', websiteConnected: false,cacheStatus:null,capacityWarning:false, ...emptyData() });
export const useBmsRealtimeStore = create<RealtimeStore>((set) => ({
  ...initial(),
  accept: (sample) => set((state) => {
    if (sample.snapshot.deviceId !== state.deviceId || sample.snapshot.pack !== state.pack || sample.snapshot.source !== state.source) return {};
    const key = sampleKey(sample.snapshot);
    const previous = state.samples.find((item) => sampleKey(item.snapshot) === key);
    if (previous?.snapshot.connectionSessionId === sample.snapshot.connectionSessionId && previous.snapshot.sequence >= sample.snapshot.sequence) return {};
    const otherSession = state.samples.some((item) => item.snapshot.connectionSessionId !== sample.snapshot.connectionSessionId);
    const samples = (otherSession ? [] : state.samples).filter((item) => sampleKey(item.snapshot) !== key).concat(sample);
    return { samples, channel: samples.some((item) => sampleKey(item.snapshot) === state.channel) ? state.channel : key };
  }),
  appendTrend:(metric,points,replace=false)=>set(state=>{
    const floor=Date.now()-3600000, base=replace?[]:state.trends[metric];
    const seen=new Set(base.map(p=>p.entryId));
    const added=points.filter(p=>{if(seen.has(p.entryId)||Date.parse(p.capturedUtc)<floor)return false;seen.add(p.entryId);return true;});
    const merged=base.concat(added).filter(p=>Date.parse(p.capturedUtc)>=floor).sort((a,b)=>a.entryId-b.entryId);
    return {trends:{...state.trends,[metric]:merged}};
  }),
  clearData: () => set({ ...emptyData(), channel: '', capacityWarning:false }),
  reset: () => set(initial()),
}));
