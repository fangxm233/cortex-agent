use serde::Serialize;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

use super::{parse_login_path, SETUP_LOG_EVENT};

#[derive(Clone, Serialize)]
struct SetupLogLine<'a> {
    run: &'a str,
    stream: &'a str,
    line: String,
}

pub(super) struct RunOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl RunOutcome {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    pub fn combined(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

/// GUI launchers omit nvm/brew paths. Resolve the user's login PATH once; Windows inherits it.
pub(super) fn login_path() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if cfg!(target_os = "windows") {
                return None;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let out = Command::new(&shell)
                .args(["-lic", "echo $PATH"])
                .output()
                .ok()?;
            parse_login_path(&String::from_utf8_lossy(&out.stdout))
        })
        .as_deref()
}

pub(super) fn npm_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// Init's final NDJSON event contains credentials, not progress. UI enable also reports a token
/// (in pretty-printed JSON). Keep both out of events while retaining the original stdout for IPC.
fn is_private_output(line: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        return value.get("step").and_then(|v| v.as_str()) == Some("result")
            || value.get("clientToken").is_some()
            || value.get("token").is_some();
    }
    line.split_once(':')
        .is_some_and(|(key, _)| matches!(key.trim(), "\"token\"" | "\"clientToken\""))
}

fn capture_stream(reader: impl BufRead, mut emit: impl FnMut(String)) -> String {
    let mut collected = String::new();
    for line in reader.lines().map_while(Result::ok) {
        if !is_private_output(&line) {
            emit(line.clone());
        }
        collected.push_str(&line);
        collected.push('\n');
    }
    collected
}

fn pump_stream(
    app: &AppHandle,
    run: &str,
    reader: Option<Box<dyn std::io::Read + Send>>,
    stream: &'static str,
) -> std::thread::JoinHandle<String> {
    let handle = app.clone();
    let run = run.to_string();
    std::thread::spawn(move || {
        let Some(reader) = reader else {
            return String::new();
        };
        capture_stream(BufReader::new(reader), |line| {
            let _ = handle.emit(
                SETUP_LOG_EVENT,
                SetupLogLine {
                    run: &run,
                    stream,
                    line: redact_log_line(&line),
                },
            );
        })
    })
}

pub(super) fn effective_path() -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    if let Some(selected) = selected_runtime().ok()? {
        return selected
            .path(&inherited_path())
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
    }
    Some(inherited_path().to_string_lossy().into_owned())
}

pub(super) fn inherited_path() -> std::ffi::OsString {
    login_path()
        .map(Into::into)
        .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub(super) fn selected_runtime() -> Result<Option<super::runtime::Selection>, String> {
    let home = super::cortex_home().ok_or("RUNTIME_MISSING: home unavailable")?;
    let selected = super::runtime::Selection::load(&home)?;
    #[cfg(target_os = "windows")]
    if let Some(selected) = &selected {
        // Legacy records remain readable by bootstrap, but normal launch must use the
        // complete qualified selection. Report repair instead of silently using PATH.
        selected.validate_windows_npm()?;
        if selected.git.is_none() {
            return Err("RUNTIME_MISSING: selected Git Bash unavailable".into());
        }
    }
    Ok(selected)
}

fn redact_log_line(line: &str) -> String {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    return super::runtime::redact_line(line);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    line.to_string()
}

pub(super) fn install_log(app: &AppHandle, line: &str) {
    let _ = app.emit(
        SETUP_LOG_EVENT,
        SetupLogLine {
            run: "install",
            stream: "stdout",
            line: redact_log_line(line),
        },
    );
}

fn setup_command(program: &str, args: &[impl AsRef<OsStr>]) -> Result<Command, String> {
    let mut command = Command::new(program);
    command.env("PATH", inherited_path());
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    if let Some(selected) = selected_runtime()? {
        command = selected.command(OsStr::new(program));
        let home = super::cortex_home().ok_or("RUNTIME_MISSING: home unavailable")?;
        selected.apply(&mut command, &home, &inherited_path())?;
    }
    // Output is piped to the setup UI; on Windows `npm.cmd` would otherwise flash a console.
    crate::no_console_window(&mut command)
        .args(args)
        .stdin(Stdio::null());
    Ok(command)
}

/// Each pipe has its own reader so a chatty stderr cannot deadlock stdout during npm/init.
pub(super) fn run_streaming(
    app: &AppHandle,
    run: &str,
    program: &str,
    args: &[impl AsRef<OsStr>],
) -> Result<RunOutcome, String> {
    let mut child = setup_command(program, args)?
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("PROGRAM_FAILED: {program}: {e}"))?;
    let out = pump_stream(
        app,
        run,
        child.stdout.take().map(|s| Box::new(s) as _),
        "stdout",
    );
    let err = pump_stream(
        app,
        run,
        child.stderr.take().map(|s| Box::new(s) as _),
        "stderr",
    );
    let status = child
        .wait()
        .map_err(|e| format!("PROGRAM_FAILED: {program}: {e}"))?;
    Ok(RunOutcome {
        code: status.code().unwrap_or(-1),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// Missing/failing probes mean "absent", not a wizard error.
pub(super) fn probe_output(program: &str, args: &[&str]) -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    return super::runtime::output(setup_command(program, args).ok()?, &[]);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let out = setup_command(program, args).ok()?.output().ok()?;
        out.status.success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|text| !text.is_empty())
    }
}

