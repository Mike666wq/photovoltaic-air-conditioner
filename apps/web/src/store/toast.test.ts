// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from './toast';

describe('Toast 自动消失与去重', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    useToastStore.getState().clear();
  });

  it('普通 toast 到期后自动消失', () => {
    useToastStore.getState().push('info', '导入完成', { duration: 3000 });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('同文案重复推送会刷新存活时长，而不是在原到期时刻被提前删掉（回归：曾只活 1 秒）', () => {
    useToastStore.getState().push('info', '导入完成', { duration: 3000 });
    vi.advanceTimersByTime(2000);
    useToastStore.getState().push('info', '导入完成', { duration: 3000 });
    // 去重后仍只有一条
    expect(useToastStore.getState().toasts).toHaveLength(1);
    // 原到期时刻（t=3000）刚过，应仍然可见
    vi.advanceTimersByTime(1200);
    expect(useToastStore.getState().toasts, 't=3200 时提示被旧定时器提前删掉了').toHaveLength(1);
    // 刷新后的 3000ms 才到期
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('去重后返回的 id 指向仍然存在的 toast', () => {
    const first = useToastStore.getState().push('info', '重复消息', { duration: 3000 });
    const second = useToastStore.getState().push('info', '重复消息', { duration: 3000 });
    expect(second).toBe(first);
    expect(useToastStore.getState().toasts.map((t) => t.id)).toContain(second);
  });

  it('手动 dismiss 后不再残留定时器二次触发', () => {
    const id = useToastStore.getState().push('error', '导入失败', { duration: 5000 });
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // 旧定时器到点不应报错或复活任何东西
    expect(() => vi.advanceTimersByTime(6000)).not.toThrow();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('不同文案不合并，各自独立到期', () => {
    useToastStore.getState().push('info', 'A', { duration: 2000 });
    useToastStore.getState().push('error', 'B', { duration: 4000 });
    expect(useToastStore.getState().toasts).toHaveLength(2);
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('duration 为 0 表示常驻', () => {
    useToastStore.getState().push('info', '常驻', { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
