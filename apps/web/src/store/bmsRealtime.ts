import { create } from 'zustand';
import { BMS_METRICS, metricValue, sampleKey } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsIdentity, BmsMetric, BmsSample, TrendPoint, ViewerLease } from '../services/bmsRealtimeTypes';

export type ViewingPhase = 'idle' | 'connecting' | 'watching' | 'reconnecting' | 'expired' | 'paused' | 'unauthorized';
type Trends = Record<BmsMetric, TrendPoint[]>;
interface RealtimeStore {
  identity: BmsIdentity | null; devices: BmsDevice[]; deviceId: string; pack: number; channel: string;
  phase: ViewingPhase; lease: ViewerLease | null; samples: BmsSample[]; trends: Trends; error: string; websiteConnected: boolean;
  accept: (sample: BmsSample) => void; clearData: () => void; reset: () => void;
}
const emptyData = () => ({ samples: [] as BmsSample[], trends: { voltage: [], current: [], soc: [] } as Trends });
const initial = () => ({ identity: null, devices: [], deviceId: '', pack: 1, channel: '', phase: 'idle' as ViewingPhase, lease: null, error: '', websiteConnected: false, ...emptyData() });
export const useBmsRealtimeStore = create<RealtimeStore>((set) => ({
  ...initial(),
  accept: (sample) => set((state) => {
    if (sample.snapshot.deviceId !== state.deviceId || sample.snapshot.pack !== state.pack) return {};
    const key = sampleKey(sample.snapshot);
    const previous = state.samples.find((item) => sampleKey(item.snapshot) === key);
    if (previous?.snapshot.connectionSessionId === sample.snapshot.connectionSessionId && previous.snapshot.sequence >= sample.snapshot.sequence) return {};
    const otherSession = state.samples.some((item) => item.snapshot.connectionSessionId !== sample.snapshot.connectionSessionId);
    const samples = (otherSession ? [] : state.samples).filter((item) => sampleKey(item.snapshot) !== key).concat(sample);
    const trends = { ...state.trends };
    for (const metric of BMS_METRICS) {
      const points = otherSession ? [] : trends[metric];
      const point = { capturedUtc: sample.snapshot.capturedUtc, receivedAt: sample.receivedAt, sequence: sample.snapshot.sequence, connectionSessionId: sample.snapshot.connectionSessionId, source: sample.snapshot.source, address: sample.snapshot.address, value: metricValue(sample.snapshot, metric) };
      trends[metric] = points.filter((p) => Date.parse(p.receivedAt) > Date.parse(sample.receivedAt) - 600000 && !(p.connectionSessionId === point.connectionSessionId && p.sequence === point.sequence && p.address === point.address && p.source === point.source)).concat(point).slice(-600);
    }
    return { samples, trends, channel: samples.some((item) => sampleKey(item.snapshot) === state.channel) ? state.channel : key };
  }),
  clearData: () => set({ ...emptyData(), channel: '' }),
  reset: () => set(initial()),
}));
