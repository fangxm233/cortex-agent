use super::*;

const SYSTEM: &str = "C:\\Windows";
const DIAGNOSTIC: &[u8] = b"The batch file cannot be found.\r\n";

#[test]
fn postinstall_current_system_diagnostic_is_not_a_fixed_locale() {
    for bytes in [DIAGNOSTIC, b"opaque non-UTF8: \xff\xfe\r\n"] {
        assert!(accept_outcome(
            1,
            &expected_stdout(SYSTEM),
            bytes,
            false,
            true,
            SYSTEM,
            || Ok(valid_diagnostic(bytes)),
        )
        .is_ok());
    }
}

fn valid_diagnostic(bytes: &[u8]) -> SelfDeleteDiagnostic {
    let dir = tempfile::tempdir().unwrap();
    let batch = dir.path().join("post-install.bat");
    touch(&batch, b"@DEL post-install.bat\r\n");
    std::fs::remove_file(&batch).unwrap(); // Simulated synthetic command, never executed.
    SelfDeleteDiagnostic::validate(1, b"", bytes, false, &batch, &CancelToken::default()).unwrap()
}

fn accept_fixture(code: u32, stdout: &[u8], stderr: &[u8], truncated: bool, ready: bool) -> bool {
    accept_outcome(code, stdout, stderr, truncated, ready, SYSTEM, || {
        Ok(valid_diagnostic(DIAGNOSTIC))
    })
    .is_ok()
}

#[test]
fn postinstall_exact_self_delete_only_after_readiness() {
    let stdout = expected_stdout(SYSTEM);
    assert!(accept_fixture(0, &stdout, b"", false, true));
    assert!(accept_fixture(1, &stdout, DIAGNOSTIC, false, true));
    for stderr in [
        b"".as_slice(),
        b"other diagnostic",
        b"The batch file cannot be found.\n",
    ] {
        assert!(!accept_fixture(1, &stdout, stderr, false, true));
    }
    assert!(!accept_fixture(1, &stdout, DIAGNOSTIC, true, true));
    assert!(!accept_fixture(1, &stdout, DIAGNOSTIC, false, false));
    assert!(!accept_fixture(0, &stdout, DIAGNOSTIC, false, true));
    let mut extra = stdout.clone();
    extra.extend_from_slice(b"warning\n");
    assert!(!accept_fixture(1, &extra, DIAGNOSTIC, false, true));
}

#[test]
fn postinstall_raw_mismatch_is_not_lossily_decoded_or_prefix_matched() {
    for (real, calibrated) in [
        (b"\xff\r\n".as_slice(), b"\xfe\r\n".as_slice()),
        (b"error\r\nextra", b"error\r\n"),
        (b"error\r\n", b"error\r\nextra"),
    ] {
        assert!(accept_outcome(
            1,
            &expected_stdout(SYSTEM),
            real,
            false,
            true,
            SYSTEM,
            || Ok(valid_diagnostic(calibrated))
        )
        .is_err());
    }
}

#[test]
fn postinstall_zero_still_requires_clean_complete_readiness() {
    let stdout = expected_stdout(SYSTEM);
    for (out, err, truncated, ready) in [
        (stdout.as_slice(), b"warning".as_slice(), false, true),
        (b"", b"", false, true),
        (stdout.as_slice(), b"", true, true),
        (stdout.as_slice(), b"", false, false),
    ] {
        assert!(
            accept_outcome(0, out, err, truncated, ready, SYSTEM, || panic!(
                "exit zero must not calibrate"
            ))
            .is_err()
        );
    }
}

#[test]
fn postinstall_never_calibrates_zero_or_other_exit_codes() {
    for code in [0, 2, 37, 255, u32::MAX] {
        let result = accept_outcome(
            code,
            &expected_stdout(SYSTEM),
            b"",
            false,
            true,
            SYSTEM,
            || panic!("calibration is exit-1-only"),
        );
        assert_eq!(result.is_ok(), code == 0);
    }
}

#[test]
fn postinstall_calibration_error_or_timeout_cannot_qualify() {
    for error in [
        "SERVER_INSTALL_FAILED: probe deadline",
        "SETUP_CANCELLED",
        "spawn failed",
    ] {
        let result = accept_outcome(
            1,
            &expected_stdout(SYSTEM),
            DIAGNOSTIC,
            false,
            true,
            SYSTEM,
            || Err(error.into()),
        );
        assert_eq!(result.err().as_deref(), Some(error));
    }
}

