interface DownloadedUpdate {
 download(onProgress?: (event: unknown) => void): Promise<void>;
 install(): Promise<void>;
}

export async function installBetaUpdate(
 update: DownloadedUpdate,
 prepare: () => Promise<void>,
 relaunch: () => Promise<void>,
 onProgress?: (event: unknown) => void,
): Promise<void> {
 await update.download(onProgress);
 await prepare();
 try { await update.install(); }
 finally { await relaunch(); }
}
