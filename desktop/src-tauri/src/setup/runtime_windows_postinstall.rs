//! Post-install is callable only after extract_x64 authenticates the full pinned payload.
//! Exit 1 requires the current system's verified terminal batch self-delete diagnostic.
//! Never use this single-purpose exception in ordinary run_install.
use super::CancelToken;
use std::{
    io::{Read, Write},
    path::Path,
    process::Command,
};
const NETWORK_FILES: &[(&str, &str, &str)] = &[
    ("hosts", "hosts", "network-hosts"),
    ("protocol", "protocols", "network-protocols"),
    ("services", "services", "network-services"),
    ("networks", "networks", "network-networks"),
];

fn failure(_: impl std::fmt::Display) -> String {
    "RUNTIME_INTEGRITY_FAILED: PortableGit post-install did not qualify".into()
}

// Labels are code-owned constants, never process output, paths or OS errors.
fn check_failure(label: &'static str) -> String {
    format!("{} [{label}]", failure(""))
}

fn label_error(error: String, label: &'static str) -> String {
    if error == "SETUP_CANCELLED" {
        return error;
    }
    check_failure(label)
}

fn require_checks(checks: &[(bool, &'static str)]) -> Result<(), String> {
    for &(passed, label) in checks {
        if !passed {
            return Err(check_failure(label));
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn run(
    stage: &Path,
    home: &Path,
    token: &CancelToken,
) -> Result<super::GitSelection, String> {
    token.check()?;
    let system = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| failure("SystemRoot"))?;
    let outcome = run_upstream(stage, home, &system, token)?;
    let ready = ready_files(stage, &system, token);
    token.check()?;
    accept_outcome(
        outcome.exit_code,
        &outcome.stdout,
        &outcome.stderr,
        outcome.stdout_truncated || outcome.stderr_truncated,
        ready.map(|()| true)?,
        &system.to_string_lossy(),
        || calibrate_self_delete(stage, home, &system, token),
    )?;
    check_msys(stage, home, &system, token)?;
    let git = super::GitSelection::from_root(stage.to_path_buf(), true)
        .ok_or_else(|| check_failure("git-layout"))?;
    if !git.qualify(token)? {
        return Err(check_failure("git-bash-qualification"));
    }
    token.check()?;
    Ok(git)
}

#[cfg(windows)]
fn run_upstream(
    stage: &Path,
    home: &Path,
    system: &Path,
    token: &CancelToken,
) -> Result<super::process::windows::Outcome, String> {
    if !system.is_absolute() {
        return Err(failure("SystemRoot"));
    }
    std::fs::create_dir_all(home.join(".config")).map_err(failure)?;
    let command = postinstall_command(stage, stage, home, system)?;
    super::process::windows::run(
        command,
        token,
        Some(std::time::Duration::from_secs(180)),
        &|_| {},
    )
}

fn postinstall_command(
    stage: &Path,
    cwd: &Path,
    home: &Path,
    system: &Path,
) -> Result<Command, String> {
    let mut command = launcher_command(stage, cwd, home, system)?;
    command.arg("--command=post-install.bat");
    Ok(command)
}

fn launcher_command(
    stage: &Path,
    cwd: &Path,
    home: &Path,
    system: &Path,
) -> Result<Command, String> {
    let mut command = Command::new(stage.join("git-bash.exe"));
    command
        .current_dir(cwd)
        .args(["--no-needs-console", "--hide", "--no-cd"]);
    sanitize(&mut command, home, stage, system)?;
    Ok(command)
}

fn calibration_command(
    stage: &Path,
    cwd: &Path,
    home: &Path,
    system: &Path,
) -> Result<Command, String> {
    // Relative --command targets resolve beside the launcher, not against cwd.
    let mut target = std::ffi::OsString::from("--command=\"");
    target.push(cwd.join("post-install.bat"));
    target.push("\"");
    let mut command = launcher_command(stage, cwd, home, system)?;
    command.arg(target);
    Ok(command)
}

#[cfg(windows)]
fn calibrate_self_delete(
    stage: &Path,
    home: &Path,
    system: &Path,
    token: &CancelToken,
) -> Result<SelfDeleteDiagnostic, String> {
    token.check()?;
    let directory = self_delete_directory(stage, home)?;
    let command = calibration_command(stage, directory.path(), home, system)?;
    let out = super::process::windows::run(
        command,
        token,
        Some(std::time::Duration::from_secs(10)),
        &|_| {},
    )?;
    SelfDeleteDiagnostic::validate(
        out.exit_code,
        &out.stdout,
        &out.stderr,
        out.stdout_truncated || out.stderr_truncated,
        &directory.path().join("post-install.bat"),
        token,
    )
}

fn self_delete_directory(stage: &Path, home: &Path) -> Result<tempfile::TempDir, String> {
    let stage = stage.canonicalize().map_err(failure)?;
    let canonical_home = home.canonicalize().map_err(failure)?;
    if !home.is_absolute() || canonical_home.starts_with(&stage) {
        return Err(failure(
            "diagnostic HOME must be absolute and outside payload",
        ));
    }
    // Canonical paths are for containment only: cmd.exe rejects verbatim cwd.
    let directory = tempfile::Builder::new()
        .prefix("self-delete-")
        .tempdir_in(home)
        .map_err(failure)?;
    // Fresh cwd outside the authenticated payload: never overwrite or replay its batch.
    let mut batch = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.path().join("post-install.bat"))
        .map_err(failure)?;
    batch
        .write_all(b"@DEL post-install.bat\r\n")
        .map_err(failure)?;
    Ok(directory)
}

// Opaque bytes exist only after the synthetic command's outcome and deletion qualify.
struct SelfDeleteDiagnostic(Vec<u8>);

impl SelfDeleteDiagnostic {
    fn validate(
        code: u32,
        stdout: &[u8],
        stderr: &[u8],
        truncated: bool,
        batch: &Path,
        token: &CancelToken,
    ) -> Result<Self, String> {
        token.check()?;
        require_checks(&[
            (code == 1, "calibration-return"),
            (stdout.is_empty(), "calibration-stdout"),
            (
                !stderr.is_empty() && stderr.len() <= 1024,
                "calibration-stderr",
            ),
            (!truncated, "calibration-truncation"),
        ])?;
        match std::fs::symlink_metadata(batch) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(check_failure("calibration-deletion")),
        }
        Ok(Self(stderr.to_vec()))
    }
}

fn accept_outcome(
    code: u32,
    stdout: &[u8],
    stderr: &[u8],
    truncated: bool,
    ready: bool,
    system: &str,
    calibrate: impl FnOnce() -> Result<SelfDeleteDiagnostic, String>,
) -> Result<(), String> {
    require_checks(&[
        (!truncated, "postinstall-truncation"),
        (ready, "postinstall-readiness"),
        (stdout == expected_stdout(system), "postinstall-stdout"),
    ])?;
    // cmd.exe can report exit 1 when the upstream batch deletes itself. Prove that
    // exact system behavior with only DEL; never interpret localized diagnostic text.
    match code {
        0 => require_checks(&[(stderr.is_empty(), "postinstall-stderr")]),
        1 => require_checks(&[(stderr == calibrate()?.0, "calibration-mismatch")]),
        _ => Err(check_failure("postinstall-exit")),
    }
}

fn expected_stdout(system: &str) -> Vec<u8> {
    let mut out = String::from("\"running post-install\"\r\n");
    for (source, target, _) in NETWORK_FILES {
        out.push_str(&format!(
            "'{system}\\system32\\drivers\\etc\\{source}' -> '/etc/{target}'\n"
        ));
    }
    out.into_bytes()
}

fn remove_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "BASH_ENV"
            | "ENV"
            | "SYSCONFDIR"
            | "HOME"
            | "SHELLOPTS"
            | "BASHOPTS"
            | "CDPATH"
            | "GLOBIGNORE"
    ) || ["GIT_", "MSYS", "ORIGINAL_", "XDG_", "BASH_FUNC_"]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

fn sanitize(command: &mut Command, home: &Path, stage: &Path, system: &Path) -> Result<(), String> {
    let keys: Vec<_> = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string()))
        .collect();
    for key in keys {
        if remove_key(&key.to_string_lossy()) || key.eq_ignore_ascii_case("PATH") {
            command.env_remove(key);
        }
    }
    let path = std::env::join_paths([
        stage.join("cmd"),
        stage.join("ucrt64/bin"),
        stage.join("usr/bin"),
        system.join("System32"),
        system.to_path_buf(),
        system.join("System32/WindowsPowerShell/v1.0"),
    ])
    .map_err(failure)?;
    command
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("PATH", path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8");
    Ok(())
}

