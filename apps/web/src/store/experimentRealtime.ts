import { create } from 'zustand';
import type { BmsDevice, BmsIdentity, MonitoringCacheStatus, ViewerLease } from '../services/bmsRealtimeTypes';
import { experimentChannel, experimentTrendKey } from '../services/experimentRealtimeTypes';
import type { ExperimentPoint, ExperimentSample, ExperimentTrendPoint } from '../services/experimentRealtimeTypes';

interface ExperimentRealtime {
  identity: BmsIdentity | null; devices: BmsDevice[]; deviceId: string; lease: ViewerLease | null; phase: 'idle' | 'connecting' | 'watching' | 'reconnecting' | 'paused' | 'expired' | 'unauthorized'; error: string; websiteConnected: boolean;
  samples: Record<string, ExperimentSample>; lastGoodByPoint: Record<string, ExperimentPoint>; trend: ExperimentTrendPoint[]; trendByPoint: Record<string, ExperimentTrendPoint[]>; selection: string; cacheStatus: MonitoringCacheStatus | null; capacityWarning: boolean;
  accept: (sample: ExperimentSample) => void; appendTrend: (key: string, points: ExperimentTrendPoint[], replace?: boolean) => void; clearTrend: (key: string) => void; clearData: () => void; reset: () => void;
}
const initial = () => ({ identity: null, devices: [], deviceId: '', lease: null, phase: 'idle' as const, error: '', websiteConnected: false, samples: {}, lastGoodByPoint: {}, trend: [], trendByPoint: {}, selection: 'PLC/T0', cacheStatus: null, capacityWarning: false });
export const useExperimentRealtimeStore = create<ExperimentRealtime>((set, get) => ({
  ...initial(),
  accept(sample) {
    const current = get();
    if (sample.snapshot.deviceId !== current.deviceId) return;
    const snapshot = sample.snapshot, channel = experimentChannel(sample), previous = current.samples[channel];
    if (previous && previous.acceptedOrder >= sample.acceptedOrder) return;
    const floor = Date.now() - 60 * 60 * 1000;
    const samples = Object.fromEntries(Object.entries(current.samples).filter(([, value]) => Date.parse(value.receivedAt) >= floor && experimentChannel(value) !== channel));
    const lastGoodByPoint = Object.fromEntries(Object.entries(current.lastGoodByPoint).filter(([, point]) => Date.parse(point.observedUtc) >= floor));
    const points = snapshot.points.map(point => {
      const seen = { ...point, seenMono: performance.now() };
      if (point.quality === 'good') {
        const key = `${snapshot.source}/${snapshot.equipmentId}/${point.id}`, previousGood = lastGoodByPoint[key];
        if (!previousGood || Date.parse(point.observedUtc) > Date.parse(previousGood.observedUtc)) lastGoodByPoint[key] = seen;
      }
      return seen;
    });
    samples[channel] = { ...sample, snapshot: { ...snapshot, points } };
    set({ samples, lastGoodByPoint, devices: current.devices.map(device => device.deviceId === snapshot.deviceId ? { ...device, online: true } : device) });
  },
  appendTrend(key, points, replace = false) {
    set(state => {
      const floor = Date.now() - 60 * 60 * 1000, base = replace ? [] : state.trendByPoint[key] ?? [], seen = new Set(base.map(point => point.entryId));
      const added = points.filter(point => { if (seen.has(point.entryId) || Date.parse(point.observedUtc) < floor) return false; seen.add(point.entryId); return true; });
      const series = base.concat(added).filter(point => Date.parse(point.observedUtc) >= floor).sort((a, b) => a.entryId - b.entryId);
      const trend = key === experimentTrendKey(state.deviceId, state.selection) ? series : state.trend;
      return { trend, trendByPoint: { ...state.trendByPoint, [key]: series } };
    });
  },
  clearTrend(key) {
    set(state => { const trendByPoint = { ...state.trendByPoint }; delete trendByPoint[key]; return { trendByPoint, trend: key === experimentTrendKey(state.deviceId, state.selection) ? [] : state.trend }; });
  },
  clearData() { set({ samples: {}, lastGoodByPoint: {}, trend: [], trendByPoint: {}, capacityWarning: false }); },
  reset() { set(initial()); },
}));
