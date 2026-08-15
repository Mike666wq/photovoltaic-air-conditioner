import { create } from 'zustand';
import type { SourceProfile } from '../data/sourceProfile';
import { prepareDataSource, type ProcessedSourceRow, type SourceQualityReport } from '../services/dataSourcePipeline';

export type DashboardView = 'realtime' | 'energy' | 'ratio';
export type EnergyGranularity = 'hour' | 'day';
export type AnalysisMode = 'union' | 'intersection' | 'single';
export type BatteryCurrentConvention = 'unknown' | 'positive-charge' | 'positive-discharge';

/**
 * 已由现场确认：BMS 正电流代表充电，负电流代表放电。
 * 保留 unknown / positive-discharge 仅用于兼容其他设备或人工复核，
 * 但新会话不再要求用户重复确认本项目的既定口径。
 */
export const DEFAULT_BATTERY_CURRENT_CONVENTION: BatteryCurrentConvention = 'positive-charge';

export interface AnalysisSource {
  id: string;
  sourceFile: string;
  format: 'csv' | 'xlsx' | 'pdf';
  headers: string[];
  rows: Array<Record<string, string>>;
  timeColumn?: string;
  importedAt: string;
  profile: SourceProfile;
  quality: SourceQualityReport;
  processedRows: ProcessedSourceRow[];
}

interface AnalysisState {
  sources: AnalysisSource[];
  activeView: DashboardView;
  granularity: EnergyGranularity;
  range: [number, number] | null;
  analysisMode: AnalysisMode;
  selectedSourceIds: string[];
  singleSourceId: string | null;
  batteryCurrentConvention: BatteryCurrentConvention;
  dashboardFullscreen: boolean;
  addSource: (source: Omit<AnalysisSource, 'id' | 'importedAt' | 'profile' | 'quality' | 'processedRows'>) => AnalysisSource;
  removeSource: (id: string) => void;
  clearSources: () => void;
  setActiveView: (view: DashboardView) => void;
  setGranularity: (value: EnergyGranularity) => void;
  setRange: (range: [number, number] | null) => void;
  setAnalysisMode: (mode: AnalysisMode) => void;
  toggleSourceSelection: (id: string) => void;
  setSingleSource: (id: string | null) => void;
  setBatteryCurrentConvention: (value: BatteryCurrentConvention) => void;
  toggleDashboardFullscreen: () => void;
}

function createId() {
  return `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasSeparateThermalAndBmsSources(sources: AnalysisSource[]): boolean {
  const thermalSources = sources.filter((source) => source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed');
  const bmsSources = sources.filter((source) => source.profile.kind === 'battery-bms' || source.profile.kind === 'mixed');
  return thermalSources.some((thermal) => bmsSources.some((bms) => bms.id !== thermal.id));
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  sources: [],
  activeView: 'realtime',
  granularity: 'hour',
  range: null,
  analysisMode: 'union',
  selectedSourceIds: [],
  singleSourceId: null,
  batteryCurrentConvention: DEFAULT_BATTERY_CURRENT_CONVENTION,
  dashboardFullscreen: false,
  addSource: (source) => {
    const id = createId();
    const prepared = prepareDataSource({
      id,
      filename: source.sourceFile,
      format: source.format,
      headers: source.headers,
      rows: source.rows,
      timeColumn: source.timeColumn,
    });
    const added: AnalysisSource = {
      ...source,
      id,
      headers: [...source.headers],
      rows: source.rows.map((row) => ({ ...row })),
      importedAt: new Date().toISOString(),
      profile: prepared.profile,
      quality: prepared.quality,
      processedRows: prepared.processedRows,
    };
    set((state) => {
      const sources = [...state.sources, added];
      // 仅在“首次形成双源组合”时自动切换。之后用户手动选择的并集/单源模式
      // 不会因继续导入其他来源而被覆盖。
      const shouldDefaultToIntersection = !hasSeparateThermalAndBmsSources(state.sources) && hasSeparateThermalAndBmsSources(sources);
      return {
        sources,
        selectedSourceIds: [...state.selectedSourceIds, added.id],
        singleSourceId: state.singleSourceId ?? added.id,
        analysisMode: shouldDefaultToIntersection ? 'intersection' : state.analysisMode,
      };
    });
    return added;
  },
  removeSource: (id) => set((state) => {
    const sources = state.sources.filter((source) => source.id !== id);
    return {
      sources,
      selectedSourceIds: state.selectedSourceIds.filter((sourceId) => sourceId !== id),
      singleSourceId: state.singleSourceId === id ? sources[0]?.id ?? null : state.singleSourceId,
    };
  }),
  clearSources: () => set({
    sources: [],
    range: null,
    analysisMode: 'union',
    selectedSourceIds: [],
    singleSourceId: null,
    batteryCurrentConvention: DEFAULT_BATTERY_CURRENT_CONVENTION,
  }),
  setActiveView: (activeView) => set({ activeView }),
  setGranularity: (granularity) => set({ granularity }),
  setRange: (range) => set({ range }),
  setAnalysisMode: (analysisMode) => set({ analysisMode }),
  toggleSourceSelection: (id) => set((state) => ({
    selectedSourceIds: state.selectedSourceIds.includes(id)
      ? state.selectedSourceIds.filter((sourceId) => sourceId !== id)
      : [...state.selectedSourceIds, id],
  })),
  setSingleSource: (singleSourceId) => set({ singleSourceId }),
  setBatteryCurrentConvention: (batteryCurrentConvention) => set({ batteryCurrentConvention }),
  toggleDashboardFullscreen: () => set((state) => ({ dashboardFullscreen: !state.dashboardFullscreen })),
}));
