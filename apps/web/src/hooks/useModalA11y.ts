import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const modalStack: symbol[] = [];

/**
 * 弹窗无障碍：Esc 关闭 + 打开时移焦 + Tab 焦点陷阱 + 关闭后焦点归位。
 *
 * 修的是实测到的两类问题：
 *  1. 全应用 4 个弹窗的 Esc 只在各自组件内部零散处理，弹窗外壳层一个都没有 ——
 *     「数据质量」中心按两轮 Escape 仍不关闭，只能点遮罩。
 *  2. 打开后 document.activeElement 停在 BODY，键盘用户无法直接进入弹窗；
 *     Tab 会跑到背后的画布上。
 */
export function useModalA11y(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const modalId = Symbol('modal');
    modalStack.push(modalId);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // 移焦用 setTimeout 而非 requestAnimationFrame：
    // rAF 在后台标签页 / 无头浏览器中会被节流甚至不触发，弹窗打开后焦点会永远留在 BODY。
    // 若首次仍未取到焦点（元素当时还是 0×0 或 display:none），最多再重试 3 次。
    let retryTimer = 0;
    let attempts = 0;
    const focusFirst = () => {
      if (modalStack[modalStack.length - 1] !== modalId) return;
      attempts += 1;
      const target = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      if (target) {
        target.focus();
        if (document.activeElement === target || ref.current?.contains(document.activeElement)) return;
      }
      if (attempts < 4) retryTimer = window.setTimeout(focusFirst, 60);
    };
    const focusTimer = window.setTimeout(focusFirst, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== modalId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;

      const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => element.getBoundingClientRect().width > 0);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !ref.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(retryTimer);
      document.removeEventListener('keydown', onKeyDown);
      const stackIndex = modalStack.lastIndexOf(modalId);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  return ref;
}
