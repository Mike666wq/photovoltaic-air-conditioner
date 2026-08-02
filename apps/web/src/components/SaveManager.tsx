import { useEffect, useState } from 'react';
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
  const [busy, setBusy] = useState(false);

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
      setScenarioName((prev) => prev || defaultName());
      refresh();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setBusy(true);
    let targetName = currentFileName;
    if (!targetName) {
      const raw = window.prompt('请输入保存名称', scenarioName);
      if (!raw) {
        setBusy(false);
        return;
      }
      const base = safeName(raw);
      if (!base) {
        setError('名称不能为空');
        setBusy(false);
        return;
      }
      setError(null);
      targetName = toFilename(base);
    }
    try {
      const doc = serializeState(targetName.replace(/\.json$/i, ''));
      await saveScenario(targetName, doc);
      setCurrentFileName(targetName);
      await refresh();
      toast.success(`已保存到 ${targetName}`);
    } catch (err) {
      console.error('保存失败:', err);
      toast.warning((err as Error).message || '保存失败');
    }
    setBusy(false);
  };

  const handleSaveAs = async () => {
    setBusy(true);
    const raw = window.prompt('另存为新名称（不含扩展名）', currentFileName ?? scenarioName);
    if (raw == null) {
      setBusy(false);
      return;
    }
    const base = safeName(raw);
    if (!base) {
      setError('名称不能为空');
      setBusy(false);
      return;
    }
    setError(null);
    setScenarioName(base);
    const targetName = toFilename(base);
    try {
      const doc = serializeState(base);
      await saveScenario(targetName, doc);
      setCurrentFileName(targetName);
      await refresh();
      toast.success(`已另存为 ${targetName}`);
    } catch (err) {
      console.error('另存失败:', err);
      toast.warning((err as Error).message || '另存失败');
    }
    setBusy(false);
  };

  const handleOpen = async (filename: string) => {
    setBusy(true);
    try {
      setError(null);
      const doc = await loadScenario(filename);
      const validated = validateDocument(doc);
      applyDocumentToStore(validated);
      // 同步"当前名称"为去掉 .json 的形式
      setScenarioName(filename.replace(/\.json$/i, ''));
      setCurrentFileName(filename);
      toast.success(`已打开 ${filename}`);
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
    const ok = window.confirm(`删除 "${filename}"？此操作不可撤销。`);
    if (!ok) return;
    setBusy(true);
    try {
      setError(null);
      await removeScenario(filename);
      await refresh();
      toast.success(`已删除 ${filename}`);
    } catch (err) {
      console.error('删除失败:', err);
      toast.warning((err as Error).message || '删除失败');
    }
    setBusy(false);
  };

  return (
    <div className="save-manager-overlay" onClick={onClose}>
      <div className="save-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="save-manager-header">
          <h3>💾 状态管理</h3>
          <button onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="save-manager-body">
          {error && <div className="save-manager-error">{error}</div>}

          <div className="save-manager-section">
            <h4>当前状态</h4>
            <div className="save-manager-row save-manager-name-row">
              <label>名称</label>
              <input
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder="未命名场景"
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
                disabled={busy || !safeName(scenarioName)}
                onClick={handleSave}
              >
                保存
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={handleSaveAs}
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
                        disabled={busy}
                        onClick={() => handleOpen(f.name)}
                      >
                        打开
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => handleDelete(f.name)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="save-manager-footer">
          <button onClick={onClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>
  );
}
