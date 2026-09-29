import { useMemo, useRef, useState } from 'react';
import { useModalA11y } from '../hooks/useModalA11y';
import { findChartField } from '../data/chartFields';
import {
  prepareFileForImport,
  type ImportPreparationStage,
} from '../services/preparedImport';
import {
  type PreparedDataSource,
} from '../services/dataSourcePipeline';
import {
  commitPreparedExperiment,
  previewExperimentSession,
} from '../services/sessionCoordinator';

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
  const modalRef = useModalA11y(open, onClose);
  const [step, setStep] = useState<Step>('select');
  const [preparedSources, setPreparedSources] = useState<PreparedDataSource[]>([]);
  const [anchorSourceId, setAnchorSourceId] = useState('');
  const [toleranceMs, setToleranceMs] = useState(2_000);
  // 默认勾选。持久化来源只有分析库（serializeState 只从 experimentBatches 取数据源），
  // 不发布就等于"原理图在回放但场景文件里什么都没有"：保存后重开数据源静默清空、
  // controlMode 退回 simulation，且无任何警告。两个入口必须产生一致的副作用。
  const [publishToAnalysis, setPublishToAnalysis] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionPreview = useMemo(
    () => previewExperimentSession(preparedSources, { anchorSourceId, toleranceMs }),
    [anchorSourceId, preparedSources, toleranceMs],
  );
  const strictSession = sessionPreview.session;
  const timedSourceCount = preparedSources.filter((source) =>
    source.timeStats.start != null && source.timeStats.end != null,
  ).length;
  const commitBlockers = sessionPreview.blockers;

  if (!open) return null;

  const resetState = () => {
    setStep('select');
    setPreparedSources([]);
    setAnchorSourceId('');
    setToleranceMs(2_000);
    setPublishToAnalysis(true);
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
      const defaultAnchor = prepared.find((source) =>
        source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed',
      ) ?? prepared[0];
      setAnchorSourceId(defaultAnchor?.id ?? '');
      setError(errors.length ? `部分文件未能导入：${errors.join('；')}` : null);
      if (prepared.length) setStep('preview');
      else setError(errors.length ? `没有可用的数据文件。${errors.join('；')}` : '没有可用的数据文件。');
    } finally {
      setProgress(null);
      input.value = '';
    }
  };

  const handleCommit = () => {
    if (!preparedSources.length || progress || commitBlockers.length) return;
    try {
      commitPreparedExperiment(preparedSources, { anchorSourceId, toleranceMs, publishToAnalysis });
      resetState();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法建立实验批次');
    }
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
        ref={modalRef}
        className="import-data-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-data-title"
        aria-busy={Boolean(progress)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="import-data-header">
          <h3 id="import-data-title">导入时序数据 — {compId ?? '原理图'}</h3>
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
                {preparedSources.length > 1 && <label>主时间轴<select aria-label="导入主时间轴" value={sessionPreview.anchorSourceId ?? ''} onChange={(event) => setAnchorSourceId(event.target.value)}>{preparedSources.map((source) => <option key={source.id} value={source.id}>{source.filename}</option>)}</select></label>}
                {preparedSources.length > 1 && <label>同步容差<select aria-label="导入同步容差" value={toleranceMs} onChange={(event) => setToleranceMs(Number(event.target.value))}>{[500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000].map((value) => <option key={value} value={value}>±{value / 1_000} 秒</option>)}</select></label>}
                <label title="数据源需登记到分析库，场景文件才能保存并在下次打开时恢复"><input type="checkbox" checked={publishToAnalysis} onChange={(event) => setPublishToAnalysis(event.target.checked)} /> 同时加入数据分析（场景保存依赖此项）</label>
                {!publishToAnalysis && <span className="import-data-selection-note" role="status">未加入分析库的数据不会写入场景文件，打开场景时无法恢复这批数据。</span>}
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

              {commitBlockers.length > 0 && (
                <div className="import-data-error" role="alert">
                  暂不能进入回放：{commitBlockers.join('；')}
                </div>
              )}
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
                setAnchorSourceId('');
                setError(null);
              }}>重新选择</button>
              <button
                onClick={handleCommit}
                className="primary"
                disabled={!preparedSources.length || Boolean(progress) || commitBlockers.length > 0}
                title={commitBlockers[0] ?? ''}
              >
                确认导入并定位首帧
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