#[test]
fn calibration_requires_exit_one_empty_stdout_and_bounded_raw_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("post-install.bat");
    let token = CancelToken::default();
    for code in [0, 2, 255, u32::MAX] {
        assert!(
            SelfDeleteDiagnostic::validate(code, b"", DIAGNOSTIC, false, &absent, &token).is_err()
        );
    }
    for (stdout, stderr, truncated) in [
        (b"output".as_slice(), DIAGNOSTIC, false),
        (b"", b"", false),
        (b"", DIAGNOSTIC, true),
        (b"", &[42; 1025][..], false),
    ] {
        assert!(
            SelfDeleteDiagnostic::validate(1, stdout, stderr, truncated, &absent, &token).is_err()
        );
    }
    assert_eq!(valid_diagnostic(&[255; 1024]).0, vec![255; 1024]);
}

#[test]
fn calibration_requires_actual_deletion_not_a_remaining_file_or_directory() {
    let dir = tempfile::tempdir().unwrap();
    let batch = dir.path().join("post-install.bat");
    touch(&batch, b"@DEL post-install.bat\r\n");
    let token = CancelToken::default();
    assert!(SelfDeleteDiagnostic::validate(1, b"", DIAGNOSTIC, false, &batch, &token).is_err());
    assert!(SelfDeleteDiagnostic::validate(1, b"", DIAGNOSTIC, false, dir.path(), &token).is_err());
}

#[test]
fn calibration_cancellation_cannot_construct_diagnostic() {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let guard = super::super::InstallGuard::begin().unwrap();
    super::super::cancel_install();
    let dir = tempfile::tempdir().unwrap();
    let result = SelfDeleteDiagnostic::validate(
        1,
        b"",
        DIAGNOSTIC,
        false,
        &dir.path().join("post-install.bat"),
        guard.token(),
    );
    assert_eq!(result.err().as_deref(), Some("SETUP_CANCELLED"));
}

#[test]
fn calibration_directory_is_private_fresh_and_preserves_official_batch() {
    let root = tempfile::tempdir().unwrap();
    let stage = root.path().join("stage");
    let home = root.path().join("home");
    touch(&stage.join("post-install.bat"), b"official immutable batch");
    std::fs::create_dir(&home).unwrap();
    let first = self_delete_directory(&stage, &home).unwrap();
    let second = self_delete_directory(&stage, &home).unwrap();
    let first_path = first.path().to_path_buf();
    assert_ne!(first.path(), second.path());
    assert_eq!(
        first.path().parent(),
        Some(home.canonicalize().unwrap().as_path())
    );
    assert_eq!(
        std::fs::read(first.path().join("post-install.bat")).unwrap(),
        b"@DEL post-install.bat\r\n"
    );
    drop(first);
    assert!(!first_path.exists());
    assert!(second.path().exists());
    assert_eq!(
        std::fs::read(stage.join("post-install.bat")).unwrap(),
        b"official immutable batch"
    );
}

#[test]
fn calibration_rejects_home_inside_official_payload() {
    let root = tempfile::tempdir().unwrap();
    let stage = root.path().join("stage");
    let nested = stage.join("home");
    std::fs::create_dir_all(&nested).unwrap();
    touch(&stage.join("post-install.bat"), b"official");
    assert!(self_delete_directory(&stage, &stage).is_err());
    assert!(self_delete_directory(&stage, &nested).is_err());
    assert_eq!(std::fs::read_dir(&nested).unwrap().count(), 0);
    assert_eq!(
        std::fs::read(stage.join("post-install.bat")).unwrap(),
        b"official"
    );
}

#[test]
fn calibration_uses_same_launcher_flags_and_sanitized_environment() {
    let stage = Path::new("/stage");
    let home = Path::new("/private-home");
    let system = Path::new("/windows");
    let cwd = home.join("self-delete-fixture");
    let upstream = postinstall_command(stage, stage, home, system).unwrap();
    let diagnostic = postinstall_command(stage, &cwd, home, system).unwrap();
    assert_eq!(diagnostic.get_program(), stage.join("git-bash.exe"));
    assert_eq!(
        diagnostic.get_args().collect::<Vec<_>>(),
        [
            "--no-needs-console",
            "--hide",
            "--no-cd",
            "--command=post-install.bat",
        ]
    );
    assert_eq!(
        upstream.get_args().collect::<Vec<_>>(),
        diagnostic.get_args().collect::<Vec<_>>()
    );
    assert_eq!(
        upstream.get_envs().collect::<Vec<_>>(),
        diagnostic.get_envs().collect::<Vec<_>>()
    );
    assert_eq!(upstream.get_current_dir(), Some(stage));
    assert_eq!(diagnostic.get_current_dir(), Some(cwd.as_path()));
}

