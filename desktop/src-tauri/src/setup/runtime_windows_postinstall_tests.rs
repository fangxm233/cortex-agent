use super::*;

#[test]
fn postinstall_exact_self_delete_only_after_readiness() {
    let stdout = expected_stdout("C:\\Windows");
    assert!(accept_outcome(0, &stdout, b"", false, true, "C:\\Windows").is_ok());
    assert!(accept_outcome(1, &stdout, SELF_DELETE, false, true, "C:\\Windows").is_ok());
    for code in [2, 37, 255] {
        assert!(accept_outcome(code, &stdout, SELF_DELETE, false, true, "C:\\Windows").is_err());
    }
    for stderr in [
        b"".as_slice(),
        b"The batch file cannot be found.\r\n",
        b"other diagnostic",
    ] {
        assert!(accept_outcome(1, &stdout, stderr, false, true, "C:\\Windows").is_err());
    }
    assert!(accept_outcome(1, &stdout, SELF_DELETE, true, true, "C:\\Windows").is_err());
    assert!(accept_outcome(1, &stdout, SELF_DELETE, false, false, "C:\\Windows").is_err());
    assert!(accept_outcome(0, &stdout, SELF_DELETE, false, true, "C:\\Windows").is_err());
    let mut extra = stdout.clone();
    extra.extend_from_slice(b"warning\n");
    assert!(accept_outcome(1, &extra, SELF_DELETE, false, true, "C:\\Windows").is_err());
}

#[test]
fn postinstall_sanitizes_only_its_child_environment() {
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
    for (source, target) in NETWORK_FILES {
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

fn touch(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}
