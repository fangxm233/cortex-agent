use super::{CancelToken, Selection, Server};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

/// Shared by the native command and the opt-in isolated integration harness.
/// Re-probes external Cortex only AFTER bootstrap, since its shebang may need the new node.
pub fn ensure_server(
    home: &Path,
    path: &OsStr,
    package: impl FnOnce() -> Result<std::ffi::OsString, String>,
    node_floor: &str,
    server_floor: &str,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<Selection, String> {
    let mut selected = super::bootstrap(home, path, node_floor, token, log)?;
    let saved = selected.server.is_some();
    if !saved {
        select_server(&mut selected, home, path, package, token, log)?;
    }
    #[cfg(windows)]
    bind_windows_server(&mut selected)?;
    check_server(&selected, home, path, server_floor, token)?;
    token.check()?;
    if !saved || cfg!(windows) {
        selected.save(home)?;
    }
    token.check()?;
    Ok(selected)
}

fn select_server(
    selected: &mut Selection,
    home: &Path,
    path: &OsStr,
    package: impl FnOnce() -> Result<std::ffi::OsString, String>,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<(), String> {
    #[cfg(windows)]
    if let Ok(bin) = managed_cli(&selected.prefix) {
        selected.server = Some(Server {
            bin,
            managed: true,
            node_entry: None,
        });
        return Ok(());
    }
    if let Some(bin) = external_server(selected, home, path, token)? {
        selected.server = Some(Server {
            bin,
            managed: false,
            node_entry: None,
        });
        log("Checking existing external Cortex installation");
        return Ok(());
    }
    install_managed(selected, home, path, &package()?, token, log)
}

fn install_managed(
    selected: &mut Selection,
    home: &Path,
    path: &OsStr,
    package: &OsStr,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<(), String> {
    std::fs::create_dir_all(&selected.prefix).map_err(super::storage_error)?;
    let mut command = selected.command(OsStr::new("npm"));
    selected.apply(&mut command, home, path)?;
    command.args([
        OsStr::new("install"),
        OsStr::new("-g"),
        OsStr::new("--prefix"),
        selected.prefix.as_os_str(),
        package,
    ]);
    log("Installing Cortex into private user prefix");
    super::run_install(command, token, log)?;
    token.check()?;
    let bin = managed_cli(&selected.prefix)?;
    selected.server = Some(Server {
        bin,
        managed: true,
        node_entry: None,
    });
    Ok(())
}

pub(super) fn managed_cli(prefix: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    return super::windows_server::package_cli(prefix);
    #[cfg(unix)]
    managed_posix_cli(prefix)
}

#[cfg(unix)]
fn managed_posix_cli(prefix: &Path) -> Result<PathBuf, String> {
    let bin = prefix
        .join("bin/cortex")
        .canonicalize()
        .map_err(|_| "CLI_NOT_ON_PATH")?;
    let packages = prefix
        .join("lib/node_modules")
        .canonicalize()
        .map_err(|_| "CLI_NOT_ON_PATH")?;
    if !bin.starts_with(packages) || !bin.is_file() {
        return Err("CLI_NOT_ON_PATH: private package CLI is missing or outside prefix".into());
    }
    Ok(bin)
}

fn external_server(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    token: &CancelToken,
) -> Result<Option<PathBuf>, String> {
    token.check()?;
    let effective = selected.path(path)?;
    let paths = std::env::split_paths(&effective).filter(|p| p != &selected.prefix_bin());
    let external_path = std::env::join_paths(paths).map_err(super::storage_error)?;
    if let Some(bin) = super::find_bin("cortex", &external_path) {
        return Ok(Some(bin));
    }
    let npm = npm_prefix_command(selected, home, &effective);
    let Some(prefix) = super::probe::output(npm, &["prefix", "-g"], token)? else {
        return Ok(None);
    };
    Ok(prefix_candidate(Path::new(&prefix), selected))
}

fn npm_prefix_command(selected: &Selection, home: &Path, path: &OsStr) -> Command {
    // Deliberately NO apply(): npm prefix -g must see the user's existing config.
    let mut npm = selected.npm_command();
    npm.env("PATH", path).env("CORTEX_HOME", home);
    npm
}

fn prefix_candidate(prefix: &Path, selected: &Selection) -> Option<PathBuf> {
    if prefix == selected.prefix {
        return None;
    }
    #[cfg(windows)]
    return super::selection_discovery::find_windows_bin("cortex", prefix.as_os_str());
    #[cfg(unix)]
    {
        let candidate = prefix.join("bin/cortex");
        candidate.is_file().then_some(candidate)
    }
}

#[cfg(windows)]
fn bind_windows_server(selected: &mut Selection) -> Result<(), String> {
    let server = selected.server.as_mut().ok_or("CLI_NOT_ON_PATH")?;
    if !server.managed {
        return super::windows_server::bind_external(server);
    }
    let cli = super::windows_server::package_cli(&selected.prefix)?;
    if server.bin.canonicalize().ok().as_ref() != Some(&cli) {
        return Err("CLI_NOT_ON_PATH: saved server identity does not match private package".into());
    }
    server.node_entry = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_prefix_query_binds_npm_cli_without_private_prefix_override() {
        let mut selected = Selection::new(
            "/selected/node.exe".into(),
            "/selected/npm.cmd".into(),
            "/private".into(),
        );
        selected.npm_cli = Some("/selected/node_modules/npm/bin/npm-cli.js".into());
        let command = npm_prefix_command(&selected, Path::new("/home"), OsStr::new("/effective"));
        assert_eq!(command.get_program(), selected.node);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [selected.npm_cli.as_ref().unwrap().as_os_str()]
        );
        assert!(command
            .get_envs()
            .all(|(key, _)| !key.to_string_lossy().to_ascii_lowercase().contains("prefix")));
    }
}

pub fn server_version(selected: &Selection, home: &Path, path: &OsStr) -> Option<String> {
    let program = selected.server.as_ref()?.bin.as_os_str();
    super::selected_output(selected, home, path, program, &["--version"])
        .or_else(|| super::selected_output(selected, home, path, program, &["daemon", "--version"]))
}

fn install_server_version(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    token: &CancelToken,
) -> Result<Option<String>, String> {
    let Some(server) = selected.server.as_ref() else {
        return Ok(None);
    };
    let program = server.bin.as_os_str();
    let version = super::probe::selected_output(selected, home, path, program, &["--version"], token)?;
    if version.is_some() {
        return Ok(version);
    }
    super::probe::selected_output(selected, home, path, program, &["daemon", "--version"], token)
}

fn check_server(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
) -> Result<(), String> {
    if install_server_version(selected, home, path, token)?
        .is_some_and(|v| super::version_at_least(&v, floor))
    {
        return Ok(());
    }
    if selected.server.as_ref().is_some_and(|s| !s.managed) {
        return Err("SERVER_EXTERNAL_UNSUPPORTED: existing Cortex must be updated by its owner".into());
    }
    Err("SERVER_TOO_OLD: installed Cortex cannot run or is too old".into())
}
