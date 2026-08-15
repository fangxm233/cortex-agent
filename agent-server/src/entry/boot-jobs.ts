// input:  boot settings and async startup callbacks
// output: guarded client reload and store archive timers
// pos:    Registers optional composition-root boot jobs
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

const CLIENT_HOT_RELOAD_DELAY_MS = 2_000;
const STORE_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startClientHotReloadJob(
  enabled: boolean,
  runProbe: () => Promise<void>,
  startRemoteClients: () => Promise<void>,
): void {
  if (!enabled) {
    void startRemoteClients();
    return;
  }
  setTimeout(async () => {
    await runProbe();
    await startRemoteClients();
  }, CLIENT_HOT_RELOAD_DELAY_MS);
}

export function startStoreArchiveJob(
  enabled: boolean,
  runArchive: () => Promise<void>,
): void {
  if (!enabled) return;
  setInterval(runArchive, STORE_ARCHIVE_INTERVAL_MS);
}
