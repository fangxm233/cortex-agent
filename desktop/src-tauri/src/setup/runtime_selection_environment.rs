//! Child-only environment construction. Windows never creates runtime symlinks.
use super::{storage_error, Selection};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

pub(super) fn prefix_bin_for(prefix: &Path, windows: bool) -> PathBuf {
    if windows {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    }
}

pub(super) fn windows_paths(selected: &Selection) -> Result<Vec<PathBuf>, String> {
    let node_dir = selected.node.parent().ok_or("RUNTIME_MISSING")?;
    if selected.npm.parent() != Some(node_dir) {
        return Err("RUNTIME_MISSING: unsupported split Windows npm layout".into());
    }
    let mut paths = vec![
        node_dir.to_path_buf(),
        prefix_bin_for(&selected.prefix, true),
    ];
    if let Some(git) = &selected.git {
        git.validate()?;
        paths.extend([git.root.join("cmd"), git.root.join("usr/bin")]);
    }
    Ok(paths)
}

impl Selection {
    pub fn prefix_bin(&self) -> PathBuf {
        prefix_bin_for(&self.prefix, cfg!(windows))
    }

    pub fn path(&self, inherited: &OsStr) -> Result<OsString, String> {
        #[cfg(windows)]
        let mut paths = windows_paths(self)?;
        #[cfg(not(windows))]
        let mut paths = self.posix_paths()?;
        paths.extend(std::env::split_paths(inherited));
        std::env::join_paths(paths).map_err(storage_error)
    }

    #[cfg(unix)]
    fn posix_paths(&self) -> Result<Vec<PathBuf>, String> {
        let node_dir = self.node.parent().ok_or("RUNTIME_MISSING")?;
        let mut paths = vec![node_dir.to_path_buf(), self.prefix_bin()];
        if self.npm.parent() != Some(node_dir) {
            paths.insert(0, self.pinned_bin()?);
        }
        Ok(paths)
    }

    // Persisted POSIX split-runtime identities remain authoritative over PATH.
    #[cfg(unix)]
    fn pinned_bin(&self) -> Result<PathBuf, String> {
        let runtime = self.prefix.parent().ok_or("RUNTIME_MISSING")?;
        let bin = runtime.join("bin");
        std::fs::create_dir_all(&bin).map_err(storage_error)?;
        for (name, target) in [("node", &self.node), ("npm", &self.npm)] {
            let link = bin.join(name);
            if std::fs::read_link(&link).ok().as_ref() == Some(target) {
                continue;
            }
            let stage = tempfile::tempdir_in(runtime).map_err(storage_error)?;
            let staged = stage.path().join(name);
            std::os::unix::fs::symlink(target, &staged).map_err(storage_error)?;
            std::fs::rename(staged, link).map_err(storage_error)?;
        }
        Ok(bin)
    }

    pub fn apply(
        &self,
        command: &mut Command,
        home: &Path,
        inherited: &OsStr,
    ) -> Result<(), String> {
        let path = self.path(inherited)?;
        self.apply_environment(command, home, &path, cfg!(windows));
        Ok(())
    }

    pub(super) fn apply_environment(
        &self,
        command: &mut Command,
        home: &Path,
        path: &OsStr,
        windows: bool,
    ) {
        for (key, value) in [
            ("PATH", path),
            ("CORTEX_HOME", home.as_os_str()),
            ("CORTEX_NPM_PREFIX", self.prefix.as_os_str()),
            ("NPM_CONFIG_PREFIX", self.prefix.as_os_str()),
        ] {
            set_env(command, key, value, windows);
        }
        if !windows {
            command.env("npm_config_prefix", &self.prefix);
        }
        if let Some(git) = &self.git {
            set_env(
                command,
                "CORTEX_GIT_BASH_PATH",
                git.bash.as_os_str(),
                windows,
            );
            set_env(command, "MSYS2_PATH_TYPE", OsStr::new("inherit"), windows);
            remove_env(command, "ORIGINAL_PATH", windows);
        }
    }
}

fn set_env(command: &mut Command, key: &str, value: &OsStr, windows: bool) {
    remove_env(command, key, windows);
    command.env(key, value);
}

pub(super) fn remove_env(command: &mut Command, key: &str, windows: bool) {
    let keys: Vec<_> = std::env::vars_os()
        .map(|(k, _)| k)
        .chain(command.get_envs().map(|(k, _)| k.to_os_string()))
        .filter(|k| env_key_matches(k, key, windows))
        .collect();
    for key in keys {
        command.env_remove(key);
    }
    command.env_remove(key);
}

fn env_key_matches(candidate: &OsStr, key: &str, windows: bool) -> bool {
    if windows {
        candidate.to_string_lossy().eq_ignore_ascii_case(key)
    } else {
        candidate == OsStr::new(key)
    }
}
