// App shell self-updater (sibling of ota.rs, which updates only the SPA).
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

/// Decide which Linux package kind this install uses, pure over its inputs: a set `$APPIMAGE` env
/// (AppImage self-run path) wins; otherwise /etc/os-release ID/ID_LIKE picks deb vs rpm; unknown
/// falls back to appimage (self-contained, always installable).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn detect_linux_kind_from(appimage_env: Option<&str>, os_release: &str) -> &'static str {
    if appimage_env.is_some_and(|v| !v.trim().is_empty()) {
        return "appimage";
    }
    const DEB_IDS: &[&str] = &["debian", "ubuntu", "linuxmint", "pop", "elementary", "kali"];
    const RPM_IDS: &[&str] = &["rhel", "fedora", "centos", "rocky", "almalinux", "suse", "opensuse", "opensuse-leap", "opensuse-tumbleweed"];
    let ids: Vec<String> = os_release
        .lines()
        .filter_map(|line| {
            line.strip_prefix("ID=").or_else(|| line.strip_prefix("ID_LIKE="))
        })
        .flat_map(|v| {
            v.trim_matches('"')
                .split_whitespace()
                .map(|s| s.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .collect();
    if ids.iter().any(|id| DEB_IDS.contains(&id.as_str())) {
        return "deb";
    }
    if ids.iter().any(|id| RPM_IDS.contains(&id.as_str())) {
        return "rpm";
    }
    "appimage"
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

/// The package kind this install consumes: nsis / dmg / apk fixed per OS; Linux inspects the
/// runtime environment ($APPIMAGE, /etc/os-release).
pub fn wanted_kind() -> String {
    #[cfg(target_os = "windows")]
    {
        "nsis".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "dmg".to_string()
    }
    #[cfg(target_os = "android")]
    {
        "apk".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        detect_linux_kind_from(std::env::var("APPIMAGE").ok().as_deref(), &os_release).to_string()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos", target_os = "android")))]
    {
        "none".to_string()
    }
}

// ─── Check + download (network; thin wrapper over the tested pieces) ────────

/// Fetch the manifest and, when it advertises a newer shell for this platform, download the asset
/// from the GitHub CDN (streamed to disk), verify its sha256, and keep it in the store. Returns the
/// ready-to-install update, or None when up to date / skipped / no matching asset. A dev (non-
/// CalVer) own version disables the check entirely.
#[allow(clippy::too_many_arguments)]
pub fn check_and_prepare(
    server_url: &str,
    token: &str,
    own_version: &str,
    os: &str,
    arch: &str,
    kind: &str,
    store: &UpdateStore,
) -> Result<Option<AppUpdate>, String> {
    if !is_calver(own_version) {
        return Ok(None);
    }
    let base = server_url.trim_end_matches('/');
    let client = crate::ota::build_http_client()?;
    let manifest: Manifest = client
        .get(format!("{base}{MANIFEST_PATH}"))
        .header("x-cortex-token", token)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    let version = match manifest.version {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(None), // `{}` manifest = no qualifying release
    };
    if compare_calver(&version, own_version) != Ordering::Greater {
        return Ok(None);
    }
    if store.skipped_version().as_deref() == Some(version.as_str()) {
        return Ok(None);
    }
    let asset = match select_asset(&manifest.assets, os, arch, kind) {
        Some(a) => a.clone(),
        None => return Ok(None),
    };

    let dest = store.asset_path(&asset.name);
    let cached = dest.is_file()
        && hash_file(&dest)
            .map(|h| h.eq_ignore_ascii_case(&asset.sha256))
            .unwrap_or(false);
    if !cached {
        store.ensure_root().map_err(|e| e.to_string())?;
        let part = path_with_suffix(&dest, ".part");
        // NO token header here: the URL is the GitHub CDN, never the Cortex server — the token
        // must not leak to a third party.
        let mut resp = client
            .get(&asset.url)
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        resp.copy_to(&mut file).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        let actual = hash_file(&part).map_err(|e| e.to_string())?;
        if !actual.eq_ignore_ascii_case(&asset.sha256) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("asset sha256 mismatch for {}", asset.name));
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    if let Some(keep) = dest.file_name().and_then(|s| s.to_str()) {
        store.prune_except(keep);
    }

    Ok(Some(AppUpdate {
        version,
        release_url: manifest.release_url,
        notes: manifest.notes,
        size: asset.size,
        kind: asset.kind,
        path: dest,
        sha256: asset.sha256,
    }))
}

// ─── Install (platform-branched) ────────────────────────────────────────────

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

/// Install the prepared update. `Ok(None)` = the shell handed off and is exiting (installer
/// spawned / AppImage swapped / Android package installer raised); `Ok(Some(path))` = an installer
/// file was opened for the user to finish (dmg / deb / rpm assisted flows).
#[cfg(target_os = "windows")]
pub fn install(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    // Hand off to the NSIS installer interactively (clear UAC provenance) and exit so the
    // installer can replace the running binary.
    std::process::Command::new(&update.path)
        .spawn()
        .map_err(|e| format!("failed to launch installer: {e}"))?;
    app.exit(0);
    Ok(None)
}

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    // Unsigned builds can't safely self-replace under Gatekeeper — assisted flow: put the dmg in
    // Downloads and open it (the user drags Cortex.app to Applications).
    let dest = copy_to_downloads(app, &update.path)?;
    std::process::Command::new("open")
        .arg(&dest)
        .spawn()
        .map_err(|e| format!("failed to open dmg: {e}"))?;
    Ok(Some(dest.display().to_string()))
}

#[cfg(target_os = "linux")]
pub fn install(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    if update.kind == "appimage" {
        if let Ok(current) = std::env::var("APPIMAGE") {
            // Fully automatic: swap the AppImage file in place (previous kept as .old), relaunch
            // the new file, exit. The running process keeps serving from its open inode.
            let current = PathBuf::from(current);
            swap_file_keep_old(&current, &update.path).map_err(|e| format!("swap failed: {e}"))?;
            std::process::Command::new(&current)
                .spawn()
                .map_err(|e| format!("relaunch failed: {e}"))?;
            app.exit(0);
            return Ok(None);
        }
        // Not actually running from an AppImage (dev run / extracted) → assisted flow below.
    }
    // deb / rpm need root — assisted flow: land the package in Downloads and open it with the
    // GUI package installer.
    let dest = copy_to_downloads(app, &update.path)?;
    let _ = std::process::Command::new("xdg-open").arg(&dest).spawn();
    Ok(Some(dest.display().to_string()))
}

#[cfg(target_os = "android")]
pub fn install(app: &tauri::AppHandle, update: &AppUpdate) -> Result<Option<String>, String> {
    use tauri::Manager;
    // Raise the system package installer over the verified APK (FileProvider + ACTION_VIEW inside
    // the cortex-download plugin). The app stays up; Android replaces it on user confirm.
    app.state::<tauri_plugin_cortex_download::CortexDownload<tauri::Wry>>()
        .install_apk(update.path.to_string_lossy().to_string())?;
    Ok(None)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos", target_os = "android")))]
pub fn install(_app: &tauri::AppHandle, _update: &AppUpdate) -> Result<Option<String>, String> {
    Err("app update is not supported on this platform".to_string())
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
    fn detect_linux_kind_prefers_appimage_env_then_os_release() {
        assert_eq!(detect_linux_kind_from(Some("/opt/Cortex.AppImage"), ""), "appimage");
        assert_eq!(detect_linux_kind_from(Some("  "), "ID=ubuntu"), "deb"); // blank env ≠ AppImage run
        assert_eq!(detect_linux_kind_from(None, "ID=ubuntu\nID_LIKE=debian"), "deb");
        assert_eq!(detect_linux_kind_from(None, "ID=debian"), "deb");
        assert_eq!(detect_linux_kind_from(None, "ID=fedora"), "rpm");
        assert_eq!(detect_linux_kind_from(None, "ID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\""), "rpm");
        assert_eq!(detect_linux_kind_from(None, "ID=arch"), "appimage"); // unknown distro → appimage
        assert_eq!(detect_linux_kind_from(None, ""), "appimage");
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
            path: PathBuf::from("/secret/updates/x.apk"),
            sha256: "aa".repeat(32),
        };
        let json = serde_json::to_string(&u).unwrap();
        assert!(json.contains(r#""releaseUrl":"https://g/r""#));
        assert!(json.contains(r#""version":"2026.7.30""#));
        assert!(!json.contains("secret"), "local path must not be exposed to the SPA");
        assert!(!json.contains("sha256"), "sha256 is shell-internal");
    }
}
