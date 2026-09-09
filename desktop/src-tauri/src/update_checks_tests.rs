// input:  OTA stores, update coordinator, loopback HTTP fixtures
// output: Deterministic update checks and exclusion regression tests
// pos:    Native update protocol and concurrency tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

use crate::update_checks::{self, ChannelOutcome, CheckReport, Status, UpdateGate};
use crate::{app_update, ota};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("cortex-check-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bundle() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("index.html", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"staged frontend").unwrap();
    zip.finish().unwrap().into_inner()
}

// One real HTTP request per fixture proves that even cached updates fetch a fresh manifest.
fn manifest_server(status: u16, body: &str) -> (String, std::thread::JoinHandle<String>) {
    response_server(status, body.as_bytes())
}

fn response_server(status: u16, body: &[u8]) -> (String, std::thread::JoinHandle<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    response.extend_from_slice(body);
    let task = std::thread::spawn(move || serve_once(listener, response));
    (url, task)
}

fn serve_once(listener: std::net::TcpListener, response: Vec<u8>) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Ok((mut stream, _)) = listener.accept() {
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let request = read_request(&mut stream);
            stream.write_all(&response).unwrap();
            return request;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "manifest was never fetched"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        let mut bytes = [0; 4096];
        let n = stream.read(&mut bytes).unwrap();
        assert!(n > 0, "incomplete HTTP request");
        request.extend_from_slice(&bytes[..n]);
    }
    String::from_utf8(request).unwrap()
}

fn pending_store(path: &Path) -> ota::UiStore {
    let store = ota::UiStore::new(path);
    store.stage_bundle("installed", &bundle()).unwrap();
    store.promote_staged().unwrap();
    store.stage_bundle("pending", &bundle()).unwrap();
    store
}

fn recheck_pending(manifest_version: &str) {
    let dir = TempDir::new();
    let store = pending_store(&dir.0);
    let manifest = format!(
        r#"{{"version":"{manifest_version}","sha256":"unused","size":42,"url":"/bundle.zip"}}"#
    );
    let (url, task) = manifest_server(200, &manifest);
    let result = ota::check_and_stage(&url, "test-token", &store);
    let request = task.join().unwrap();
    assert!(request.starts_with("GET /api/ui-ota/manifest.json "));
    assert!(request.to_lowercase().contains("cache-control: no-cache"));
    let update = result
        .unwrap()
        .expect("pending update must remain available");
    assert_eq!(update.version, "pending");
    assert_eq!(store.staged_version().as_deref(), Some("pending"));
    assert_eq!(store.installed_version().as_deref(), Some("installed"));
}

#[test]
fn recheck_same_staged_ui_is_available() {
    recheck_pending("pending");
}

#[test]
fn recheck_current_manifest_does_not_hide_staged_ui() {
    recheck_pending("installed");
}

#[test]
fn recheck_changed_manifest_preserves_staged_ui() {
    recheck_pending("different");
}

#[test]
fn failed_ui_refresh_is_error_with_pending_payload_not_current() {
    let dir = TempDir::new();
    let store = pending_store(&dir.0);
    for (status, body, reason) in [
        (401, "{}", "HTTP 401"),
        (503, "{}", "HTTP 503"),
        (200, "bad json", "invalid update response"),
    ] {
        let (url, task) = manifest_server(status, body);
        let outcome = update_checks::check_ui(&url, "test-token", &store);
        task.join().unwrap();
        assert_eq!(outcome.status, Status::Error);
        assert!(outcome.reason.unwrap().contains(reason));
        assert_eq!(outcome.update.unwrap().version, "pending");
        assert_eq!(store.staged_version().as_deref(), Some("pending"));
    }
}

