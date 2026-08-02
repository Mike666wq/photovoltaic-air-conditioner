import { useToastStore } from '../store/toast';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.variant}`}
          onClick={() => dismiss(t.id)}
          role="status"
        >
          <span className="toast-icon" aria-hidden="true">
            {t.variant === 'success' && '✓'}
            {t.variant === 'warning' && '⚠'}
            {t.variant === 'error' && '✕'}
            {t.variant === 'info' && 'ⓘ'}
          </span>
          <span className="toast-message">{t.message}</span>
          <button
            className="toast-close"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(t.id);
            }}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
