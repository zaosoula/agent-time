// Beta updates run entirely in the Rust host: it checks the feed, downloads, pauses the collector,
// installs and restarts the app. The dashboard only asks for a check, starts the install and shows
// download progress. The bridge is injectable so this logic can be tested without Tauri.

export interface BetaUpdateInfo {
  version: string;
  currentVersion: string;
  body?: string | null;
  /** Release date as unix seconds, when the feed provides one. */
  date?: number | null;
}

export type BetaUpdateProgress =
  | { event: 'Progress'; downloaded: number; total?: number | null }
  | { event: 'Finished' };

export interface UpdaterBridge {
  invoke<T>(command: string): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

export const progressEvent = 'beta-update-progress';

export function checkBetaUpdate(bridge: UpdaterBridge): Promise<BetaUpdateInfo | null> {
  return bridge.invoke<BetaUpdateInfo | null>('beta_update_check');
}

/**
 * Start the install. On success the host restarts the app, so this promise may never settle; on failure
 * it rejects with the host's error and the collector keeps running.
 */
export async function installBetaUpdate(
  bridge: UpdaterBridge,
  onProgress?: (progress: BetaUpdateProgress) => void,
): Promise<void> {
  const unlisten = await bridge.listen<BetaUpdateProgress>(progressEvent, (payload) => onProgress?.(payload));
  try {
    await bridge.invoke('beta_update_install');
  } finally {
    unlisten();
  }
}

/** Readable progress text for the install button. */
export function progressLabel(progress: BetaUpdateProgress | null): string {
  if (!progress) return 'Preparing update…';
  if (progress.event === 'Finished') return 'Installing and restarting…';
  if (progress.total && progress.total > 0)
    return `Downloading… ${Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))}%`;
  return 'Downloading…';
}

/** The Tauri bridge used by the desktop app. */
export async function tauriUpdaterBridge(): Promise<UpdaterBridge> {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  return {
    invoke: <T>(command: string) => invoke<T>(command),
    listen: async <T>(event: string, handler: (payload: T) => void) => {
      const dispose = await listen<T>(event, (message) => handler(message.payload));
      return dispose;
    },
  };
}
