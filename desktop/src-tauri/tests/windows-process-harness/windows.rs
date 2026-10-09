use super::{cancel, probe, process, CancelToken};
use process::windows::{job::Owned, run};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

fn fixture(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_owned-fixture"));
    command.args(args);
    command
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "cortex-owned-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn marker(&self) -> PathBuf {
        self.0.join("marker")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct TestChild(std::process::Child);
impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn marker_ready(marker: &Path) -> bool {
    std::fs::read_to_string(marker).is_ok_and(|s| s.parse::<u32>().is_ok())
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "fixture deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn process_handle(pid: u32) -> Option<OwnedHandle> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    (!handle.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn assert_dead(pid: u32) {
    if let Some(handle) = process_handle(pid) {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }
}

fn marker_pid(marker: &Path) -> u32 {
    std::fs::read_to_string(marker).unwrap().parse().unwrap()
}

#[test]
fn assigned_and_verified_before_any_child_bytecode() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let owned = Owned::suspended(fixture(&["sleep", marker.to_str().unwrap()])).unwrap();
    assert!(owned.is_member().unwrap());
    assert_eq!(owned.accounting().unwrap().ActiveProcesses, 1);
    std::thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists(), "child executed before resume");
    owned.resume().unwrap();
    wait_until(|| marker_ready(&marker));
    let pid = owned.child.id();
    drop(owned);
    assert_dead(pid);
}

#[test]
fn error_unwind_before_resume_never_runs_child() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let owned = Owned::suspended(fixture(&["sleep", marker.to_str().unwrap()])).unwrap();
    let pid = owned.child.id();
    // Same RAII path as a token/error between successful assignment and resume.
    drop(owned);
    assert!(!marker.exists());
    assert_dead(pid);
}

#[test]
fn resume_failure_cannot_fall_back_to_unowned_execution() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let mut owned = Owned::suspended(fixture(&["sleep", marker.to_str().unwrap()])).unwrap();
    owned.child.kill().unwrap();
    owned.child.wait().unwrap();
    assert!(owned.resume().is_err());
    drop(owned);
    assert!(!marker.exists());
}

#[test]
fn descendants_cannot_request_breakaway() {
    let outcome =
        process::run_install_outcome(fixture(&["breakaway"]), &CancelToken::default(), &|_| {})
            .unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout).trim(),
        "breakaway denied"
    );
}

#[test]
fn fast_descendant_is_accounted_even_after_exit() {
    let mut owned = Owned::suspended(fixture(&["fast"])).unwrap();
    owned.resume().unwrap();
    assert!(owned.child.wait().unwrap().success());
    wait_until(|| owned.accounting().unwrap().ActiveProcesses == 0);
    assert!(owned.accounting().unwrap().TotalProcesses >= 2);
}

#[test]
fn root_exit_settles_descendant_held_output_handles() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let started = Instant::now();
    let outcome = process::run_install_outcome(
        fixture(&["tree-exit", marker.to_str().unwrap()]),
        &CancelToken::default(),
        &|_| {},
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_dead(marker_pid(&marker));
}

fn cancel_owned_tree(marker: &Path, token: &CancelToken) {
    std::thread::scope(|scope| {
        let result = scope.spawn(|| {
            process::run_install(
                fixture(&["tree-wait", marker.to_str().unwrap()]),
                token,
                &|_| {},
            )
        });
        wait_until(|| marker_ready(marker));
        cancel::cancel_install();
        assert_eq!(result.join().unwrap().unwrap_err(), "SETUP_CANCELLED");
    });
}

#[test]
fn cancellation_settles_descendants_and_leaves_outsider_alive() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let outsider_marker = scratch.0.join("outsider");
    let mut outsider = TestChild(
        fixture(&["sleep", outsider_marker.to_str().unwrap()])
            .spawn()
            .unwrap(),
    );
    let guard = cancel::InstallGuard::begin().unwrap();
    cancel_owned_tree(&marker, guard.token());
    assert_dead(marker_pid(&marker));
    assert!(outsider.0.try_wait().unwrap().is_none());
    drop(outsider);
    let pre_cancelled = scratch.0.join("pre-cancelled");
    assert!(process::run_install(
        fixture(&["sleep", pre_cancelled.to_str().unwrap()]),
        guard.token(),
        &|_| {}
    )
    .is_err());
    assert!(!pre_cancelled.exists());
    drop(guard);
    assert!(
        process::run_install(fixture(&["exit", "0"]), &CancelToken::default(), &|_| {}).is_ok()
    );
}

