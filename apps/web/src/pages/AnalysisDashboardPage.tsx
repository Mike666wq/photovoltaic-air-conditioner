import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import { prepareFileForImport, type ImportPreparationStage } from '../services/preparedImport';
import type { PreparedDataSource } from '../services/dataSourcePipeline';
import {
  aggregateEnergy,
  aggregateLastSeriesValue,
  aggregatePowerEnergy,
  aggregateSignedPowerEnergy,
  buildAnalysisPoints,
  buildSeries,
  downsampleSeriesForChart,
  filterPoints,
  getCurrentValue,
  getDerivedSeries,
  indexAnalysisPointsBySource,
  sumBuckets,
  type AnalysisPoint,
  type SeriesPoint,
} from '../services/analysisSeries';
import { buildPlaybackSession } from '../services/playbackSession';
import { useAnalysisStore, type AnalysisSource } from '../store/analysis';
import { useSimStore } from '../store/simulation';
import { applyTimelineFrame } from '../components/TimelineControls';
import { EChart } from '../components/dashboard/EChart';
import { ChartPanel } from '../components/dashboard/ChartPanel';
import { MetricCard } from '../components/dashboard/MetricCard';
import '../analysis-dashboard.css';

type DashboardLineType = 'solid' | 'dashed' | 'dotted';

interface DashboardLineStyle {
  color: string;
  type: DashboardLineType;
  width: number;
  symbol: 'circle' | 'rect' | 'roundRect' | 'triangle' | 'diamond';
}

/**
 * 实时曲线使用“颜色 + 线型 + 图例符号”三重编码。
 * 电压、电流和 SOC 不再依赖同一色系的深浅差异，便于深色背景及色觉差异用户识别。
 */
const LINE_STYLES: Record<string, DashboardLineStyle> = {
  tank_temp: { color: '#ec4899', type: 'dashed', width: 2, symbol: 'diamond' },
  supply_water_temp: { color: '#3b82f6', type: 'solid', width: 2, symbol: 'circle' },
  return_water_temp: { color: '#f97316', type: 'dashed', width: 2, symbol: 'rect' },
  outlet_temp: { color: '#a855f7', type: 'dotted', width: 2, symbol: 'triangle' },
  pv_voltage: { color: '#38bdf8', type: 'solid', width: 2, symbol: 'circle' },
  pv_current: { color: '#f59e0b', type: 'dashed', width: 2, symbol: 'diamond' },
  system_voltage: { color: '#8b5cf6', type: 'solid', width: 2, symbol: 'circle' },
  system_current: { color: '#f43f5e', type: 'solid', width: 2, symbol: 'triangle' },
  grid_voltage: { color: '#06b6d4', type: 'dashed', width: 2, symbol: 'rect' },
  grid_current: { color: '#fb923c', type: 'dashed', width: 2, symbol: 'diamond' },
  battery_soc: { color: '#22c55e', type: 'solid', width: 3, symbol: 'circle' },
  battery_voltage: { color: '#a78bfa', type: 'dashed', width: 2, symbol: 'rect' },
  battery_current: { color: '#f59e0b', type: 'dotted', width: 2, symbol: 'triangle' },
};

/**
 * 统计图固定使用业务语义色，同一种能源在指标卡、柱图和环图中保持一致。
 * 颜色横跨黄、蓝、紫、绿、红、橙、青和中性灰，避免只靠相近色阶区分类别。
 */
const ENERGY_COLORS = {
  system: '#c084fc',
  photovoltaic: '#facc15',
  grid: '#38bdf8',
  battery: '#22c55e',
  charge: '#2dd4bf',
  discharge: '#fb7185',
  cooling: '#22d3ee',
  heatPump: '#fb923c',
  reference: '#64748b',
} as const;

function valueText(value: number | null, digits = 1) {
  return value == null ? '—' : value.toFixed(digits);
}

function contrastTextColor(hex: string) {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return '#f8fafc';
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#071b2e' : '#f8fafc';
}

const SYNC_TOLERANCE_MS = 2_000;

function isRowUsable(row: Record<string, string>): boolean {
  const marker = row.__valid ?? row._valid ?? row.valid ?? row.__quality;
  return marker == null || !/^(false|invalid|schema_misaligned|rejected)$/i.test(String(marker).trim());
}

function formatTimeRange(range: [number, number] | null) {
  if (!range) return '无有效时间';
  const format = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
  return `${format(range[0])} ～ ${format(range[1])}`;
}

function hasPointValue(point: { values: Record<string, number> }, fieldKey: string) {
  return Number.isFinite(point.values[fieldKey]);
}

function seriesWithGaps(data: SeriesPoint[]): Array<[number, number | null]> {
  if (data.length < 2) return data.map((point) => [point.timestamp, point.value]);
  const ordered = [...data].sort((a, b) => a.timestamp - b.timestamp);
  const intervals = ordered.slice(1)
    .map((point, index) => point.sourceId === ordered[index].sourceId ? point.timestamp - ordered[index].timestamp : 0)
    .filter((value) => value > 0 && value < 24 * 3_600_000)
    .sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
  const gapLimit = Math.max(1_000, median * 3);
  const segments: SeriesPoint[][] = [];
  for (const point of ordered) {
    const segment = segments[segments.length - 1];
    const previous = segment?.[segment.length - 1];
    if (!segment || !previous || previous.sourceId !== point.sourceId || point.timestamp - previous.timestamp > gapLimit) segments.push([point]);
    else segment.push(point);
  }
  const result: Array<[number, number | null]> = [];
  segments.forEach((segment, index) => {
    // 先在原始采样轴识别真实断档，再按连续段分配绘图预算。不能反过来，
    // 否则抽稀后的正常间距会被误判为断档并产生大量 null 点。
    const segmentBudget = Math.max(4, Math.floor(2_400 * segment.length / ordered.length));
    const sampled = downsampleSeriesForChart(segment, segmentBudget);
    if (index > 0) result.push([sampled[0].timestamp - 1, null]);
    sampled.forEach((point) => result.push([point.timestamp, point.value]));
  });
  return result;
}

