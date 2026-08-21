import { create } from 'zustand';
import type { SourceProfile } from '../data/sourceProfile';
import {
  prepareDataSource,
  type PreparedDataSource,
  type ProcessedSourceRow,
  type SourceQualityReport,
} from '../services/dataSourcePipeline';

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
  /** 解析、字段识别和质量检测的共享结果；分析页与原理图不得重复计算。 */
  prepared: PreparedDataSource;
}

type NewAnalysisSource = Omit<
  AnalysisSource,
  'id' | 'importedAt' | 'profile' | 'quality' | 'processedRows' | 'prepared'
>;

interface AnalysisState {
  sources: AnalysisSource[];
  activeView: DashboardView;
  granularity: EnergyGranularity;
  range: [number, number] | null;
  analysisMode: AnalysisMode;
  /** 用户是否主动选择过分析模式；导入完成后不得覆盖其选择。 */
  analysisModeTouched: boolean;
  selectedSourceIds: string[];
  singleSourceId: string | null;
  batteryCurrentConvention: BatteryCurrentConvention;
  dashboardFullscreen: boolean;
  addSource: (source: NewAnalysisSource) => AnalysisSource;
  /** 批量提交已经整理好的来源，只触发一次状态更新。 */
  addPreparedSources: (sources: PreparedDataSource[]) => AnalysisSource[];
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

function toAnalysisSource(prepared: PreparedDataSource, importedAt = new Date().toISOString()): AnalysisSource {
  return {
    id: prepared.id,
    sourceFile: prepared.filename,
    format: prepared.format,
    headers: prepared.headers,
    rows: prepared.rows,
    timeColumn: prepared.timeStats.timeColumn,
    importedAt,
    profile: prepared.profile,
    quality: prepared.quality,
    processedRows: prepared.processedRows,
    prepared,
  };
}

function appendSources(state: AnalysisState, added: AnalysisSource[]): Partial<AnalysisState> {
  if (!added.length) return {};
  const addedIds = new Set(added.map((source) => source.id));
  // 同一文件（稳定 source id）再次导入时更新它，不把相同万级数据重复堆入内存。
  const sources = [...state.sources.filter((source) => !addedIds.has(source.id)), ...added];
  // 仅在“首次形成双源组合”时自动切换。之后用户手动选择的并集/单源模式
  // 不会因继续导入其他来源而被覆盖。
  const shouldDefaultToIntersection = !state.analysisModeTouched
    && !hasSeparateThermalAndBmsSources(state.sources)
    && hasSeparateThermalAndBmsSources(sources);
  return {
    sources,
    selectedSourceIds: [...new Set([...state.selectedSourceIds, ...added.map((source) => source.id)])],
    singleSourceId: state.singleSourceId ?? added[0].id,
    analysisMode: shouldDefaultToIntersection ? 'intersection' : state.analysisMode,
  };
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  sources: [],
  activeView: 'realtime',
  granularity: 'hour',
  range: null,
  analysisMode: 'union',
  analysisModeTouched: false,
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
    const added = toAnalysisSource(prepared);
    set((state) => appendSources(state, [added]));
    return added;
  },
  addPreparedSources: (preparedSources) => {
    const importedAt = new Date().toISOString();
    const added = preparedSources.map((prepared) => toAnalysisSource(prepared, importedAt));
    set((state) => appendSources(state, added));
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
    analysisModeTouched: false,
    selectedSourceIds: [],
    singleSourceId: null,
    batteryCurrentConvention: DEFAULT_BATTERY_CURRENT_CONVENTION,
  }),
  setActiveView: (activeView) => set({ activeView }),
  setGranularity: (granularity) => set({ granularity }),
  setRange: (range) => set({ range }),
  setAnalysisMode: (analysisMode) => set({ analysisMode, analysisModeTouched: true }),
  toggleSourceSelection: (id) => set((state) => ({
    selectedSourceIds: state.selectedSourceIds.includes(id)
      ? state.selectedSourceIds.filter((sourceId) => sourceId !== id)
      : [...state.selectedSourceIds, id],
  })),
  setSingleSource: (singleSourceId) => set({ singleSourceId }),
  setBatteryCurrentConvention: (batteryCurrentConvention) => set({ batteryCurrentConvention }),
  toggleDashboardFullscreen: () => set((state) => ({ dashboardFullscreen: !state.dashboardFullscreen })),
}));
