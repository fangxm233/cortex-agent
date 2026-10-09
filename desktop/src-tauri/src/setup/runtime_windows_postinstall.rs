//! Post-install is callable only after extract_x64 authenticates the full pinned payload.
//! The sole exit-1 signature is the observed GB18030 terminal self-delete error.
//! Other locales are NOT qualified. Never use this exception in ordinary run_install.
use super::CancelToken;
use std::{io::Read, path::Path, process::Command};

const SELF_DELETE: &[u8] =
    b"\xd5\xd2\xb2\xbb\xb5\xbd\xc5\xfa\xb4\xa6\xc0\xed\xce\xc4\xbc\xfe\xa1\xa3\x0d\x0a";
const NETWORK_FILES: &[(&str, &str)] = &[
    ("hosts", "hosts"),
    ("protocol", "protocols"),
    ("services", "services"),
    ("networks", "networks"),
];

fn failure(_: impl std::fmt::Display) -> String {
    "RUNTIME_INTEGRITY_FAILED: PortableGit post-install did not qualify".into()
}

#[cfg(windows)]
pub(super) fn run(stage: &Path, home: &Path, token: &CancelToken) -> Result<super::GitSelection, String> {
    token.check()?;
    let system = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| failure("SystemRoot"))?;
    let outcome = run_upstream(stage, home, &system, token)?;
    let ready = ready_files(stage, &system, token).is_ok();
    token.check()?;
    accept_outcome(
        outcome.exit_code,
        &outcome.stdout,
        &outcome.stderr,
        outcome.stdout_truncated || outcome.stderr_truncated,
        ready,
        &system.to_string_lossy(),
    )?;
    check_msys(stage, home, &system, token)?;
    let git =
        super::GitSelection::from_root(stage.to_path_buf(), true).ok_or_else(|| failure("Git layout"))?;
    if !git.qualify(token)? {
        return Err(failure("Git/Bash qualification"));
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
    let mut command = Command::new(stage.join("git-bash.exe"));
    command.current_dir(stage).args([
        "--no-needs-console",
        "--hide",
        "--no-cd",
        "--command=post-install.bat",
    ]);
    sanitize(&mut command, home, stage, system)?;
    super::process::windows::run(command, token, Some(std::time::Duration::from_secs(180)), &|_| {})
}

fn accept_outcome(
    code: u32,
    stdout: &[u8],
    stderr: &[u8],
    truncated: bool,
    ready: bool,
    system: &str,
) -> Result<(), String> {
    let exit_ok = (code == 0 && stderr.is_empty()) || (code == 1 && stderr == SELF_DELETE);
    if !exit_ok || truncated || !ready || stdout != expected_stdout(system) {
        return Err(failure("post-install outcome"));
    }
    Ok(())
}

fn expected_stdout(system: &str) -> Vec<u8> {
    let mut out = String::from("\"running post-install\"\r\n");
    for (source, target) in NETWORK_FILES {
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
        "BASH_ENV" | "ENV" | "SYSCONFDIR" | "HOME" | "SHELLOPTS" | "BASHOPTS" | "CDPATH" | "GLOBIGNORE"
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
    for removed in ["post-install.bat", "etc/post-install"] {
        match std::fs::symlink_metadata(stage.join(removed)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(failure("upstream cleanup")),
        }
    }
    for (source, target) in NETWORK_FILES {
        same_file(
            &system.join("System32/drivers/etc").join(source),
            &stage.join("etc").join(target),
            token,
        )?;
    }
    same_file(
        &stage.join("ucrt64/bin/git.exe"),
        &stage.join("ucrt64/libexec/git-core/dlls-copied.exe"),
        token,
    )?;
    dll_copies(stage, token)?;
    if !stage.join("dev/shm").is_dir()
        || !stage.join("dev/mqueue").is_dir()
        || !stage.join("etc/mtab").is_file()
    {
        return Err(failure("MSYS initialization markers"));
    }
    token.check()
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
            &stage.join("ucrt64/libexec/git-core").join(entry.file_name()),
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
    let out =
        super::process::windows::run(command, token, Some(std::time::Duration::from_secs(15)), &|_| {})?;
    if out.exit_code != 0
        || out.stdout_truncated
        || out.stderr_truncated
        || !out.stdout.is_empty()
        || !out.stderr.is_empty()
    {
        return Err(failure("MSYS initialization probe"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "runtime_windows_postinstall_tests.rs"]
mod tests;
