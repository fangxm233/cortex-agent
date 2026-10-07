//! User-owned POSIX runtime. No Tauri dependency: the headless harness runs this exact code.
use serde::{Deserialize, Serialize};
use std::{ffi::{OsStr, OsString}, path::{Path, PathBuf}, process::Command};

#[path = "runtime_archive.rs"]
mod archive;
#[path = "runtime_cancel.rs"]
mod cancel;
#[path = "runtime_install.rs"]
mod install;
#[path = "runtime_process.rs"]
mod process;
pub use archive::{release_for, safe_link, safe_member};
pub use cancel::{cancel_install, CancelToken, InstallGuard};
pub use install::ensure_server;
pub use process::{redact_line, run_install};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Selection {
    pub node: PathBuf,
    pub npm: PathBuf,
    pub prefix: PathBuf,
    #[serde(default)]
    pub server: Option<Server>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Server {
    pub bin: PathBuf,
    /// Managed packages are launched as node + actual CLI, never through PATH.
    pub managed: bool,
}

impl Selection {
    pub fn new(node: PathBuf, npm: PathBuf, prefix: PathBuf) -> Self {
        Self { node, npm, prefix, server: None }
    }

    pub fn load(home: &Path) -> Result<Option<Self>, String> {
        let file = home.join("runtime/selection.json");
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("RUNTIME_MISSING: cannot read saved selection".into()),
        };
        let selected: Self = serde_json::from_slice(&bytes)
            .map_err(|_| "RUNTIME_MISSING: invalid saved selection")?;
        selected.validate()?;
        Ok(Some(selected))
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.node.is_absolute() || !self.npm.is_absolute() || !self.prefix.is_absolute() {
            return Err("RUNTIME_MISSING: invalid selected paths".into());
        }
        if !self.node.is_file() || !self.npm.is_file() {
            return Err("RUNTIME_MISSING: selected runtime was removed; restore it and retry".into());
        }
        Ok(())
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

    pub fn path(&self, inherited: &OsStr) -> Result<OsString, String> {
        let mut paths = vec![self.node.parent().ok_or("RUNTIME_MISSING")?.to_path_buf(), self.prefix.join("bin")];
        paths.extend(std::env::split_paths(inherited));
        std::env::join_paths(paths).map_err(storage_error)
    }

    pub fn apply(&self, command: &mut Command, home: &Path, inherited: &OsStr) -> Result<(), String> {
        command.env("PATH", self.path(inherited)?)
            .env("CORTEX_HOME", home).env("NPM_CONFIG_PREFIX", &self.prefix)
            .env("npm_config_prefix", &self.prefix);
        Ok(())
    }

    pub fn command(&self, program: &OsStr) -> Command {
        if program == OsStr::new("node") { return Command::new(&self.node); }
        if program == OsStr::new("npm") { return Command::new(&self.npm); }
        self.server_command(program)
    }

    fn server_command(&self, program: &OsStr) -> Command {
        let managed = self.server.as_ref().filter(|s| s.managed && s.bin.as_os_str() == program);
        if let Some(server) = managed {
            let mut command = Command::new(&self.node);
            command.arg(&server.bin);
            return command;
        }
        Command::new(program)
    }
}

pub fn storage_error(e: impl std::fmt::Display) -> String {
    format!("SERVER_INSTALL_FAILED: {e}")
}

pub fn find_bin(name: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path).map(|dir| dir.join(name)).find(|p| executable(p))
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute() && path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub fn output(mut command: Command, args: &[&str]) -> Option<String> {
    let out = command.args(args).stdin(std::process::Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

pub fn selected_output(selected: &Selection, home: &Path, path: &OsStr, program: &OsStr, args: &[&str]) -> Option<String> {
    let mut command = selected.command(program);
    selected.apply(&mut command, home, path).ok()?;
    output(command, args)
}

pub fn version_at_least(value: &str, floor: &str) -> bool {
    fn parts(s: &str) -> Vec<u32> {
        s.trim().trim_start_matches('v').split(['.', '-']).map_while(|p| p.parse().ok()).collect()
    }
    let (mut a, mut b) = (parts(value), parts(floor));
    if a.is_empty() || b.is_empty() { return false; }
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a >= b
}

pub fn bootstrap(home: &Path, path: &OsStr, floor: &str, token: &CancelToken, log: &impl Fn(&str)) -> Result<Selection, String> {
    if let Some(saved) = Selection::load(home)? { return Ok(saved); }
    token.check()?;
    let selected = match external_runtime(home, path, floor) {
        Some(selected) => { log("Reusing qualified external runtime"); selected }
        None => archive::bootstrap(home, path, floor, token, log)?,
    };
    token.check()?;
    selected.save(home)?;
    Ok(selected)
}

fn external_runtime(home: &Path, path: &OsStr, floor: &str) -> Option<Selection> {
    let selected = Selection::new(find_bin("node", path)?, find_bin("npm", path)?, home.join("runtime/prefix"));
    qualified(&selected, home, path, floor).then_some(selected)
}

pub fn qualified(selected: &Selection, home: &Path, path: &OsStr, floor: &str) -> bool {
    let node = selected_output(selected, home, path, OsStr::new("node"), &["--version"]);
    let npm = selected_output(selected, home, path, OsStr::new("npm"), &["--version"]);
    node.is_some_and(|v| version_at_least(&v, floor)) && npm.is_some_and(|v| version_at_least(&v, "1.0.0"))
}