#[test]
fn successful_current_ui_manifest_is_current_without_pending() {
    let dir = TempDir::new();
    let store = pending_store(&dir.0);
    store.promote_staged().unwrap();
    let (url, task) = manifest_server(
        200,
        r#"{"version":"pending","sha256":"unused","url":"/bundle"}"#,
    );
    let outcome = update_checks::check_ui(&url, "test-token", &store);
    task.join().unwrap();
    assert_eq!(outcome.status, Status::Current);
    assert!(outcome.update.is_none());
}

#[test]
fn fresh_ui_download_is_verified_and_staged_without_promotion() {
    let dir = TempDir::new();
    let store = ota::UiStore::new(&dir.0);
    let zip = bundle();
    let (url, task) = ui_download_server(&zip, &digest(&zip));
    let outcome = update_checks::check_ui(&url, "test-token", &store);
    task.join().unwrap();
    assert_eq!(outcome.status, Status::Available);
    assert_eq!(store.staged_version().as_deref(), Some("fresh"));
    assert!(store.installed_version().is_none());
}

#[test]
fn invalid_ui_download_is_error_and_never_staged() {
    let dir = TempDir::new();
    let store = ota::UiStore::new(&dir.0);
    let (url, task) = ui_download_server(&bundle(), "bad-hash");
    let outcome = update_checks::check_ui(&url, "test-token", &store);
    task.join().unwrap();
    assert_eq!(outcome.status, Status::Error);
    assert!(store.staged_version().is_none());
}

fn ui_download_server(zip: &[u8], hash: &str) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let body =
        serde_json::json!({"version":"fresh", "sha256":hash, "url":"/bundle.zip"}).to_string();
    let responses = [body.into_bytes(), zip.to_vec()];
    let task = std::thread::spawn(move || {
        for body in responses {
            let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
            response.extend(body);
            let request = serve_once(listener.try_clone().unwrap(), response);
            assert!(request.contains("test-token"));
        }
    });
    (url, task)
}

fn shell_manifest(version: &str, url: &str, hash: &str) -> String {
    serde_json::json!({"version": version, "assets": [{
        "name": "installer.deb", "os": "linux", "arch": "x86_64", "kind": "deb",
        "url": url, "sha256": hash, "size": 9
    }]})
    .to_string()
}

fn shell_check(
    body: &str,
    store: &app_update::UpdateStore,
) -> ChannelOutcome<app_update::AppUpdate> {
    let (url, task) = manifest_server(200, body);
    let result = shell_request(&url, store);
    let request = task.join().unwrap().to_lowercase();
    assert!(request.contains("x-cortex-token: test-token"));
    assert!(request.contains("cache-control: no-cache"));
    result.unwrap()
}

fn shell_request(
    url: &str,
    store: &app_update::UpdateStore,
) -> Result<ChannelOutcome<app_update::AppUpdate>, String> {
    app_update::check_and_prepare(
        url,
        "test-token",
        "2026.9.1",
        "linux",
        "x86_64",
        "deb",
        store,
    )
}

