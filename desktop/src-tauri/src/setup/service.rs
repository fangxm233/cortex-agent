// Native-owned POSIX autostart. Operator CLI installation policy is intentionally separate.
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::autostart::AutostartState;
use super::process::run_streaming;

const LABEL: &str = "cc.cortex.agent-server";
const SYSTEMCTL: &str = "/usr/bin/systemctl";
const LAUNCHCTL: &str = "/bin/launchctl";
const UNIT: &str = "cortex.service";
const OWNER: &str = "Managed by Cortex desktop user-service v1; do not edit.";

pub(super) struct ServiceLaunch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Cortex data directory, not the user's login home.
    pub home: PathBuf,
    pub path: OsString,
    pub npm_prefix: Option<PathBuf>,
}

pub(super) fn enable_user_service(
    app: &tauri::AppHandle,
    run: &str,
    launch: &ServiceLaunch,
) -> Result<bool, String> {
    let os = std::env::consts::OS;
    if !matches!(os, "linux" | "macos") {
        return Ok(false);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let result = home
        .ok_or_else(|| "login HOME is missing".to_string())
        .and_then(|home| {
            enable_for(os, &home, launch, &mut |program, args, private| {
                execute(app, run, program, args, private)
            })
        });
    result.map_err(|error| format!("AUTOSTART_FAILED: {error}"))
}

struct Output {
    ok: bool,
    stdout: String,
}

type Runner<'a> = dyn FnMut(&str, &[OsString], bool) -> Result<Output, String> + 'a;

// Inspection can include environment values: never send it through the setup log stream.
fn execute(
    app: &tauri::AppHandle,
    run: &str,
    program: &str,
    args: &[OsString],
    private: bool,
) -> Result<Output, String> {
    if private {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|_| format!("cannot inspect user service with {program}"))?;
        return Ok(Output {
            ok: output.status.success(),
            stdout: String::from_utf8(output.stdout)
                .map_err(|_| "service inspection returned non-UTF-8 data".to_string())?,
        });
    }
    let output = run_streaming(app, run, program, args)?;
    Ok(Output {
        ok: output.ok(),
        stdout: String::new(),
    })
}

fn enable_for(
    os: &str,
    home: &Path,
    launch: &ServiceLaunch,
    runner: &mut Runner<'_>,
) -> Result<bool, String> {
    if !home.is_absolute() {
        return Err("login HOME must be absolute".into());
    }
    match os {
        "linux" => enable_systemd(home, launch, runner)?,
        "macos" => enable_launchd(home, launch, runner)?,
        _ => return Ok(false),
    }
    Ok(true)
}

fn text(value: &OsStr) -> Result<&str, String> {
    let value = value.to_str().ok_or("service values must be valid UTF-8")?;
    if value.contains('\0') {
        return Err("service values cannot contain NUL".into());
    }
    Ok(value)
}

fn argv(launch: &ServiceLaunch) -> Result<Vec<&str>, String> {
    if !launch.program.is_absolute() || !launch.home.is_absolute() {
        return Err("service executable and Cortex home must be absolute".into());
    }
    std::iter::once(launch.program.as_os_str())
        .chain(launch.args.iter().map(OsString::as_os_str))
        .map(text)
        .collect()
}

fn environment(launch: &ServiceLaunch) -> Result<Vec<(&str, &str)>, String> {
    let mut entries = vec![
        ("CORTEX_HOME", text(launch.home.as_os_str())?),
        ("PATH", text(&launch.path)?),
    ];
    if let Some(prefix) = &launch.npm_prefix {
        if !prefix.is_absolute() {
            return Err("service npm prefix must be absolute".into());
        }
        let prefix = text(prefix.as_os_str())?;
        entries.extend([("CORTEX_NPM_PREFIX", prefix), ("NPM_CONFIG_PREFIX", prefix), ("npm_config_prefix", prefix)]);
    }
    Ok(entries)
}

fn xml(value: &str) -> Result<String, String> {
    if value.chars().any(|c| !matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')) {
        return Err("service value contains a character unsupported by XML".into());
    }
    Ok(value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('\r', "&#13;"))
}

