use super::{CancelToken, Selection, Server};
use std::{ffi::OsStr, path::{Path, PathBuf}, process::Command};

/// Shared by the native command and the opt-in isolated integration harness.
/// Re-probes external Cortex only AFTER bootstrap, since its shebang may need the new node.
pub fn ensure_server(home: &Path, path: &OsStr, package: &OsStr, node_floor: &str, server_floor: &str,
    token: &CancelToken, log: &(impl Fn(&str) + Sync)) -> Result<Selection, String> {
    let mut selected = super::bootstrap(home, path, node_floor, token, log)?;
    if selected.server.is_some() {
        check_server(&selected, home, path, server_floor)?;
        return Ok(selected);
    }
    if let Some(bin) = external_server(&selected, home, path) {
        selected.server = Some(Server { bin, managed: false });
        check_server(&selected, home, path, server_floor)?;
        token.check()?;
        selected.save(home)?;
        log("Reusing supported external Cortex installation");
        return Ok(selected);
    }
    install_managed(&mut selected, home, path, package, server_floor, token, log)?;
    Ok(selected)
}

fn install_managed(selected: &mut Selection, home: &Path, path: &OsStr, package: &OsStr,
    floor: &str, token: &CancelToken, log: &(impl Fn(&str) + Sync)) -> Result<(), String> {
    std::fs::create_dir_all(&selected.prefix).map_err(super::storage_error)?;
    let mut command = selected.command(OsStr::new("npm"));
    selected.apply(&mut command, home, path)?;
    command.args([OsStr::new("install"), OsStr::new("-g"), OsStr::new("--prefix"), selected.prefix.as_os_str(), package]);
    log("Installing Cortex into private user prefix");
    super::run_install(command, token, log)?;
    token.check()?;
    let bin = managed_cli(&selected.prefix)?;
    selected.server = Some(Server { bin, managed: true });
    check_server(selected, home, path, floor)?;
    selected.save(home)
}

pub(super) fn managed_cli(prefix: &Path) -> Result<PathBuf, String> {
    let bin = prefix.join("bin/cortex").canonicalize().map_err(|_| "CLI_NOT_ON_PATH")?;
    let packages = prefix.join("lib/node_modules").canonicalize().map_err(|_| "CLI_NOT_ON_PATH")?;
    if !bin.starts_with(packages) || !bin.is_file() {
        return Err("CLI_NOT_ON_PATH: private package CLI is missing or outside prefix".into());
    }
    Ok(bin)
}

fn external_server(selected: &Selection, home: &Path, path: &OsStr) -> Option<PathBuf> {
    let effective = selected.path(path).ok()?;
    let paths = std::env::split_paths(&effective).filter(|p| p != &selected.prefix.join("bin"));
    let external_path = std::env::join_paths(paths).ok()?;
    if let Some(bin) = super::find_bin("cortex", &external_path) { return Some(bin); }
    // Do not apply our private prefix to this discovery query: respect the user's existing npm config.
    let mut npm = Command::new(&selected.npm);
    npm.env("PATH", effective).env("CORTEX_HOME", home);
    let prefix = super::output(npm, &["prefix", "-g"])?;
    let candidate = Path::new(&prefix).join("bin/cortex");
    (candidate.is_file() && candidate != selected.prefix.join("bin/cortex")).then_some(candidate)
}

pub fn server_version(selected: &Selection, home: &Path, path: &OsStr) -> Option<String> {
    let program = selected.server.as_ref()?.bin.as_os_str();
    super::selected_output(selected, home, path, program, &["--version"])
        .or_else(|| super::selected_output(selected, home, path, program, &["daemon", "--version"]))
}

fn check_server(selected: &Selection, home: &Path, path: &OsStr, floor: &str) -> Result<(), String> {
    if server_version(selected, home, path).is_some_and(|v| super::version_at_least(&v, floor)) { return Ok(()); }
    if selected.server.as_ref().is_some_and(|s| !s.managed) {
        return Err("SERVER_EXTERNAL_UNSUPPORTED: existing Cortex must be updated by its owner".into());
    }
    Err("SERVER_VERSION_UNSUPPORTED: installed Cortex cannot run or is too old".into())
}
