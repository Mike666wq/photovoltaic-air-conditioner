import { useEffect, useState } from 'react';
import { useModalA11y } from '../hooks/useModalA11y';
import {
  serializeState,
  validateDocument,
  applyDocumentToStore,
  DocumentValidationError,
} from '../services/stateSerializer';
import {
  list as listScenarios,
  load as loadScenario,
  save as saveScenario,
  remove as removeScenario,
  type ScenarioFile,
} from '../services/scenarioStorage';
import { toast } from '../store/toast';

interface Props {
  open: boolean;
  onClose: () => void;
}

function defaultName(): string {
  return '未命名场景-' + new Date().toISOString().slice(0, 10);
}

function safeName(input: string): string {
  // 去掉 .json 后缀；过滤非法字符
  let n = input.trim();
  if (n.toLowerCase().endsWith('.json')) {
    n = n.slice(0, -5);
  }
  n = n.replace(/[/\\:*?"<>|]/g, '_');
  return n;
}

function toFilename(input: string): string {
  return safeName(input) + '.json';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SaveManager({ open: isOpen, onClose }: Props) {
  const [scenarioName, setScenarioName] = useState(defaultName());
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [files, setFiles] = useState<ScenarioFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const modalRef = useModalA11y(isOpen, () => {
    setPendingOverwrite(null);
    setPendingDelete(null);
    setSaveAsOpen(false);
    onClose();
  });
  const confirmationPending = pendingOverwrite !== null || pendingDelete !== null;

  const handleClose = () => {
    setPendingOverwrite(null);
    setPendingDelete(null);
    setSaveAsOpen(false);
    onClose();
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const list = await listScenarios();
      setFiles(list);
    } catch (err) {
      console.error('获取文件列表失败:', err);
      toast.warning(`获取文件列表失败：${(err as Error).message || '未知错误'}`);
    }
    setBusy(false);
  };

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setRestoreNotice(null);
      setScenarioName((prev) => prev || defaultName());
      refresh();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    const targetName = currentFileName ?? toFilename(safeName(scenarioName));
    if (!safeName(scenarioName)) {
      setError('名称不能为空');
      return;
    }
    setError(null);
    if (!currentFileName && files.some((file) => file.name === targetName)) {
      setSaveAsName(safeName(scenarioName));
      setSaveAsOpen(true);
      setPendingOverwrite(targetName);
      return;
    }
    setBusy(true);
    try {
      const doc = serializeState(targetName.replace(/\.json$/i, ''));
      await saveScenario(targetName, doc);
      setCurrentFileName(targetName);
      await refresh();
      toast.success(`已保存到 ${targetName}`);
    } catch (err) {
      console.error('保存失败:', err);
      setError((err as Error).message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const persistAs = async (confirmedTarget?: string) => {
    const base = safeName(confirmedTarget?.replace(/\.json$/i, '') ?? saveAsName);
    if (!base) {
      setError('名称不能为空');
      return;
    }
    const targetName = toFilename(base);
    if (!confirmedTarget && targetName !== currentFileName && files.some((file) => file.name === targetName)) {
      setPendingOverwrite(targetName);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const doc = serializeState(base);
      await saveScenario(targetName, doc);
      setScenarioName(base);
      setCurrentFileName(targetName);
      setPendingOverwrite(null);
      setSaveAsOpen(false);
      await refresh();
      toast.success(`已另存为 ${targetName}`);
    } catch (err) {
      console.error('另存失败:', err);
      setError((err as Error).message || '另存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (filename: string) => {
    setBusy(true);
    try {
      setError(null);
      const doc = await loadScenario(filename);
      const validated = validateDocument(doc);
      const applied = await applyDocumentToStore(validated);
      // 同步"当前名称"为去掉 .json 的形式
      setScenarioName(filename.replace(/\.json$/i, ''));
      setCurrentFileName(filename);
      if (applied.dataSession === 'restored') {
        const message = `已打开 ${filename}，并恢复 ${applied.restoredBatchIds.length} 个实验批次`;
        setRestoreNotice(message);
        toast.success(message);
      } else if (applied.dataSession === 'partial' || applied.dataSession === 'missing') {
        const message = applied.dataSession === 'partial'
          ? `已恢复场景布局和 ${applied.restoredBatchIds.length} 个完整实验批次；${applied.missingSourceIds.length} 个数据源缓存缺失，请重新导入对应原始文件`
          : `已恢复场景布局；数据缓存缺失，保留当前数据会话；${applied.missingSourceIds.length} 个数据源需重新导入`;
        setRestoreNotice(message);
        toast.warning(message);
      } else {
        toast.success(`已打开 ${filename}`);
      }
      onClose();
    } catch (err) {
      console.error('打开失败:', err);
      if (err instanceof DocumentValidationError) {
        toast.error(`文件验证失败: ${err.message}`);
      } else {
        toast.error((err as Error).message || '打开失败');
      }
    }
    setBusy(false);
  };

  const handleDelete = async (filename: string) => {
    setBusy(true);
    try {
      setError(null);
      await removeScenario(filename);
      setPendingDelete(null);
      await refresh();
      toast.success(`已删除 ${filename}`);
    } catch (err) {
      console.error('删除失败:', err);
      toast.warning((err as Error).message || '删除失败');
    }
    setBusy(false);
  };

  return (
    <div className="save-manager-overlay" onClick={handleClose}>
      <div ref={modalRef} className="save-manager-modal" role="dialog" aria-modal="true" aria-labelledby="save-manager-title" onClick={(e) => e.stopPropagation()}>
        <div className="save-manager-header">
          <h3 id="save-manager-title">💾 状态管理</h3>
          <button onClick={handleClose} aria-label="关闭">×</button>
        </div>
        <div className="save-manager-body">
          {error && <div className="save-manager-error">{error}</div>}
          {restoreNotice && <div className="save-manager-hint" role="status">{restoreNotice}</div>}

          <div className="save-manager-section">
            <h4>当前状态</h4>
            <div className="save-manager-row save-manager-name-row">
              <label>名称</label>
              <input
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder="未命名场景"
                disabled={confirmationPending}
              />
              {currentFileName && (
                <span className="save-manager-current-file">当前: {currentFileName}</span>
              )}
            </div>
            <div className="save-manager-hint">
              保存在 <code>/scenarios/</code> 目录（项目根）
            </div>
            <div className="save-manager-actions">
              <button
                className="primary"
                disabled={busy || confirmationPending || !safeName(scenarioName)}
                onClick={handleSave}
              >
                保存
              </button>
              <button
                className="primary"
                disabled={busy || confirmationPending}
                onClick={() => {
                  setSaveAsName(currentFileName?.replace(/\.json$/i, '') ?? scenarioName);
                  setSaveAsOpen((open) => !open);
                  setPendingOverwrite(null);
                }}
              >
                另存为
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => refresh()}
              >
                刷新列表
              </button>
            </div>
            {saveAsOpen && <div className="save-manager-inline-confirm">
              <label>另存为名称<input autoFocus value={saveAsName} disabled={Boolean(pendingOverwrite)} onChange={(event) => setSaveAsName(event.target.value)} /></label>
              <button disabled={busy || !safeName(saveAsName)} onClick={() => persistAs()}>确认另存</button>
              <button disabled={busy} onClick={() => { setSaveAsOpen(false); setPendingOverwrite(null); }}>取消</button>
            </div>}
            {pendingOverwrite && <div className="save-manager-inline-confirm" role="alert">
              <span>“{pendingOverwrite}”已存在，覆盖该场景？</span>
              <button disabled={busy} onClick={() => persistAs(pendingOverwrite)}>覆盖</button>
              <button disabled={busy} onClick={() => setPendingOverwrite(null)}>取消</button>
            </div>}
          </div>

          <div className="save-manager-section">
            <h4>文件列表</h4>
            {files.length === 0 ? (
              <div className="save-manager-empty">尚无保存的场景</div>
            ) : (
              <div className="save-manager-recent">
                {files.map((f) => (
                  <div key={f.name} className="save-manager-recent-item">
                    <div className="save-manager-recent-info">
                      <div className="save-manager-recent-name">{f.name}</div>
                      <div className="save-manager-recent-file">
                        {formatTime(f.savedAt)} · {formatBytes(f.size)}
                      </div>
                    </div>
                    <div className="save-manager-recent-actions">
                      <button
                        className="primary"
                        disabled={busy || confirmationPending}
                        onClick={() => handleOpen(f.name)}
                      >
                        打开
                      </button>
                      <button
                        className="danger"
                        disabled={busy || confirmationPending}
                        onClick={() => setPendingDelete(f.name)}
                      >
                        删除
                      </button>
                      {pendingDelete === f.name && <div className="save-manager-inline-confirm" role="alert">
                        <span>删除“{f.name}”？此操作不可撤销。</span>
                        <button className="danger" disabled={busy} onClick={() => handleDelete(f.name)}>确认删除</button>
                        <button disabled={busy} onClick={() => setPendingDelete(null)}>取消</button>
                      </div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="save-manager-footer">
          <button onClick={handleClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>
  );
}