fn ready_files(stage: &Path, system: &Path, token: &CancelToken) -> Result<(), String> {
    for (removed, label) in [
        ("post-install.bat", "cleanup-post-install-bat"),
        ("etc/post-install", "cleanup-etc-post-install"),
    ] {
        match std::fs::symlink_metadata(stage.join(removed)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(check_failure(label)),
        }
    }
    network_copies(stage, system, token)?;
    same_file(
        &stage.join("ucrt64/bin/git.exe"),
        &stage.join("ucrt64/libexec/git-core/dlls-copied.exe"),
        token,
    )
    .map_err(|error| label_error(error, "dll-sentinel"))?;
    dll_copies(stage, token).map_err(|error| label_error(error, "dll-copies"))?;
    require_checks(&[
        (stage.join("dev/shm").is_dir(), "native-dev-shm"),
        (stage.join("dev/mqueue").is_dir(), "native-dev-mqueue"),
        (stage.join("etc/mtab").is_file(), "native-etc-mtab"),
    ])?;
    token.check()
}

fn network_copies(stage: &Path, system: &Path, token: &CancelToken) -> Result<(), String> {
    for (source, target, label) in NETWORK_FILES {
        same_file(
            &system.join("System32/drivers/etc").join(source),
            &stage.join("etc").join(target),
            token,
        )
        .map_err(|error| label_error(error, label))?;
    }
    Ok(())
}

