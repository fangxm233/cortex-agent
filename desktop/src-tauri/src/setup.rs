// input:  wizard answers, the user's login PATH, the npm/cortex CLIs
// output: setup_* Tauri commands, streamed `setup-log` events, a reachable local server
// pos:    Drives a local Cortex install from the native shell
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The oldest server release that understands `init --answers` / `ui enable`, i.e. the machine-driven
/// surface this wizard drives. A fresh `@latest` install always clears it; an *existing* install
/// below it is offered an explicit upgrade rather than being silently overwritten.
///
/// Bump this to the release that actually ships those flags whenever they move.
pub const MIN_SERVER_VERSION: &str = "2026.8.20";

/// Node floor. The server targets modern Node; below this the install fails in confusing ways
/// (missing globals, unsupported syntax), so the wizard refuses before touching anything.
pub const MIN_NODE_MAJOR: u32 = 20;

/// Event carrying one line of a running command to the wizard page.
pub const SETUP_LOG_EVENT: &str = "setup-log";

/// How long to wait for the server to answer after starting the daemon. A cold start loads the whole
/// agent runtime, so this is generous; it is still bounded so a broken install fails visibly.
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(90);

/// The same wait at app launch, where no window is on screen yet.
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(15);

// ─── Pure helpers ──────────────────────────────────────────────────────────

/// Split a version string into comparable numeric parts.
///
/// Handles both shapes the wizard meets: `v20.11.0` (node/npm, leading `v` optional) and the Cortex
/// CalVer `2026.5.22-2`, where the `-N` same-day suffix is a real, ordered component. Parsing stops
/// at the first non-numeric part (`v21.0.0-nightly` → `[21, 0, 0]`), and a string with no leading
/// number at all is not a version.
pub fn parse_version(raw: &str) -> Option<Vec<u32>> {
    let trimmed = raw.trim().trim_start_matches('v');
    let mut parts = Vec::new();
    for piece in trimmed.split(['.', '-']) {
        match piece.parse::<u32>() {
            Ok(n) => parts.push(n),
            Err(_) => break,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

/// True when `installed` is the same as or newer than `floor`.
///
/// Component-wise numeric comparison with missing components read as 0, so `2026.5.22` (no suffix)
/// sorts before `2026.5.22-2`, and `2026.10.1` sorts after `2026.9.30` — which a string compare gets
/// backwards. An unparseable `installed` never clears the floor: "we could not tell" must not read
/// as "new enough".
pub fn version_at_least(installed: &str, floor: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(installed), parse_version(floor)) else {
        return false;
    };
    for i in 0..a.len().max(b.len()) {
        let l = a.get(i).copied().unwrap_or(0);
        let r = b.get(i).copied().unwrap_or(0);
        if l != r {
            return l > r;
        }
    }
    true
}

/// Major version of a `node -v` string.
pub fn node_major(raw: &str) -> Option<u32> {
    parse_version(raw).and_then(|p| p.first().copied())
}

/// Recognise npm's global-prefix permission failure.
///
/// `npm install -g` into a root-owned prefix is the single most common way this wizard fails, and the
/// raw npm log is a wall of stack frames. Detecting it lets the wizard answer with the actual remedy
/// (a user-owned prefix) instead of dumping the log.
pub fn is_npm_permission_error(log: &str) -> bool {
    let upper = log.to_ascii_uppercase();
    upper.contains("EACCES") || upper.contains("EPERM") || upper.contains("PERMISSION DENIED")
}

/// Pull the PATH out of a login shell's output.
///
/// A GUI-launched app inherits a minimal PATH, so an nvm/brew `node` is invisible to it; asking the
/// user's own login shell is the only reliable way to see what their terminal sees. Shell rc files
/// print banners and other noise, and the `echo $PATH` we asked for is the *last* thing printed, so
/// the last PATH-looking line wins. Nothing PATH-shaped → no answer (keep the inherited PATH).
pub fn parse_login_path(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.contains('/') && (line.starts_with('/') || line.contains(':')))
        .map(str::to_string)
}

/// The final `{"step":"result"}` event of an `init --json` run.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub home: Option<String>,
    pub version: Option<String>,
    /// The bearer the app must send as `x-cortex-token`.
    pub client_token: Option<String>,
    /// Loopback URL of the Web UI endpoint init enabled.
    pub ui_url: Option<String>,
}

/// Find the result event in an NDJSON stream. Non-JSON lines are skipped rather than fatal: init's
/// stdout is machine-only by construction, but a stray write from a dependency must not lose the
/// install. None means init never reached its final step.
pub fn parse_init_result(stdout: &str) -> Option<InitResult> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("step").and_then(|v| v.as_str()) == Some("result") {
            return serde_json::from_value(value).ok();
        }
    }
    None
}

