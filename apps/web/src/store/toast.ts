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

    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }

    return id;
  },
  dismiss: (id) => {
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
