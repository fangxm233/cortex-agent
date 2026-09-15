// input:  Shell manifests, download store, platform installers
// output: Typed check outcomes and verified installable shell assets
// pos:    App shell update selection, preparation and installation
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
//
// Server side: agent-server `platform/ui-http/app-update.ts` serves /api/app-update/manifest.json —
// the newest GitHub release carrying native app assets, CAPPED at the server's own version, so this
// shell is never offered a version newer than the server it talks to. This module fetches that
// manifest, compares CalVer versions, picks the asset for the running platform, downloads it from
// the GitHub CDN (streamed to disk, sha256-verified), and stores it under `<appDataDir>/updates/`.
// Installing is platform-branched (see `install`): Windows hands off to the NSIS installer, an
// AppImage swaps itself in place and relaunches, deb/rpm/dmg are copied to Downloads and opened,
// Android fires the system package installer via the cortex-download plugin.
//
// Dev builds are protected by `is_calver`: a non-CalVer own version (e.g. tauri.conf.json's dev
// `0.0.1`) disables the whole check, so only release-stamped builds ever prompt.

use std::cmp::Ordering;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::update_checks::ChannelOutcome;

/// Same-origin manifest path served by agent-server `platform/ui-http/app-update.ts`.
pub const MANIFEST_PATH: &str = "/api/app-update/manifest.json";

// ─── Manifest shapes ────────────────────────────────────────────────────────

/// The app-update manifest. The server serves `{}` when no qualifying release exists, so every
/// field is defaulted — a version-less manifest simply means "no update".
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default, rename = "releaseUrl")]
    pub release_url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// One installable release asset. `os`/`arch`/`kind` are the server-normalized names
/// (os: linux/windows/macos/android; arch: x86_64/aarch64/universal; kind:
/// appimage/deb/rpm/nsis/dmg/apk).
#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub os: String,
    pub arch: String,
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
    pub sha256: String,
}

/// A downloaded, verified app update ready to install. Emitted to the SPA (`app-update-available`
/// event) and returned by the `get_app_update` command; `path`/`sha256` are shell-internal.
#[derive(Debug, Clone, Serialize)]
pub struct AppUpdate {
    pub version: String,
    #[serde(rename = "releaseUrl")]
    pub release_url: Option<String>,
    pub notes: Option<String>,
    pub size: u64,
    pub kind: String,
    /// What will happen to this update: `silent` — it will be installed on its own when the app
    /// next quits, so the SPA must NOT raise a modal; `prompt` — the user has to decide.
    pub apply: String,
    /// Local path of the verified download — not serialized (the SPA never sees paths).
    #[serde(skip)]
    pub path: PathBuf,
    /// Expected sha256, kept for the install-time re-verification of the on-disk file.
    #[serde(skip)]
    pub sha256: String,
}

// ─── CalVer ─────────────────────────────────────────────────────────────────

/// `YYYY.M.D[-N]` → [year, month, day, suffix]; unparseable elements become 0 (mirror of the
/// server's forgiving parse — ordering only has to be right for real CalVer strings).
fn parse_calver(v: &str) -> [u32; 4] {
    let mut parts = v.split('.');
    let year = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let month = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut day_suffix = parts.next().unwrap_or("0").split('-');
    let day = day_suffix.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let suffix = day_suffix.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    [year, month, day, suffix]
}

/// Compare CalVer `YYYY.M.D[-N]` strings. The `-N` hotfix suffix sorts ABOVE the plain version
/// (mirror of the server's compareCalVer; the opposite of semver prerelease ordering — which is
/// why semver comparison must never be used on these versions).
pub fn compare_calver(a: &str, b: &str) -> Ordering {
    parse_calver(a).cmp(&parse_calver(b))
}