fn render_launchd(launch: &ServiceLaunch) -> Result<String, String> {
    let args = argv(launch)?
        .into_iter()
        .map(|arg| xml(arg).map(|value| format!("    <string>{value}</string>\n")))
        .collect::<Result<String, _>>()?;
    let env = environment(launch)?
        .into_iter()
        .map(|(key, value)| {
            xml(value).map(|value| format!("    <key>{key}</key><string>{value}</string>\n"))
        })
        .collect::<Result<String, _>>()?;
    Ok(format!(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- {} -->\n",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
        "<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n",
        "<key>ProgramArguments</key><array>\n{}</array>\n",
        "<key>EnvironmentVariables</key><dict>\n{}</dict>\n",
        "<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n",
        "</dict></plist>\n"
    ), OWNER, LABEL, args, env))
}

// The ExecStart ':' prefix disables $ expansion, including dollars in argv[0].
// % specifiers and C-style quoting still apply to both argv and Environment.
fn systemd_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    let escaped: String = escaped
        .chars()
        .map(|c| {
            if c.is_control() {
                format!("\\u{:04x}", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect();
    format!("\"{escaped}\"")
}

fn render_systemd(launch: &ServiceLaunch) -> Result<String, String> {
    let words = argv(launch)?;
    if words[0].chars().any(char::is_control) {
        return Err("systemd executable path cannot contain control characters".into());
    }
    let args = words
        .into_iter()
        .map(systemd_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let env = environment(launch)?
        .into_iter()
        .map(|(key, value)| format!("Environment={}\n", systemd_quote(&format!("{key}={value}"))))
        .collect::<String>();
    Ok(format!(
        concat!(
            "# {}\n[Unit]\nDescription=Cortex Agent Server\nAfter=network.target\n\n",
            "[Service]\nType=simple\nExecStart=:{}\n{}Restart=on-failure\nRestartSec=5\n\n",
            "[Install]\nWantedBy=default.target\n"
        ),
        OWNER, args, env
    ))
}

fn matches_file(path: &Path, content: &str) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("cannot inspect existing user service file".into()),
    };
    if !metadata.file_type().is_file() || fs::read(path).ok().as_deref() != Some(content.as_bytes())
    {
        return Err("existing user service differs or is not a regular file; preserved unchanged. Review it manually before retrying".into());
    }
    Ok(true)
}

// create_new prevents truncating even a concurrently created file or a dangling symlink.
fn ensure_file(path: &Path, content: &str) -> Result<(), String> {
    if matches_file(path, content)? {
        return Ok(());
    }
    fs::create_dir_all(path.parent().ok_or("service path has no parent")?)
        .map_err(|_| "cannot create user service directory".to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return matches_file(path, content).map(|_| ());
        }
        Err(_) => return Err("cannot create user service file".into()),
    };
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            "cannot finish user service file; review the incomplete file before retrying".into()
        })
}

fn invoke(
    runner: &mut Runner<'_>,
    program: &str,
    args: &[&OsStr],
    private: bool,
) -> Result<String, String> {
    let args = args.iter().map(|s| s.to_os_string()).collect::<Vec<_>>();
    let output = runner(program, &args, private)?;
    if !output.ok {
        return Err(format!("{program} user service operation failed; check the user session/service manager and retry (no administrator fallback)"));
    }
    Ok(output.stdout)
}

fn property<'a>(output: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    let mut values = output.lines().filter_map(|line| line.strip_prefix(&prefix));
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

fn check_systemd_state(output: &str, path: &Path, file_matches: bool) -> Result<(), String> {
    let absent = property(output, "LoadState") == Some("not-found")
        && property(output, "ActiveState") == Some("inactive")
        && property(output, "FragmentPath") == Some("")
        && property(output, "DropInPaths") == Some("");
    if absent {
        return Ok(());
    }
    let valid = file_matches
        && property(output, "LoadState") == Some("loaded")
        && property(output, "FragmentPath") == path.to_str()
        && property(output, "DropInPaths") == Some("")
        && property(output, "NeedDaemonReload") == Some("no");
    if !valid {
        return Err("existing loaded user service cannot be verified against this launch; preserved unchanged. Review its source, overrides and pending reload manually".into());
    }
    Ok(())
}

