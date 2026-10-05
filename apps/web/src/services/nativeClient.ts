import { consumeModalBack } from '../hooks/useModalA11y';
import { enableNativeForeground, setNativeForeground, subscribeClientForeground, isClientForeground } from './clientForeground';
import { useSimStore } from '../store/simulation';
import { useAnalysisStore } from '../store/analysis';
import { serializeState } from './stateSerializer';
type SaveStatus = 'saved' | 'cancelled' | 'failed';
interface ClientApi { back(): boolean; setForeground(value: boolean): void; canDiscard(): boolean; onSaveResult(id: string, status: SaveStatus): void; }
declare global {
  interface Window {
    PvAcClient?: ClientApi;
    pvAcNative?: { postMessage(message: string): void };
    chrome?: { webview?: { postMessage(message: string): void } };
  }
}
const pending = new Map<string, (status: SaveStatus) => void>();
export function nativeBridge() {
  if (window.top !== window || window.location.origin !== 'https://pv-ac.bbben.xyz') return null;
  if (typeof window.pvAcNative?.postMessage === 'function') return (message: string) => window.pvAcNative!.postMessage(message);
  if (typeof window.chrome?.webview?.postMessage === 'function') return (message: string) => window.chrome!.webview!.postMessage(message);
  return null;
}
export function validNativeSave(fileName: string, text: string): boolean {
  return fileName.length > 0 && fileName.length <= 180 && !/[\\/\x00-\x1f<>:"|?*]/.test(fileName)
    && fileName !== '.' && fileName !== '..' && !/[. ]$/.test(fileName)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)
    && new TextEncoder().encode(text).byteLength <= 1024 * 1024;
}
/** 两种写入命令共享相关 ID 和宿主回执，不读取系统剪贴板。 */
function postNativeWrite(command: { type: 'saveText'; fileName: string; text: string } | { type: 'copyText'; text: string }): Promise<SaveStatus> | null {
  const post = nativeBridge();
  if (!post) return null;
  const valid = command.type === 'saveText' ? validNativeSave(command.fileName, command.text)
    : new TextEncoder().encode(command.text).byteLength <= 1024 * 1024;
  if (!valid || pending.size) return Promise.resolve('failed');
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    pending.set(id, resolve);
    try { post(JSON.stringify({ ...command, id })); }
    catch { pending.delete(id); resolve('failed'); }
  });
}
/** 返回 null 时使用浏览器下载；客户端结果必须由宿主确认。 */
export function saveNativeText(fileName: string, text: string): Promise<SaveStatus> | null {
  return postNativeWrite({ type: 'saveText', fileName, text });
}
/** 只在用户主动点击复制时调用，返回 null 时沿用浏览器写入接口。 */
export function copyNativeText(text: string): Promise<SaveStatus> | null {
  return postNativeWrite({ type: 'copyText', text });
}
function persistentSignature() {
  const { simulation, layout, preferences } = serializeState('');
  return JSON.stringify({ simulation, layout, preferences });
}
let installed = false;
let baseline = '';
const discardGuards = new Set<() => boolean>();
export function registerDiscardGuard(guard: () => boolean) {
  discardGuards.add(guard);
  return () => { discardGuards.delete(guard); };
}
export function markClientStateSaved() { if (installed) baseline = persistentSignature(); }
export function installNativeClient() {
  if (installed || !nativeBridge()) return;
  installed = true;
  baseline = persistentSignature();
  enableNativeForeground();
  window.PvAcClient = {
    back: consumeModalBack,
    setForeground(value) { if (typeof value === 'boolean') setNativeForeground(value); },
    canDiscard() {
      const sim = useSimStore.getState();
      return [...discardGuards].every(guard => guard()) && !pending.size && !sim.injectionDataset && !sim.injectionSources.length
        && !useAnalysisStore.getState().sources.length && persistentSignature() === baseline;
    },
    onSaveResult(id, status) {
      if (!['saved', 'cancelled', 'failed'].includes(status)) return;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id); resolve(status);
    },
  };
  subscribeClientForeground(() => {
    if (!isClientForeground()) useSimStore.getState().setTimelinePlaying(false);
  });
  if (!isClientForeground()) useSimStore.getState().setTimelinePlaying(false);
}