/// The loopback Web UI endpoint reported by `cortex ui enable --json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiEndpoint {
    pub url: String,
    pub token: String,
    pub port: u16,
    /// True when configuration actually changed — .env is read once at process start, so the daemon
    /// must be restarted for it to take effect.
    pub changed: bool,
    #[serde(default)]
    pub home: Option<String>,
}

/// Parse the `ui enable --json` payload. None when the output is not that payload at all (a missing
/// binary, a usage error), so the caller reports the real output instead of inventing a default.
pub fn parse_ui_endpoint(stdout: &str) -> Option<UiEndpoint> {
    serde_json::from_str(stdout.trim()).ok()
}

/// The wizard's answers, translated into the `cortex init --answers` document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAnswers {
    pub lang: String,
    pub machine_name: String,
    pub backends: Vec<String>,
    pub install_service: bool,
    pub port: u16,
}

/// Build the `--answers` document.
///
/// `platforms` is deliberately empty: the desktop app *is* the interface, so Slack/Feishu are not
/// asked about — a platform-less install falls back to the built-in gateway. `localUi` is what turns
/// this install into something the shell can reach at all.
pub fn answers_json(answers: &SetupAnswers) -> String {
    serde_json::json!({
        "lang": answers.lang,
        "machineName": answers.machine_name,
        "backends": answers.backends,
        "platforms": [],
        "installService": answers.install_service,
        "localUi": { "enabled": true, "port": answers.port },
    })
    .to_string()
}

// ─── Process execution ─────────────────────────────────────────────────────

/// One streamed line, as delivered to the wizard page.
#[derive(Clone, Serialize)]
struct SetupLogLine<'a> {
    run: &'a str,
    stream: &'a str,
    line: String,
}

/// Result of one streamed command: exit status plus each stream captured whole.
pub struct RunOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl RunOutcome {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    /// Both streams, for error reporting — the useful message may be on either.
    pub fn combined(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

/// The PATH a login shell reports, resolved once per process.
///
/// macOS Finder launches (and Linux `.desktop` launches) hand the app a stripped PATH that has no
/// nvm, no homebrew and often no node at all, while the user's terminal — where they installed all
/// of it — has a full one. `$SHELL -lic 'echo $PATH'` asks their own shell what it sees. Windows GUI
/// processes inherit the full user PATH already, so it is skipped there.
fn login_path() -> Option<&'static str> {
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

/// npm's executable name. Windows ships npm as a batch script, which must be named explicitly —
/// `Command` resolves a literal file name, it does not apply PATHEXT.
fn npm_bin() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn cortex_bin_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "cortex.cmd"
    } else {
        "cortex"
    }
}

