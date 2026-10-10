//! Git for Windows (bundled PortableGit) as the shell for Cortex on Windows.
use super::{probe, selection_environment::remove_env, storage_error, CancelToken};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Command};

const QUALIFY_SCRIPT: &str = "git --version >/dev/null && sh -c ':' && printf '%s\\n' cortex-git-qualified | grep -x cortex-git-qualified";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GitSelection {
    pub root: PathBuf,
    pub git: PathBuf,
    pub bash: PathBuf,
    #[serde(default)]
    pub managed: bool,
}

impl GitSelection {
    pub fn from_root(root: PathBuf, managed: bool) -> Option<Self> {
        let selected = Self {
            git: root.join("cmd/git.exe"),
            bash: root.join("usr/bin/bash.exe"),
            root,
            managed,
        };
        selected.validate().ok().map(|_| selected)
    }

    /// Qualification uses only owned, bounded probe processes, never login profiles.
    pub fn qualify(&self, token: &CancelToken) -> Result<bool, String> {
        token.check()?;
        if self.validate().is_err() {
            return Ok(false);
        }
        let git = probe::output(self.probe_command(&self.git)?, &["--version"], token)?;
        if !git.is_some_and(|v| v.starts_with("git version ")) {
            return Ok(false);
        }
        let bash = probe::output(
            self.probe_command(&self.bash)?,
            &["--noprofile", "--norc", "-c", QUALIFY_SCRIPT],
            token,
        )?;
        Ok(bash.as_deref() == Some("cortex-git-qualified"))
    }

    fn probe_command(&self, program: &std::path::Path) -> Result<Command, String> {
        let mut command = Command::new(program);
        let path = std::env::join_paths([self.root.join("cmd"), self.root.join("usr/bin")])
            .map_err(storage_error)?;
        remove_env(&mut command, "PATH", true);
        command.env("PATH", path);
        sanitize_probe(&mut command);
        Ok(command)
    }

    /// Missing utilities fail validation too; never substitute PATH tools.
    pub fn validate(&self) -> Result<(), String> {
        if !self.root.is_absolute()
            || self.git != self.root.join("cmd/git.exe")
            || self.bash != self.root.join("usr/bin/bash.exe")
        {
            return Err("RUNTIME_MISSING: invalid selected Git/Bash paths".into());
        }
        let utilities = [
            self.root.join("usr/bin/sh.exe"),
            self.root.join("usr/bin/grep.exe"),
        ];
        if [&self.git, &self.bash]
            .into_iter()
            .chain(utilities.iter())
            .any(|p| !p.is_file())
        {
            return Err("RUNTIME_MISSING: selected Git/Bash or utility was removed".into());
        }
        Ok(())
    }
}

pub(super) fn sanitize_probe(command: &mut Command) {
    for key in [
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "BASHOPTS",
        "CDPATH",
        "GLOBIGNORE",
        "ORIGINAL_PATH",
        "MSYS2_PATH_TYPE",
    ] {
        remove_env(command, key, true);
    }
    let functions: Vec<_> = std::env::vars_os()
        .map(|(k, _)| k)
        .chain(command.get_envs().map(|(k, _)| k.to_os_string()))
        .filter(|k| {
            k.to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("BASH_FUNC_")
        })
        .collect();
    for key in functions {
        command.env_remove(key);
    }
    command.env("MSYS2_PATH_TYPE", "inherit");
}
