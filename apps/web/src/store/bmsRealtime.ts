import { create } from 'zustand';
import { bmsChannelKey, sampleKey } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsIdentity, BmsMetric, BmsSample, TrendPoint, ViewerLease, MonitoringCacheStatus } from '../services/bmsRealtimeTypes';

export type ViewingPhase = 'idle' | 'connecting' | 'watching' | 'reconnecting' | 'expired' | 'paused' | 'unauthorized';
export type Trends = Record<BmsMetric, TrendPoint[]>;
interface RealtimeStore {
  identity: BmsIdentity | null; devices: BmsDevice[]; deviceId: string; pack: number; channel: string;
  phase: ViewingPhase; lease: ViewerLease | null; samples: BmsSample[]; trends: Record<number, Trends>; error: string; websiteConnected: boolean; cacheStatus: MonitoringCacheStatus | null; capacityWarning: boolean;
  accept: (sample: BmsSample) => void; appendTrend: (pack: number, metric: BmsMetric, points: TrendPoint[], replace?: boolean) => void; clearData: () => void; reset: () => void;
}
const emptyTrends = (): Trends => ({ voltage: [], current: [], soc: [] });
const initial = () => ({ identity: null, devices: [], deviceId: '', pack: 1, channel: '', phase: 'idle' as ViewingPhase, lease: null, error: '', websiteConnected: false, cacheStatus: null, capacityWarning: false, samples: [] as BmsSample[], trends: {} as Record<number, Trends> });

export const useBmsRealtimeStore = create<RealtimeStore>((set) => ({
  ...initial(),
  accept: (sample) => set((state) => {
    if (sample.snapshot.deviceId !== state.deviceId) return {};
    const key = sampleKey(sample.snapshot);
    const previous = state.samples.find(item => sampleKey(item.snapshot) === key);
    if (previous && previous.acceptedOrder >= sample.acceptedOrder) return {};
    const floor = Date.now() - 60 * 60 * 1000;
    const samples = state.samples.filter(item => Date.parse(item.receivedAt) >= floor && sampleKey(item.snapshot) !== key).concat(sample);
    const currentPackHasChannel = state.channel && samples.some(item => item.snapshot.pack === state.pack && bmsChannelKey(item.snapshot) === state.channel);
    const channel = currentPackHasChannel || sample.snapshot.pack !== state.pack ? state.channel : bmsChannelKey(sample.snapshot);
    return { samples, channel };
  }),
  appendTrend: (pack, metric, points, replace = false) => set(state => {
    const floor = Date.now() - 60 * 60 * 1000;
    const current = state.trends[pack] ?? emptyTrends();
    const base = replace ? [] : current[metric];
    const seen = new Set(base.map(point => point.entryId));
    const added = points.filter(point => {
      if (seen.has(point.entryId) || Date.parse(point.capturedUtc) < floor) return false;
      seen.add(point.entryId); return true;
    });
    const merged = base.concat(added).filter(point => Date.parse(point.capturedUtc) >= floor).sort((a, b) => a.entryId - b.entryId);
    return { trends: { ...state.trends, [pack]: { ...current, [metric]: merged } } };
  }),
  clearData: () => set({ samples: [], trends: {}, channel: '', capacityWarning: false }),
  reset: () => set(initial()),
}));
