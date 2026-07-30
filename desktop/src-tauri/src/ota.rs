// Frontend OTA updater.
//
// Downloads a newer SPA bundle from the connected server and stages it for the NEXT launch, so the
// running SPA is never swapped underneath itself. Layout under `<appDataDir>/ui/`:
//   current/           the active frontend (served by the cortexui:// handler)
//   current.version    version string of `current`
//   staged/            a downloaded, verified next version
//   staged.version     version string of `staged`
//
// Flow: at startup, promote_staged() swaps staged→current (fast, local). After the window opens, a
// background thread runs check_and_stage(): fetch manifest, compare versions, download + sha256-
// verify the zip, extract atomically into staged/. Any network/verify failure is a no-op — the
// current version keeps serving (offline-safe). The pure pieces (version compare, sha256 verify, zip
// extract, staged/current promotion) are unit-tested; the network call is a thin wrapper.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Same-origin manifest path served by agent-server `platform/ui-http/ui-ota.ts`.
pub const MANIFEST_PATH: &str = "/api/ui-ota/manifest.json";

/// The OTA manifest the server publishes for the built SPA.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// Content-addressed frontend id (changes iff the SPA content changes).
    pub version: String,
    /// SHA-256 (hex) of the zip bytes — the download is verified against this.
    pub sha256: String,
    /// Zip byte length — surfaced to the hot-update prompt ("… · 8.4 MB · 已下载").
    /// `#[serde(default)]` so an older/partial manifest without it still parses (size → 0).
    #[serde(default)]
    pub size: u64,
    /// Same-origin path to fetch the bundle from.
    pub url: String,
}

/// A frontend update that has been downloaded + staged for the next launch. Emitted to the SPA
/// (`frontend-update-staged` event) so it can raise the hot-update prompt, and returned by the
/// `get_staged_update` command as a backstop for a missed event.
#[derive(Debug, Clone, Serialize)]
pub struct StagedUpdate {
    /// Content-addressed id of the newly staged version.
    pub version: String,
    /// The version currently installed (staged replaces it on next launch). None on first install.
    #[serde(rename = "fromVersion")]
    pub from_version: Option<String>,
    /// Zip byte length (0 when unknown, e.g. reconstructed from disk without the manifest).
    pub size: u64,
}

/// Whether the manifest version differs from what is installed.
pub fn needs_update(installed: Option<&str>, manifest_version: &str) -> bool {
    installed != Some(manifest_version)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Constant-purpose integrity check: SHA-256(bytes) == expected_hex (case-insensitive).
pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    to_hex(&hasher.finalize()).eq_ignore_ascii_case(expected_hex)
}

fn zip_err(e: zip::result::ZipError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Extract a zip archive into `dest`. `enclosed_name()` drops any entry whose path would escape the
/// destination (path-traversal guard) — belt-and-suspenders atop the sha256 check.
pub fn extract_zip(bytes: &[u8], dest: &Path) -> io::Result<()> {
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes)).map_err(zip_err)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(zip_err)?;
        let name = match entry.enclosed_name() {
            Some(n) => n,
            None => continue,
        };
        let out = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&out)?;
        io::copy(&mut entry, &mut f)?;
    }
    Ok(())
}