/// True when `v` parses as a CalVer version with a plausible year (>= 2000). The dev build version
/// (tauri.conf.json `0.0.1`) fails this, which disables the update check on dev builds entirely.
pub fn is_calver(v: &str) -> bool {
    let dotted: Vec<&str> = v.split('.').collect();
    if dotted.len() != 3 {
        return false;
    }
    let year: u32 = match dotted[0].parse() {
        Ok(y) => y,
        Err(_) => return false,
    };
    if year < 2000 || dotted[1].parse::<u32>().is_err() {
        return false;
    }
    let mut day_suffix = dotted[2].split('-');
    let day_ok = day_suffix.next().is_some_and(|d| d.parse::<u32>().is_ok());
    let suffix_ok = match day_suffix.next() {
        Some(s) => s.parse::<u32>().is_ok(),
        None => true,
    };
    day_ok && suffix_ok
}

/// Why the background shell-update check must not run, or None when it may. Pure over its inputs
/// (the env values are read by the caller). Dev mode is detected by the `CORTEX_FRONTEND_DIR`
/// override: a shell serving the SPA from a local dir is a development run, never an installed
/// app. The env kill-switch and the non-CalVer (unstamped build) version stay as guards too.
pub fn check_disabled_reason(
    env_disable: Option<&str>,
    dev_frontend_dir: Option<&str>,
    own_version: &str,
) -> Option<String> {
    if env_disable == Some("1") {
        return Some("disabled by CORTEX_APP_UPDATE_DISABLE".to_string());
    }
    if dev_frontend_dir.is_some_and(|d| !d.trim().is_empty()) {
        return Some("dev mode (CORTEX_FRONTEND_DIR is set)".to_string());
    }
    if !is_calver(own_version) {
        return Some(format!("dev version {own_version}"));
    }
    None
}

// ─── Asset selection ────────────────────────────────────────────────────────

/// Pick the asset for this platform: matching os + kind, and matching arch (a `universal` asset
/// matches any arch).
pub fn select_asset<'a>(assets: &'a [Asset], os: &str, arch: &str, kind: &str) -> Option<&'a Asset> {
    assets
        .iter()
        .find(|a| a.os == os && a.kind == kind && (a.arch == arch || a.arch == "universal"))
}

// ─── On-disk store ──────────────────────────────────────────────────────────

/// Download store under `<appDataDir>/updates`: verified installer files + the skipped-version
/// marker (persisted shell-side so it survives SPA OTA swaps).
pub struct UpdateStore {
    root: PathBuf,
}

