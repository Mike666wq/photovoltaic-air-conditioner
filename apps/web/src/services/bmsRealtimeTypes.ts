import { latestByChannel } from './realtimeSource';
export interface BmsSnapshot {
  schemaVersion: 1;
  deviceId: string;
  connectionSessionId: string;
  sequence: number;
  acquisitionRound: number;
  periodSeconds?: number | null;
  capturedUtc: string;
  source: 'serial' | 'simulation';
  address: number;
  pack: number;
  voltageCentivolts: number;
  currentCentiamps: number;
  socPercent: number;
  sohPercent: number;
  remainingCentiAh: number;
  totalCentiAh: number;
  cycles: number;
  humidityPercent: number;
  cellsMillivolts: number[];
  temperaturesCelsius: number[];
  alarmObservationAvailable: boolean;
  alarmObservation: { observedUtc: string; acquisitionRound: number; pack: number; payloadHex: string } | null;
}
export interface BmsSample { snapshot: BmsSnapshot; receivedAt: string; stale: boolean; acceptedOrder: number }
export interface BmsDevice { module?: 'bms' | 'experiment'; allowedEquipment?: string[]; deviceId: string; alias: string; allowedPacks: number[]; allowedAddresses?: number[]; allowSimulation?: boolean; online: boolean; lastHeartbeatAt: string | null }
export interface BmsSetupStatus { enabled: boolean; initialized: boolean; writable: boolean; bootstrapAvailable: boolean; serviceRoot: string | null }
export interface BmsRegisteredUser { username: string; role: 'viewer' | 'admin'; devices: string[]; effectiveDeviceIds?: string[]; monitoringAccess?: boolean; disabled?: boolean }
export interface MonitoringSystemConfig { name: string; experimentDeviceId: string | null; bmsDeviceId: string | null; allowSimulation: boolean }
export interface MonitoringSystemAdmin { writable: boolean; system: MonitoringSystemConfig }
export interface MonitoringSystemView { name: string; allowSimulation: boolean; experimentDevice: BmsDevice | null; bmsDevice: BmsDevice | null }
export interface MonitoringCacheStatus { usedPoints: number; maxPoints: number; estimatedBytes: number; maxEstimatedBytes: number; pointBudgetBytes: number; retentionSeconds: number }
export interface BmsRegistry { writable: boolean; devices: BmsDevice[]; users: BmsRegisteredUser[] }
export interface BmsDeviceCredential { device: BmsDevice; deviceToken: string }
export interface BmsIdentity { username: string; role: 'viewer' | 'admin'; monitoringAccess?: boolean; effectiveDeviceIds?: string[] }
export interface ViewerLease { viewerId: string; expiresAt: string; renewAfterSeconds: number }
export interface TrendPoint { entryId:number; capturedUtc: string; receivedAt: string; sequence: number; connectionSessionId: string; value: number; source: BmsSnapshot['source']; address: number }
export type BmsMetric = 'voltage' | 'current' | 'soc';
export const BMS_METRICS: BmsMetric[] = ['voltage', 'current', 'soc'];
export const BMS_TIME_ZONE = 'Asia/Shanghai';
export function bmsTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: BMS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
export const bmsNumber = (value: number | null | undefined, divisor = 1, digits = 2) => value == null || !Number.isFinite(value) ? '—' : (value / divisor).toFixed(digits);
export const sampleKey = (s: BmsSnapshot) => `${s.source}/${s.address}/${s.pack}`;
export const bmsChannelKey = (s: BmsSnapshot) => `${s.address}/${s.pack}`;
export const sampleExpired = (item: BmsSample, now = Date.now()) => now - Date.parse(item.snapshot.capturedUtc) >= 3600000;
export function sampleStale(item: BmsSample, now = Date.now()) {
  return item.stale || now - Date.parse(item.receivedAt) >= Math.min(600000, Math.max(15000, (item.snapshot.periodSeconds ?? 15) * 3000));
}
export function clockSkew(s: BmsSample) { return Math.abs(Date.parse(s.snapshot.capturedUtc) - Date.parse(s.receivedAt)) > 60000; }
export function metricValue(s: BmsSnapshot, metric: BmsMetric) { return metric === 'voltage' ? s.voltageCentivolts / 100 : metric === 'current' ? s.currentCentiamps / 100 : s.socPercent; }

export const latestBmsSamples = (samples: BmsSample[]) => latestByChannel(samples, sample => bmsChannelKey(sample.snapshot));