fn systemd_state(runner: &mut Runner<'_>) -> Result<String, String> {
    invoke(
        runner,
        "/usr/bin/systemctl",
        &[
            OsStr::new("--user"),
            OsStr::new("show"),
            OsStr::new(UNIT),
            OsStr::new(
                "--property=LoadState,ActiveState,FragmentPath,DropInPaths,NeedDaemonReload",
            ),
        ],
        true,
    )
}

fn enable_systemd(
    home: &Path,
    launch: &ServiceLaunch,
    runner: &mut Runner<'_>,
) -> Result<(), String> {
    let path = home.join(".config/systemd/user").join(UNIT);
    let content = render_systemd(launch)?;
    let matched = matches_file(&path, &content)?;
    let state = systemd_state(runner)?;
    check_systemd_state(&state, &path, matched)?;
    ensure_file(&path, &content)?;
    if property(&state, "LoadState") == Some("not-found") {
        load_systemd(&path, runner)?;
    }
    // Deliberately no --now: readiness/start is owned by setup; never replace a live daemon.
    invoke(
        runner,
        "/usr/bin/systemctl",
        &[OsStr::new("--user"), OsStr::new("enable"), OsStr::new(UNIT)],
        false,
    )?;
    Ok(())
}

fn load_systemd(path: &Path, runner: &mut Runner<'_>) -> Result<(), String> {
    invoke(
        runner,
        "/usr/bin/systemctl",
        &[OsStr::new("--user"), OsStr::new("daemon-reload")],
        false,
    )?;
    let loaded = systemd_state(runner)?;
    check_systemd_state(&loaded, path, true)?;
    if property(&loaded, "LoadState") != Some("loaded") {
        return Err("user service was not loaded after registration".into());
    }
    Ok(())
}

fn launchd_target(runner: &mut Runner<'_>) -> Result<(String, String), String> {
    let uid = invoke(runner, "/usr/bin/id", &[OsStr::new("-u")], true)?;
    let uid = uid.trim();
    if uid.is_empty() || !uid.bytes().all(|c| c.is_ascii_digit()) {
        return Err("cannot determine the login user for launchd".into());
    }
    let domain = format!("gui/{uid}");
    Ok((domain.clone(), format!("{domain}/{LABEL}")))
}

fn launchd_is_loaded(runner: &mut Runner<'_>) -> Result<bool, String> {
    let listing = invoke(runner, "/bin/launchctl", &[OsStr::new("list")], true)?;
    let mut lines = listing.lines();
    if lines
        .next()
        .map(|s| s.split_whitespace().collect::<Vec<_>>())
        != Some(vec!["PID", "Status", "Label"])
    {
        return Err("cannot verify the login launchd service list".into());
    }
    Ok(lines.any(|line| line.split_whitespace().last() == Some(LABEL)))
}

fn launchd_block<'a>(output: &'a str, name: &str) -> Option<Vec<&'a str>> {
    let start = format!("\t{name} = {{");
    let mut lines = output.lines().skip_while(|line| *line != start);
    lines.next()?;
    let mut result = Vec::new();
    for line in lines {
        if line == "\t}" {
            return Some(result);
        }
        result.push(line.strip_prefix("\t\t")?);
    }
    None
}

fn check_launchd_state(output: &str, path: &Path, launch: &ServiceLaunch) -> Result<(), String> {
    let args = argv(launch)?;
    let mut expected_env = environment(launch)?
        .into_iter()
        .map(|(key, value)| format!("{key} => {value}"))
        .collect::<Vec<_>>();
    expected_env.push(format!("XPC_SERVICE_NAME => {LABEL}"));
    expected_env.sort();
    let mut actual_env = launchd_block(output, "environment").unwrap_or_default();
    actual_env.sort();
    let path_line = format!("\tpath = {}", text(path.as_os_str())?);
    let program_line = format!("\tprogram = {}", args[0]);
    let valid = output.lines().any(|line| line == path_line)
        && output.lines().any(|line| line == program_line)
        && launchd_block(output, "arguments").as_ref() == Some(&args)
        && actual_env == expected_env;
    if !valid {
        return Err("existing launchd service launch/environment does not match or cannot be verified; preserved unchanged. Review it manually before retrying".into());
    }
    Ok(())
}

