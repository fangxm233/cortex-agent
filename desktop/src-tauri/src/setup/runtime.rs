//! User-owned selected runtime. No Tauri dependency: the headless harness runs this exact code.
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

#[path = "runtime_archive.rs"]
mod archive;
#[path = "runtime_cancel.rs"]
mod cancel;
#[path = "runtime_git_selection.rs"]
mod git_selection;
#[path = "runtime_install.rs"]
mod install;
#[cfg(windows)]
#[path = "runtime_portablegit.rs"]
mod portablegit;
#[path = "runtime_probe.rs"]
mod probe;
#[path = "runtime_process.rs"]
mod process;
#[path = "runtime_selection.rs"]
mod selection;
#[path = "runtime_selection_discovery.rs"]
mod selection_discovery;
#[path = "runtime_selection_environment.rs"]
mod selection_environment;
#[cfg(any(windows, test))]
#[path = "runtime_windows_archive.rs"]
mod windows_archive;
#[cfg(any(windows, test))]
#[path = "runtime_windows_bootstrap.rs"]
mod windows_bootstrap;
#[cfg(any(windows, test))]
#[path = "runtime_windows_download.rs"]
mod windows_download;
#[cfg(any(windows, test))]
#[path = "runtime_windows_postinstall.rs"]
mod windows_postinstall;
#[cfg(any(windows, test))]
#[path = "runtime_windows_server.rs"]
mod windows_server;
pub use git_selection::GitSelection;
pub use selection::RepairNeeds;
#[cfg(all(test, unix))]
#[path = "runtime_git_selection_tests.rs"]
mod git_selection_tests;
#[cfg(test)]
#[path = "runtime_selection_windows_tests.rs"]
mod selection_windows_tests;
#[cfg(test)]
pub use archive::{release_for, safe_link, safe_member};
pub use cancel::{cancel_install, CancelToken, InstallGuard};
pub use install::ensure_server;
pub use process::{redact_line, run_install};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Selection {
    pub node: PathBuf,
    pub npm: PathBuf,
    pub prefix: PathBuf,
    /// False for legacy records; never infer ownership from the current PATH.
    #[serde(default)]
    pub node_managed: bool,
    /// Actual qualified entry, invoked with the selected Node (not cmd.exe).
    #[serde(default)]
    pub npm_cli: Option<PathBuf>,
    /// None means Git has not been selected, not a corrupt legacy record.
    #[serde(default)]
    pub git: Option<GitSelection>,
    #[serde(default)]
    pub server: Option<Server>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Server {
    pub bin: PathBuf,
    /// Managed packages are launched as node + actual CLI, never through PATH.
    pub managed: bool,
    /// Qualified external Windows package entry. Retain the original wrapper identity
    /// and ownership, but never execute it or let it choose an unrelated Node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_entry: Option<PathBuf>,
}

impl Selection {
    pub fn new(node: PathBuf, npm: PathBuf, prefix: PathBuf) -> Self {
        Self {
            node,
            npm,
            prefix,
            node_managed: false,
            npm_cli: None,
            git: None,
            server: None,
        }
    }

    pub fn load(home: &Path) -> Result<Option<Self>, String> {
        let selected = Self::read_saved(home)?;
        if let Some(selected) = &selected {
            selected.validate()?;
        }
        Ok(selected)
    }

    /// Read identities even if a saved tool disappeared; repair policy belongs to bootstrap.
    pub fn read_saved(home: &Path) -> Result<Option<Self>, String> {
        let file = home.join("runtime/selection.json");
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("RUNTIME_MISSING: cannot read saved selection".into()),
        };
        let selected: Self =
            serde_json::from_slice(&bytes).map_err(|_| "RUNTIME_MISSING: invalid saved selection")?;
        Ok(Some(selected))
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.node.is_absolute() || !self.npm.is_absolute() || !self.prefix.is_absolute() {
            return Err("RUNTIME_MISSING: invalid selected paths".into());
        }
        if !self.node.is_file() || !self.npm.is_file() {
            return Err("RUNTIME_MISSING: selected runtime was removed; restore it and retry".into());
        }
        self.validate_optional_tools()
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        let dir = home.join("runtime");
        std::fs::create_dir_all(&dir).map_err(storage_error)?;
        let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(storage_error)?;
        serde_json::to_writer(&mut file, self).map_err(storage_error)?;
        file.as_file().sync_all().map_err(storage_error)?;
        file.persist(dir.join("selection.json")).map_err(storage_error)?;
        Ok(())
    }

    pub fn command(&self, program: &OsStr) -> Command {
        if program == OsStr::new("node") || program == OsStr::new("node.exe") {
            return Command::new(&self.node);
        }
        if self.is_npm(program) {
            return self.npm_command();
        }
        self.server_command(program)
    }

    fn server_command(&self, program: &OsStr) -> Command {
        let bound = self
            .server
            .as_ref()
            .filter(|s| (s.managed || s.node_entry.is_some()) && s.bin.as_os_str() == program);
        if let Some(server) = bound {
            let mut command = Command::new(&self.node);
            command.arg(server.node_entry.as_ref().unwrap_or(&server.bin));
            return command;
        }
        Command::new(program)
    }
}