/// Spawn `program` with the resolved PATH and stream both its outputs to the wizard as they arrive.
///
/// Streaming rather than collecting matters here: `npm install -g` and a cold `cortex init` each run
/// for tens of seconds, and a wizard that shows nothing for that long is indistinguishable from one
/// that has hung. Each stream is read on its own thread so a chatty stderr cannot deadlock stdout.
fn run_streaming(
    app: &AppHandle,
    run: &str,
    program: &str,
    args: &[&str],
) -> Result<RunOutcome, String> {
    let mut command = Command::new(program);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    if let Some(path) = login_path() {
        command.env("PATH", path);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;

    let pump = |reader: Option<Box<dyn std::io::Read + Send>>, stream: &'static str| {
        let handle = app.clone();
        let run = run.to_string();
        std::thread::spawn(move || {
            let mut collected = String::new();
            if let Some(reader) = reader {
                for line in BufReader::new(reader).lines().map_while(Result::ok) {
                    let _ = handle.emit(
                        SETUP_LOG_EVENT,
                        SetupLogLine { run: &run, stream, line: line.clone() },
                    );
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            collected
        })
    };

    let out = pump(
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stdout",
    );
    let err = pump(
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stderr",
    );

    let status = child.wait().map_err(|e| format!("{program}: {e}"))?;
    Ok(RunOutcome {
        code: status.code().unwrap_or(-1),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// Run a short command and return its trimmed stdout, or None when it is not installed / fails.
/// Used for the version probes, which must never surface as errors — "absent" is a valid answer.
fn probe_output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    if let Some(path) = login_path() {
        command.env("PATH", path);
    }
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Absolute path of the installed `cortex` executable, if any.
///
/// `which` first; when npm's global bin directory is not on the PATH we still find the binary via
/// `npm prefix -g`, which is exactly the situation right after a first-ever global install.
fn resolve_cortex_bin() -> Option<String> {
    let finder = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Some(found) = probe_output(finder, &[cortex_bin_name()]) {
        if let Some(first) = found.lines().next() {
            return Some(first.trim().to_string());
        }
    }
    let prefix = probe_output(npm_bin(), &["prefix", "-g"])?;
    let candidate = if cfg!(target_os = "windows") {
        std::path::Path::new(&prefix).join("cortex.cmd")
    } else {
        std::path::Path::new(&prefix).join("bin").join("cortex")
    };
    candidate.is_file().then(|| candidate.to_string_lossy().to_string())
}

/// The Cortex home this machine would use — the same resolution the server does.
fn cortex_home() -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("CORTEX_HOME") {
        if !explicit.trim().is_empty() {
            return Some(std::path::PathBuf::from(explicit));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(std::path::Path::new(&home).join(".cortex"))
}

// ─── Reachability ──────────────────────────────────────────────────────────

/// Does a Cortex server answer at `url` with this token?
///
/// Same contract as the connect screen's probe: any answer other than 401 means we reached a server
/// that accepts us. A short timeout — this runs in a poll loop and on the startup path.
pub fn endpoint_answers(url: &str, token: &str) -> bool {
    let Ok(client) = crate::ota::build_http_client_with_timeout(Duration::from_secs(3)) else {
        return false;
    };
    match client
        .get(format!("{}/trpc", url.trim_end_matches('/')))
        .header("x-cortex-token", token)
        .send()
    {
        Ok(response) => response.status().as_u16() != 401,
        Err(_) => false,
    }
}

/// Poll until the server answers or the budget runs out. Returns whether it came up.
fn wait_until_ready(url: &str, token: &str, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if endpoint_answers(url, token) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(600));
    }
}

/// Start (or restart) the local daemon and wait for it to answer.
///
/// `restart` first, `daemon` when that reports nothing was running: a wizard run that just changed
/// `.env` needs the *running* process replaced, because the file is read once at start — while a
/// fresh install has nothing to restart. Doing both in that order covers install and repair with one
/// path.
pub fn start_local_daemon(
    app: &AppHandle,
    run: &str,
    bin: &str,
    url: &str,
    token: &str,
) -> Result<bool, String> {
    let restarted = run_streaming(app, run, bin, &["daemon", "restart"])?;
    if !restarted.ok() {
        let started = run_streaming(app, run, bin, &["daemon"])?;
        if !started.ok() {
            return Err(started.combined());
        }
    }
    Ok(wait_until_ready(url, token, DAEMON_READY_TIMEOUT))
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// What the machine already has, as the wizard's first screen renders it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProbe {
    pub node: Option<String>,
    pub node_ok: bool,
    pub npm: Option<String>,
    pub git: Option<String>,
    /// Absolute path of an already-installed `cortex`, when there is one.
    pub cortex_bin: Option<String>,
    pub server_version: Option<String>,
    /// Whether that install understands the flags this wizard drives it through.
    pub server_ok: bool,
    pub home_exists: bool,
    pub min_node_major: u32,
    pub min_server_version: String,
    /// The PATH used for every spawn — the first thing to look at when node "is installed" but the
    /// probe cannot see it.
    pub path: Option<String>,
}

/// Inspect the machine: toolchain versions, any existing install, and whether it is new enough.
#[tauri::command]
pub fn setup_probe() -> SetupProbe {
    let node = probe_output("node", &["-v"]);
    let cortex_bin = resolve_cortex_bin();
    let server_version = cortex_bin
        .as_deref()
        .and_then(|bin| probe_output(bin, &["--version"]));
    SetupProbe {
        node_ok: node.as_deref().and_then(node_major).is_some_and(|m| m >= MIN_NODE_MAJOR),
        node,
        npm: probe_output(npm_bin(), &["-v"]),
        git: probe_output("git", &["--version"]),
        cortex_bin,
        server_ok: server_version
            .as_deref()
            .is_some_and(|v| version_at_least(v, MIN_SERVER_VERSION)),
        server_version,
        home_exists: cortex_home().is_some_and(|p| p.join("config").is_dir()),
        min_node_major: MIN_NODE_MAJOR,
        min_server_version: MIN_SERVER_VERSION.to_string(),
        path: login_path().map(str::to_string),
    }
}

/// Result of the install step: where the binary landed and what version it is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub cortex_bin: String,
    pub server_version: Option<String>,
}

/// `npm install -g @cortex-agent/server@latest`.
///
/// Always `@latest`, never a version pinned to this app: the app and the server share a CalVer but
/// not a release cadence — native packages ship only when the shell changes, so an app is routinely
/// older than the newest server, and the supported direction is server ≥ app.
#[tauri::command]
pub fn setup_install_server(app: AppHandle, run: String) -> Result<InstallResult, String> {
    let outcome = run_streaming(
        &app,
        &run,
        npm_bin(),
        &["install", "-g", "@cortex-agent/server@latest"],
    )?;
    if !outcome.ok() {
        let log = outcome.combined();
        return Err(if is_npm_permission_error(&log) {
            "EACCES".to_string()
        } else {
            log
        });
    }
    let cortex_bin = resolve_cortex_bin()
        .ok_or_else(|| "cortex was installed but is not on the PATH".to_string())?;
    let server_version = probe_output(&cortex_bin, &["--version"]);
    Ok(InstallResult { cortex_bin, server_version })
}

/// `cortex init --answers <file> --json` — the whole configuration step, run headlessly.
///
/// The answers go through a temp file rather than the command line so nothing about the machine ends
/// up in the process table, and the file is removed as soon as init has read it.
#[tauri::command]
pub fn setup_run_init(
    app: AppHandle,
    run: String,
    bin: String,
    answers: SetupAnswers,
) -> Result<InitResult, String> {
    let file = std::env::temp_dir().join(format!("cortex-init-{}.json", std::process::id()));
    std::fs::write(&file, answers_json(&answers)).map_err(|e| format!("answers file: {e}"))?;
    let path = file.to_string_lossy().to_string();
    let outcome = run_streaming(&app, &run, &bin, &["init", "--answers", &path, "--json"]);
    let _ = std::fs::remove_file(&file);

    let outcome = outcome?;
    if !outcome.ok() {
        return Err(outcome.combined());
    }
    parse_init_result(&outcome.stdout)
        .ok_or_else(|| "init finished without reporting a result".to_string())
}

/// `cortex ui enable --json` — the repair path for an install that predates the wizard, or one whose
/// Web UI endpoint was never switched on.
#[tauri::command]
pub fn setup_enable_ui(
    app: AppHandle,
    run: String,
    bin: String,
    port: u16,
) -> Result<UiEndpoint, String> {
    let port = port.to_string();
    let outcome = run_streaming(&app, &run, &bin, &["ui", "enable", "--port", &port, "--json"])?;
    if !outcome.ok() {
        return Err(outcome.combined());
    }
    parse_ui_endpoint(&outcome.stdout).ok_or_else(|| outcome.combined())
}

/// Bring the local daemon up at launch, if it is not already answering.
///
/// A local install makes this app responsible for the server's lifecycle: without autostart (Windows
/// has none, and the systemd user unit needs lingering enabled) the daemon is simply not running
/// after a reboot, and the workbench would open onto a dead server. The probe comes first so the
/// common case — a daemon already up — costs one loopback request.
///
/// The readiness wait is deliberately shorter than the wizard's: the window is not open yet, so every
/// second here is a second the app looks like it hung. Timing out is not fatal — the daemon keeps
/// starting in the background and the SPA's queries reach it when it lands.
pub fn ensure_local_daemon(app: &AppHandle, bin: &str, url: &str, token: &str) -> bool {
    if endpoint_answers(url, token) {
        return true;
    }
    match run_streaming(app, "startup", bin, &["daemon"]) {
        Ok(outcome) if outcome.ok() => wait_until_ready(url, token, STARTUP_READY_TIMEOUT),
        Ok(outcome) => {
            // Non-zero usually means "already running" — a process is up but not yet listening, so
            // waiting is still the right move.
            let _ = outcome;
            wait_until_ready(url, token, STARTUP_READY_TIMEOUT)
        }
        Err(_) => false,
    }
}

/// Start the local daemon and wait for it to answer. False = it never came up in the budget.
#[tauri::command]
pub fn setup_start_daemon(
    app: AppHandle,
    run: String,
    bin: String,
    url: String,
    token: String,
) -> Result<bool, String> {
    start_local_daemon(&app, &run, &bin, &url, &token)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_node_version_string() {
        assert_eq!(parse_version("v20.11.0"), Some(vec![20, 11, 0]));
        assert_eq!(parse_version("10.2.4\n"), Some(vec![10, 2, 4]));
        assert_eq!(parse_version("not a version"), None);
    }

    #[test]
    fn parses_a_calver_with_a_same_day_suffix() {
        assert_eq!(parse_version("2026.5.22-2"), Some(vec![2026, 5, 22, 2]));
    }

    #[test]
    fn a_same_day_rerelease_sorts_after_the_first_release() {
        assert!(version_at_least("2026.5.22-2", "2026.5.22"));
        assert!(!version_at_least("2026.5.22", "2026.5.22-2"));
    }

    #[test]
    fn the_version_floor_compares_numerically_not_lexically() {
        // "2026.10.1" < "2026.9.30" as strings — the whole reason this is not a string compare.
        assert!(version_at_least("2026.10.1", "2026.9.30"));
        assert!(!version_at_least("2026.9.30", "2026.10.1"));
        assert!(version_at_least("2026.8.20", "2026.8.20"));
    }

    #[test]
    fn an_unreadable_installed_version_never_clears_the_floor() {
        assert!(!version_at_least("", MIN_SERVER_VERSION));
        assert!(!version_at_least("unknown", MIN_SERVER_VERSION));
    }

    #[test]
    fn node_major_reads_the_major_component() {
        assert_eq!(node_major("v20.11.0"), Some(20));
        assert_eq!(node_major("v18.19.1\n"), Some(18));
        assert_eq!(node_major(""), None);
    }

    #[test]
    fn npm_permission_failures_are_recognised_from_the_log() {
        assert!(is_npm_permission_error("npm ERR! code EACCES\nnpm ERR! syscall mkdir"));
        assert!(is_npm_permission_error("npm ERR! Error: EPERM: operation not permitted"));
        assert!(!is_npm_permission_error(
            "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found"
        ));
    }

    #[test]
    fn the_login_shell_path_is_the_last_path_looking_line() {
        // rc files print banners and `set -x` noise before the echo; the PATH is what came last.
        let out = "Welcome to your shell!\n/opt/homebrew/bin:/usr/bin:/bin\n";
        assert_eq!(
            parse_login_path(out).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn a_login_shell_that_prints_no_path_is_ignored() {
        assert_eq!(parse_login_path("motd banner\n"), None);
        assert_eq!(parse_login_path(""), None);
    }

    #[test]
    fn the_init_result_is_read_out_of_the_ndjson_stream() {
        let stream = concat!(
            "{\"step\":\"answers\",\"state\":\"ok\"}\n",
            "not json at all\n",
            "{\"step\":\"result\",\"state\":\"ok\",\"home\":\"/h\",\"version\":\"2026.8.20\",",
            "\"clientToken\":\"tok\",\"uiUrl\":\"http://127.0.0.1:3004\"}\n",
        );
        let r = parse_init_result(stream).expect("the result event must be found");
        assert_eq!(r.client_token.as_deref(), Some("tok"));
        assert_eq!(r.ui_url.as_deref(), Some("http://127.0.0.1:3004"));
        assert_eq!(r.version.as_deref(), Some("2026.8.20"));
        assert_eq!(r.home.as_deref(), Some("/h"));
    }

    #[test]
    fn an_init_run_without_a_result_event_reports_none() {
        assert!(parse_init_result("{\"step\":\"config\",\"state\":\"ok\"}\n").is_none());
    }

    #[test]
    fn the_answers_document_carries_the_choices_and_no_messaging_platform() {
        let answers = SetupAnswers {
            lang: "zh".into(),
            machine_name: "workbench".into(),
            backends: vec!["claude".into()],
            install_service: true,
            port: 3004,
        };
        let doc: serde_json::Value = serde_json::from_str(&answers_json(&answers)).unwrap();
        assert_eq!(doc["machineName"], "workbench");
        assert_eq!(doc["lang"], "zh");
        assert_eq!(doc["backends"][0], "claude");
        assert_eq!(doc["installService"], true);
        assert_eq!(doc["localUi"]["enabled"], true);
        assert_eq!(doc["localUi"]["port"], 3004);
        assert_eq!(
            doc["platforms"].as_array().map(|a| a.len()),
            Some(0),
            "the wizard never configures a messaging platform"
        );
    }

    #[test]
    fn the_ui_endpoint_is_read_from_the_command_json() {
        let out = "{\n  \"ok\": true,\n  \"home\": \"/h\",\n  \"url\": \"http://127.0.0.1:3004\",\n  \"token\": \"tok\",\n  \"port\": 3004,\n  \"changed\": true\n}\n";
        let e = parse_ui_endpoint(out).expect("the endpoint payload must parse");
        assert_eq!(e.url, "http://127.0.0.1:3004");
        assert_eq!(e.token, "tok");
        assert!(e.changed);
    }

    #[test]
    fn a_non_json_ui_output_is_an_error_not_a_silent_default() {
        assert!(parse_ui_endpoint("cortex: command not found\n").is_none());
    }
}