impl UpdateStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("updates") }
    }

    fn skipped_path(&self) -> PathBuf {
        self.root.join("skipped.version")
    }

    pub fn asset_path(&self, name: &str) -> PathBuf {
        // Basename only — asset names come from the manifest and must never traverse.
        let base = Path::new(name)
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_else(|| "update.bin".into());
        self.root.join(base)
    }

    /// The store directory itself — `update_prefs::PrefsStore` lives alongside the installers.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ensure_root(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.root)
    }

    pub fn skipped_version(&self) -> Option<String> {
        std::fs::read_to_string(self.skipped_path())
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn set_skipped(&self, version: &str) -> io::Result<()> {
        self.ensure_root()?;
        std::fs::write(self.skipped_path(), version)
    }

    /// Remove every stored installer except `keep` (older downloads; `.part` leftovers). The
    /// skipped-version marker always survives.
    pub fn prune_except(&self, keep: &str) {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == *keep || name == *"skipped.version" {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ─── File hashing / swapping ────────────────────────────────────────────────

/// SHA-256 of a file's bytes, streamed (installers can be 100+ MB), as lowercase hex.
pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(out)
}

/// Append `suffix` to a full path (`Cortex.AppImage` → `Cortex.AppImage.old`) — NOT an extension
/// replacement, which would eat the `.AppImage`.
fn path_with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut os = p.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// Replace `current` with `new_file`, keeping the previous file as `<current>.old` (one
/// generation). Copies (not renames) the new file in — the store and the target may sit on
/// different filesystems — marks it executable on unix, and restores the backup if the final
/// swap fails. The running process keeps its open inode, so this is safe on a live AppImage.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn swap_file_keep_old(current: &Path, new_file: &Path) -> io::Result<()> {
    let staged = path_with_suffix(current, ".new");
    let old = path_with_suffix(current, ".old");
    std::fs::copy(new_file, &staged)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    let had_current = current.exists();
    if had_current {
        let _ = std::fs::remove_file(&old);
        std::fs::rename(current, &old)?;
    }
    match std::fs::rename(&staged, current) {
        Ok(()) => Ok(()),
        Err(e) => {
            if had_current {
                let _ = std::fs::rename(&old, current); // roll back
            }
            let _ = std::fs::remove_file(&staged);
            Err(e)
        }
    }
}

// ─── Platform identity ──────────────────────────────────────────────────────
// The os/arch names this build matches manifest assets on (server-normalized spellings).

#[cfg(target_os = "linux")]
pub const OS_NAME: &str = "linux";
#[cfg(target_os = "windows")]
pub const OS_NAME: &str = "windows";
#[cfg(target_os = "macos")]
pub const OS_NAME: &str = "macos";
#[cfg(target_os = "android")]
pub const OS_NAME: &str = "android";
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos", target_os = "android")))]
pub const OS_NAME: &str = "unsupported";

#[cfg(target_arch = "x86_64")]
pub const ARCH_NAME: &str = "x86_64";
#[cfg(target_arch = "aarch64")]
pub const ARCH_NAME: &str = "aarch64";
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub const ARCH_NAME: &str = "unsupported";

// ─── Check + download (network; thin wrapper over the tested pieces) ────────

/// Fetch fresh metadata, preserving version/asset/skip policy. The caller holds
/// the shared update operation guard through preparation and state publication.
#[allow(clippy::too_many_arguments)]
pub fn check_and_prepare(
    server_url: &str,
    token: &str,
    own_version: &str,
    os: &str,
    arch: &str,
    kind: &str,
    apply: &str,
    store: &UpdateStore,
) -> Result<ChannelOutcome<AppUpdate>, String> {
    if !is_calver(own_version) {
        return Ok(ChannelOutcome::skipped("dev_version"));
    }
    let client = crate::ota::build_http_client()?;
    let manifest: Manifest = crate::ota::fetch_manifest(&client, server_url, token, MANIFEST_PATH)?;
    let Some(version) = manifest.version.as_deref().filter(|v| !v.is_empty()) else {
        return Ok(ChannelOutcome::current()); // `{}` = no qualifying release
    };
    if compare_calver(version, own_version) != Ordering::Greater {
        return Ok(ChannelOutcome::current());
    }
    prepare_selected(&client, &manifest, version, (os, arch, kind), apply, store)
}

fn prepare_selected(
    client: &reqwest::blocking::Client,
    manifest: &Manifest,
    version: &str,
    platform: (&str, &str, &str),
    apply: &str,
    store: &UpdateStore,
) -> Result<ChannelOutcome<AppUpdate>, String> {
    if store.skipped_version().as_deref() == Some(version) {
        return Ok(ChannelOutcome::skipped("version_skipped"));
    }
    let Some(asset) = select_asset(&manifest.assets, platform.0, platform.1, platform.2) else {
        return Ok(ChannelOutcome::skipped("no_matching_asset"));
    };
    let dest = prepare_asset(client, asset, store)?;
    Ok(ChannelOutcome::available(AppUpdate {
        version: version.into(),
        release_url: manifest.release_url.clone(),
        notes: manifest.notes.clone(),
        size: asset.size,
        kind: asset.kind.clone(),
        apply: apply.to_string(),
        path: dest,
        sha256: asset.sha256.clone(),
    }))
}

pub(crate) fn verified(update: &AppUpdate) -> bool {
    hash_file(&update.path).is_ok_and(|hash| hash.eq_ignore_ascii_case(&update.sha256))
}

fn store_error(error: io::Error) -> String {
    format!("could not prepare shell update: {}", error.kind())
}

fn prepare_asset(
    client: &reqwest::blocking::Client,
    asset: &Asset,
    store: &UpdateStore,
) -> Result<PathBuf, String> {
    let dest = store.asset_path(&asset.name);
    let cached = hash_file(&dest).is_ok_and(|hash| hash.eq_ignore_ascii_case(&asset.sha256));
    if !cached {
        store.ensure_root().map_err(store_error)?;
        download_asset(client, asset, &dest)?;
    }
    if let Some(keep) = dest.file_name().and_then(|s| s.to_str()) {
        store.prune_except(keep);
    }
    Ok(dest)
}

fn download_asset(
    client: &reqwest::blocking::Client,
    asset: &Asset,
    dest: &Path,
) -> Result<(), String> {
    let part = path_with_suffix(dest, ".part");
    // No Cortex token on CDN requests, including their redirects.
    let mut response = client.get(&asset.url).send().map_err(crate::ota::http_error)?
        .error_for_status().map_err(crate::ota::http_error)?;
    let mut file = std::fs::File::create(&part).map_err(store_error)?;
    response.copy_to(&mut file).map_err(crate::ota::http_error)?;
    file.flush().map_err(store_error)?;
    drop(file);
    let actual = hash_file(&part).map_err(store_error)?;
    if !actual.eq_ignore_ascii_case(&asset.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err("asset sha256 mismatch".into());
    }
    std::fs::rename(&part, dest).map_err(store_error)
}

// ─── Install ────────────────────────────────────────────────────────────────
//
// Three mechanisms, chosen by where this build actually lives (install_site.rs), never by the host
// OS alone:
//
//   Auto      replace ourselves with no interaction at all — the only mechanism allowed to run
//             unattended (at quit, or before the window opens on the next launch)
//   Elevated  one root authorization dialog (polkit) drives the package manager; user-present only
//   Assisted  hand the file to the user: copy into Downloads and open it
//
// The user-facing entry point `install` always picks the strongest mechanism available, so the
// dialog's Install button benefits from the same in-place swap the silent path uses.

use crate::install_site::{Apply, InstallSite};
use std::ffi::OsStr;

/// Copy the verified installer into the user's Downloads dir (overwrite — the name is versioned and
/// the content sha-verified) and return the destination. Used by the assisted flows (dmg/deb/rpm)
/// so the file sits somewhere the user can find again.
#[cfg(not(target_os = "android"))]
fn copy_to_downloads(app: &tauri::AppHandle, src: &Path) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads")))
        .map_err(|e| format!("no download dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src.file_name().ok_or("bad source file name")?;
    let dest = dir.join(name);
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Run a program to completion, turning a non-zero exit into an error.
fn run_ok(program: &str, args: &[&OsStr]) -> Result<(), String> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("{program} could not be started: {e}"))?;
    if status.success() {
        return Ok(());
    }
    match status.code() {
        Some(code) => Err(format!("{program} exited with {code}")),
        None => Err(format!("{program} was terminated by a signal")),
    }
}

/// Command-line for a silent NSIS upgrade.
///
/// `/S`      NSIS silent mode. The Tauri template's `CheckIfAppIsRunning` reacts to it by killing
///           the running Cortex itself instead of asking, and `RestorePreviousInstallLocation`
///           reads the directory recorded at first install — so no `/D=` is needed (and passing one
///           would be wrong: we only reach this path when we ARE the recorded install).
/// `/UPDATE` skip the reinstall/downgrade page and the WebView2 bootstrap — this is an upgrade of a
///           working install, the runtime is already present.
/// `/NS`     do not (re)create shortcuts; the user may have deliberately deleted them.
/// `/R`      relaunch the app when the installer finishes. Only read in silent/passive mode.
pub fn nsis_args(relaunch: bool) -> Vec<&'static str> {
    let mut args = vec!["/S", "/UPDATE", "/NS"];
    if relaunch {
        args.push("/R");
    }
    args
}

