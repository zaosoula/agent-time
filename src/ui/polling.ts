import { ref } from 'vue';
import { native } from './transport.ts';

/**
 * True while the dashboard window can be seen. Closing the window hides it to the menu bar, so we
 * watch both `visibilitychange` and a blur followed by the native window reporting itself hidden.
 */
export const windowVisible = ref(typeof document === 'undefined' || document.visibilityState === 'visible');
/** True while the window has keyboard focus. */
export const windowFocused = ref(typeof document === 'undefined' || document.hasFocus());

let visibilityStarted = false;
export function watchWindowVisibility() {
  if (visibilityStarted || typeof document === 'undefined') return;
  visibilityStarted = true;
  document.addEventListener('visibilitychange', () => {
    windowVisible.value = document.visibilityState === 'visible';
  });
  window.addEventListener('focus', () => {
    windowFocused.value = true;
    windowVisible.value = document.visibilityState === 'visible';
  });
  window.addEventListener('blur', () => {
    windowFocused.value = false;
    if (!native) return;
    // A hidden native window may not fire visibilitychange in WKWebView; ask the window itself.
    setTimeout(async () => {
      if (windowFocused.value) return;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (!windowFocused.value && !(await getCurrentWindow().isVisible())) windowVisible.value = false;
      } catch {
        /* Keep the visibility state reported by the document. */
      }
    }, 400);
  });
}

export interface Poller {
  /** Re-evaluate whether the poller should run, starting or stopping it. */
  sync(): void;
  /** Run now (after any in-flight request) and reschedule. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Chained-timeout poller: one request at a time, no overlap. `interval` returns the delay in ms, or
 * null while polling should be paused (for example when the page is hidden or not showing the data).
 */
export function createPoller(task: () => Promise<unknown>, interval: () => number | null): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined,
    inflight: Promise<void> | undefined,
    again = false,
    active = false;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    clear();
    const delay = interval();
    if (delay === null) {
      active = false;
      return;
    }
    timer = setTimeout(() => void run(), delay);
  }
  function run(): Promise<void> {
    clear();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        await task();
      } catch {
        /* Tasks report their own errors. */
      }
    })().finally(() => {
      inflight = undefined;
      if (again) {
        again = false;
        void run();
      } else if (active) schedule();
    });
    return inflight;
  }
  return {
    sync() {
      const enabled = interval() !== null;
      if (enabled && !active) {
        active = true;
        void run();
      } else if (!enabled && active) {
        active = false;
        clear();
      } else if (enabled && !inflight) {
        // The delay may have changed (for example a different page); restart the countdown.
        schedule();
      }
    },
    refresh() {
      return run();
    },
    stop() {
      active = false;
      clear();
    },
  };
}
