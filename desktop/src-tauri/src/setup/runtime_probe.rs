//! INSTALL-only qualification. Never attach to or signal an existing daemon.
use super::{CancelToken, Selection};
use std::{ffi::OsStr, path::Path, process::Command, time::Duration};
#[cfg(unix)]
use std::{
    io::{self, Read},
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{Child, Stdio},
    time::Instant,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(unix)]
const MAX_OUTPUT: usize = 64 * 1024;

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn deadline_bounds_silent_probe_and_descendant_held_pipe() {
        for script in [
            "/bin/sleep 2",
            "/bin/sleep 2 & exit 0",
            "exec 1>&-; /bin/sleep 2",
        ] {
            let start = Instant::now();
            let result = capture(
                shell(script),
                &CancelToken::default(),
                Duration::from_millis(100),
            );
            assert!(result.unwrap().is_none(), "{script}");
            assert!(start.elapsed() < Duration::from_secs(1), "{script}");
        }
    }

    #[test]
    fn output_limit_bounds_newline_free_capture() {
        let start = Instant::now();
        let command = shell("/bin/dd if=/dev/zero bs=1024 count=80 2>/dev/null; /bin/sleep 2");
        assert!(
            capture(command, &CancelToken::default(), Duration::from_secs(3))
                .unwrap()
                .is_none()
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn qualification_captures_only_successful_nonempty_stdout() {
        for (script, expected) in [
            ("echo v24.21.0", Some("v24.21.0")),
            ("exit 0", None),
            ("echo v24.21.0; exit 1", None),
        ] {
            let result = output(shell(script), &[], &CancelToken::default()).unwrap();
            assert_eq!(result.as_deref(), expected);
        }
    }
}

pub(super) fn selected_output(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    program: &OsStr,
    args: &[&str],
    token: &CancelToken,
) -> Result<Option<String>, String> {
    token.check()?;
    let mut command = selected.command(program);
    selected.apply(&mut command, home, path)?;
    output(command, args, token)
}

pub(super) fn output(
    mut command: Command,
    args: &[&str],
    token: &CancelToken,
) -> Result<Option<String>, String> {
    command.args(args);
    capture(command, token, PROBE_TIMEOUT)
}

#[cfg(windows)]
fn capture(
    command: Command,
    token: &CancelToken,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let result = super::process::windows::run(command, token, Some(timeout), &|_| {});
    token.check()?;
    Ok(result
        .ok()
        .filter(|outcome| outcome.exit_code == 0)
        .map(|outcome| String::from_utf8_lossy(&outcome.stdout).trim().to_string())
        .filter(|text| !text.is_empty()))
}

// RAII covers cancellation, deadline, output limit, I/O errors, and normal completion.
// Descendants retaining stdout cannot keep a reader thread (or the installer) blocked.
#[cfg(unix)]
struct OwnedProbe(Child);
#[cfg(unix)]
impl Drop for OwnedProbe {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn capture(
    mut command: Command,
    token: &CancelToken,
    timeout: Duration,
) -> Result<Option<String>, String> {
    token.check()?;
    command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let result = match command.spawn() {
        Ok(child) => read_probe(&mut OwnedProbe(child), token, timeout),
        Err(_) => Ok(None),
    };
    token.check()?;
    result
}

#[cfg(unix)]
fn nonblocking(stdout: &impl AsRawFd) -> io::Result<()> {
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn read_probe(
    child: &mut OwnedProbe,
    token: &CancelToken,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let mut stdout = child
        .0
        .stdout
        .take()
        .ok_or("SERVER_INSTALL_FAILED: probe stdout")?;
    if nonblocking(&stdout).is_err() {
        return Ok(None);
    }
    let deadline = Instant::now() + timeout;
    match read_until_eof(&mut stdout, token, deadline)? {
        Some(bytes) => finish_probe(child, &bytes, token, deadline),
        None => Ok(None),
    }
}

#[cfg(unix)]
fn read_until_eof(
    stdout: &mut impl Read,
    token: &CancelToken,
    deadline: Instant,
) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    loop {
        token.check()?;
        if Instant::now() >= deadline {
            return Ok(None);
        }
        match read_chunk(stdout, &mut bytes) {
            Ok(true) => return Ok(Some(bytes)),
            Ok(false) => (),
            Err(_) => return Ok(None),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn read_chunk(stdout: &mut impl Read, bytes: &mut Vec<u8>) -> io::Result<bool> {
    let mut chunk = [0; 8192];
    let count = match stdout.read(&mut chunk) {
        Ok(count) => count,
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            return Ok(false)
        }
        Err(e) => return Err(e),
    };
    if bytes.len() + count > MAX_OUTPUT {
        return Err(io::Error::other("probe output limit"));
    }
    bytes.extend_from_slice(&chunk[..count]);
    Ok(count == 0)
}

#[cfg(unix)]
fn finish_probe(
    child: &mut OwnedProbe,
    bytes: &[u8],
    token: &CancelToken,
    deadline: Instant,
) -> Result<Option<String>, String> {
    loop {
        token.check()?;
        if Instant::now() >= deadline {
            return Ok(None);
        }
        match child.0.try_wait() {
            Ok(Some(status)) => {
                return Ok(status
                    .success()
                    .then(|| String::from_utf8_lossy(bytes).trim().to_string())
                    .filter(|s| !s.is_empty()))
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return Ok(None),
        }
    }
}
