import { useMemo, useRef, useState } from 'react';
import { findChartField } from '../data/chartFields';
import { useSimStore } from '../store/simulation';
import {
  prepareFileForImport,
  type ImportPreparationStage,
} from '../services/preparedImport';
import type { PreparedDataSource } from '../services/dataSourcePipeline';
import { buildPlaybackSession } from '../services/playbackSession';
import { applyTimelineFrame } from './TimelineControls';

interface Props {
  compId: string | null;
  open: boolean;
  onClose: () => void;
}

type Step = 'select' | 'preview';

interface ImportProgress {
  fileName: string;
  current: number;
  total: number;
  stage: ImportPreparationStage;
}

const STAGE_LABELS: Record<ImportPreparationStage, string> = {
  reading: '读取文件',
  parsing: '解析数据',
  quality: '检查时间与数据质量',
};

function sourceId(file: File): string {
  // 与大屏使用同一稳定标识。同一文件从两个入口导入时更新同一数据源，
  // 文件内容变化后 size / lastModified 会形成新版本。
  return `analysis:${file.name}:${file.size}:${file.lastModified}`;
}

function formatTime(value: number | null): string {
  return value == null
    ? '未识别'
    : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatInterval(value: number | null): string {
  if (value == null) return '未识别';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)} 秒`;
  if (value < 3_600_000) return `${(value / 60_000).toFixed(value % 60_000 === 0 ? 0 : 1)} 分钟`;
  return `${(value / 3_600_000).toFixed(value % 3_600_000 === 0 ? 0 : 1)} 小时`;
}

function canonicalFields(source: PreparedDataSource) {
  return source.fieldMappings.map((mapping) => {
    const field = findChartField(mapping.fieldKey);
    return {
      key: mapping.fieldKey,
      label: field?.label ?? mapping.fieldKey,
      unit: field?.unit ?? '',
      sourceColumn: mapping.sourceColumn,
    };
  });
}

export function ImportDataDialog({ compId, open, onClose }: Props) {
  const [step, setStep] = useState<Step>('select');
  const [preparedSources, setPreparedSources] = useState<PreparedDataSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const strictSession = useMemo(() => {
    if (!preparedSources.length) return null;
    const anchor = preparedSources.find((source) =>
      source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed',
    ) ?? preparedSources[0];
    return buildPlaybackSession({ sources: preparedSources, anchorSourceId: anchor.id, toleranceMs: 2_000 });
  }, [preparedSources]);
  const timedSourceCount = preparedSources.filter((source) =>
    source.timeStats.start != null && source.timeStats.end != null,
  ).length;

  if (!open) return null;

  const resetState = () => {
    setStep('select');
    setPreparedSources([]);
    setError(null);
    setProgress(null);
  };

  const handleCancel = () => {
    if (progress) return;
    resetState();
    onClose();
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    if (!files.length || progress) return;

    setError(null);
    setPreparedSources([]);
    const prepared: PreparedDataSource[] = [];
    const errors: string[] = [];

    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        try {
          const result = await prepareFileForImport(
            file,
            sourceId(file),
            (stage) => setProgress({
              fileName: file.name,
              current: index + 1,
              total: files.length,
              stage,
            }),
          );
          prepared.push(result);
        } catch (cause) {
          errors.push(`${file.name}：${cause instanceof Error ? cause.message : '文件无法解析'}`);
        }
      }

      setPreparedSources(prepared);
      setError(errors.length ? `部分文件未能导入：${errors.join('；')}` : null);
      if (prepared.length) setStep('preview');
      else setError(errors.length ? `没有可用的数据文件。${errors.join('；')}` : '没有可用的数据文件。');
    } finally {
      setProgress(null);
      input.value = '';
    }
  };

  const handleCommit = () => {
    if (!preparedSources.length || progress) return;

    const sim = useSimStore.getState();
    for (const prepared of preparedSources) {
      sim.setInjectionDataset({
        sourceId: prepared.id,
        sourceFile: prepared.filename,
        format: prepared.format,
        headers: prepared.headers,
        rows: prepared.rows,
        timeColumn: prepared.timeStats.timeColumn,
        role: prepared.profile.kind,
        prepared,
      });
    }
    useSimStore.getState().setActivePlaybackSourceIds(preparedSources.map((source) => source.id));

    const next = useSimStore.getState();
    const hasThermal = preparedSources.some((source) =>
      source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed',
    );
    const hasBms = preparedSources.some((source) =>
      source.profile.kind === 'battery-bms' || source.profile.kind === 'mixed',
    );
    if (hasThermal && hasBms) next.setTimelineMode('combined');
    applyTimelineFrame(0);
    useSimStore.getState().applyInjection({
      sourceFile: preparedSources.length === 1
        ? preparedSources[0].filename
        : `${preparedSources.length} 个文件`,
      rowsCount: preparedSources.reduce((sum, source) => sum + source.rows.length, 0),
    });

    resetState();
    onClose();
  };

  return (
    <div
      className="import-data-overlay"
      onClick={(event) => {
        event.stopPropagation();
        handleCancel();
      }}
    >
      <div
        className="import-data-modal"
        aria-busy={Boolean(progress)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="import-data-header">
          <h3>导入时序数据 — {compId ?? '原理图'}</h3>
          <button onClick={handleCancel} disabled={Boolean(progress)} aria-label="关闭">×</button>
        </div>

        <div className="import-data-body">
          {error && <div className="import-data-error" role="alert">{error}</div>}

          {step === 'select' && (
            <div className="import-data-step import-data-select">
              <p>选择一个或多个 CSV / Excel / PDF 文件，建立同一段时间的数据会话。</p>
              <p className="import-data-sub">
                文件将使用与数据大屏相同的解析、字段识别和质量检查流程；Excel 在后台线程处理。
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".csv,.xlsx,.xls,.pdf"
                onChange={handleFileSelect}
                hidden
                disabled={Boolean(progress)}
              />
              <button
                className="import-data-btn primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={Boolean(progress)}
              >
                {progress ? '正在分析文件…' : '选择文件…'}
              </button>
              <p className="import-data-selection-note">可同时选择热工/电表数据与电池 BMS 数据；确认后会自动建立综合同步时间轴。</p>

              {progress && (
                <div className="import-data-progress" role="status">
                  <span className="import-data-progress-spinner" aria-hidden="true" />
                  <span>
                    {STAGE_LABELS[progress.stage]}：<strong>{progress.fileName}</strong>
                    {' '}（{progress.current}/{progress.total}）
                  </span>
                </div>
              )}
            </div>
          )}

          {step === 'preview' && preparedSources.length > 0 && (
            <div className="import-data-step">
              <div className="import-data-session-summary">
                <strong>{preparedSources.length} 个数据源</strong>
                <span>{preparedSources.reduce((sum, source) => sum + source.rows.length, 0)} 行原始数据</span>
                {timedSourceCount > 1 && (
                  <span className={strictSession?.range ? 'ok' : 'warn'}>
                    严格交集：{strictSession?.range
                      ? `${formatTime(strictSession.range.start)} ～ ${formatTime(strictSession.range.end)} · ${strictSession.frames.length} 帧`
                      : '无可同步帧'}
                  </span>
                )}
              </div>

              <div className="import-data-source-list">
                {preparedSources.map((source) => {
                  const fields = canonicalFields(source);
                  const issueEntries = Object.entries(source.quality.issueCounts)
                    .filter(([, count]) => Boolean(count));
                  return (
                    <article className="import-data-source-card" key={source.id}>
                      <header>
                        <div>
                          <strong title={source.filename}>{source.filename}</strong>
                          <span className={`import-data-profile import-data-profile--${source.profile.kind}`}>
                            {source.profile.label}
                          </span>
                        </div>
                        <small>{source.format.toUpperCase()} · {source.rows.length} 行 × {source.headers.length} 列</small>
                      </header>

                      <dl className="import-data-source-metrics">
                        <div><dt>时间列</dt><dd>{source.timeStats.timeColumn ?? '未识别'}</dd></div>
                        <div><dt>有效时间</dt><dd>{formatTime(source.timeStats.start)} ～ {formatTime(source.timeStats.end)}</dd></div>
                        <div><dt>中位采样间隔</dt><dd>{formatInterval(source.timeStats.medianIntervalMs)}</dd></div>
                        <div>
                          <dt>数据质量</dt>
                          <dd className={source.quality.invalidRows ? 'warn' : 'ok'}>
                            有效 {source.quality.validRows}/{source.quality.totalRows}
                            {source.quality.invalidRows ? ` · 隔离 ${source.quality.invalidRows} 行` : ' · 无异常行'}
                          </dd>
                        </div>
                      </dl>

                      <div className="import-data-canonical-fields">
                        <span className="import-data-card-label">规范字段</span>
                        {fields.length ? fields.map((field) => (
                          <span
                            className="import-data-field-chip"
                            key={`${field.key}:${field.sourceColumn}`}
                            title={`${field.sourceColumn} → ${field.key}`}
                          >
                            {field.label}{field.unit ? ` (${field.unit})` : ''}
                          </span>
                        )) : <span className="import-data-empty-fields">未识别到规范业务字段</span>}
                      </div>

                      {issueEntries.length > 0 && (
                        <div className="import-data-quality-issues">
                          质量提示：{issueEntries.map(([code, count]) => `${code} ${count}`).join('；')}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="import-data-footer">
          {step === 'select' ? (
            <button onClick={handleCancel} disabled={Boolean(progress)}>取消</button>
          ) : (
            <>
              <button onClick={() => {
                setStep('select');
                setPreparedSources([]);
                setError(null);
              }}>重新选择</button>
              <button onClick={handleCommit} className="primary" disabled={!preparedSources.length}>
                确认导入并定位首帧
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
