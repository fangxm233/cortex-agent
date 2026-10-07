use super::CancelToken;
use std::{io::{BufRead, BufReader}, process::{Command, Stdio}, time::Duration};

/// Install output is diagnostic only. Suppress credential-bearing lines, including npm registry URLs.
pub fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let secret = ["token", "password", "authorization", "secret", "api_key", "apikey"]
        .iter().any(|key| lower.contains(key));
    if secret || (line.contains("://") && line.contains('@')) {
        return "[credential-bearing output redacted]".into();
    }
    line.to_string()
}

pub fn run_install(mut command: Command, token: &CancelToken, log: &(impl Fn(&str) + Sync)) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    token.check()?;
    command.process_group(0).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "SERVER_INSTALL_FAILED: could not start npm")?;
    let stdout = child.stdout.take().ok_or("SERVER_INSTALL_FAILED: stdout")?;
    let stderr = child.stderr.take().ok_or("SERVER_INSTALL_FAILED: stderr")?;
    std::thread::scope(|scope| {
        let out = scope.spawn(|| pump(stdout, log));
        let err = scope.spawn(|| pump(stderr, log));
        let status = wait_owned(&mut child, token);
        let _ = out.join();
        let _ = err.join();
        status
    })
}

fn pump(reader: impl std::io::Read, log: &impl Fn(&str)) {
    for line in BufReader::new(reader).lines().map_while(Result::ok) { log(&redact_line(&line)); }
}

fn wait_owned(child: &mut std::process::Child, token: &CancelToken) -> Result<(), String> {
    loop {
        if token.check().is_err() {
            // Only our newly-created npm process group; never an existing server/daemon.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.wait();
            return Err("SETUP_CANCELLED".into());
        }
        match child.try_wait().map_err(|_| "SERVER_INSTALL_FAILED: npm wait")? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("SERVER_INSTALL_FAILED: npm exited {status}; see installation log")),
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