pub fn storage_error(e: impl std::fmt::Display) -> String {
    format!("SERVER_INSTALL_FAILED: {e}")
}

pub fn find_bin(name: &str, path: &OsStr) -> Option<PathBuf> {
    #[cfg(windows)]
    return selection_discovery::find_windows_bin(name, path);
    #[cfg(not(windows))]
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|p| executable(p))
}

#[cfg(windows)]
fn executable(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

// Read-only native helpers keep their existing contract. INSTALL qualification must
// use `probe` so cancellation/deadlines only signal newly owned probe groups.
pub fn output(mut command: Command, args: &[&str]) -> Option<String> {
    let out = command
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn selected_output(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    program: &OsStr,
    args: &[&str],
) -> Option<String> {
    let mut command = selected.command(program);
    selected.apply(&mut command, home, path).ok()?;
    output(command, args)
}

pub fn version_at_least(value: &str, floor: &str) -> bool {
    fn parts(s: &str) -> Vec<u32> {
        s.trim()
            .trim_start_matches('v')
            .split(['.', '-'])
            .map_while(|p| p.parse().ok())
            .collect()
    }
    let (mut a, mut b) = (parts(value), parts(floor));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a >= b
}

pub fn bootstrap(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<Selection, String> {
    #[cfg(windows)]
    return windows_bootstrap::bootstrap(home, path, floor, token, log);
    #[cfg(unix)]
    bootstrap_posix(home, path, floor, token, log)
}

#[cfg(unix)]
fn bootstrap_posix(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<Selection, String> {
    token.check()?;
    if let Some(saved) = Selection::load(home)? {
        requalify_saved(&saved, home, path, floor, token)?;
        return Ok(saved);
    }
    let selected = match external_runtime(home, path, floor, token)? {
        Some(selected) => {
            log("Reusing qualified external runtime");
            selected
        }
        None => archive::bootstrap(home, path, floor, token, log)?,
    };
    token.check()?;
    selected.save(home)?;
    token.check()?;
    Ok(selected)
}

fn requalify_saved(
    saved: &Selection,
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
) -> Result<(), String> {
    if !qualified_install(saved, home, path, floor, token)? {
        return Err(
            "RUNTIME_MISSING: selected Node/npm cannot run or is too old; restore it and retry".into(),
        );
    }
    token.check()
}

fn external_runtime(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
) -> Result<Option<Selection>, String> {
    let (Some(node), Some(npm)) = (find_bin("node", path), find_bin("npm", path)) else {
        return Ok(None);
    };
    let selected = Selection::new(node, npm, home.join("runtime/prefix"));
    #[cfg(windows)]
    let selected = {
        let mut selected = selected;
        if !selected.qualify_windows_npm() {
            return Ok(None);
        }
        selected
    };
    Ok(qualified_install(&selected, home, path, floor, token)?.then_some(selected))
}

fn qualified_install(
    selected: &Selection,
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
) -> Result<bool, String> {
    token.check()?;
    if !executable(&selected.node) || !executable(&selected.npm) {
        return Ok(false);
    }
    for (tool, minimum) in [("node", floor), ("npm", "1.0.0")] {
        let version = probe::selected_output(selected, home, path, OsStr::new(tool), &["--version"], token)?;
        if !version.is_some_and(|v| version_at_least(&v, minimum)) {
            return Ok(false);
        }
    }
    token.check()?;
    Ok(true)
}

pub fn qualified(selected: &Selection, home: &Path, path: &OsStr, floor: &str) -> bool {
    let node = selected_output(selected, home, path, OsStr::new("node"), &["--version"]);
    let npm = selected_output(selected, home, path, OsStr::new("npm"), &["--version"]);
    node.is_some_and(|v| version_at_least(&v, floor)) && npm.is_some_and(|v| version_at_least(&v, "1.0.0"))
}