#[cfg(unix)]
#[test]
fn calibration_rejects_home_alias_into_payload_and_undeleted_dangling_batch() {
    let root = tempfile::tempdir().unwrap();
    let stage = root.path().join("stage");
    std::fs::create_dir(&stage).unwrap();
    let alias = root.path().join("home");
    std::os::unix::fs::symlink(&stage, &alias).unwrap();
    assert!(self_delete_directory(&stage, &alias).is_err());
    let batch = root.path().join("post-install.bat");
    std::os::unix::fs::symlink(root.path().join("missing"), &batch).unwrap();
    assert!(SelfDeleteDiagnostic::validate(
        1,
        b"",
        DIAGNOSTIC,
        false,
        &batch,
        &CancelToken::default()
    )
    .is_err());
}

#[test]
fn postinstall_blocks_startup_and_git_injection_keys() {
    for key in [
        "BASH_ENV",
        "env",
        "Git_Config_Global",
        "MSYSTEM",
        "MSYS2_PATH_TYPE",
        "ORIGINAL_PATH",
        "SYSCONFDIR",
        "BASH_FUNC_echo%%",
        "HOME",
        "XDG_CONFIG_HOME",
        "SHELLOPTS",
        "BASHOPTS",
    ] {
        assert!(remove_key(key), "{key}");
    }
    assert!(!remove_key("SystemRoot"));
}

#[test]
fn postinstall_sanitizes_only_its_child_environment() {
    let mut command = std::process::Command::new("fixture");
    command.env("gIt_Config_Global", "unsafe");
    sanitize(
        &mut command,
        Path::new("/private"),
        Path::new("/stage"),
        Path::new("/windows"),
    )
    .unwrap();
    let env: std::collections::HashMap<_, _> = command.get_envs().collect();
    assert_eq!(env[std::ffi::OsStr::new("gIt_Config_Global")], None);
    assert_eq!(
        env[std::ffi::OsStr::new("HOME")],
        Some(std::ffi::OsStr::new("/private"))
    );
}

#[test]
fn readiness_requires_exe_sentinel_and_upstream_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let stage = dir.path().join("stage");
    let system = dir.path().join("windows");
    readiness_fixture(&stage, &system);
    assert!(ready_files(&stage, &system, &CancelToken::default()).is_ok());
    std::fs::rename(
        stage.join("ucrt64/libexec/git-core/dlls-copied.exe"),
        stage.join("ucrt64/libexec/git-core/dlls-copied"),
    )
    .unwrap();
    assert!(ready_files(&stage, &system, &CancelToken::default()).is_err());
    readiness_fixture(&stage, &system);
    std::fs::write(stage.join("post-install.bat"), "leftover").unwrap();
    assert!(ready_files(&stage, &system, &CancelToken::default()).is_err());
}

fn readiness_fixture(stage: &Path, system: &Path) {
    for (source, target, _) in NETWORK_FILES {
        touch(&system.join("System32/drivers/etc").join(source), b"system");
        touch(&stage.join("etc").join(target), b"system");
    }
    for name in [
        "ucrt64/bin/git.exe",
        "ucrt64/libexec/git-core/dlls-copied.exe",
        "ucrt64/bin/test.dll",
        "ucrt64/libexec/git-core/test.dll",
    ] {
        touch(&stage.join(name), b"dll");
    }
    for name in ["dev/shm", "dev/mqueue"] {
        std::fs::create_dir_all(stage.join(name)).unwrap();
    }
    touch(&stage.join("etc/mtab"), b"!<symlink>/proc/mounts");
}

fn assert_check<T>(result: Result<T, String>, label: &str) {
    assert_eq!(
        result.err().as_deref(),
        Some(
            format!("RUNTIME_INTEGRITY_FAILED: PortableGit post-install did not qualify [{label}]")
                .as_str()
        )
    );
}

