use super::CancelToken;
use std::process::Command;
#[cfg(unix)]
use std::{
    io::{BufRead, BufReader},
    process::Stdio,
    time::Duration,
};

#[cfg(windows)]
#[path = "runtime_windows_process.rs"]
pub(super) mod windows;

/// Internal post-install inspection boundary: does NOT forgive any nonzero exit.
/// Raw diagnostics are capped at 64 KiB per stream and must not be logged unredacted.
#[cfg(windows)]
pub(super) fn run_install_outcome(
    command: Command,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<windows::Outcome, String> {
    windows::run(command, token, None, log)
}

#[cfg(windows)]
pub fn run_install(
    command: Command,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<(), String> {
    let outcome = run_install_outcome(command, token, log)?;
    if outcome.exit_code != 0 {
        return Err(format!(
            "SERVER_INSTALL_FAILED: npm exited {}; see installation log",
            outcome.exit_code
        ));
    }
    Ok(())
}

/// Install output is diagnostic only. Suppress credential-bearing lines, including npm registry URLs.
pub fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let secret = [
        "token",
        "password",
        "authorization",
        "secret",
        "api_key",
        "apikey",
        "_auth",
        "bearer ",
        "credential",
        "signature",
        "key=",
    ]
    .iter()
    .any(|key| lower.contains(key));
    if secret || (line.contains("://") && line.contains('@')) {
        return "[credential-bearing output redacted]".into();
    }
    line.to_string()
}

#[cfg(unix)]
pub fn run_install(
    mut command: Command,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    token.check()?;
    command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "SERVER_INSTALL_FAILED: could not start npm")?;
    pump_install(&mut child, token, log)
}

#[cfg(unix)]
fn pump_install(
    child: &mut std::process::Child,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<(), String> {
    let stdout = child.stdout.take().ok_or("SERVER_INSTALL_FAILED: stdout")?;
    let stderr = child.stderr.take().ok_or("SERVER_INSTALL_FAILED: stderr")?;
    std::thread::scope(|scope| {
        let out = scope.spawn(|| pump(stdout, log));
        let err = scope.spawn(|| pump(stderr, log));
        let status = wait_owned(child, token);
        let _ = out.join();
        let _ = err.join();
        status
    })
}

#[cfg(unix)]
fn pump(reader: impl std::io::Read, log: &impl Fn(&str)) {
    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        log(&redact_line(&line));
    }
}

#[cfg(unix)]
fn wait_owned(child: &mut std::process::Child, token: &CancelToken) -> Result<(), String> {
    loop {
        if token.check().is_err() {
            // Only our newly-created npm process group; never an existing server/daemon.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            return Err("SETUP_CANCELLED".into());
        }
        match child
            .try_wait()
            .map_err(|_| "SERVER_INSTALL_FAILED: npm wait")?
        {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                return Err(format!(
                    "SERVER_INSTALL_FAILED: npm exited {status}; see installation log"
                ))
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
