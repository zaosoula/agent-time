interface DownloadedUpdate {
 download(onProgress?: (event: unknown) => void): Promise<void>;
 install(): Promise<void>;
}

export async function installBetaUpdate(
 update: DownloadedUpdate,
 prepare: () => Promise<void>,
 relaunch: () => Promise<void>,
 onProgress?: (event: unknown) => void,
 recover?: () => Promise<void>,
): Promise<void> {
 await update.download(onProgress);
 try { await prepare(); await update.install(); }
 finally {
  try { await relaunch(); }
  catch(error){await recover?.();throw error;}
 }
}