fn dll_copies(stage: &Path, token: &CancelToken) -> Result<(), String> {
    let mut count = 0;
    for entry in std::fs::read_dir(stage.join("ucrt64/bin")).map_err(failure)? {
        token.check()?;
        let entry = entry.map_err(failure)?;
        if entry
            .path()
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("dll"))
        {
            continue;
        }
        count += 1;
        if count > 128 {
            return Err(failure("DLL limit"));
        }
        same_file(
            &entry.path(),
            &stage
                .join("ucrt64/libexec/git-core")
                .join(entry.file_name()),
            token,
        )?;
    }
    if count == 0 {
        return Err(failure("no DLL copies"));
    }
    Ok(())
}

fn same_file(left: &Path, right: &Path, token: &CancelToken) -> Result<(), String> {
    let mut left = std::fs::File::open(left).map_err(failure)?;
    let mut right = std::fs::File::open(right).map_err(failure)?;
    let size = left.metadata().map_err(failure)?.len();
    if size > 64 * 1024 * 1024 || size != right.metadata().map_err(failure)?.len() {
        return Err(failure("copy size"));
    }
    let (mut a, mut b) = ([0; 65536], [0; 65536]);
    let mut remaining = size;
    while remaining > 0 {
        token.check()?;
        let count = remaining.min(a.len() as u64) as usize;
        left.read_exact(&mut a[..count]).map_err(failure)?;
        right.read_exact(&mut b[..count]).map_err(failure)?;
        if a[..count] != b[..count] {
            return Err(failure("copy mismatch"));
        }
        remaining -= count as u64;
    }
    Ok(())
}

#[cfg(windows)]
fn check_msys(stage: &Path, home: &Path, system: &Path, token: &CancelToken) -> Result<(), String> {
    let mut command = Command::new(stage.join("usr/bin/bash.exe"));
    sanitize(&mut command, home, stage, system)?;
    command.current_dir(stage).args(["--noprofile", "--norc", "-c",
        "test -d /dev/shm && test -d /dev/mqueue && test -L /etc/mtab && test \"$(/usr/bin/readlink /etc/mtab)\" = /proc/mounts && /usr/bin/cmp /etc/mtab /proc/mounts"]);
    let out = super::process::windows::run(
        command,
        token,
        Some(std::time::Duration::from_secs(15)),
        &|_| {},
    )?;
    if out.exit_code != 0
        || out.stdout_truncated
        || out.stderr_truncated
        || !out.stdout.is_empty()
        || !out.stderr.is_empty()
    {
        return Err(check_failure("msys-probe"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "runtime_windows_postinstall_tests.rs"]
mod tests;
