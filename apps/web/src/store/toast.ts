import { create } from 'zustand';

export type ToastVariant = 'success' | 'warning' | 'error' | 'info';

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  duration: number;
  createdAt: number;
}

interface ToastStore {
  toasts: Toast[];
  push: (variant: ToastVariant, message: string, opts?: { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULTS: Record<ToastVariant, number> = {
  success: 2500,
  info: 3000,
  warning: 4000,
  error: 5000,
};

const MAX_TOASTS = 5;

let counter = 0;
const nextId = () => `toast-${Date.now()}-${counter++}`;

/**
 * 每个 toast id 对应的自动消失定时器。
 *
 * 去重（同文案同类型再次 push）时会复用旧 id 并刷新存活时长：
 * 若不取消旧定时器，刷新后的提示会在「原始到期时刻」被提前删掉（实测只活 1 秒）；
 * 若按新生成的 id 排定时器，又会去 dismiss 一个不存在的 id。
 * 用这张表统一管理，两种问题一起消掉。
 */
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (variant, message, opts) => {
    const id = nextId();
    const duration = opts?.duration ?? DEFAULTS[variant];
    const toast: Toast = {
      id,
      variant,
      message,
      duration,
      createdAt: Date.now(),
    };

    set((state) => {
      const existing = state.toasts.find(
        (t) => t.message === message && t.variant === variant,
      );
      let next = state.toasts;
      if (existing) {
        next = state.toasts.filter((t) => t.id !== existing.id);
        toast.id = existing.id;
      }
      const updated = [toast, ...next];
      while (updated.length > MAX_TOASTS) updated.pop();
      return { toasts: updated };
    });

    // 去重时 toast.id 会被改成既有那条的 id，所以最终生效的 id 必须在 set 之后重新取。
    // 原先直接返回新生成的 id，调用方拿它 dismiss() 会找不到任何 toast。
    const finalId = get().toasts.find((t) => t.message === message && t.variant === variant)?.id ?? id;

    if (duration > 0) {
      const previous = autoDismissTimers.get(finalId);
      if (previous) clearTimeout(previous);
      autoDismissTimers.set(finalId, setTimeout(() => {
        autoDismissTimers.delete(finalId);
        get().dismiss(finalId);
      }, duration));
    }

    return finalId;
  },
  dismiss: (id) => {
    const timer = autoDismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      autoDismissTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  success: (message: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('success', message, opts),
  warning: (message: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('warning', message, opts),
  error: (message: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('error', message, opts),
  info: (message: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('info', message, opts),
};