#[test]
fn shell_current_skipped_and_missing_asset_are_distinct() {
    let dir = TempDir::new();
    let store = app_update::UpdateStore::new(&dir.0);
    assert_eq!(shell_check("{}", &store).status, Status::Current);
    assert_eq!(
        shell_check(r#"{"version":"2026.9.1"}"#, &store).status,
        Status::Current
    );
    let missing = shell_check(r#"{"version":"2026.9.2"}"#, &store);
    assert_eq!(missing.status, Status::Skipped);
    assert_eq!(missing.reason.as_deref(), Some("no_matching_asset"));
    store.set_skipped("2026.9.2").unwrap();
    let skipped = shell_check(r#"{"version":"2026.9.2"}"#, &store);
    assert_eq!(skipped.status, Status::Skipped);
    assert_eq!(skipped.reason.as_deref(), Some("version_skipped"));
}

#[test]
fn shell_download_verifies_and_never_sends_server_token_to_asset_host() {
    let dir = TempDir::new();
    let store = app_update::UpdateStore::new(&dir.0);
    let (asset_url, asset_task) = manifest_server(200, "installer");
    let hash = digest(b"installer");
    let manifest = shell_manifest("2026.9.2", &asset_url, &hash);
    let result = shell_check(&manifest, &store);
    assert_eq!(result.status, Status::Available);
    assert!(!asset_task.join().unwrap().contains("test-token"));
    let update = result.update.unwrap();
    assert!(app_update::verified(&update));
    assert_eq!(std::fs::read(&update.path).unwrap(), b"installer");
    // Asset server has stopped: only fresh manifest reads + verified cache reuse can pass.
    assert_eq!(shell_check(&manifest, &store).status, Status::Available);
    assert_eq!(shell_check(&manifest, &store).status, Status::Available);
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn bad_shell_download_fails_verification_without_replacing_old_file() {
    let dir = TempDir::new();
    let store = app_update::UpdateStore::new(&dir.0);
    store.ensure_root().unwrap();
    std::fs::write(store.asset_path("installer.deb"), b"old verified installer").unwrap();
    let (asset_url, asset_task) = manifest_server(200, "tampered");
    let (url, task) = manifest_server(
        200,
        &shell_manifest("2026.9.2", &asset_url, &digest(b"installer")),
    );
    let result = shell_request(&url, &store);
    task.join().unwrap();
    asset_task.join().unwrap();
    assert_eq!(result.unwrap_err(), "asset sha256 mismatch");
    assert_eq!(
        std::fs::read(store.asset_path("installer.deb")).unwrap(),
        b"old verified installer"
    );
    assert!(!store.asset_path("installer.deb.part").exists());
}

#[test]
fn shell_http_failure_is_an_error_not_a_current_result() {
    let dir = TempDir::new();
    let store = app_update::UpdateStore::new(&dir.0);
    let (url, task) = manifest_server(403, "{}");
    let result = shell_request(&format!("{url}/private-query?secret=value"), &store);
    task.join().unwrap();
    let reason = result.unwrap_err();
    assert!(reason.contains("HTTP 403"));
    assert!(!reason.contains("secret"));
    assert!(!reason.contains("test-token"));
    assert!(!reason.contains("127.0.0.1"));
}

#[test]
fn dev_shell_check_is_skipped_without_network() {
    let dir = TempDir::new();
    let result = app_update::check_and_prepare(
        "not a URL",
        "test-token",
        "0.0.1",
        "linux",
        "x86_64",
        "deb",
        &app_update::UpdateStore::new(&dir.0),
    )
    .unwrap();
    assert_eq!(result.status, Status::Skipped);
    assert_eq!(result.reason.as_deref(), Some("dev_version"));
}

fn current_report() -> CheckReport {
    CheckReport {
        ui: ChannelOutcome::current(),
        shell: ChannelOutcome::current(),
    }
}

fn with_inflight_operation(body: impl FnOnce(&UpdateGate)) {
    let gate = std::sync::Arc::new(UpdateGate::new());
    let worker_gate = gate.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        update_checks::guarded(&worker_gate, || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            current_report()
        })
    });
    started_rx.recv().unwrap();
    body(&gate);
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(
        update_checks::guarded(&gate, current_report).ui.status,
        Status::Current
    );
}

#[test]
fn concurrent_manual_background_and_install_operations_cannot_enter() {
    with_inflight_operation(|gate| {
        let duplicate = update_checks::guarded(gate, || panic!("overlap must not touch stores"));
        assert_eq!(duplicate.ui.status, Status::Skipped);
        assert_eq!(
            duplicate.shell.reason.as_deref(),
            Some("update_in_progress")
        );
        assert_eq!(gate.begin().unwrap_err(), "update_in_progress");
    });
}

#[test]
fn restart_or_direct_install_handoff_latches_until_relaunch() {
    let gate = UpdateGate::new();
    *gate.begin().unwrap() = true;
    assert_eq!(gate.begin().unwrap_err(), "restart_or_install_pending");
    let result = update_checks::guarded(&gate, || panic!("must not write during handoff"));
    assert_eq!(result.ui.status, Status::Skipped);
    assert_eq!(
        result.shell.reason.as_deref(),
        Some("restart_or_install_pending")
    );
}

#[test]
fn errors_release_the_gate_but_panics_poison_it() {
    let gate = UpdateGate::new();
    update_checks::guarded(&gate, || CheckReport::error("offline"));
    assert!(gate.begin().is_ok());
    let _ = std::panic::catch_unwind(|| update_checks::guarded(&gate, || panic!("worker panic")));
    let result = update_checks::guarded(&gate, || panic!("poisoned store must not be touched"));
    assert_eq!(result.ui.status, Status::Error);
    assert_eq!(result.shell.reason.as_deref(), Some("update_lock_poisoned"));
}

#[test]
fn outcome_mapping_preserves_pending_without_hiding_errors_or_skips() {
    let failed = update_checks::reconcile::<u8>(Err("offline".into()), Some(7));
    assert_eq!(failed.status, Status::Error);
    assert_eq!(failed.update, Some(7));
    let skipped = update_checks::reconcile(Ok(ChannelOutcome::skipped("version_skipped")), Some(7));
    assert_eq!(skipped.status, Status::Skipped);
    assert_eq!(skipped.update, Some(7));
    let current = update_checks::reconcile(Ok(ChannelOutcome::current()), Some(7));
    assert_eq!(current.status, Status::Available);
    assert_eq!(current.update, Some(7));
    let fresh = update_checks::reconcile(Ok(ChannelOutcome::available(8)), Some(7));
    assert_eq!(fresh.update, Some(8));
}

fn prepared_shell() -> app_update::AppUpdate {
    app_update::AppUpdate {
        version: "2026.9.2".into(),
        release_url: None,
        notes: None,
        size: 9,
        kind: "deb".into(),
        path: PathBuf::from("private-installer"),
        sha256: "private-hash".into(),
    }
}

#[test]
fn failed_skip_write_preserves_prepared_shell() {
    let dir = TempDir::new();
    std::fs::write(dir.0.join("updates"), b"not a directory").unwrap();
    let store = app_update::UpdateStore::new(&dir.0);
    let mut pending = Some(prepared_shell());
    let result = update_checks::skip_prepared(&mut pending, |version| {
        store.set_skipped(version).map_err(|e| e.to_string())
    });
    assert!(result.is_err());
    assert_eq!(pending.unwrap().version, "2026.9.2");
}

#[test]
fn successful_skip_write_clears_prepared_shell() {
    let dir = TempDir::new();
    let store = app_update::UpdateStore::new(&dir.0);
    let mut pending = Some(prepared_shell());
    update_checks::skip_prepared(&mut pending, |version| {
        store.set_skipped(version).map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(pending.is_none());
    assert_eq!(store.skipped_version().as_deref(), Some("2026.9.2"));
}

#[test]
fn report_wire_schema_has_lowercase_statuses_and_no_internal_shell_fields() {
    let report = CheckReport {
        ui: ChannelOutcome::current(),
        shell: ChannelOutcome::available(prepared_shell()),
    };
    let json = serde_json::to_value(report).unwrap();
    assert_eq!(json["ui"], serde_json::json!({"status": "current"}));
    assert_eq!(
        json["shell"],
        serde_json::json!({"status": "available", "update": {
            "version": "2026.9.2", "releaseUrl": null, "notes": null, "size": 9, "kind": "deb"
        }})
    );
}

#[test]
fn skipped_and_error_wire_schema_includes_reason() {
    assert_eq!(
        serde_json::to_value(ChannelOutcome::<u8>::skipped("no_credentials")).unwrap(),
        serde_json::json!({"status": "skipped", "reason": "no_credentials"})
    );
    assert_eq!(
        serde_json::to_value(ChannelOutcome::<u8>::error("offline")).unwrap(),
        serde_json::json!({"status": "error", "reason": "offline"})
    );
}