function lineOption(series: Array<{ key: string; label: string; unit: string; axis?: 0 | 1; data: SeriesPoint[] }>, title = ''): EChartsOption {
  const hasSecondary = series.some((item) => item.axis === 1);
  return {
    animation: false,
    title: title ? { text: title, show: false } : undefined,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross', lineStyle: { color: '#7dd3fc' }, crossStyle: { color: '#7dd3fc' } }, backgroundColor: '#0b2138', borderColor: '#2786a8', textStyle: { color: '#e6f4ff' } },
    legend: { top: 2, textStyle: { color: '#d7efff' }, itemWidth: 24, itemHeight: 10, itemGap: 16 },
    grid: { top: 34, left: 48, right: hasSecondary ? 54 : 20, bottom: 34 },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: '#31516a' } }, axisLabel: { color: '#8da9bd' } },
    yAxis: hasSecondary
      ? [{ type: 'value', name: series.find((item) => item.axis !== 1)?.unit ?? '', nameTextStyle: { color: '#8da9bd' }, axisLabel: { color: '#8da9bd' }, splitLine: { lineStyle: { color: 'rgba(148,203,232,.12)' } } }, { type: 'value', name: series.find((item) => item.axis === 1)?.unit ?? '', nameTextStyle: { color: '#8da9bd' }, axisLabel: { color: '#8da9bd' }, splitLine: { show: false } }]
      : { type: 'value', name: series[0]?.unit ?? '', nameTextStyle: { color: '#8da9bd' }, axisLabel: { color: '#8da9bd' }, splitLine: { lineStyle: { color: 'rgba(148,203,232,.12)' } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4, borderColor: 'transparent', fillerColor: 'rgba(34,211,238,.16)', textStyle: { color: '#8da9bd' } }],
    series: series.map((item) => {
      const style = LINE_STYLES[item.key] ?? { color: '#22d3ee', type: 'solid' as const, width: 2, symbol: 'circle' as const };
      return {
        name: item.label,
        type: 'line',
        yAxisIndex: item.axis ?? 0,
        showSymbol: false,
        symbol: style.symbol,
        symbolSize: 7,
        smooth: false,
        connectNulls: false,
        lineStyle: { width: style.width, color: style.color, type: style.type },
        itemStyle: { color: style.color },
        emphasis: { focus: 'series', lineStyle: { width: style.width + 1 } },
        data: seriesWithGaps(item.data),
      };
    }),
  };
}

function barOption(series: Array<{ name: string; color: string; data: Array<{ key: string; value: number }> }>): EChartsOption {
  const keys = [...new Set(series.flatMap((item) => item.data.map((entry) => entry.key)))];
  return {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(125,211,252,.08)' } }, backgroundColor: '#0b2138', borderColor: '#2786a8', textStyle: { color: '#e6f4ff' } },
    legend: { top: 2, textStyle: { color: '#d7efff' }, itemWidth: 18, itemHeight: 10, itemGap: 18, icon: 'roundRect' },
    grid: { top: 34, left: 52, right: 18, bottom: 30 },
    xAxis: { type: 'category', data: keys, axisLabel: { color: '#8da9bd', rotate: keys.length > 9 ? 35 : 0 }, axisLine: { lineStyle: { color: '#31516a' } } },
    yAxis: { type: 'value', name: 'kWh', nameTextStyle: { color: '#8da9bd' }, axisLabel: { color: '#8da9bd' }, splitLine: { lineStyle: { color: 'rgba(148,203,232,.12)' } } },
    series: series.map((item, index) => ({
      name: item.name,
      type: 'bar',
      barMaxWidth: 28,
      itemStyle: {
        color: item.color,
        borderColor: 'rgba(230,244,255,.65)',
        borderWidth: 0.5,
        borderRadius: [3, 3, 0, 0],
        decal: index % 2 ? { symbol: 'rect', symbolSize: 1, color: 'rgba(4,20,36,.3)', dashArrayX: [1, 0], dashArrayY: [3, 4], rotation: -Math.PI / 4 } : undefined,
      },
      emphasis: { focus: 'series', itemStyle: { borderColor: '#ffffff', borderWidth: 1.5 } },
      tooltip: { valueFormatter: (value) => `${Number(value).toFixed(3)} kWh` },
      data: keys.map((key) => item.data.find((entry) => entry.key === key)?.value ?? 0),
    })),
  };
}

function donutOption(data: Array<{ name: string; value: number; color: string }>): EChartsOption {
  const visibleData = data.filter((item) => item.value > 0);
  return {
    animation: false,
    tooltip: { trigger: 'item', valueFormatter: (value) => `${Number(value).toFixed(2)} kWh`, backgroundColor: '#0b2138', borderColor: '#2786a8', textStyle: { color: '#e6f4ff' } },
    legend: { bottom: 0, textStyle: { color: '#d7efff' }, itemWidth: 18, itemHeight: 10, itemGap: 18, icon: 'roundRect' },
    series: [{
      type: 'pie',
      radius: ['43%', '67%'],
      center: ['50%', '44%'],
      stillShowZeroSum: false,
      avoidLabelOverlap: true,
      label: { position: 'inside', formatter: '{b}\n{d}%', fontSize: 12, fontWeight: 600 },
      labelLine: { show: false },
      labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
      emphasis: { focus: 'self', scaleSize: 6 },
      data: visibleData.map((item, index) => ({
        ...item,
        itemStyle: {
          color: item.color,
          borderColor: '#071b2e',
          borderWidth: 2,
          decal: index % 2 ? { symbol: 'rect', symbolSize: 1, color: 'rgba(4,20,36,.28)', dashArrayX: [1, 0], dashArrayY: [3, 4], rotation: -Math.PI / 4 } : undefined,
        },
        label: { color: contrastTextColor(item.color) },
      })),
    }],
  };
}

function preparedSourcesFromSimulation(): PreparedDataSource[] {
  const state = useSimStore.getState();
  const datasets = state.injectionSources.length
    ? state.injectionSources
    : state.injectionDataset ? [state.injectionDataset] : [];
  return datasets.map((dataset) => dataset.prepared);
}

interface ImportProgress {
  fileName: string;
  current: number;
  total: number;
  stage: ImportPreparationStage | 'committing';
}

const IMPORT_STAGE_LABELS: Record<ImportProgress['stage'], string> = {
  reading: '读取文件',
  parsing: '后台解析表格',
  quality: '校验字段与异常行',
  committing: '建立多源时间轴',
};

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function importSourceId(file: File): string {
  // 名称、体积和最后修改时间共同标识本地文件。同一文件重复导入执行更新；
  // 内容发生变化时浏览器提供的新 size/lastModified 会自然形成新版本。
  return `analysis:${file.name}:${file.size}:${file.lastModified}`;
}