pub(super) fn probe_server_version(bin: &str) -> Option<String> {
    version_from_probe(|args| probe_output(bin, args))
}

fn version_from_probe(mut probe: impl FnMut(&[&str]) -> Option<String>) -> Option<String> {
    probe(&["--version"]).or_else(|| probe(&["daemon", "--version"]))
}

/// Find the binary even when npm's global bin directory is not on PATH yet.
pub(super) fn resolve_cortex_bin() -> Option<String> {
    resolve_cli_bin("cortex")
}

pub(super) fn resolve_cli_bin(name: &str) -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    if let Some(selected) = selected_runtime().ok()? {
        if name == "cortex" {
            return selected
                .server
                .map(|s| s.bin.to_string_lossy().into_owned());
        }
        let found = super::runtime::find_bin(name, &selected.path(&inherited_path()).ok()?);
        if let Some(found) = found {
            return Some(found.to_string_lossy().into_owned());
        }
    }
    resolve_legacy_cli_bin(name)
}

fn resolve_legacy_cli_bin(name: &str) -> Option<String> {
    resolve_legacy_cli(name, cfg!(target_os = "windows"), probe_output, |path| {
        path.is_file()
    })
}

fn resolve_legacy_cli(
    name: &str,
    windows: bool,
    mut probe: impl FnMut(&str, &[&str]) -> Option<String>,
    is_file: impl FnOnce(&std::path::Path) -> bool,
) -> Option<String> {
    let finder = if windows { "where" } else { "which" };
    if let Some(found) = probe(finder, &[name]).and_then(|out| first_cli_path(&out, windows)) {
        return Some(found);
    }
    let npm = if windows { "npm.cmd" } else { "npm" };
    let prefix = probe(npm, &["prefix", "-g"])?;
    let candidate = npm_cli_path(&prefix, name, windows);
    is_file(&candidate).then(|| candidate.to_string_lossy().to_string())
}

fn first_cli_path(output: &str, windows: bool) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|path| !windows || is_windows_cli_entry(path))
        .map(str::to_string)
}

fn is_windows_cli_entry(path: &str) -> bool {
    // npm also writes a POSIX shim without an extension; keep where's order, not suffix priority.
    let path = path.to_ascii_lowercase();
    path.ends_with(".cmd") || path.ends_with(".exe")
}