/// The single `*.app` directory at the root of a mounted disk image.
fn find_app_bundle(mount: &Path) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(mount).map_err(|e| format!("cannot read mounted image: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() == Some(OsStr::new("app")) {
            return Ok(path);
        }
    }
    Err("no .app bundle inside the disk image".to_string())
}

/// Replace an installed `.app` with the one inside `dmg`.
///
/// The swap happens next to the bundle (rename, not write-in-place) so a partially copied bundle is
/// never visible as the app, and the running process keeps its own inode either way. `ditto` is used
/// rather than a hand-rolled recursive copy because it preserves symlinks, permissions and extended
/// attributes — a bundle copied without them will not launch.
///
/// Gatekeeper: the image was downloaded by us, not by a quarantine-applying app, so the replacement
/// carries no `com.apple.quarantine` attribute and the ad-hoc signature is enough. NOT verified on a
/// real machine — see the plan's risk table.
fn swap_mac_bundle(dmg: &Path, bundle: &Path) -> Result<(), String> {
    let mount = std::env::temp_dir().join(format!("cortex-dmg-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&mount);
    std::fs::create_dir_all(&mount).map_err(|e| format!("mount point: {e}"))?;

    run_ok(
        "hdiutil",
        &[
            OsStr::new("attach"),
            OsStr::new("-nobrowse"),
            OsStr::new("-readonly"),
            OsStr::new("-quiet"),
            OsStr::new("-mountpoint"),
            mount.as_os_str(),
            dmg.as_os_str(),
        ],
    )?;

    let result = (|| -> Result<(), String> {
        let source = find_app_bundle(&mount)?;
        let staged = path_with_suffix(bundle, ".new");
        let previous = path_with_suffix(bundle, ".old");
        let _ = std::fs::remove_dir_all(&staged);
        run_ok("ditto", &[source.as_os_str(), staged.as_os_str()])?;
        let _ = std::fs::remove_dir_all(&previous);
        std::fs::rename(bundle, &previous)
            .map_err(|e| format!("could not move the current app aside: {e}"))?;
        match std::fs::rename(&staged, bundle) {
            Ok(()) => {
                // Best effort: the old bundle is still mapped by this process, and macOS is happy
                // to unlink it. If it will not go, next launch's swap removes it.
                let _ = std::fs::remove_dir_all(&previous);
                Ok(())
            }
            Err(e) => {
                let _ = std::fs::rename(&previous, bundle);
                Err(format!("could not move the new app into place: {e}"))
            }
        }
    })();

    let _ = run_ok("hdiutil", &[OsStr::new("detach"), mount.as_os_str(), OsStr::new("-quiet")]);
    let _ = std::fs::remove_dir(&mount);
    result
}

/// Put the new version in place with no user interaction. Valid only for sites whose
/// `silent_capability` is `Apply::Auto`; the caller is responsible for that check and for exiting
/// afterwards. `relaunch` starts the new build once it is in place — false at quit time, because
/// the user asked to leave.
/// Returns whether the shell must exit for the install to complete: every desktop mechanism needs
/// the old process gone, while Android's package installer works around a live app and must NOT be
/// killed before the system has taken the APK.
pub fn install_auto(
    app: &tauri::AppHandle,
    update: &AppUpdate,
    site: &InstallSite,
    relaunch: bool,
) -> Result<bool, String> {
    match site {
        InstallSite::WindowsNsis { .. } => {
            // The installer replaces the binary after killing us; nothing else to do here.
            std::process::Command::new(&update.path)
                .args(nsis_args(relaunch))
                .spawn()
                .map_err(|e| format!("failed to launch installer: {e}"))?;
            Ok(true)
        }
        InstallSite::MacBundle { bundle, .. } => {
            swap_mac_bundle(&update.path, bundle)?;
            if relaunch {
                run_ok("open", &[OsStr::new("-n"), bundle.as_os_str()])?;
            }
            Ok(true)
        }
        InstallSite::LinuxAppImage { path } => {
            // The running process keeps serving from its open inode, so this is safe live.
            swap_file_keep_old(path, &update.path).map_err(|e| format!("swap failed: {e}"))?;
            if relaunch {
                std::process::Command::new(path)
                    .spawn()
                    .map_err(|e| format!("relaunch failed: {e}"))?;
            }
            Ok(true)
        }
        InstallSite::Android => install_android(app, update).map(|()| false),
        other => Err(format!("{other:?} cannot be installed unattended")),
    }
}

/// Android hands the APK to the system package installer. On API 31+ the plugin commits a
/// `PackageInstaller` session that needs no user action once we are the installer of record; before
/// that (and on the first install) the system still asks.
#[cfg(target_os = "android")]
fn install_android(app: &tauri::AppHandle, update: &AppUpdate) -> Result<(), String> {
    use tauri::Manager;
    app.state::<tauri_plugin_cortex_download::CortexDownload<tauri::Wry>>()
        .install_apk(update.path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "android"))]
fn install_android(_app: &tauri::AppHandle, _update: &AppUpdate) -> Result<(), String> {
    Err("not an Android build".to_string())
}

/// Drive the owning package manager through one polkit authorization dialog.
///
/// Never called from the quit or startup paths: raising a password dialog while the user is walking
/// away is worse than not updating. `pkexec` needs an absolute program path and resets PATH, and it
/// fails outright when the session has no polkit agent — both handled by the caller falling back to
/// the assisted flow.
pub fn install_elevated(update: &AppUpdate, site: &InstallSite) -> Result<(), String> {
    let InstallSite::LinuxManaged { manager } = site else {
        return Err("this install does not need elevation".to_string());
    };
    let file = update.path.to_string_lossy().to_string();
    let status = std::process::Command::new("pkexec")
        .arg(manager.program())
        .args(manager.args(&file))
        .status()
        .map_err(|e| format!("pkexec could not be started: {e}"))?;
    if status.success() {
        return Ok(());
    }
    // 126: the authorization dialog was dismissed or authentication failed.
    // 127: pkexec could not run the program — usually no polkit agent in this session.
    match status.code() {
        Some(code) => Err(format!("pkexec exited with {code}")),
        None => Err("pkexec was terminated by a signal".to_string()),
    }
}

/// Put the installer somewhere the user can find it and open it for them.
#[cfg(target_os = "android")]
fn install_assisted(_app: &tauri::AppHandle, _update: &AppUpdate) -> Result<Option<String>, String> {
    Err("Android has no assisted install flow".to_string())
}

#[cfg(not(target_os = "android"))]
fn install_assisted(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    let dest = copy_to_downloads(app, &update.path)?;
    #[cfg(target_os = "windows")]
    let opener: (&str, Vec<&OsStr>) = ("cmd", vec![OsStr::new("/C"), OsStr::new("start"), OsStr::new("")]);
    #[cfg(target_os = "macos")]
    let opener: (&str, Vec<&OsStr>) = ("open", vec![]);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let opener: (&str, Vec<&OsStr>) = ("xdg-open", vec![]);

    let mut args = opener.1;
    args.push(dest.as_os_str());
    // Best effort: the file is already where the user was told it would be.
    let _ = std::process::Command::new(opener.0).args(args).spawn();
    Ok(Some(dest.display().to_string()))
}

/// Install the prepared update on a user-present path (the dialog's Install button, the menu).
/// `Ok(None)` = handled by us or handed off to an installer and the shell is about to exit;
/// `Ok(Some(path))` = a file was opened for the user to finish.
pub fn install(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    let site = crate::install_site::detect();
    match crate::install_site::silent_capability(&site) {
        Apply::Auto => {
            if install_auto(app, update, &site, true)? {
                app.exit(0);
            }
            Ok(None)
        }
        Apply::Elevated => match install_elevated(update, &site) {
            Ok(()) => {
                // The files on disk are new; this process is still the old build.
                if let Ok(exe) = std::env::current_exe() {
                    let _ = std::process::Command::new(exe).spawn();
                }
                app.exit(0);
                Ok(None)
            }
            // No polkit agent, dialog dismissed, manager failure: fall back rather than dead-end.
            Err(_) => install_assisted(app, update),
        },
        Apply::Assisted(_) => install_assisted(app, update),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn with_tmp(body: impl FnOnce(&Path)) {
        let n = COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!("cortex-appup-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&dir)));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(e) = res {
            std::panic::resume_unwind(e);
        }
    }

    fn asset(os: &str, arch: &str, kind: &str) -> Asset {
        Asset {
            name: format!("Cortex-2026.7.30-{os}-{arch}.{kind}"),
            os: os.to_string(),
            arch: arch.to_string(),
            kind: kind.to_string(),
            url: "https://example.com/x".to_string(),
            size: 1,
            sha256: "ab".repeat(32),
        }
    }

    #[test]
    fn check_disabled_reason_gates_env_dev_dir_and_version() {
        // Explicit env kill-switch wins.
        assert!(check_disabled_reason(Some("1"), None, "2026.7.30").is_some());
        // Dev mode: the SPA is served from a local dir override → never check.
        assert!(check_disabled_reason(None, Some("/home/x/web/dist"), "2026.7.30").is_some());
        // A blank override does not count as dev mode.
        assert!(check_disabled_reason(None, Some("  "), "2026.7.30").is_none());
        // Non-CalVer own version (unstamped build) stays a backstop guard.
        assert!(check_disabled_reason(None, None, "0.0.1").is_some());
        // A stamped release with no overrides checks normally.
        assert!(check_disabled_reason(None, None, "2026.7.30").is_none());
    }

    #[test]
    fn compare_calver_orders_dates_and_suffixes() {
        assert_eq!(compare_calver("2026.7.30", "2026.7.30"), Ordering::Equal);
        assert_eq!(compare_calver("2026.7.29", "2026.7.30"), Ordering::Less);
        assert_eq!(compare_calver("2026.8.1", "2026.7.30"), Ordering::Greater);
        assert_eq!(compare_calver("2027.1.1", "2026.12.31"), Ordering::Greater);
        // -N hotfix suffix sorts ABOVE the plain version (NOT semver prerelease ordering).
        assert_eq!(compare_calver("2026.7.30-2", "2026.7.30"), Ordering::Greater);
        assert_eq!(compare_calver("2026.7.30-2", "2026.7.30-3"), Ordering::Less);
        // No string-ordering pitfalls across digit boundaries.
        assert_eq!(compare_calver("2026.10.1", "2026.9.30"), Ordering::Greater);
    }

    #[test]
    fn is_calver_accepts_releases_and_rejects_dev_versions() {
        assert!(is_calver("2026.7.30"));
        assert!(is_calver("2026.7.30-2"));
        assert!(!is_calver("0.0.1")); // dev build guard
        assert!(!is_calver("1999.1.1")); // implausible year
        assert!(!is_calver("dev"));
        assert!(!is_calver(""));
        assert!(!is_calver("2026.7"));
        assert!(!is_calver("2026.7.x"));
    }

    #[test]
    fn manifest_parses_empty_and_full_bodies() {
        let empty: Manifest = serde_json::from_str("{}").unwrap();
        assert!(empty.version.is_none());
        assert!(empty.assets.is_empty());

        let full: Manifest = serde_json::from_str(
            r#"{"version":"2026.7.30","releaseUrl":"https://g/r","notes":"n","assets":[
                {"name":"Cortex-2026.7.30-Linux-x86_64.AppImage","os":"linux","arch":"x86_64",
                 "kind":"appimage","url":"https://g/d","size":5,"sha256":"aa"}]}"#,
        )
        .unwrap();
        assert_eq!(full.version.as_deref(), Some("2026.7.30"));
        assert_eq!(full.release_url.as_deref(), Some("https://g/r"));
        assert_eq!(full.assets.len(), 1);
        assert_eq!(full.assets[0].kind, "appimage");
    }

    #[test]
    fn select_asset_matches_platform_matrix() {
        let assets = vec![
            asset("linux", "x86_64", "appimage"),
            asset("linux", "x86_64", "deb"),
            asset("linux", "x86_64", "rpm"),
            asset("windows", "x86_64", "nsis"),
            asset("macos", "universal", "dmg"),
            asset("android", "aarch64", "apk"),
        ];
        assert_eq!(select_asset(&assets, "linux", "x86_64", "appimage").unwrap().kind, "appimage");
        assert_eq!(select_asset(&assets, "linux", "x86_64", "deb").unwrap().kind, "deb");
        assert_eq!(select_asset(&assets, "windows", "x86_64", "nsis").unwrap().kind, "nsis");
        // A universal asset matches any arch.
        assert!(select_asset(&assets, "macos", "x86_64", "dmg").is_some());
        assert!(select_asset(&assets, "macos", "aarch64", "dmg").is_some());
        assert_eq!(select_asset(&assets, "android", "aarch64", "apk").unwrap().kind, "apk");
        // Arch mismatch → no match (never offer the wrong binary).
        assert!(select_asset(&assets, "linux", "aarch64", "appimage").is_none());
        assert!(select_asset(&assets, "android", "x86_64", "apk").is_none());
    }

    #[test]
    fn update_store_skipped_version_round_trip() {
        with_tmp(|dir| {
            let store = UpdateStore::new(dir);
            assert_eq!(store.skipped_version(), None);
            store.set_skipped("2026.7.30").unwrap();
            assert_eq!(store.skipped_version().as_deref(), Some("2026.7.30"));
        });
    }

    #[test]
    fn update_store_prune_keeps_target_and_marker() {
        with_tmp(|dir| {
            let store = UpdateStore::new(dir);
            store.set_skipped("x").unwrap();
            std::fs::write(store.asset_path("old.AppImage"), b"old").unwrap();
            std::fs::write(store.asset_path("new.AppImage"), b"new").unwrap();
            store.prune_except("new.AppImage");
            assert!(!store.asset_path("old.AppImage").exists());
            assert!(store.asset_path("new.AppImage").exists());
            assert_eq!(store.skipped_version().as_deref(), Some("x"));
        });
    }

    #[test]
    fn hash_file_matches_known_digest() {
        with_tmp(|dir| {
            let p = dir.join("f");
            std::fs::write(&p, b"hello").unwrap();
            assert_eq!(
                hash_file(&p).unwrap(),
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            );
        });
    }

    #[test]
    fn swap_file_keeps_previous_generation() {
        with_tmp(|dir| {
            let current = dir.join("Cortex.AppImage");
            let new_file = dir.join("updates").join("Cortex-new.AppImage");
            std::fs::create_dir_all(new_file.parent().unwrap()).unwrap();
            std::fs::write(&current, b"v1").unwrap();
            std::fs::write(&new_file, b"v2").unwrap();

            swap_file_keep_old(&current, &new_file).unwrap();

            assert_eq!(std::fs::read(&current).unwrap(), b"v2");
            let old = dir.join("Cortex.AppImage.old");
            assert_eq!(std::fs::read(&old).unwrap(), b"v1");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&current).unwrap().permissions().mode();
                assert_eq!(mode & 0o111, 0o111, "swapped-in file must be executable");
            }
        });
    }

    #[test]
    fn swap_file_works_without_existing_current() {
        with_tmp(|dir| {
            let current = dir.join("Cortex.AppImage");
            let new_file = dir.join("n");
            std::fs::write(&new_file, b"v2").unwrap();
            swap_file_keep_old(&current, &new_file).unwrap();
            assert_eq!(std::fs::read(&current).unwrap(), b"v2");
        });
    }

    #[test]
    fn app_update_serializes_camel_case_without_internals() {
        let u = AppUpdate {
            version: "2026.7.30".to_string(),
            release_url: Some("https://g/r".to_string()),
            notes: Some("n".to_string()),
            size: 7,
            kind: "apk".to_string(),
            apply: "silent".to_string(),
            path: PathBuf::from("/secret/updates/x.apk"),
            sha256: "aa".repeat(32),
        };
        let json = serde_json::to_string(&u).unwrap();
        assert!(json.contains(r#""releaseUrl":"https://g/r""#));
        assert!(json.contains(r#""version":"2026.7.30""#));
        assert!(!json.contains("secret"), "local path must not be exposed to the SPA");
        assert!(!json.contains("sha256"), "sha256 is shell-internal");
        assert!(json.contains(r#""apply":"silent""#));
    }

    #[test]
    fn nsis_args_are_silent_and_only_relaunch_when_asked() {
        // Quit-time: the user asked to leave, so the installer must not bring the app back.
        assert_eq!(nsis_args(false), vec!["/S", "/UPDATE", "/NS"]);
        assert_eq!(nsis_args(true), vec!["/S", "/UPDATE", "/NS", "/R"]);
        // /R is only read in silent or passive mode, so /S must always be present.
        assert!(nsis_args(true).contains(&"/S"));
    }
}
