import type { Vocab } from '@/i18n/vocab';
import { nativeErrorText } from '@/lib/native-error';

// Codes `install_app_update` rejects with (desktop/src-tauri/src/update_checks.rs + app_update.rs,
// and the Android plugin's ApkInstaller.kt / DownloadPlugin.kt), as `code` or `code: detail`.
function installErrorCopy(L: Vocab): Record<string, string> {
  return {
    update_in_progress: L.updateCheckInProgress,
    restart_or_install_pending: L.updateCheckRestartPending,
    update_worker_failed: L.updateErrWorker,
    update_lock_poisoned: L.updateErrLock,
    no_update_prepared: L.updateErrNoUpdate,
    update_verification_failed: L.updateErrVerification,
    download_dir_unavailable: L.updateErrDownloadDir,
    installer_copy_failed: L.updateErrCopy,
    command_failed: L.updateErrCommand,
    disk_image_unreadable: L.updateErrDiskImage,
    no_app_bundle: L.updateErrNoBundle,
    app_replace_failed: L.updateErrReplace,
    installer_launch_failed: L.updateErrLaunch,
    relaunch_failed: L.updateErrRelaunch,
    install_unsupported: L.updateErrUnsupported,
    elevation_failed: L.updateErrElevation,
    apk_not_found: L.updateErrApkMissing,
    apk_install_failed: L.updateErrApkHandoff,
    apk_installer_refused: L.updateErrApkRefused,
    apk_commit_failed: L.updateErrApkCommit,
  };
}

/** The shell's install failure in the UI language; its technical detail follows in parentheses. */
export function installErrorText(error: string, L: Vocab): string {
  return nativeErrorText(error, installErrorCopy(L));
}
