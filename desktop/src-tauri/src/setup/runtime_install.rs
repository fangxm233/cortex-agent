use super::{CancelToken, Selection, Server};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

/// Shared by the native command and the headless harness.
///
/// The server always runs on the bundled Node. A saved server that still answers with a
/// supported version is kept; anything else (none yet, removed, broken, too old) is installed
/// into the private prefix with the bundled npm, then checked once more.
pub fn ensure_server(
    home: &Path,
    bundle: &Path,
    path: &OsStr,
    package: impl FnOnce() -> Result<std::ffi::OsString, String>,
    server_floor: &str,
    token: &CancelToken,
    log: &(impl Fn(&str) + Sync),
) -> Result<Selection, String> {
    let mut selected = super::ensure_runtime(home, bundle, token, log)?;
    if selected.server.is_some() {
        if server_supported(&selected, home, path, server_floor, token)? {
            return Ok(selected);
        }
        log("Saved Cortex installation cannot run or is too old; reinstalling it privately");
    }
    install_managed(&mut selected, home, path, &package()?, token, log)?;
    if !server_supported(&selected, home, path, server_floor, token)? {
        return Err("SERVER_TOO_OLD: installed Cortex cannot run or is too old".into());
    }
    token.check()?;
    selected.save(home)?;
    token.check()?;
    Ok(selected)
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
    let mut command = selected.npm_command();
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
    selected.server = Some(Server {
        bin: managed_cli(&selected.prefix)?,
        managed: true,
        node_entry: None,
    });
    Ok(())
}

/// The installed package's JS entry inside the private prefix.
pub(super) fn managed_cli(prefix: &Path) -> Result<PathBuf, String> {
    let missing = |_| "CLI_NOT_ON_PATH: private package CLI is missing".to_string();
    if cfg!(windows) {
        // npm's Windows global prefix is flat; read the entry from the package itself.
        let package = prefix.join("node_modules/@cortex-agent/server");
        let bytes = std::fs::read(package.join("package.json")).map_err(missing)?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        let entry = manifest["bin"]["cortex"].as_str().unwrap_or("dist/entry/cortex-cli.js");
        return package.join(entry).canonicalize().map_err(missing);
    }
    prefix.join("bin/cortex").canonicalize().map_err(missing)
}

fn server_supported(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
) -> Result<bool, String> {
    Ok(install_server_version(selected, home, path, token)?
        .is_some_and(|v| super::version_at_least(&v, floor)))
}

pub fn install_server_version(
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
