import { useSyncExternalStore } from 'react';

let nativeEnabled = false;
let nativeForeground = true;
let previous = true;
const listeners = new Set<() => void>();
/** 普通浏览器沿用原来的可见性行为，客户端同时要求窗口和文档可见。 */
export const isClientForeground = () => !document.hidden && (!nativeEnabled || nativeForeground);
export const isNativeForeground = () => !nativeEnabled || isClientForeground();
function notify() {
  const next = isClientForeground();
  if (next === previous) return;
  previous = next;
  listeners.forEach(listener => listener());
}
export function subscribeClientForeground(listener: () => void) {
  if (!listeners.size) previous = isClientForeground();
  listeners.add(listener);
  document.addEventListener('visibilitychange', notify);
  return () => { listeners.delete(listener); if (!listeners.size) document.removeEventListener('visibilitychange', notify); };
}
export function enableNativeForeground() { nativeEnabled = true; previous = isClientForeground(); }
export function setNativeForeground(value: boolean) { nativeForeground = value; notify(); }
export function useNativeForeground() { return useSyncExternalStore(subscribeClientForeground, isNativeForeground, () => true); }
