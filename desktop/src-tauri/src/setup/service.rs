// Native-owned POSIX autostart. Operator CLI installation policy is intentionally separate.
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::process::run_streaming;

const LABEL: &str = "cc.cortex.agent-server";
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
        entries.push(("CORTEX_NPM_PREFIX", text(prefix.as_os_str())?));
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
    if property(output, "LoadState") == Some("not-found") {
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
            OsStr::new("--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload"),
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

fn bootstrap_launchd(runner: &mut Runner<'_>, domain: &str, path: &Path) -> Result<(), String> {
    invoke(
        runner,
        "/bin/launchctl",
        &[
            OsStr::new("bootstrap"),
            OsStr::new(domain),
            path.as_os_str(),
        ],
        false,
    )?;
    Ok(())
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
    let (domain, target) = launchd_target(runner)?;
    let loaded = verify_launchd(runner, &target, &path, launch, matched)?;
    ensure_file(&path, &content)?;
    invoke(
        runner,
        "/bin/launchctl",
        &[OsStr::new("enable"), OsStr::new(&target)],
        false,
    )?;
    if !loaded {
        bootstrap_launchd(runner, &domain, &path)?;
    }
    Ok(())
}
