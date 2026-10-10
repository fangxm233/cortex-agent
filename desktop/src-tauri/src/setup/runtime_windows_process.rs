//! Windows install/probe execution only. No activation of ordinary app/daemon commands.
use super::{redact_line, CancelToken};
use std::{
    io::{self, Read},
    os::windows::io::AsRawHandle,
    process::{Command, ExitStatus},
    ptr::null_mut,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};

#[path = "runtime_windows_process_job.rs"]
pub(crate) mod job;
#[path = "runtime_windows_process_output.rs"]
mod output;
use output::Capture;

/// Raw, bounded diagnostics for an internal caller to inspect AFTER ownership settles.
/// These bytes are not redacted: never forward them directly to the UI/log.
pub(crate) struct Outcome {
    pub exit_code: u32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

struct Streams {
    stdout: Capture,
    stderr: Capture,
    out_eof: bool,
    err_eof: bool,
}

pub(crate) fn run(
    command: Command,
    token: &CancelToken,
    timeout: Option<Duration>,
    log: &impl Fn(&str),
) -> Result<Outcome, String> {
    token.check()?;
    let deadline = timeout.map(|duration| Instant::now() + duration);
    let mut owned = job::Owned::suspended(command).map_err(failure)?;
    token.check()?;
    owned.resume().map_err(failure)?;
    let result = collect(&mut owned, token, deadline, log);
    drop(owned); // All paths settle the tree before cancellation/error/result escapes.
    token.check()?;
    result
}

fn failure(error: io::Error) -> String {
    format!("SERVER_INSTALL_FAILED: owned Windows command: {error}")
}

fn collect(
    owned: &mut job::Owned,
    token: &CancelToken,
    deadline: Option<Instant>,
    log: &impl Fn(&str),
) -> Result<Outcome, String> {
    let mut streams = Streams::new();
    loop {
        check_deadline(token, deadline)?;
        streams.poll(owned, log).map_err(failure)?;
        if deadline.is_some() && streams.stdout.truncated {
            return Err("SERVER_INSTALL_FAILED: probe output limit".into());
        }
        if let Some(status) = owned.child.try_wait().map_err(failure)? {
            owned.terminate().map_err(failure)?;
            if streams.complete() && owned.accounting().map_err(failure)?.ActiveProcesses == 0 {
                return Ok(streams.outcome(status));
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn check_deadline(token: &CancelToken, deadline: Option<Instant>) -> Result<(), String> {
    token.check()?;
    if deadline.is_some_and(|end| Instant::now() >= end) {
        return Err("SERVER_INSTALL_FAILED: probe deadline".into());
    }
    Ok(())
}

impl Streams {
    fn new() -> Self {
        Self {
            stdout: Capture::default(),
            stderr: Capture::default(),
            out_eof: false,
            err_eof: false,
        }
    }

    fn poll(&mut self, owned: &mut job::Owned, log: &impl Fn(&str)) -> io::Result<()> {
        let mut redacted = |line: &str| log(&redact_line(line));
        let out = owned
            .child
            .stdout
            .as_mut()
            .ok_or_else(|| io::Error::other("stdout missing"))?;
        let err = owned
            .child
            .stderr
            .as_mut()
            .ok_or_else(|| io::Error::other("stderr missing"))?;
        self.out_eof |= poll_pipe(out, &mut self.stdout, &mut redacted)?;
        self.err_eof |= poll_pipe(err, &mut self.stderr, &mut redacted)?;
        Ok(())
    }

    fn complete(&self) -> bool {
        self.out_eof && self.err_eof
    }

    fn outcome(self, status: ExitStatus) -> Outcome {
        Outcome {
            exit_code: status.code().expect("Windows exit status has a code") as u32,
            stdout: self.stdout.bytes,
            stderr: self.stderr.bytes,
            stdout_truncated: self.stdout.truncated,
            stderr_truncated: self.stderr.truncated,
        }
    }
}

fn poll_pipe(
    pipe: &mut (impl Read + AsRawHandle),
    capture: &mut Capture,
    log: &mut impl FnMut(&str),
) -> io::Result<bool> {
    let Some(available) = available_bytes(pipe)? else {
        capture.finish(log);
        return Ok(true);
    };
    if available == 0 {
        return Ok(false);
    }
    // Exactly one reader, reading at most PeekNamedPipe's available bytes: no blocking
    // reader thread to strand on cancellation or on a descendant retaining a writer.
    let mut bytes = [0; 8192];
    let count = available.min(bytes.len());
    let read = pipe.read(&mut bytes[..count])?;
    capture.push(&bytes[..read], log);
    Ok(false)
}

fn available_bytes(pipe: &impl AsRawHandle) -> io::Result<Option<usize>> {
    let mut available = 0;
    // SAFETY: a live std-owned anonymous pipe; only the available-byte output is used.
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            &mut available,
            null_mut(),
        )
    };
    if ok != 0 {
        return Ok(Some(available as usize));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
        return Ok(None);
    }
    Err(error)
}
