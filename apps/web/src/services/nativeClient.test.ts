import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

function environment(origin = 'https://pv-ac.bbben.xyz') {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const postMessage = vi.fn();
  const window = { location: { origin }, pvAcNative: { postMessage }, top: null as unknown };
  window.top = window;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  return { document, window, postMessage };
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('客户端网页协议', () => {
  it('仅允许固定 HTTPS 站点主框架，并保留无桥接浏览器下载', async () => {
    const env = environment('http://pv-ac.bbben.xyz');
    const client = await import('./nativeClient');
    expect(client.nativeBridge()).toBeNull();
    env.window.location.origin = 'https://pv-ac.bbben.xyz';
    env.window.top = {};
    expect(client.nativeBridge()).toBeNull();
    env.window.top = env.window;
    expect(client.nativeBridge()).not.toBeNull();
    delete (env.window as { pvAcNative?: unknown }).pvAcNative;
    expect(client.saveNativeText('说明.txt', '内容')).toBeNull();
    client.installNativeClient();
    expect((env.window as unknown as Window).PvAcClient).toBeUndefined();
  });

  it('普通浏览器在隐藏时挂载，重新可见仍通知列表恢复', async () => {
    const env = environment();
    env.document.hidden = true;
    const foreground = await import('./clientForeground');
    const callback = vi.fn();
    const unsubscribe = foreground.subscribeClientForeground(callback);
    expect(foreground.isNativeForeground()).toBe(true);
    env.document.hidden = false;
    env.document.dispatchEvent(new Event('visibilitychange'));
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('Windows 发送同一 JSON，并识别 saved/failed 回执与投递异常', async () => {
    const env = environment();
    delete (env.window as { pvAcNative?: unknown }).pvAcNative;
    const postMessage = vi.fn();
    Object.assign(env.window, { chrome: { webview: { postMessage } } });
    const client = await import('./nativeClient');
    client.installNativeClient();
    const api = (env.window as unknown as Window).PvAcClient!;
    for (const status of ['saved', 'failed'] as const) {
      const result = client.saveNativeText('配置.txt', '内容');
      const message = JSON.parse(postMessage.mock.lastCall![0]);
      expect(message.type).toBe('saveText');
      api.onSaveResult(message.id, status);
      await expect(result).resolves.toBe(status);
    }
    postMessage.mockImplementation(() => { throw new Error('宿主不可用'); });
    await expect(client.saveNativeText('配置.txt', '内容')).resolves.toBe('failed');
    expect(api.canDiscard()).toBe(true);
  });

  it('复制只发送 copyText 与文本，共享 ID 回执并限制 UTF-8 1MiB', async () => {
    const env = environment();
    const client = await import('./nativeClient');
    client.installNativeClient();
    const api = (env.window as unknown as Window).PvAcClient!;
    expect(env.postMessage).not.toHaveBeenCalled();
    for (const status of ['saved', 'failed'] as const) {
      const result = client.copyNativeText('令牌或短 SHA');
      const message = JSON.parse(env.postMessage.mock.lastCall![0]);
      expect(message).toEqual({ type: 'copyText', id: expect.any(String), text: '令牌或短 SHA' });
      await expect(client.copyNativeText('重复请求')).resolves.toBe('failed');
      api.onSaveResult(message.id, status);
      await expect(result).resolves.toBe(status);
    }
    const sent = env.postMessage.mock.calls.length;
    await expect(client.copyNativeText('中'.repeat(350000))).resolves.toBe('failed');
    expect(env.postMessage).toHaveBeenCalledTimes(sent);
    const boundary = client.copyNativeText('a'.repeat(1024 * 1024));
    api.onSaveResult(JSON.parse(env.postMessage.mock.lastCall![0]).id, 'saved');
    await expect(boundary).resolves.toBe('saved');
    delete (env.window as { pvAcNative?: unknown }).pvAcNative;
    expect(client.copyNativeText('普通浏览器')).toBeNull();
  });

  it('限制文件名与 UTF-8 字节，拒绝路径和 Windows 保留名', async () => {
    environment();
    const { validNativeSave } = await import('./nativeClient');
    for (const name of ['../token.txt', 'a\\b.txt', 'CON.txt', 'nul', 'a\n.txt', 'a.txt.', '']) {
      expect(validNativeSave(name, '')).toBe(false);
    }
    expect(validNativeSave('配置.txt', 'a'.repeat(1024 * 1024))).toBe(true);
    expect(validNativeSave('配置.txt', '中'.repeat(350000))).toBe(false);
  });

  it('等待对应宿主回执，前后台合并且回放不自动重启，保留用户动画开关', async () => {
    const env = environment();
    const client = await import('./nativeClient');
    const { useSimStore } = await import('../store/simulation');
    const foreground = await import('./clientForeground');
    client.installNativeClient();
    const api = (env.window as unknown as Window).PvAcClient!;
    expect(api.canDiscard()).toBe(true);
    const result = client.saveNativeText('配置.txt', '私密内容');
    const message = JSON.parse(env.postMessage.mock.calls[0][0]);
    expect(message).toEqual({ type: 'saveText', id: expect.any(String), fileName: '配置.txt', text: '私密内容' });
    expect(api.canDiscard()).toBe(false);
    api.onSaveResult('unknown', 'saved');
    expect(api.canDiscard()).toBe(false);
    api.onSaveResult(message.id, 'cancelled');
    await expect(result).resolves.toBe('cancelled');
    expect(api.canDiscard()).toBe(true);
    useSimStore.setState({ timelinePlaying: true, animationOn: true });
    api.setForeground(false);
    expect(foreground.isNativeForeground()).toBe(false);
    expect(useSimStore.getState().timelinePlaying).toBe(false);
    expect(useSimStore.getState().animationOn).toBe(true);
    env.document.hidden = true;
    env.document.dispatchEvent(new Event('visibilitychange'));
    api.setForeground(true);
    expect(foreground.isNativeForeground()).toBe(false);
    env.document.hidden = false;
    env.document.dispatchEvent(new Event('visibilitychange'));
    expect(foreground.isNativeForeground()).toBe(true);
    expect(useSimStore.getState().timelinePlaying).toBe(false);
    useSimStore.setState({ animationOn: false });
    api.setForeground(false); api.setForeground(true);
    expect(useSimStore.getState().animationOn).toBe(false);
    expect(api.canDiscard()).toBe(false);
    client.markClientStateSaved();
    expect(api.canDiscard()).toBe(true);
    const unregister = client.registerDiscardGuard(() => false);
    expect(api.canDiscard()).toBe(false);
    unregister();
    expect(api.canDiscard()).toBe(true);
    useSimStore.setState({ injectionSources: [{} as never] });
    expect(api.canDiscard()).toBe(false);
  });

  it('返回键只关闭顶层弹窗，抽屉始终位于弹窗下面', async () => {
    environment();
    const { consumeModalBack, registerBackLayer } = await import('../hooks/useModalA11y');
    const parent = vi.fn(), child = vi.fn(), drawer = vi.fn();
    const removeParent = registerBackLayer(parent);
    const removeChild = registerBackLayer(child);
    const removeDrawer = registerBackLayer(drawer, 'drawer');
    expect(consumeModalBack()).toBe(true);
    expect(child).toHaveBeenCalledOnce();
    expect(parent).not.toHaveBeenCalled();
    expect(drawer).not.toHaveBeenCalled();
    removeChild();
    consumeModalBack(); expect(parent).toHaveBeenCalledOnce();
    removeParent();
    consumeModalBack(); expect(drawer).toHaveBeenCalledOnce();
    removeDrawer();
    expect(consumeModalBack()).toBe(false);
  });
});