fn npm_cli_path(prefix: &str, name: &str, windows: bool) -> std::path::PathBuf {
    let prefix = std::path::Path::new(prefix);
    if windows {
        prefix.join(format!("{name}.cmd"))
    } else {
        prefix.join("bin").join(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cli_skips_npm_posix_shim() {
        let output = "C:\\Users\\Test\\npm\\cortex\r\nC:\\Users\\Test\\npm\\cortex.cmd\r\n";
        assert_eq!(
            first_cli_path(output, true).as_deref(),
            Some(r"C:\Users\Test\npm\cortex.cmd")
        );
    }

    #[test]
    fn windows_cli_preserves_lookup_order_for_cmd_and_direct_exe() {
        let cmd = r"C:\earlier npm\cortex.cmd";
        let exe = r"D:\native install\cortex.exe";
        for (first, second) in [(cmd, exe), (exe, cmd)] {
            let output = format!("{first}\r\n{second}\r\n");
            assert_eq!(first_cli_path(&output, true).as_deref(), Some(first));
            assert_eq!(first_cli_path(first, true).as_deref(), Some(first));
        }
    }

    #[test]
    fn windows_cli_preserves_case_and_spaces() {
        for path in [r"C:\Program Files\Cortex.CMD", r"D:\Cortex App\CORTEX.ExE"] {
            let output = format!("C:\\npm\\cortex\r\n  {path}  \r\n");
            assert_eq!(first_cli_path(&output, true).as_deref(), Some(path));
        }
        assert!(first_cli_path("C:\\npm\\cortex\nC:\\npm\\cortex.ps1\n", true).is_none());
    }

    #[test]
    fn windows_cli_uses_npm_prefix_when_lookup_is_unusable() {
        for found in [None, Some("C:\\npm\\cortex\r\nC:\\npm\\cortex.ps1")] {
            let mut calls = Vec::new();
            let expected = std::path::Path::new("C:/npm prefix").join("cortex.cmd");
            let result = resolve_legacy_cli(
                "cortex",
                true,
                |program, args| {
                    calls.push(format!("{program} {}", args.join(" ")));
                    if program == "where" {
                        return found.map(str::to_string);
                    }
                    assert_eq!(program, "npm.cmd");
                    Some("C:/npm prefix".into())
                },
                |path| {
                    assert_eq!(path, expected);
                    true
                },
            );
            assert_eq!(result, Some(expected.to_string_lossy().into_owned()));
            assert_eq!(calls, ["where cortex", "npm.cmd prefix -g"]);
        }
    }

    #[test]
    fn cli_prefix_fallback_requires_an_existing_file() {
        for windows in [false, true] {
            let result = resolve_legacy_cli(
                "cortex",
                windows,
                |_, args| (args == ["prefix", "-g"]).then(|| "/missing-prefix".into()),
                |_| false,
            );
            assert!(result.is_none());
            assert!(resolve_legacy_cli(
                "cortex",
                windows,
                |_, _| None,
                |_| { panic!("no prefix to check") }
            )
            .is_none());
        }
    }

    #[test]
    fn unix_cli_keeps_first_which_result_and_bin_prefix_fallback() {
        assert_eq!(
            first_cli_path(" /usr/local/bin/cortex \n/usr/bin/cortex", false),
            Some("/usr/local/bin/cortex".into())
        );
        let mut calls = Vec::new();
        let expected = std::path::Path::new("/npm prefix")
            .join("bin")
            .join("cortex");
        let result = resolve_legacy_cli(
            "cortex",
            false,
            |program, args| {
                calls.push(format!("{program} {}", args.join(" ")));
                (program == "npm").then(|| "/npm prefix".into())
            },
            |path| {
                assert_eq!(path, expected);
                true
            },
        );
        assert_eq!(result, Some(expected.to_string_lossy().into_owned()));
        assert_eq!(calls, ["which cortex", "npm prefix -g"]);
    }

    #[test]
    fn cli_lookup_does_not_probe_npm_after_a_valid_match() {
        for (windows, path) in [(true, "C:/npm/cortex.cmd"), (false, "/usr/bin/cortex")] {
            let result = resolve_legacy_cli(
                "cortex",
                windows,
                |program, args| {
                    assert_eq!(program, if windows { "where" } else { "which" });
                    assert_eq!(args, ["cortex"]);
                    Some(path.into())
                },
                |_| panic!("PATH match needs no prefix check"),
            );
            assert_eq!(result.as_deref(), Some(path));
        }
    }

    #[test]
    fn server_version_supports_both_operator_cli_layouts() {
        let mut calls = Vec::new();
        let version = version_from_probe(|args| {
            calls.push(args.join(" "));
            (args == ["daemon", "--version"]).then(|| "2026.9.7".into())
        });
        assert_eq!(version.as_deref(), Some("2026.9.7"));
        assert_eq!(calls, ["--version", "daemon --version"]);
        let mut calls = 0;
        assert!(version_from_probe(|_| {
            calls += 1;
            Some("2026.9.7".into())
        })
        .is_some());
        assert_eq!(calls, 1);
        assert!(version_from_probe(|_| None).is_none());
    }

    #[test]
    fn setup_logs_filter_init_result_but_capture_it_for_parsing() {
        let stdout = concat!(
            "{\"step\":\"config\",\"state\":\"ok\"}\n",
            "ordinary progress\n",
            "{\"step\":\"result\",\"clientToken\":\"test-secret\",\"home\":\"/h\"}\n",
        );
        let mut events = Vec::new();
        let captured = capture_stream(std::io::Cursor::new(stdout), |line| events.push(line));
        assert_eq!(captured, stdout);
        assert_eq!(events.len(), 2);
        assert!(!events.join("\n").contains("test-secret"));
        let result = super::super::parse_init_result(&captured).unwrap();
        assert_eq!(result.client_token.as_deref(), Some("test-secret"));
    }

    #[test]
    fn setup_logs_filter_token_payloads_and_pretty_json_fields() {
        for line in [
            r#"{"token":"test-secret","url":"http://localhost:3004"}"#,
            r#"  "token": "test-secret","#,
            r#"  "clientToken" : "test-secret","#,
            r#"{"step":"result","state":"ok"}"#,
        ] {
            assert!(is_private_output(line));
        }
        assert!(!is_private_output(r#"{"step":"config","state":"ok"}"#));
        assert!(!is_private_output("npm ERR! code EACCES"));
    }
}
