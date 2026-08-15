import { useMemo, useRef, useState } from 'react';
import { useSimStore } from '../store/simulation';
import {
  FIELD_OPTIONS,
  applyMapping,
  matchColumnToField,
  type NumericFieldKey,
  getFieldOptionsForComponent,
} from '../services/dataMapper';
import { findPdfColumnMapping } from '../services/pdfFieldMap';
import { PDF_BIND_LABELS } from '../data/meters';
import { parseFile, type ParsedData } from '../services/injectionParser';
import { detectTimeColumn } from '../services/dataset';
import { detectSourceProfile } from '../data/sourceProfile';
import { applyTimelineFrame } from './TimelineControls';
import { prepareDataSource } from '../services/dataSourcePipeline';

interface Props {
  compId: string | null;
  open: boolean;
  onClose: () => void;
}

type Step = 'select' | 'preview' | 'map' | 'confirm';

export function ImportDataDialog({ compId, open, onClose }: Props) {
  const [step, setStep] = useState<Step>('select');
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, NumericFieldKey | ''>>({});
  const [strategy, setStrategy] = useState<'first' | 'last' | 'avg'>('last');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qualityPreview = useMemo(() => parsed ? prepareDataSource({
    id: `preview:${parsed.filename}`,
    filename: parsed.filename,
    format: parsed.format,
    headers: parsed.headers,
    rows: parsed.rows,
  }) : null, [parsed]);

  if (!open) return null;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const data = await parseFile(file);
      setParsed(data);
      const profile = detectSourceProfile(data.headers);
      const autoMapping: Record<string, NumericFieldKey | ''> = {};
      let matchedCount = 0;
      // PDF 是全局采集数据（电表/温度/热泵），不受当前部件白名单限制；
      // CSV/XLSX 按当前部件白名单过滤（避免 '环境温度'→at_temp 等跨部件误配）。
      const isGlobalSource = data.format === 'pdf' || profile.kind !== 'generic';
      const allowedKeys = isGlobalSource
        ? null
        : (compId ? getFieldOptionsForComponent(compId) : null);
      for (const header of data.headers) {
        const mapped = matchColumnToField(header);
        // 白名单存在时仅保留白名单内字段；否则保留自动匹配结果
        const keep = allowedKeys ? (mapped && allowedKeys.includes(mapped) ? mapped : null) : mapped;
        if (keep) matchedCount++;
        autoMapping[header] = keep ?? '';
      }
      setMapping(autoMapping);
      if (data.headers.length > 0) {
        // PDF：统计"已识别列数"（含仪表绑定列），而非仅 store 滑块映射列——
        // 电压/电流/温度等列由 PM/TS/PCM 仪表绑定承载，数据并未丢失。
        if (data.format === 'pdf') {
          const recognized = data.headers.filter(
            (h) => findPdfColumnMapping(h) != null,
          ).length;
          setError(
            recognized > 0
              ? `已识别 ${recognized}/${data.headers.length} 列（序号/采样时刻为元数据）。`
              : '未能识别 PDF 列结构。',
          );
        } else if (profile.kind !== 'generic') {
          setError(`已识别为${profile.label}；导入后将与已有其他类型数据源并存。`);
        } else if (matchedCount === 0) {
          setError(`未能自动匹配任何字段（${data.headers.length} 列）。请在下一步手动选择每列对应的部件字段。`);
        } else if (matchedCount < data.headers.length / 2) {
          setError(`自动匹配了 ${matchedCount}/${data.headers.length} 列。剩余列请在下一步手动选择。`);
        }
      }
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析失败');
    } finally {
      // 清空 input value 以便再次选择同名文件
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleNext = () => {
    if (step === 'preview') {
      setStep('map');
    } else if (step === 'map') {
      setStep('confirm');
    } else if (step === 'confirm') {
      const validMapping: Record<string, NumericFieldKey> = {};
      for (const [k, v] of Object.entries(mapping)) {
        if (v) validMapping[k] = v as NumericFieldKey;
      }
      // M2-β：保存完整数据集（含原始行 + 时间列检测），供仪表实例按 bind 显示 + 时序回放
      if (parsed) {
        const timeColumn = detectTimeColumn(parsed.headers, parsed.rows);
        const profile = detectSourceProfile(parsed.headers);
        useSimStore.getState().setInjectionDataset({
          sourceFile: parsed.filename,
          format: parsed.format,
          headers: parsed.headers,
          rows: parsed.rows,
          timeColumn,
          mapping: validMapping,
          role: profile.kind,
        });
        // setInjectionDataset 同步完成后，按当前主时间轴统一应用全部有效数据源。
        applyTimelineFrame(useSimStore.getState().timelineIndex);
      }
      useSimStore.getState().applyInjection({
        sourceFile: parsed?.filename ?? 'unknown',
        rowsCount: parsed?.rowCount ?? 0,
      });
      resetState();
      onClose();
    }
  };

  const handleBack = () => {
    if (step === 'preview') setStep('select');
    else if (step === 'map') setStep('preview');
    else if (step === 'confirm') setStep('map');
  };

  const handleCancel = () => {
    resetState();
    onClose();
  };

  const resetState = () => {
    setStep('select');
    setParsed(null);
    setMapping({});
    setError(null);
  };

  const validMappingForPreview: Record<string, NumericFieldKey> = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (v) validMappingForPreview[k] = v as NumericFieldKey;
  }
  const previewUpdates = parsed
    ? applyMapping(validMappingForPreview, parsed.rows, strategy)
    : {};
  const currentState = useSimStore.getState();

  return (
    <div
      className="import-data-overlay"
      onClick={(e) => {
        e.stopPropagation();
        handleCancel();
      }}
    >
      <div className="import-data-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-data-header">
          <h3>导入数据 — {compId ?? '当前部件'}</h3>
          <button onClick={handleCancel} aria-label="关闭">×</button>
        </div>
        <div className="import-data-body">
          {error && <div className="import-data-error">{error}</div>}

          {step === 'select' && (
            <div className="import-data-step">
              <p>选择 CSV / Excel / PDF 文件导入实验数据。</p>
              <p className="import-data-sub">
                首行为字段名，其余为数据；解析后会按列名自动匹配部件字段。
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,.pdf"
                onChange={handleFileSelect}
                hidden
              />
              <button
                className="import-data-btn primary"
                onClick={() => fileInputRef.current?.click()}
              >
                选择文件…
              </button>
            </div>
          )}

          {step === 'preview' && parsed && (
            <div className="import-data-step">
              <p className="import-data-summary">
                文件：<code>{parsed.filename}</code> · {parsed.rowCount} 行 × {parsed.headers.length} 列
              </p>
              {qualityPreview && (
                <div className="import-data-hint" role="status">
                  识别为：{qualityPreview.profile.label}；时间：
                  {qualityPreview.timeStats.start == null ? '未识别' : new Date(qualityPreview.timeStats.start).toLocaleString('zh-CN')}
                  {' ～ '}
                  {qualityPreview.timeStats.end == null ? '未识别' : new Date(qualityPreview.timeStats.end).toLocaleString('zh-CN')}。
                  {qualityPreview.quality.invalidRows > 0
                    ? ` 检测到 ${qualityPreview.quality.invalidRows} 行结构异常，确认导入后将保留原始行，但从注入、同步和统计中隔离。`
                    : ' 未检测到需要隔离的结构异常行。'}
                </div>
              )}
              <div className="import-data-table-wrap">
                <table className="import-data-table">
                  <thead>
                    <tr>
                      {parsed.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 5).map((row, i) => (
                      <tr key={i}>
                        {parsed.headers.map((h) => (
                          <td key={h}>{row[h]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > 5 && (
                <div className="import-data-hint">
                  仅显示前 5 行（共 {parsed.rows.length} 行）
                </div>
              )}
            </div>
          )}

          {step === 'map' && parsed && (
            <div className="import-data-step">
              <p>为每列选择要写入的部件字段（自动匹配已预填）：</p>
              {(() => {
                // PDF 数据是全局采集（电表/温度/热泵/水箱），不受当前部件白名单限制
                const profile = detectSourceProfile(parsed.headers);
                const isGlobalSource = parsed.format === 'pdf' || profile.kind !== 'generic';
                const allowedKeys = isGlobalSource ? null : (compId ? getFieldOptionsForComponent(compId) : null);
                const hasWhitelist = allowedKeys != null;
                const options = hasWhitelist
                  ? FIELD_OPTIONS.filter((o) => allowedKeys!.includes(o.value))
                  : FIELD_OPTIONS;
                if (hasWhitelist && options.length === 0) {
                  return (
                    <div className="import-data-hint">
                      当前部件（{compId}）无任何可导入字段。请先在部件详情页选择有数据源的部件。
                    </div>
                  );
                }
                return (
                  <div className="import-data-mapping">
                    {parsed.headers.map((h) => {
                      const pdfMap = parsed.format === 'pdf'
                        ? findPdfColumnMapping(h)
                        : null;
                      // PDF 载体去向标签：PM / TS / PCM（电压电流等由仪表绑定承载，不依赖 store 滑块映射）
                      const bindLabel = pdfMap?.meterBind
                        ? (PDF_BIND_LABELS[pdfMap.meterBind] ?? null)
                        : null;
                      return (
                      <div key={h} className="import-data-mapping-row">
                        <span className="col-name" title={h}>
                          {h}
                          {pdfMap && (
                            <span className="import-data-pdf-label">
                              {' '}[{pdfMap.chineseLabel}]
                            </span>
                          )}
                          {bindLabel && (
                            <span className="import-data-bind-label">
                              {' '}→ {bindLabel}
                            </span>
                          )}
                        </span>
                        <select
                          value={mapping[h] ?? ''}
                          onChange={(e) =>
                            setMapping((prev) => ({
                              ...prev,
                              [h]: e.target.value as NumericFieldKey | '',
                            }))
                          }
                        >
                          <option value="">（忽略此列）</option>
                          {options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      );
                    })}
                  </div>
                );
              })()}
              <div className="import-data-strategy">
                <label>多行数据策略：</label>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as 'first' | 'last' | 'avg')}
                >
                  <option value="first">取首行</option>
                  <option value="last">取末行</option>
                  <option value="avg">取平均</option>
                </select>
              </div>
            </div>
          )}

          {step === 'confirm' && parsed && (
            <div className="import-data-step">
              <p>预览注入后的字段值（与当前值对比）：</p>
              {Object.keys(previewUpdates).length === 0 ? (
                <div className="import-data-hint">
                  未映射任何字段，请返回上一步选择。
                </div>
              ) : (
                <div className="import-data-preview">
                  {Object.entries(previewUpdates).map(([field, value]) => {
                    const oldVal = (currentState as unknown as Record<string, unknown>)[field];
                    const oldStr =
                      typeof oldVal === 'number' ? oldVal.toFixed(2) : '-';
                    const newStr = typeof value === 'number' ? value.toFixed(2) : '-';
                    return (
                      <div key={field} className="import-data-preview-row">
                        <span className="field-name">{field}</span>
                        <span className="old-value">{oldStr}</span>
                        <span className="arrow">→</span>
                        <span className="new-value">{newStr}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="import-data-footer">
          {step !== 'select' && (
            <button onClick={handleBack}>上一步</button>
          )}
          {step === 'select' && (
            <button onClick={handleCancel}>取消</button>
          )}
          {step === 'preview' && (
            <button onClick={handleNext} className="primary">
              下一步：列映射
            </button>
          )}
          {step === 'map' && (
            <button onClick={handleNext} className="primary">
              下一步：预览
            </button>
          )}
          {step === 'confirm' && (
            <button
              onClick={handleNext}
              className="primary"
              disabled={Object.keys(previewUpdates).length === 0}
            >
              确认导入
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