#[test]
fn postinstall_fixed_labels_distinguish_cleanup_and_copies_without_paths() {
    for (path, label) in [
        ("post-install.bat", "cleanup-post-install-bat"),
        ("etc/post-install", "cleanup-etc-post-install"),
        ("etc/hosts", "network-hosts"),
        ("etc/protocols", "network-protocols"),
        ("etc/services", "network-services"),
        ("etc/networks", "network-networks"),
        ("ucrt64/libexec/git-core/dlls-copied.exe", "dll-sentinel"),
        ("ucrt64/libexec/git-core/test.dll", "dll-copies"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("private-stage-SECRET");
        let system = dir.path().join("private-system-SECRET");
        readiness_fixture(&stage, &system);
        touch(&stage.join(path), b"secret-copy-content");
        assert_check(ready_files(&stage, &system, &CancelToken::default()), label);
    }
}

#[test]
fn postinstall_fixed_labels_distinguish_each_native_marker() {
    for (path, label) in [
        ("dev/shm", "native-dev-shm"),
        ("dev/mqueue", "native-dev-mqueue"),
        ("etc/mtab", "native-etc-mtab"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("SECRET-stage");
        let system = dir.path().join("SECRET-system");
        readiness_fixture(&stage, &system);
        std::fs::rename(stage.join(path), stage.join("SECRET-moved-marker")).unwrap();
        assert_check(ready_files(&stage, &system, &CancelToken::default()), label);
    }
}

#[test]
fn postinstall_fixed_labels_distinguish_output_without_disclosing_bytes() {
    let stdout = expected_stdout(SYSTEM);
    assert_outcome_check(0, &stdout, b"", true, true, "postinstall-truncation");
    assert_outcome_check(0, b"SECRET-stdout", b"", false, true, "postinstall-stdout");
    assert_outcome_check(0, &stdout, b"", false, false, "postinstall-readiness");
    assert_outcome_check(0, &stdout, b"SECRET", false, true, "postinstall-stderr");
    assert_outcome_check(2, &stdout, b"", false, true, "postinstall-exit");
    assert_outcome_check(1, &stdout, b"SECRET", false, true, "calibration-mismatch");
}

fn assert_outcome_check(
    code: u32,
    out: &[u8],
    err: &[u8],
    truncated: bool,
    ready: bool,
    label: &str,
) {
    assert_check(
        accept_outcome(code, out, err, truncated, ready, SYSTEM, || {
            Ok(valid_diagnostic(DIAGNOSTIC))
        }),
        label,
    );
}

#[test]
fn postinstall_fixed_labels_distinguish_calibration_checks() {
    let dir = tempfile::tempdir().unwrap();
    let batch = dir.path().join("SECRET-batch");
    let token = CancelToken::default();
    for (code, out, err, truncated, label) in [
        (0, b"".as_slice(), DIAGNOSTIC, false, "calibration-return"),
        (1, b"SECRET-stdout", DIAGNOSTIC, false, "calibration-stdout"),
        (1, b"", b"", false, "calibration-stderr"),
        (1, b"", &[42; 1025][..], false, "calibration-stderr"),
        (1, b"", DIAGNOSTIC, true, "calibration-truncation"),
    ] {
        assert_check(
            SelfDeleteDiagnostic::validate(code, out, err, truncated, &batch, &token),
            label,
        );
    }
    touch(&batch, b"SECRET-batch-content");
    assert_check(
        SelfDeleteDiagnostic::validate(1, b"", DIAGNOSTIC, false, &batch, &token),
        "calibration-deletion",
    );
}

#[test]
fn postinstall_readiness_copy_cancellation_is_not_relabelled() {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let guard = super::super::InstallGuard::begin().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let stage = dir.path().join("stage");
    let system = dir.path().join("system");
    readiness_fixture(&stage, &system);
    super::super::cancel_install();
    assert_eq!(
        ready_files(&stage, &system, guard.token()).err().as_deref(),
        Some("SETUP_CANCELLED")
    );
    assert_eq!(
        dll_copies(&stage, guard.token()).err().as_deref(),
        Some("SETUP_CANCELLED")
    );
}

#[test]
fn postinstall_copy_errors_are_fixed_for_missing_files_and_unequal_bytes() {
    for (path, label) in [
        ("etc/hosts", "network-hosts"),
        ("etc/protocols", "network-protocols"),
        ("etc/services", "network-services"),
        ("etc/networks", "network-networks"),
        ("ucrt64/libexec/git-core/dlls-copied.exe", "dll-sentinel"),
        ("ucrt64/libexec/git-core/test.dll", "dll-copies"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("SECRET-stage");
        let system = dir.path().join("SECRET-system");
        readiness_fixture(&stage, &system);
        let target = stage.join(path);
        let different: Vec<_> = std::fs::read(&target)
            .unwrap()
            .iter()
            .map(|b| b ^ 1)
            .collect();
        std::fs::rename(&target, stage.join("SECRET-moved-copy")).unwrap();
        assert_check(ready_files(&stage, &system, &CancelToken::default()), label);
        touch(&target, &different);
        assert_check(ready_files(&stage, &system, &CancelToken::default()), label);
    }
}

#[test]
fn postinstall_error_labelling_keeps_only_cancellation_or_fixed_check() {
    assert_eq!(
        label_error("SETUP_CANCELLED".into(), "dll-copies"),
        "SETUP_CANCELLED"
    );
    for error in [
        "SECRET-path: permission denied",
        "SECRET-stdout",
        "SECRET-environment",
    ] {
        assert_check::<()>(Err(label_error(error.into(), "dll-copies")), "dll-copies");
    }
}

fn touch(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}