fn verify_launchd(
    runner: &mut Runner<'_>,
    target: &str,
    path: &Path,
    launch: &ServiceLaunch,
    matched: bool,
) -> Result<bool, String> {
    if !launchd_is_loaded(runner)? {
        return Ok(false);
    }
    if !matched {
        return Err(
            "existing launchd service has no matching owned file; preserved unchanged".into(),
        );
    }
    let state = invoke(
        runner,
        "/bin/launchctl",
        &[OsStr::new("print"), OsStr::new(target)],
        true,
    )?;
    check_launchd_state(&state, path, launch)?;
    Ok(true)
}

fn enable_launchd(
    home: &Path,
    launch: &ServiceLaunch,
    runner: &mut Runner<'_>,
) -> Result<(), String> {
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    let content = render_launchd(launch)?;
    let matched = matches_file(&path, &content)?;
    let (_, target) = launchd_target(runner)?;
    verify_launchd(runner, &target, &path, launch, matched)?;
    ensure_file(&path, &content)?;
    invoke(
        runner,
        "/bin/launchctl",
        &[OsStr::new("enable"), OsStr::new(&target)],
        false,
    )?;
    // LaunchAgents is loaded at the next login. Setup already owns the running daemon;
    // bootstrapping now would repeatedly fail its singleton lock under KeepAlive.
    Ok(())
}

/// Remove the autostart registration setup made. Ok(false) = none registered (or no autostart on
/// this platform). A registration this app did not write is reported and left alone.
pub(super) fn disable_user_service() -> Result<bool, String> {
    let Some(home) = login_home() else {
        return Ok(false);
    };
    disable_for(std::env::consts::OS, &home, &mut quiet)
}

/// Whether this app's registration starts the server at the next login.
pub(super) fn user_service_state() -> AutostartState {
    let Some(home) = login_home() else {
        return AutostartState::Off;
    };
    state_for(std::env::consts::OS, &home, &mut quiet)
}

/// Stop starting at login while the running daemon keeps running. The file stays, so turning it
/// back on re-enables the same registration instead of meeting a loaded job with no file.
pub(super) fn withdraw_user_service() -> Result<(), String> {
    let Some(home) = login_home() else {
        return Ok(());
    };
    withdraw_for(std::env::consts::OS, &home, &mut quiet)
}

/// Stop the job this app's registration runs now, leaving it registered: launchd's KeepAlive would
/// otherwise bring back a daemon stopped any other way. The next login starts it again.
/// Best-effort: no owned registration means nothing to stop.
pub(super) fn stop_user_service() {
    let Some(home) = login_home() else {
        return;
    };
    stop_for(std::env::consts::OS, &home, &mut quiet);
}

fn stop_for(os: &str, home: &Path, runner: &mut Runner<'_>) {
    if !matches!(owned_registration(os, home), Ok(Some(_))) {
        return;
    }
    let args: Vec<OsString> = match os {
        "linux" => vec!["--user".into(), "stop".into(), UNIT.into()],
        _ => match launchd_target(runner) {
            Ok((_, target)) => vec!["bootout".into(), target.into()],
            Err(_) => return,
        },
    };
    let program = if os == "linux" { SYSTEMCTL } else { LAUNCHCTL };
    let _ = runner(program, &args, false);
}

/// Point an owned registration at `launch`, then switch it back on. Ok(false) = there is none, so
/// a first registration is needed. Our own file may name an older runtime (the bundled Node.js is
/// versioned), and a loaded job is this app's own; the first-registration checks do not apply.
pub(super) fn resume_user_service(launch: &ServiceLaunch) -> Result<bool, String> {
    let Some(home) = login_home() else {
        return Ok(false);
    };
    resume_for(std::env::consts::OS, &home, launch, &mut quiet)
        .map_err(|error| format!("AUTOSTART_FAILED: {error}"))
}

