const STORE_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Client hot-reload is hello-driven: init registers the update hooks and kicks
 * off bundle resolution, so it must run before remote clients are (re)started —
 * their hellos are the update trigger.
 */
export function startClientHotReloadJob(
  enabled: boolean,
  initHotReload: () => void,
  startRemoteClients: () => Promise<void>,
): void {
  if (enabled) initHotReload();
  void startRemoteClients();
}

export function startStoreArchiveJob(
  enabled: boolean,
  runArchive: () => Promise<void>,
): void {
  if (!enabled) return;
  setInterval(runArchive, STORE_ARCHIVE_INTERVAL_MS);
}