export function AnalysisDashboardPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ratioBucketKey, setRatioBucketKey] = useState('');
  const sources = useAnalysisStore((state) => state.sources);
  const activeView = useAnalysisStore((state) => state.activeView);
  const granularity = useAnalysisStore((state) => state.granularity);
  const range = useAnalysisStore((state) => state.range);
  const analysisMode = useAnalysisStore((state) => state.analysisMode);
  const selectedSourceIds = useAnalysisStore((state) => state.selectedSourceIds);
  const singleSourceId = useAnalysisStore((state) => state.singleSourceId);
  const batteryCurrentConvention = useAnalysisStore((state) => state.batteryCurrentConvention);
  const addPreparedSources = useAnalysisStore((state) => state.addPreparedSources);
  const removeSource = useAnalysisStore((state) => state.removeSource);
  const setActiveView = useAnalysisStore((state) => state.setActiveView);
  const setGranularity = useAnalysisStore((state) => state.setGranularity);
  const setRange = useAnalysisStore((state) => state.setRange);
  const setAnalysisMode = useAnalysisStore((state) => state.setAnalysisMode);
  const toggleSourceSelection = useAnalysisStore((state) => state.toggleSourceSelection);
  const setSingleSource = useAnalysisStore((state) => state.setSingleSource);
  const setBatteryCurrentConvention = useAnalysisStore((state) => state.setBatteryCurrentConvention);
  const dataset = useSimStore((state) => state.injectionDataset);
  const injectionSources = useSimStore((state) => state.injectionSources);
  const timelineIndex = useSimStore((state) => state.timelineIndex);
  const playbackSnapshot = useSimStore((state) => state.playbackSnapshot);

  useEffect(() => {
    const missing = preparedSourcesFromSimulation().filter((prepared) => !sources.some((source) =>
      source.id === prepared.id || (
        source.sourceFile === prepared.filename &&
        source.rows.length === prepared.rows.length &&
        source.timeColumn === prepared.timeStats.timeColumn
      ),
    ));
    if (missing.length) addPreparedSources(missing);
  }, [addPreparedSources, dataset, injectionSources, sources]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const usableSources = useMemo(() => sources.map((source) => ({
    ...source,
    rows: source.processedRows?.length
      ? source.processedRows.filter((row) => row.valid).map((row) => row.raw)
      : source.rows.filter(isRowUsable),
  })), [sources]);
  // 每个来源的规范点只在文件变化时生成一次。模式切换只挑选已有点列，
  // 不能再次解析 18k×36 的 BMS 单元格。
  const allAnalysisPoints = useMemo(() => buildAnalysisPoints(usableSources), [usableSources]);
  const allPointsBySource = useMemo(() => indexAnalysisPointsBySource(allAnalysisPoints), [allAnalysisPoints]);
  const selectedSources = useMemo(
    () => usableSources.filter((source) => selectedSourceIds.includes(source.id)),
    [selectedSourceIds, usableSources],
  );
  const singleScopedSources = useMemo(
    () => usableSources.filter((source) => source.id === singleSourceId),
    [singleSourceId, usableSources],
  );
  const scopedSources = analysisMode === 'single' ? singleScopedSources : selectedSources;
  const playbackSelectionKey = scopedSources.map((source) => source.id).join('|');
  useEffect(() => {
    const sim = useSimStore.getState();
    sim.setActivePlaybackSourceIds(scopedSources.map((source) => source.id));
    queueMicrotask(() => applyTimelineFrame(0));
  }, [playbackSelectionKey]);
  const scopedAllPoints = useMemo(() => {
    if (scopedSources.length === 1) return allPointsBySource.get(scopedSources[0].id) ?? [];
    const usesEverySource = scopedSources.length === usableSources.length
      && scopedSources.every((source, index) => source.id === usableSources[index]?.id);
    if (usesEverySource) return allAnalysisPoints;
    return scopedSources
      .flatMap((source) => allPointsBySource.get(source.id) ?? [])
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [allAnalysisPoints, allPointsBySource, scopedSources, usableSources]);
  const synchronized = useMemo(() => {
    if (analysisMode !== 'intersection' || scopedSources.length < 2) return { anchors: [], points: [], frames: [] };
    const anchor = scopedSources.find((source) => source.profile.kind === 'thermal-electrical') ?? scopedSources[0];
    const session = buildPlaybackSession({
      sources: scopedSources.map((source) => source.prepared),
      anchorSourceId: anchor.id,
      toleranceMs: SYNC_TOLERANCE_MS,
    });
    const anchors: AnalysisPoint[] = [];
    const points: AnalysisPoint[] = [];
    for (const frame of session.frames) {
      const anchorSample = frame.samples[session.anchorSourceId];
      anchors.push({ timestamp: frame.timestamp, sourceId: session.anchorSourceId, values: anchorSample.values });
      for (const sample of Object.values(frame.samples)) {
        points.push({ timestamp: frame.timestamp, sourceId: sample.sourceId, values: sample.values });
      }
    }
    points.sort((left, right) => left.timestamp - right.timestamp || left.sourceId.localeCompare(right.sourceId));
    return { anchors, points, frames: session.frames };
  }, [analysisMode, scopedSources]);
  const synchronizedAnchors = synchronized.anchors;
  const modePoints = analysisMode === 'intersection' ? synchronized.points : scopedAllPoints;
  const points = useMemo(() => filterPoints(modePoints, range), [modePoints, range]);
  const seriesFor = useMemo(() => {
    const cache = new Map<string, SeriesPoint[]>();
    return (fieldKey: string) => {
      const cached = cache.get(fieldKey);
      if (cached) return cached;
      const series = buildSeries(points, fieldKey);
      cache.set(fieldKey, series);
      return series;
    };
  }, [points]);
  const derivedSeriesFor = useMemo(() => {
    const cache = new Map<'battery_power' | 'battery_remaining_energy' | 'cooling_power', SeriesPoint[]>();
    return (fieldKey: 'battery_power' | 'battery_remaining_energy' | 'cooling_power') => {
      const cached = cache.get(fieldKey);
      if (cached) return cached;
      const series = getDerivedSeries(points, fieldKey);
      cache.set(fieldKey, series);
      return series;
    };
  }, [points]);
  const latestTimestamp = points.length > 0 ? points[points.length - 1].timestamp : null;
  const currentIntersectionFrame = analysisMode === 'intersection' && synchronized.frames.length
    ? synchronized.frames[Math.max(0, Math.min(timelineIndex, synchronized.frames.length - 1))]
    : null;
  const currentTimestamp = currentIntersectionFrame?.timestamp ?? playbackSnapshot?.timestamp ?? null;
  const playbackFrameCount = analysisMode === 'intersection'
    ? synchronizedAnchors.length
    : (dataset?.rows.length ?? 0);

  const selectRange = (hours: number | null) => {
    if (hours == null || !latestTimestamp) setRange(null);
    else setRange([latestTimestamp - hours * 3_600_000, latestTimestamp]);
  };

  const importFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    if (!files.length || importProgress) return;
    const startedAt = performance.now();
    setImportError(null);
    setImportNotice(null);
    const preparedFiles: PreparedDataSource[] = [];
    const errors: string[] = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        try {
          setImportProgress({ fileName: file.name, current: index + 1, total: files.length, stage: 'reading' });
          await waitForNextPaint();
          const prepared = await prepareFileForImport(
            file,
            importSourceId(file),
            (stage) => setImportProgress({ fileName: file.name, current: index + 1, total: files.length, stage }),
          );
          preparedFiles.push(prepared);
        } catch (error) {
          errors.push(`${file.name} 导入失败：${error instanceof Error ? error.message : '文件无法解析'}`);
        }
      }

      if (preparedFiles.length) {
        setImportProgress({
          fileName: preparedFiles.length === 1 ? preparedFiles[0].filename : `${preparedFiles.length} 个文件`,
          current: files.length,
          total: files.length,
          stage: 'committing',
        });
        await waitForNextPaint();
        // 所有文件先在后台完成整理，再一次性提交分析库；原理图复用同一份结果。
        const addedSources = addPreparedSources(preparedFiles);
        const sim = useSimStore.getState();
        for (const added of addedSources) {
          sim.setInjectionDataset({
            sourceId: added.id,
            sourceFile: added.sourceFile,
            format: added.format,
            headers: added.headers,
            rows: added.rows,
            timeColumn: added.timeColumn,
            role: added.profile.kind,
            prepared: added.prepared,
          });
        }
        useSimStore.getState().setActivePlaybackSourceIds(addedSources.map((source) => source.id));
        const nextSim = useSimStore.getState();
        const hasThermal = nextSim.injectionSources.some((source) => source.role === 'thermal-electrical' || source.role === 'mixed');
        const hasBms = nextSim.injectionSources.some((source) => source.role === 'battery-bms');
        if (hasThermal && hasBms) nextSim.setTimelineMode('combined');
        applyTimelineFrame(0);
        // 把首屏图表完成布局的时间也计入“导入完成”，避免进度过早消失。
        await waitForNextPaint();
      }
      setImportError(errors.length ? errors.join('；') : null);
    } finally {
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      setImportNotice(preparedFiles.length
        ? `已完成 ${preparedFiles.length}/${files.length} 个文件，用时 ${elapsedSeconds.toFixed(1)} 秒`
        : `未导入有效文件，用时 ${elapsedSeconds.toFixed(1)} 秒`);
      setImportProgress(null);
      input.value = '';
    }
  };

  const activateSource = (source: AnalysisSource) => {
    const sim = useSimStore.getState();
    sim.setTimelinePlaying(false);
    sim.setInjectionDataset({ sourceId: source.id, sourceFile: source.sourceFile, format: source.format, headers: source.headers, rows: source.rows, timeColumn: source.timeColumn, role: source.profile.kind, prepared: source.prepared });
    useSimStore.getState().setActivePlaybackSourceIds([source.id]);
    useSimStore.getState().setTimelineMode(source.profile.kind);
    applyTimelineFrame(0);
  };

  const removeAnalysisSource = (source: AnalysisSource) => {
    removeSource(source.id);
    const sim = useSimStore.getState();
    const linked = sim.injectionSources.find((candidate) => candidate.sourceId === source.id);
    if (linked) {
      sim.removeInjectionSource(linked.sourceId);
      queueMicrotask(() => applyTimelineFrame(0));
    }
  };

  const moveFrame = (delta: number) => {
    if (!playbackFrameCount) return;
    const next = Math.max(0, Math.min(playbackFrameCount - 1, timelineIndex + delta));
    applyTimelineFrame(next);
  };

  const snapshotPoints = useMemo(() => {
    if (!points.length) return [];
    if (analysisMode === 'intersection') {
      if (!currentIntersectionFrame || (range && (currentIntersectionFrame.timestamp < range[0] || currentIntersectionFrame.timestamp > range[1]))) return [];
      return Object.values(currentIntersectionFrame.samples).map((sample) => ({
        timestamp: currentIntersectionFrame.timestamp,
        sourceId: sample.sourceId,
        values: sample.values,
      }));
    }
    const cursor = points[points.length - 1].timestamp;
    // 并集模式的“当前值”只读取当前时刻，绝不回退拼接其他来源的历史末值。
    return points.filter((point) => point.timestamp === cursor);
  }, [analysisMode, currentIntersectionFrame, points, range]);
  const metrics = {
    supply: getCurrentValue(snapshotPoints, 'supply_water_temp'),
    return: getCurrentValue(snapshotPoints, 'return_water_temp'),
    outlet: getCurrentValue(snapshotPoints, 'outlet_temp'),
    pv: getCurrentValue(snapshotPoints, 'pv_power'),
    system: getCurrentValue(snapshotPoints, 'system_active_power'),
    soc: getCurrentValue(snapshotPoints, 'battery_soc'),
  };

  // 只计算当前页需要的统计量；过去三个页面的 JSX 会同时构造，BMS 全量切换时
  // 会瞬间创建多份上万点数组，Safari WebContent 容易因内存峰值黑屏。
  const statisticsEnabled = activeView !== 'realtime';
  const systemEnergy = statisticsEnabled ? aggregateEnergy(points, 'system_energy', 'system_active_power', granularity) : [];
  const pvEnergy = statisticsEnabled ? aggregatePowerEnergy(seriesFor('pv_power'), granularity) : [];
  const gridEnergy = activeView === 'energy' ? aggregateEnergy(points, 'grid_energy', 'grid_active_power', granularity) : [];
  const batteryRemainingSeries = activeView === 'energy' ? derivedSeriesFor('battery_remaining_energy') : [];
  const batteryRemaining = aggregateLastSeriesValue(batteryRemainingSeries, granularity);
  const currentBatteryEnergy = batteryRemainingSeries.length ? batteryRemainingSeries[batteryRemainingSeries.length - 1].value : null;
  const coolingPower = activeView === 'ratio' ? derivedSeriesFor('cooling_power') : [];
  const coolingEnergyBuckets = aggregatePowerEnergy(coolingPower, granularity);
  const hpEnergyBuckets = activeView === 'ratio' ? aggregatePowerEnergy(seriesFor('hp_power'), granularity) : [];
  const coolingEnergy = sumBuckets(coolingEnergyBuckets);
  const hpEnergy = sumBuckets(hpEnergyBuckets);
  const pvActual = sumBuckets(pvEnergy);
  const scopeRange: [number, number] | null = points.length ? [points[0].timestamp, points[points.length - 1].timestamp] : null;
  const completeness = useMemo(() => {
    if (activeView !== 'ratio') return 0;
    const qualityFields = ['supply_water_temp', 'return_water_temp', 'outlet_temp', 'system_active_power', 'pv_power', 'battery_soc'];
    let expected = 0;
    let actual = 0;
    for (const source of scopedSources) {
      const fields = qualityFields.filter((key) => source.profile.fieldKeys.includes(key));
      const sourcePoints = points.filter((point) => point.sourceId === source.id);
      expected += fields.length * sourcePoints.length;
      actual += sourcePoints.reduce((count, point) => count + fields.filter((key) => Number.isFinite(point.values[key])).length, 0);
    }
    return expected ? actual / expected : 0;
  }, [activeView, points, scopedSources]);
  const ratioBuckets = useMemo(() => activeView === 'ratio'
    ? [...new Map([...systemEnergy, ...pvEnergy, ...coolingEnergyBuckets, ...hpEnergyBuckets].map((bucket) => [bucket.key, bucket])).values()].sort((a, b) => a.start - b.start)
    : [], [activeView, systemEnergy, pvEnergy, coolingEnergyBuckets, hpEnergyBuckets]);
  // 占比图默认必须与顶部“时间”筛选一致：全量即累计全量。只有用户明确选择
  // 某个自然时段后，才缩小到该逐时/逐日桶，不能静默取最后一个桶。
  const activeRatioBucket = ratioBucketKey ? ratioBuckets.find((bucket) => bucket.key === ratioBucketKey) : undefined;
  const ratioValue = (buckets: typeof systemEnergy) => activeRatioBucket
    ? buckets.find((bucket) => bucket.key === activeRatioBucket.key)?.value ?? 0
    : sumBuckets(buckets);
  const ratioPvActual = ratioValue(pvEnergy);
  const ratioCoolingEnergy = ratioValue(coolingEnergyBuckets);
  const ratioHpEnergy = ratioValue(hpEnergyBuckets);
  const ratioScopeRange: [number, number] | null = activeRatioBucket
    ? [
      activeRatioBucket.start,
      Math.min(
        activeRatioBucket.start + (granularity === 'hour' ? 3_600_000 : 24 * 3_600_000),
        scopeRange?.[1] ?? activeRatioBucket.start,
      ),
    ]
    : scopeRange;
  // 5 kWp 是峰值功率。占比参考量应按实际统计时间窗折算为理论满发电量，
  // 而不是把每个不完整小时都当作完整 1 小时。
  const ratioRated = ratioScopeRange
    ? 5 * Math.max(0, ratioScopeRange[1] - ratioScopeRange[0]) / 3_600_000
    : 0;
  const ratioScopeNote = activeRatioBucket
    ? `统计时段：${activeRatioBucket.key}（${granularity === 'hour' ? '逐时' : '逐日'}）`
    : `统计范围：${formatTimeRange(scopeRange)}（与顶部时间筛选一致）`;
  const batteryPower = activeView === 'ratio' ? derivedSeriesFor('battery_power') : [];
  const positiveBatteryEnergy = aggregateSignedPowerEnergy(batteryPower, 'positive', granularity);
  const negativeBatteryEnergy = aggregateSignedPowerEnergy(batteryPower, 'negative', granularity);
  const batteryChargeEnergy = batteryCurrentConvention === 'positive-charge' ? positiveBatteryEnergy : negativeBatteryEnergy;
  const batteryDischargeEnergy = batteryCurrentConvention === 'positive-charge' ? negativeBatteryEnergy : positiveBatteryEnergy;
  const scopeLabel = analysisMode === 'union' ? '全天并集' : analysisMode === 'intersection' ? '同步交集' : '单数据源';
  const sourceLabel = scopedSources.map((source) => `${source.profile.label}：${source.sourceFile}${source.quality.invalidRows ? `（隔离 ${source.quality.invalidRows} 行）` : ''}`).join('；') || '未选择数据源';
  /**
   * 图表不能沿用页面全局的来源/时间：例如 BMS 的采样更密，而热工文件
   * 可能在同一“交集”里并没有水箱温度。这里严格以图表实际读到的字段取证。
   */
  const chartEvidence = (fieldKeys: string[]) => {
    const relevantPoints = points.filter((point) => fieldKeys.some((key) => hasPointValue(point, key)));
    const sourceIds = new Set(relevantPoints.map((point) => point.sourceId));
    const relevantSources = scopedSources.filter((source) => sourceIds.has(source.id));
    const missingFields = fieldKeys.filter((key) => !relevantPoints.some((point) => hasPointValue(point, key)));
    const timeRange: [number, number] | null = relevantPoints.length
      ? [relevantPoints[0].timestamp, relevantPoints[relevantPoints.length - 1].timestamp]
      : null;
    return { relevantPoints, relevantSources, missingFields, timeRange };
  };
  const chartSubtitle = (measure: string, fieldKeys: string[], options?: { missing?: Record<string, string>; note?: string }) => {
    const evidence = chartEvidence(fieldKeys);
    const sourceText = evidence.relevantSources.length
      ? evidence.relevantSources.map((source) => `${source.profile.label}·${source.sourceFile}`).join('；')
      : '无有效来源';
    const missingText = evidence.missingFields
      .map((key) => options?.missing?.[key])
      .filter((label): label is string => Boolean(label));
    const suffix = [
      missingText.length ? `未提供：${missingText.join('、')}` : '',
      options?.note ?? '',
    ].filter(Boolean).join('；');
    return `${measure} · 来源：${sourceText} · ${scopeLabel} · 有效时间：${formatTimeRange(evidence.timeRange)}${suffix ? ` · ${suffix}` : ''}`;
  };

  const thermalFields = ['tank_temp', 'supply_water_temp', 'return_water_temp', 'outlet_temp'];
  const pvFields = ['pv_voltage', 'pv_current'];
  const electricalFields = ['system_voltage', 'system_current', 'grid_voltage', 'grid_current'];
  const batteryStateFields = ['battery_soc', 'battery_voltage', 'battery_current'];
  const systemPvEnergyFields = ['system_energy', 'system_active_power', 'pv_power'];
  const batteryEnergyFields = ['battery_voltage', 'battery_remaining_ah', 'battery_full_capacity_ah', 'battery_soc'];
  const gridEnergyFields = ['grid_energy', 'grid_active_power'];
  const coolingFields = ['water_flow', 'supply_water_temp', 'return_water_temp'];
  const hpPowerFields = ['hp_power'];
  const coolingReady = coolingPower.length >= 2;
  const hpEnergyReady = seriesFor('hp_power').length >= 2;

  useEffect(() => {
    if (ratioBucketKey && !ratioBuckets.some((bucket) => bucket.key === ratioBucketKey)) setRatioBucketKey('');
  }, [ratioBucketKey, ratioBuckets]);

  const realtime = activeView === 'realtime' ? (
    <div className="m3-dashboard__view m3-dashboard__view--realtime">
      <MetricCard label="送水温度" value={valueText(metrics.supply)} unit="℃" tone="blue" />
      <MetricCard label="回水温度" value={valueText(metrics.return)} unit="℃" tone="green" />
      <MetricCard label="出风温度" value={valueText(metrics.outlet)} unit="℃" />
      <MetricCard label="光伏实时功率" value={valueText(metrics.pv, 2)} unit="kW" tone="yellow" />
      <MetricCard label="系统有功功率" value={valueText(metrics.system, 2)} unit="kW" tone="purple" />
      <MetricCard label="电池 SOC" value={valueText(metrics.soc, 0)} unit="%" tone="green" />
      <ChartPanel title="热工温度趋势" subtitle={chartSubtitle('T4 送水 / T5 回水 / T2 出风', thermalFields, { missing: { tank_temp: '水箱温度', supply_water_temp: '送水温度（T4）', return_water_temp: '回水温度（T5）', outlet_temp: '出风温度（T2）' } })} className="m3-chart-panel--thermal">
        {thermalFields.some((key) => seriesFor(key).length) ? <EChart option={lineOption([
          { key: 'tank_temp', label: '水箱温度', unit: '℃', data: seriesFor('tank_temp') },
          { key: 'supply_water_temp', label: '送水温度', unit: '℃', data: seriesFor('supply_water_temp') },
          { key: 'return_water_temp', label: '回水温度', unit: '℃', data: seriesFor('return_water_temp') },
          { key: 'outlet_temp', label: '出风温度', unit: '℃', data: seriesFor('outlet_temp') },
        ])} /> : <div className="m3-chart-empty">所选来源或时间范围内没有热工温度有效测点。</div>}
      </ChartPanel>
      <ChartPanel title="光伏直流监测" subtitle={chartSubtitle('ZU / ZI', pvFields, { missing: { pv_voltage: '光伏直流电压（ZU）', pv_current: '光伏直流电流（ZI）' } })}>
        {seriesFor('pv_voltage').length || seriesFor('pv_current').length ? <EChart option={lineOption([{ key: 'pv_voltage', label: '直流电压', unit: 'V', data: seriesFor('pv_voltage') }, { key: 'pv_current', label: '直流电流', unit: 'A', axis: 1, data: seriesFor('pv_current') }])} /> : <div className="m3-chart-empty">所选来源或时间范围内没有 ZU / ZI 有效测点。</div>}
      </ChartPanel>
      <ChartPanel title="交流电气监测" subtitle={chartSubtitle('D / DU', electricalFields, { missing: { system_voltage: '系统电压（D1）', system_current: '系统电流（D2）', grid_voltage: '市电电压（DU1）', grid_current: '市电电流（DU2）' } })}>
        {['system_voltage', 'system_current', 'grid_voltage', 'grid_current'].some((key) => seriesFor(key).length) ? <EChart option={lineOption([{ key: 'system_voltage', label: '系统电压', unit: 'V', data: seriesFor('system_voltage') }, { key: 'system_current', label: '系统电流', unit: 'A', axis: 1, data: seriesFor('system_current') }, { key: 'grid_voltage', label: '市电电压', unit: 'V', data: seriesFor('grid_voltage') }, { key: 'grid_current', label: '市电电流', unit: 'A', axis: 1, data: seriesFor('grid_current') }])} /> : <div className="m3-chart-empty">所选来源或时间范围内没有 D / DU 有效测点。</div>}
      </ChartPanel>
      <ChartPanel title="电池状态" subtitle={chartSubtitle('BMS：SOC / 包电压 / 包电流', batteryStateFields, { missing: { battery_soc: 'SOC', battery_voltage: '包电压', battery_current: '包电流' } })}>
        {seriesFor('battery_soc').length ? <EChart option={lineOption([{ key: 'battery_soc', label: 'SOC', unit: '%', data: seriesFor('battery_soc') }, { key: 'battery_voltage', label: '电压', unit: 'V', axis: 1, data: seriesFor('battery_voltage') }, { key: 'battery_current', label: '电流', unit: 'A', axis: 1, data: seriesFor('battery_current') }])} /> : <div className="m3-chart-empty">所选来源或时间范围内没有 BMS 有效测点。</div>}
      </ChartPanel>
    </div>
  ) : null;

  const energy = activeView === 'energy' ? (
    <div className="m3-dashboard__view m3-dashboard__view--energy">
      <MetricCard label="期间系统用电" value={valueText(sumBuckets(systemEnergy), 2)} unit="kWh" tone="purple" />
      <MetricCard label="期间光伏发电" value={valueText(pvActual, 2)} unit="kWh" tone="yellow" />
      <MetricCard label="期间市电电量" value={valueText(sumBuckets(gridEnergy), 2)} unit="kWh" tone="blue" />
      <MetricCard label="BMS 末次电池剩余" value={valueText(currentBatteryEnergy, 2)} unit="kWh" tone="green" />
      <ChartPanel title={`系统用电与光伏发电（逐${granularity === 'hour' ? '时' : '日'}）`} subtitle={chartSubtitle('D3/D8 / ZW', systemPvEnergyFields, { missing: { system_energy: '系统累计电能（D8）', system_active_power: '系统有功功率（D3，无法回退积分）', pv_power: '光伏功率（ZW）' } })} className="m3-chart-panel--wide">
        <EChart option={barOption([{ name: '系统用电', color: ENERGY_COLORS.system, data: systemEnergy }, { name: '光伏发电', color: ENERGY_COLORS.photovoltaic, data: pvEnergy }])} />
      </ChartPanel>
      <ChartPanel title={`电池剩余能量（逐${granularity === 'hour' ? '时' : '日'}）`} subtitle={chartSubtitle('BMS 剩余 Ah × 包电压；缺失不估算', batteryEnergyFields, { missing: { battery_voltage: '包电压', battery_remaining_ah: '剩余容量（Ah，若同时有 SOC 与满充容量可估算）', battery_full_capacity_ah: '满充容量（Ah，非必需）', battery_soc: 'SOC（仅在无剩余容量时参与估算）' } })}>
        <EChart option={barOption([{ name: '剩余电量', color: ENERGY_COLORS.battery, data: batteryRemaining }])} />
      </ChartPanel>
      <ChartPanel title="市电用电量" subtitle={chartSubtitle('DU3 / DU8', gridEnergyFields, { missing: { grid_energy: '市电累计电能（DU8）', grid_active_power: '市电有功功率（DU3，无法回退积分）' } })} className="m3-chart-panel--wide">
        <EChart option={barOption([{ name: '市电电量', color: ENERGY_COLORS.grid, data: gridEnergy }])} />
      </ChartPanel>
      <ChartPanel title="统计说明" className="m3-chart-panel--summary">
        <div className="m3-summary"><p>D8 / DU8 存在时按累计电能差分；缺少时回退为 D3 / DU3 功率按真实时间戳积分。</p><p>电池余量为时点库存，取每个时段末值，不参与求和。</p></div>
      </ChartPanel>
    </div>
  ) : null;

  const ratio = activeView === 'ratio' ? (
    <div className="m3-dashboard__view m3-dashboard__view--ratio">
      <MetricCard label="数据完整率" value={valueText(completeness * 100, 0)} unit="%" />
      <MetricCard label="光伏满发参考完成率" value={valueText(ratioRated ? ratioPvActual / ratioRated * 100 : null, 1)} unit="%" tone="yellow" />
      <MetricCard label="热泵 COP" value={valueText(ratioHpEnergy ? ratioCoolingEnergy / ratioHpEnergy : null, 2)} tone="orange" />
      <MetricCard label="有效记录" value={String(points.length)} unit="条" tone="purple" />
      <ChartPanel title="光伏实际 / 理论满发电量" subtitle={chartSubtitle(`ZW；5 kWp 理论满发参考 ${ratioRated.toFixed(2)} kWh；${ratioScopeNote}`, ['pv_power'], { missing: { pv_power: '光伏功率（ZW）' } })}>
        {ratioPvActual > 0 && ratioRated > 0
          ? <EChart option={donutOption([{ name: '实际发电', value: ratioPvActual, color: ENERGY_COLORS.photovoltaic }, { name: '理论满发余量', value: Math.max(0, ratioRated - ratioPvActual), color: ENERGY_COLORS.reference }])} />
          : <div className="m3-chart-empty">当前统计范围内未检测到可积分的光伏发电量；理论满发参考为 {ratioRated.toFixed(2)} kWh。</div>}
      </ChartPanel>
      <ChartPanel title="电池充电 / 放电能量" subtitle={batteryCurrentConvention === 'unknown' ? 'BMS 电流方向未确认，未计算；需要包电压与包电流的同一时段采样。' : chartSubtitle('BMS 包电压 × 包电流', ['battery_voltage', 'battery_current'], { missing: { battery_voltage: '包电压', battery_current: '包电流' }, note: '正值=充电，负值=放电' })}>
        {batteryCurrentConvention === 'unknown'
          ? <div className="m3-chart-empty">尚未确认 BMS 电流正负方向，因此不计算充放电能量。</div>
          : batteryPower.length >= 2
            ? <EChart option={barOption([{ name: '充电', color: ENERGY_COLORS.charge, data: batteryChargeEnergy }, { name: '放电', color: ENERGY_COLORS.discharge, data: batteryDischargeEnergy }])} />
            : <div className="m3-chart-empty">所选来源或时间范围内没有足够的 BMS 电压、电流有效点。</div>}
      </ChartPanel>
      <ChartPanel title="热泵供冷量 / 用电量" subtitle={chartSubtitle('流量 / T4 / T5 / 热泵功率', [...coolingFields, ...hpPowerFields], { missing: { water_flow: '循环水流量', supply_water_temp: '送水温度（T4）', return_water_temp: '回水温度（T5）', hp_power: '热泵用电功率' } })}>
        {coolingReady && hpEnergyReady
          ? <EChart option={donutOption([{ name: '供冷量', value: ratioCoolingEnergy, color: ENERGY_COLORS.cooling }, { name: '耗电量', value: ratioHpEnergy, color: ENERGY_COLORS.heatPump }])} />
          : <div className="m3-chart-empty">无法计算：供冷量需要连续的循环水流量、T4 送水温度、T5 回水温度；用电量需要连续的热泵用电功率。当前来源未同时满足这些字段。</div>}
      </ChartPanel>
      <ChartPanel title="热泵耗电来源占比" subtitle={chartSubtitle('需“热泵—光伏 / 市电 / 电池”来源分摊', ['hp_power'], { missing: { hp_power: '热泵用电功率' }, note: '仅有系统/市电/光伏总量不能推断热泵来源' })}><div className="m3-chart-empty">当前采集字段未提供“热泵由光伏 / 市电 / 电池供电”的分摊关系；为避免把全系统能量误当热泵来源，此图暂不计算。</div></ChartPanel>
    </div>
  ) : null;

  return (
    <main className="m3-dashboard">
      <div ref={stageRef} className="m3-dashboard__stage">
        <header className="m3-dashboard__header">
          <div><span>光伏·空调仿真平台</span><h1>数据分析大屏</h1></div>
          <div className="m3-dashboard__header-meta"><span>{sources.length} 个数据源 · {points.length} 条有效记录</span><span>{currentTimestamp ? new Date(currentTimestamp).toLocaleString('zh-CN') : '未定位当前帧'}</span><button onClick={() => navigate('/')}>← 原理图</button><button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void stageRef.current?.requestFullscreen(); }}>{isFullscreen ? '退出全屏' : '展示全屏'}</button></div>
        </header>
        <section className="m3-dashboard__toolbar">
          <div className="m3-tabs">{(['realtime', 'energy', 'ratio'] as const).map((view) => <button key={view} data-active={activeView === view} onClick={() => setActiveView(view)}>{view === 'realtime' ? '实时监测' : view === 'energy' ? '能量统计' : '占比分析'}</button>)}</div>
          <div className="m3-toolbar__actions">
            <span>模式：</span>{(['union', 'intersection', 'single'] as const).map((mode) => <button key={mode} data-active={analysisMode === mode} onClick={() => setAnalysisMode(mode)}>{mode === 'union' ? '全天并集' : mode === 'intersection' ? '同步交集' : '单数据源'}</button>)}
            {analysisMode === 'single' ? <select aria-label="单数据源" value={singleSourceId ?? ''} onChange={(event) => setSingleSource(event.target.value || null)}><option value="">选择来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.profile.label} · {source.sourceFile}</option>)}</select>
              : <span className="m3-source-filters">{sources.map((source) => <button key={source.id} data-active={selectedSourceIds.includes(source.id)} onClick={() => toggleSourceSelection(source.id)} title={source.sourceFile}>{source.profile.label}</button>)}</span>}
            <span>时间：</span>{[[null, '全量'], [1, '1小时'], [6, '6小时'], [24, '24小时']].map(([hours, label]) => <button key={label as string} data-active={(hours == null && range == null) || (hours != null && range != null && latestTimestamp != null && range[0] === latestTimestamp - Number(hours) * 3_600_000)} onClick={() => selectRange(hours as number | null)}>{label as string}</button>)}
            {activeView !== 'realtime' && <><span>粒度：</span>{(['hour', 'day'] as const).map((value) => <button key={value} data-active={granularity === value} onClick={() => setGranularity(value)}>{value === 'hour' ? '逐时' : '逐日'}</button>)}{activeView === 'ratio' && ratioBuckets.length > 0 && <select aria-label="占比统计时段" value={ratioBucketKey} onChange={(event) => setRatioBucketKey(event.target.value)}><option value="">当前时间筛选（全量累计）</option>{ratioBuckets.map((bucket) => <option key={bucket.key} value={bucket.key}>{bucket.key}</option>)}</select>}</>}
            <label className="m3-direction">BMS 电流：<select aria-label="BMS 电流方向" value={batteryCurrentConvention} onChange={(event) => setBatteryCurrentConvention(event.target.value as typeof batteryCurrentConvention)}><option value="positive-charge">正值=充电（当前口径）</option><option value="positive-discharge">正值=放电</option><option value="unknown">未确认（不计算）</option></select></label>
            <button className="m3-import" disabled={Boolean(importProgress)} onClick={() => fileRef.current?.click()}>{importProgress ? `导入中 ${importProgress.current}/${importProgress.total}` : '＋ 导入数据'}</button><input ref={fileRef} type="file" multiple accept=".pdf,.xlsx,.xls,.csv" hidden disabled={Boolean(importProgress)} onChange={importFiles} />
          </div>
        </section>
        <section className="m3-scope-status" aria-live="polite"><strong>{scopeLabel}</strong><span>{sourceLabel}</span><span>有效时间：{formatTimeRange(scopeRange)}</span>{analysisMode === 'intersection' && <span>匹配：±{SYNC_TOLERANCE_MS / 1000} 秒 · {synchronizedAnchors.length} 个同步点</span>}{importProgress && <span className="m3-import-progress" role="status"><i aria-hidden="true" />{IMPORT_STAGE_LABELS[importProgress.stage]}：{importProgress.fileName}（{importProgress.current}/{importProgress.total}）</span>}{!importProgress && importNotice && <span className="m3-import-complete">✓ {importNotice}</span>}</section>
        {importError && <div className="m3-import-error" role="alert">{importError}</div>}
        {points.length > 0 ? activeView === 'realtime' ? realtime : activeView === 'energy' ? energy : ratio : <section className="m3-dashboard__empty"><h2>{importProgress ? '正在准备数据' : analysisMode === 'intersection' ? '没有可同步的交集数据' : '尚未载入可分析的时序数据'}</h2><p>{importProgress ? `${IMPORT_STAGE_LABELS[importProgress.stage]}，页面仍可继续操作。` : analysisMode === 'intersection' ? '同步交集至少需要两个已选来源，且每个主时间点都必须在 ±2 秒内匹配成功。请检查来源选择、时间范围和文件时间戳。' : '请选择至少一个有效数据源，或点击“导入数据”选择 PDF、XLSX、CSV 文件。'}</p><button disabled={Boolean(importProgress)} onClick={() => fileRef.current?.click()}>{importProgress ? '导入处理中' : '导入数据'}</button></section>}
        <footer className="m3-dashboard__footer"><span>字段口径：字段对照表.jpg</span><span>采样数据按真实时间戳计算</span>{playbackFrameCount ? <span>当前帧 {Math.max(0, timelineIndex) + 1}/{playbackFrameCount} <button onClick={() => moveFrame(-1)}>◀</button><button onClick={() => moveFrame(1)}>▶</button></span> : null}<span>数据源：{sources.map((source) => <span className="m3-source-group" key={source.id}><button className="m3-source" data-active={dataset?.sourceFile === source.sourceFile} onClick={() => activateSource(source)} title={`设为原理图回放源；能力：${source.profile.capabilities.join('、') || '未识别'}`}>{source.profile.label} · {source.sourceFile}</button><button onClick={() => removeAnalysisSource(source)} title="从分析库移除">×</button></span>)}</span></footer>
      </div>
    </main>
  );
}
