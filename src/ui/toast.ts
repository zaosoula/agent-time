import { ref } from 'vue';
import { humanizeError } from './errors.ts';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  /** Optional action key. A later toast with the same key replaces this one. */
  key?: string;
  kind: ToastKind;
  message: string;
  /** Sticky toasts stay until dismissed or replaced by the same action succeeding. */
  sticky: boolean;
}

export const toasts = ref<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Remove toasts for an action key, e.g. when that action later succeeds. */
export function clearToast(key: string) {
  for (const toast of toasts.value.filter((item) => item.key === key)) dismissToast(toast.id);
}

function push(kind: ToastKind, message: string, options: { key?: string; sticky?: boolean } = {}) {
  if (options.key) clearToast(options.key);
  const toast: Toast = {
    id: nextId++,
    key: options.key,
    kind,
    message,
    sticky: options.sticky ?? kind === 'error',
  };
  toasts.value = [...toasts.value.slice(-4), toast];
  if (!toast.sticky) timers.set(toast.id, setTimeout(() => dismissToast(toast.id), 4000));
  return toast.id;
}

export const toast = {
  success: (message: string, key?: string) => push('success', message, { key }),
  info: (message: string, key?: string) => push('info', message, { key }),
  /** Action errors persist until dismissed or until the same action succeeds. */
  error: (cause: unknown, key?: string) => push('error', humanizeError(cause), { key, sticky: true }),
};
