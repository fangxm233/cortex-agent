//! Cancellation regressions: all executables and records live under temporary directories.
use super::*;
use std::{
    process::Command,
    time::{Duration, Instant},
};

struct Unrelated(std::process::Child);
impl Drop for Unrelated {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const STALL: &str = r#"echo started > "$CORTEX_HOME/probe-started"; /bin/sleep 2 & wait"#;

fn cancel_at_marker(marker: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(Instant::now() < deadline, "probe never started: {}", marker.display());
        std::thread::sleep(Duration::from_millis(10));
    }
    cancel_install();
}

fn cancelled_install(home: &Path, bundle: &Path) -> (Result<Selection, String>, Duration) {
    let owner = InstallGuard::begin().unwrap();
    let marker = home.join("probe-started");
    let mut unrelated = Unrelated(Command::new("/bin/sleep").arg("30").spawn().unwrap());
    let start = Instant::now();
    let result = std::thread::scope(|scope| {
        scope.spawn(|| cancel_at_marker(&marker));
        ensure_server(
            home,
            bundle,
            OsStr::new(PATH),
            || Ok("fixture.tgz".into()),
            "2026.8.20",
            owner.token(),
            &|_| {},
        )
    });
    let elapsed = start.elapsed();
    assert!(unrelated.0.try_wait().unwrap().is_none(), "unrelated process was killed");
    (result, elapsed)
}

#[test]
fn a_stalled_node_probe_cancels_promptly_without_saving() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // The fixture node probes as CORTEX_HOME-less; point the marker at home explicitly.
    let node = format!(
        r#"if [ "$1" = --version ]; then CORTEX_HOME="{}"; {STALL}; echo v24.21.0; else exec /bin/sh "$@"; fi"#,
        home.display()
    );
    let bundle = bundle_with(root.path(), &node, &npm_script("2026.10.6"));
    let (result, elapsed) = cancelled_install(&home, &bundle);
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    assert!(!home.join("runtime/selection.json").exists());
}

#[test]
fn a_stalled_saved_server_probe_cancels_without_replacing_the_server() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle(root.path());
    let home = root.path().join("home");
    install(&home, &bundle).unwrap();
    let saved = Selection::load(&home).unwrap().unwrap();
    script(&saved.server.as_ref().unwrap().bin, &format!("{STALL}; echo 2026.10.6"));
    let (result, elapsed) = cancelled_install(&home, &bundle);
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    assert_eq!(Selection::load(&home).unwrap().unwrap(), saved);
    assert_eq!(installs(&home), 1);
}

#[test]
fn a_cancelled_final_check_never_saves_the_new_server() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let slow = npm_script("2026.10.6").replace(
        r"printf '#!/bin/sh\necho 2026.10.6\n'",
        &format!(r"printf '#!/bin/sh\n{STALL}; echo 2026.10.6\n'"),
    );
    let bundle = bundle_with(root.path(), NODE, &slow);
    let home = root.path().join("home");
    let (result, elapsed) = cancelled_install(&home, &bundle);
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    assert!(Selection::load(&home).unwrap().unwrap().server.is_none());
}