fn read_trimmed(p: &Path) -> Option<String> {
    std::fs::read_to_string(p)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// On-disk store for the frontend versions under `<appDataDir>/ui`.
pub struct UiStore {
    root: PathBuf,
}

impl UiStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join("ui"),
        }
    }

    pub fn current_dir(&self) -> PathBuf {
        self.root.join("current")
    }
    fn staged_dir(&self) -> PathBuf {
        self.root.join("staged")
    }
    fn current_version_path(&self) -> PathBuf {
        self.root.join("current.version")
    }
    fn staged_version_path(&self) -> PathBuf {
        self.root.join("staged.version")
    }

    pub fn installed_version(&self) -> Option<String> {
        read_trimmed(&self.current_version_path())
    }
    pub fn staged_version(&self) -> Option<String> {
        read_trimmed(&self.staged_version_path())
    }

    /// Extract verified bundle bytes into a temp dir, require an index.html, then atomically rename
    /// into `staged/` and record `staged.version` last (so a crash mid-extract never leaves a
    /// staged.version pointing at a partial dir).
    pub fn stage_bundle(&self, version: &str, zip_bytes: &[u8]) -> io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        let tmp = self.root.join("staged.tmp");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)?;
        extract_zip(zip_bytes, &tmp)?;
        if !tmp.join("index.html").is_file() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bundle missing index.html",
            ));
        }
        let staged = self.staged_dir();
        let _ = std::fs::remove_dir_all(&staged);
        std::fs::rename(&tmp, &staged)?;
        std::fs::write(self.staged_version_path(), version)?;
        Ok(())
    }

    /// Promote a staged version to current (called at startup, before the window loads). Returns the
    /// promoted version, or None when there is nothing valid to promote. A staged dir without an
    /// index.html is treated as corrupt and cleaned up.
    pub fn promote_staged(&self) -> io::Result<Option<String>> {
        let version = match self.staged_version() {
            Some(v) => v,
            None => return Ok(None),
        };
        let staged = self.staged_dir();
        if !staged.join("index.html").is_file() {
            let _ = std::fs::remove_dir_all(&staged);
            let _ = std::fs::remove_file(self.staged_version_path());
            return Ok(None);
        }
        let current = self.current_dir();
        if current.exists() {
            std::fs::remove_dir_all(&current)?;
        }
        std::fs::rename(&staged, &current)?;
        std::fs::write(self.current_version_path(), &version)?;
        let _ = std::fs::remove_file(self.staged_version_path());
        Ok(Some(version))
    }
}

