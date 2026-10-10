//! The local runtime the app ships with (Node; Git Bash on Windows) and the record of what it uses.
//! No Tauri dependency: the headless harness runs this exact code.
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

#[path = "runtime_bundle.rs"]
mod bundle;
#[path = "runtime_cancel.rs"]
mod cancel;
#[path = "runtime_git_selection.rs"]
mod git_selection;
#[path = "runtime_install.rs"]
mod install;
#[path = "runtime_probe.rs"]
mod probe;
#[path = "runtime_process.rs"]
mod process;
#[path = "runtime_selection.rs"]
mod selection;
#[path = "runtime_selection_environment.rs"]
mod selection_environment;
#[cfg(any(windows, test))]
#[path = "runtime_windows_postinstall.rs"]
mod windows_postinstall;
pub use bundle::NOT_BUNDLED;
pub use cancel::{cancel_install, CancelToken, InstallGuard};
pub use git_selection::GitSelection;
pub use install::{ensure_server, install_server_version};
pub use process::{redact_line, run_install};
#[cfg(all(test, unix))]
#[path = "runtime_git_selection_tests.rs"]
mod git_selection_tests;
#[cfg(test)]
#[path = "runtime_selection_windows_tests.rs"]
mod selection_windows_tests;
/// Serializes tests that use the process-wide cancel slot (the headless harness suites).
#[cfg(test)]
#[allow(dead_code)]
pub(crate) static CANCEL_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Selection {
    pub node: PathBuf,
    pub npm: PathBuf,
    pub prefix: PathBuf,
    #[serde(default)]
    pub node_managed: bool,
    /// npm's JS entry, invoked with the selected Node (never through cmd.exe or a shebang).
    #[serde(default)]
    pub npm_cli: Option<PathBuf>,
    #[serde(default)]
    pub git: Option<GitSelection>,
    #[serde(default)]
    pub server: Option<Server>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub bin: PathBuf,
    /// Private packages are launched as node + actual CLI, never through PATH.
    pub managed: bool,
    /// JS entry of an older external Windows package, launched with the selected Node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_entry: Option<PathBuf>,
}

impl Selection {
    #[cfg(test)]
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

    /// The bundled tools unpacked under `<home>/runtime`, with the private npm prefix.
    pub fn bundled(home: &Path, node_root: &Path, git: Option<GitSelection>) -> Self {
        let layout = bundle::NodeLayout::of(node_root);
        Self {
            node: layout.node,
            npm: layout.npm,
            prefix: home.join("runtime/prefix"),
            node_managed: true,
            npm_cli: Some(layout.npm_cli),
            git,
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
            return Err("RUNTIME_MISSING: runtime files were removed".into());
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

/// Unpack (or restore) the bundled runtime and point the saved record at it.
///
/// Any earlier record — an external Node, an older private download, an external Git — is
/// rewritten to the bundled tools; the saved server is kept for `ensure_server` to judge.
pub fn ensure_runtime(
    home: &Path,
    bundle: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<Selection, String> {
    token.check()?;
    let manifest = bundle::Manifest::load(bundle)?;
    let runtime = home.join("runtime");
    let node = bundle::ensure_node(&manifest, bundle, &runtime, token, log)?;
    let git = match &manifest.git {
        Some(archive) => Some(bundle::ensure_git(archive, bundle, &runtime, token, log, post_install)?),
        None if cfg!(windows) => return Err(NOT_BUNDLED.into()),
        None => None,
    };
    token.check()?;
    let saved = Selection::read_saved(home).unwrap_or_else(|e| {
        log(&format!("Ignoring unreadable runtime record ({e})"));
        None
    });
    let mut selected = Selection::bundled(home, &node, git);
    selected.server = saved.as_ref().and_then(|s| s.server.clone());
    if saved.as_ref() != Some(&selected) {
        if saved.is_some() {
            log("Switching to the bundled runtime");
        }
        selected.save(home)?;
    }
    token.check()?;
    Ok(selected)
}

#[cfg(windows)]
fn post_install(root: &Path, token: &CancelToken) -> Result<(), String> {
    windows_postinstall::run(root, token)
}

#[cfg(not(windows))]
fn post_install(_root: &Path, _token: &CancelToken) -> Result<(), String> {
    Ok(())
}

pub fn storage_error(e: impl std::fmt::Display) -> String {
    format!("SERVER_INSTALL_FAILED: {e}")
}

pub fn find_bin(name: &str, path: &OsStr) -> Option<PathBuf> {
    let names = if cfg!(windows) && Path::new(name).extension().is_none() {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
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

// Read-only probes own temporary children and have the same output/deadline bounds.
// Install callers use install_server_version with their active cancellation token.
pub fn output(command: Command, args: &[&str]) -> Option<String> {
    probe::output(command, args, &CancelToken::default()).ok().flatten()
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