/// At launch: keep an owned registration on the runtime the app now uses, whether or not it is
/// switched on, so the next login does not start a Node.js that is gone or too old. The running
/// daemon is left alone. Ok(true) = the file was rewritten.
pub(super) fn refresh_user_service(launch: &ServiceLaunch) -> Result<bool, String> {
    let Some(home) = login_home() else {
        return Ok(false);
    };
    let os = std::env::consts::OS;
    match owned_registration(os, &home)? {
        Some(path) => refresh_file(os, &path, launch, &mut quiet),
        None => Ok(false),
    }
}

fn resume_for(os: &str, home: &Path, launch: &ServiceLaunch, runner: &mut Runner<'_>) -> Result<bool, String> {
    let Some(path) = owned_registration(os, home)? else {
        return Ok(false);
    };
    refresh_file(os, &path, launch, runner)?;
    let args: Vec<OsString> = match os {
        "linux" => vec!["--user".into(), "enable".into(), UNIT.into()],
        _ => vec!["enable".into(), launchd_target(runner)?.1.into()],
    };
    let program = if os == "linux" { SYSTEMCTL } else { LAUNCHCTL };
    let args = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    invoke(runner, program, &args, false)?;
    Ok(true)
}

fn refresh_file(os: &str, path: &Path, launch: &ServiceLaunch, runner: &mut Runner<'_>) -> Result<bool, String> {
    let content = if os == "linux" { render_systemd(launch)? } else { render_launchd(launch)? };
    if fs::read(path).ok().as_deref() == Some(content.as_bytes()) {
        return Ok(false);
    }
    replace_file(path, &content)?;
    if os == "linux" {
        invoke(runner, SYSTEMCTL, &[OsStr::new("--user"), OsStr::new("daemon-reload")], false)?;
    }
    Ok(true)
}

/// Swap in new contents by rename, so the service manager never reads a half-written file.
fn replace_file(path: &Path, content: &str) -> Result<(), String> {
    let name = path.file_name().ok_or("service path has no file name")?.to_string_lossy();
    let staged = path.with_file_name(format!(".{name}.cortex-new"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&staged)
        .and_then(|mut file| file.write_all(content.as_bytes()).and_then(|_| file.sync_all()))
        .and_then(|_| fs::rename(&staged, path));
    written.map_err(|_| {
        let _ = fs::remove_file(&staged);
        "cannot update the user service file".to_string()
    })
}

fn login_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn quiet(program: &str, args: &[OsString], _private: bool) -> Result<Output, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|_| format!("cannot run {program}"))?;
    Ok(Output {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    })
}

/// Ok(None) = nothing registered; Err = a registration this app did not write.
fn owned_registration(os: &str, home: &Path) -> Result<Option<PathBuf>, String> {
    let path = match os {
        "linux" => home.join(".config/systemd/user").join(UNIT),
        "macos" => home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")),
        _ => return Ok(None),
    };
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    if !fs::read_to_string(&path).is_ok_and(|content| content.contains(OWNER)) {
        return Err(format!("{} was not created by Cortex; preserved unchanged", path.display()));
    }
    Ok(Some(path))
}

fn disable_for(os: &str, home: &Path, runner: &mut Runner<'_>) -> Result<bool, String> {
    let Some(path) = owned_registration(os, home)? else {
        return Ok(false);
    };
    match os {
        "linux" => unregister_systemd(home, &path, runner),
        _ => unregister_launchd(&path, runner),
    }
}

fn state_for(os: &str, home: &Path, runner: &mut Runner<'_>) -> AutostartState {
    match owned_registration(os, home) {
        Err(_) => AutostartState::External,
        Ok(None) => AutostartState::Off,
        Ok(Some(_)) if starts_at_login(os, runner) => AutostartState::On,
        Ok(Some(_)) => AutostartState::Off,
    }
}