#[test]
fn probe_deadline_and_limit_settle_before_return() {
    let scratch = Scratch::new();
    let marker = scratch.marker();
    let start = Instant::now();
    let result = run(
        fixture(&["sleep", marker.to_str().unwrap()]),
        &CancelToken::default(),
        Some(Duration::from_millis(500)),
        &|_| {},
    );
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
    if marker_ready(&marker) {
        assert_dead(marker_pid(&marker));
    }
    let start = Instant::now();
    assert!(
        probe::output(fixture(&["flood"]), &[], &CancelToken::default())
            .unwrap()
            .is_none()
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn bounded_outcome_preserves_nonzero_but_normal_install_rejects_it() {
    let outcome =
        process::run_install_outcome(fixture(&["exit", "7"]), &CancelToken::default(), &|_| {})
            .unwrap();
    assert_eq!(outcome.exit_code, 7);
    assert_eq!(String::from_utf8_lossy(&outcome.stdout).trim(), "out");
    assert_eq!(String::from_utf8_lossy(&outcome.stderr).trim(), "err");
    assert!(
        process::run_install(fixture(&["exit", "7"]), &CancelToken::default(), &|_| {}).is_err()
    );
    let outcome =
        process::run_install_outcome(fixture(&["flood"]), &CancelToken::default(), &|_| {})
            .unwrap();
    assert_eq!(outcome.stdout.len(), 65536);
    assert_eq!(outcome.stderr.len(), 65536);
    assert!(outcome.stdout_truncated && outcome.stderr_truncated);
    assert_eq!(outcome.exit_code, 0);
}

#[test]
fn probe_qualifies_only_successful_stdout() {
    assert_eq!(
        probe::output(fixture(&["exit", "0"]), &[], &CancelToken::default())
            .unwrap()
            .as_deref(),
        Some("out")
    );
    assert!(
        probe::output(fixture(&["exit", "7"]), &[], &CancelToken::default())
            .unwrap()
            .is_none()
    );
    assert!(probe::output(
        Command::new("Z:\\missing-owned-probe.exe"),
        &[],
        &CancelToken::default()
    )
    .unwrap()
    .is_none());
}

#[test]
fn command_preserves_quoting_env_clear_removal_and_case_insensitive_path() {
    let args = ["", "two words", "quote\"and\\tail\\", "中文😀", "a&b|c"];
    let mut command = fixture(&["echo"]);
    command
        .args(args)
        .env_clear()
        .env("Path", "old")
        .env("PATH", "chosen")
        .env("CORTEX_REMOVED", "value")
        .env_remove("cortex_removed");
    let outcome = process::run_install_outcome(command, &CancelToken::default(), &|_| {}).unwrap();
    assert_eq!(outcome.exit_code, 0);
    let output = String::from_utf8_lossy(&outcome.stdout);
    let lines: Vec<_> = output.lines().collect();
    assert_eq!(
        lines,
        [
            format!("{args:?}"),
            "Path=Some(\"chosen\")".into(),
            "Removed=None".into()
        ]
    );
}

#[test]
fn cmd_script_is_owned_without_reimplementing_command_quoting() {
    let scratch = Scratch::new();
    let script = scratch.0.join("with space.cmd");
    std::fs::write(
        &script,
        "@echo off\r\necho %CORTEX_FIXTURE%\r\nexit /b 7\r\n",
    )
    .unwrap();
    let mut command = Command::new(script);
    command.env("CORTEX_FIXTURE", "selected");
    let outcome = process::run_install_outcome(command, &CancelToken::default(), &|_| {}).unwrap();
    assert_eq!(outcome.exit_code, 7);
    assert_eq!(String::from_utf8_lossy(&outcome.stdout).trim(), "selected");
}