/// Build the blocking HTTP client used for OTA, pinned to the webpki (Mozilla) trust anchors.
///
/// Why not the default `reqwest::blocking::Client::builder().build()`: reqwest's rustls integration
/// compiles in `rustls-platform-verifier` and selects it as the DEFAULT certificate verifier. On
/// Android that verifier must be initialized with a JNI handle to the OS trust store — which this app
/// never does — so the first HTTPS request from the default client aborts with
/// "Expect rustls-platform-verifier to be initialized", and because the release profile is
/// `panic=abort` the SIGABRT takes the whole process down (observed as a second-launch crash: the
/// window/bottom bar draw, then the background OTA thread fires ~2s later and kills the app).
///
/// We sidestep the platform verifier entirely by handing reqwest a preconfigured rustls ClientConfig
/// whose root store is the bundled webpki-roots trust anchors — no OS trust store, identical and
/// crash-free on every platform. The crypto provider is ring, supplied explicitly (so this does not
/// depend on a process-wide `install_default` having run first). reqwest wraps the passed value in
/// `Some(..)` and downcasts to `Option<rustls::ClientConfig>`; a single unified rustls version in the
/// dependency graph makes that downcast succeed.
pub(crate) fn build_http_client() -> Result<reqwest::blocking::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .use_preconfigured_tls(tls)
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch the manifest, and if a new version is available (and not already staged), download the
/// bundle, verify its sha256, and stage it for next launch. Returns the staged update (new version +
/// the version it replaces + size) on success, None when already up to date. Errors are surfaced for
/// logging but are non-fatal to the caller.
pub fn check_and_stage(
    server_url: &str,
    token: &str,
    store: &UiStore,
) -> Result<Option<StagedUpdate>, String> {
    let base = server_url.trim_end_matches('/');
    let client = build_http_client()?;

    let manifest: Manifest = client
        .get(format!("{base}{MANIFEST_PATH}"))
        .header("x-cortex-token", token)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    // Already the current version, or already downloaded as staged → nothing to do.
    let installed = store.installed_version();
    if !needs_update(installed.as_deref(), &manifest.version)
        || store.staged_version().as_deref() == Some(manifest.version.as_str())
    {
        return Ok(None);
    }

    let bundle_url = format!("{base}{}", manifest.url);
    let bytes = client
        .get(bundle_url)
        .header("x-cortex-token", token)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;

    if !verify_sha256(&bytes, &manifest.sha256) {
        return Err("bundle sha256 mismatch".to_string());
    }

    store
        .stage_bundle(&manifest.version, &bytes)
        .map_err(|e| e.to_string())?;
    Ok(Some(StagedUpdate {
        version: manifest.version,
        from_version: installed,
        size: manifest.size,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn with_tmp(body: impl FnOnce(&Path)) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("cortex-ota-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&dir)));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(e) = res {
            std::panic::resume_unwind(e);
        }
    }

    /// Build a real zip (deflate) from (name, bytes) pairs for extraction tests.
    fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        use zip::CompressionMethod;
        let mut w = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, data) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn needs_update_compares_versions() {
        assert!(needs_update(None, "abc"));
        assert!(needs_update(Some("old"), "new"));
        assert!(!needs_update(Some("same"), "same"));
    }

    #[test]
    fn verify_sha256_matches_and_rejects() {
        // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256(b"hello", expected));
        assert!(verify_sha256(b"hello", &expected.to_uppercase())); // case-insensitive
        assert!(!verify_sha256(b"hello!", expected));
    }

    #[test]
    fn manifest_parses_from_json() {
        let json = r#"{"version":"v1","sha256":"deadbeef","size":123,"url":"/api/ui-ota/bundle.zip"}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.version, "v1");
        assert_eq!(m.sha256, "deadbeef");
        assert_eq!(m.size, 123);
        assert_eq!(m.url, "/api/ui-ota/bundle.zip");
    }

    #[test]
    fn manifest_size_defaults_when_absent() {
        // An older/partial manifest without `size` must still parse (size → 0), not error.
        let json = r#"{"version":"v1","sha256":"deadbeef","url":"/api/ui-ota/bundle.zip"}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.size, 0);
    }

    #[test]
    fn staged_update_serializes_with_from_version_key() {
        let s = StagedUpdate {
            version: "b7e2".to_string(),
            from_version: Some("a3f9".to_string()),
            size: 8_400_000,
        };
        let json = serde_json::to_string(&s).unwrap();
        // The SPA reads `fromVersion` (camelCase) off the event payload.
        assert!(json.contains(r#""version":"b7e2""#));
        assert!(json.contains(r#""fromVersion":"a3f9""#));
        assert!(json.contains(r#""size":8400000"#));
    }

    #[test]
    fn extract_zip_writes_all_entries() {
        with_tmp(|dir| {
            let zip = make_zip(&[
                ("index.html", b"<html>X</html>"),
                ("assets/app.js", b"console.log(1)"),
            ]);
            extract_zip(&zip, dir).unwrap();
            assert_eq!(std::fs::read(dir.join("index.html")).unwrap(), b"<html>X</html>");
            assert_eq!(std::fs::read(dir.join("assets/app.js")).unwrap(), b"console.log(1)");
        });
    }

    #[test]
    fn stage_then_promote_round_trip() {
        with_tmp(|dir| {
            let store = UiStore::new(dir);
            assert_eq!(store.installed_version(), None);

            let zip = make_zip(&[("index.html", b"<html>V1</html>")]);
            store.stage_bundle("v1", &zip).unwrap();
            assert_eq!(store.staged_version().as_deref(), Some("v1"));
            // current not yet changed
            assert_eq!(store.installed_version(), None);

            let promoted = store.promote_staged().unwrap();
            assert_eq!(promoted.as_deref(), Some("v1"));
            assert_eq!(store.installed_version().as_deref(), Some("v1"));
            assert_eq!(store.staged_version(), None); // staged pointer cleared
            assert_eq!(
                std::fs::read(store.current_dir().join("index.html")).unwrap(),
                b"<html>V1</html>"
            );
        });
    }

    #[test]
    fn promote_is_noop_without_staged() {
        with_tmp(|dir| {
            let store = UiStore::new(dir);
            assert_eq!(store.promote_staged().unwrap(), None);
        });
    }

    #[test]
    fn stage_bundle_rejects_bundle_without_index() {
        with_tmp(|dir| {
            let store = UiStore::new(dir);
            let zip = make_zip(&[("app.js", b"x=1")]);
            assert!(store.stage_bundle("v1", &zip).is_err());
            assert_eq!(store.staged_version(), None);
        });
    }

    #[test]
    fn promote_cleans_incomplete_staged() {
        with_tmp(|dir| {
            let store = UiStore::new(dir);
            // Simulate a staged.version pointing at a staged dir with no index.html.
            std::fs::create_dir_all(dir.join("ui").join("staged")).unwrap();
            std::fs::write(dir.join("ui").join("staged.version"), "vX").unwrap();
            assert_eq!(store.promote_staged().unwrap(), None);
            assert_eq!(store.staged_version(), None); // cleaned up
        });
    }
}