fn starts_at_login(os: &str, runner: &mut Runner<'_>) -> bool {
    if os == "linux" {
        let args = ["--user".into(), "is-enabled".into(), UNIT.into()];
        // is-enabled exits non-zero for anything but "enabled", so read the answer, not the status.
        return runner(SYSTEMCTL, &args, true).is_ok_and(|out| out.stdout.trim() == "enabled");
    }
    let Ok((domain, _)) = launchd_target(runner) else {
        return false;
    };
    let args = ["print-disabled".into(), domain.into()];
    runner(LAUNCHCTL, &args, true).is_ok_and(|out| out.ok && !launchd_disabled(&out.stdout))
}

/// `launchctl print-disabled` lists overrides as `"label" => disabled` (`=> true` before macOS 13).
fn launchd_disabled(listing: &str) -> bool {
    let key = format!("\"{LABEL}\" =>");
    listing
        .lines()
        .filter_map(|line| line.trim().strip_prefix(key.as_str()))
        .any(|value| matches!(value.trim(), "disabled" | "true"))
}

fn withdraw_for(os: &str, home: &Path, runner: &mut Runner<'_>) -> Result<(), String> {
    if owned_registration(os, home)?.is_none() {
        return Ok(());
    }
    let (program, args): (&str, Vec<OsString>) = match os {
        "linux" => (SYSTEMCTL, vec!["--user".into(), "disable".into(), UNIT.into()]),
        _ => (LAUNCHCTL, vec!["disable".into(), launchd_target(runner)?.1.into()]),
    };
    let args = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    invoke(runner, program, &args, false).map(drop)
}

// Disabling is best-effort: a unit systemd never loaded cannot be stopped, and removing the file
// plus its wants link is what actually keeps it from starting at the next login.
fn unregister_systemd(home: &Path, path: &Path, runner: &mut Runner<'_>) -> Result<bool, String> {
    let systemctl = "/usr/bin/systemctl";
    let _ = runner(systemctl, &["--user".into(), "disable".into(), "--now".into(), UNIT.into()], false);
    let wants = home.join(".config/systemd/user/default.target.wants").join(UNIT);
    if fs::symlink_metadata(&wants).is_ok() {
        let _ = fs::remove_file(&wants);
    }
    fs::remove_file(path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
    let _ = runner(systemctl, &["--user".into(), "daemon-reload".into()], false);
    Ok(true)
}

// Booting out first matters: under KeepAlive launchd would restart a daemon stopped any other way.
fn unregister_launchd(path: &Path, runner: &mut Runner<'_>) -> Result<bool, String> {
    let (_, target) = launchd_target(runner)?;
    let _ = runner("/bin/launchctl", &["bootout".into(), target.into()], false);
    fs::remove_file(path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(os: &str, home: &Path) -> Vec<String> {
        let mut calls = Vec::new();
        let mut runner = |program: &str, args: &[OsString], _private: bool| {
            let line = std::iter::once(program.to_string())
                .chain(args.iter().map(|arg| arg.to_string_lossy().into_owned()))
                .collect::<Vec<_>>()
                .join(" ");
            calls.push(line);
            Ok(Output { ok: true, stdout: "501\n".into() })
        };
        stop_for(os, home, &mut runner);
        calls
    }

    fn register(home: &Path, relative: &str, content: &str) {
        let path = home.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn stopping_runs_the_owned_service_down_without_unregistering_it() {
        let home = tempfile::tempdir().unwrap();
        register(home.path(), ".config/systemd/user/cortex.service", OWNER);
        assert_eq!(record("linux", home.path()), vec![format!("{SYSTEMCTL} --user stop {UNIT}")]);

        register(home.path(), &format!("Library/LaunchAgents/{LABEL}.plist"), OWNER);
        let calls = record("macos", home.path());
        assert_eq!(calls.last().unwrap(), &format!("{LAUNCHCTL} bootout gui/501/{LABEL}"));
        assert!(home.path().join(format!("Library/LaunchAgents/{LABEL}.plist")).is_file());
    }

    #[test]
    fn stopping_leaves_missing_or_foreign_registrations_alone() {
        let home = tempfile::tempdir().unwrap();
        assert!(record("linux", home.path()).is_empty());
        register(home.path(), ".config/systemd/user/cortex.service", "[Unit]\n");
        assert!(record("linux", home.path()).is_empty());
    }
}
