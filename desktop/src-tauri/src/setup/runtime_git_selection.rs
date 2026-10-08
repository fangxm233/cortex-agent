//! Same-install Git for Windows selection. External junctions/symlinks are allowed;
//! managed archive validation is a separate concern owned by the installer.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
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

    /// Missing saved utilities fail validation too; never substitute PATH tools.
    pub fn validate(&self) -> Result<(), String> {
        if !self.root.is_absolute()
            || self.git != self.root.join("cmd/git.exe")
            || self.bash != self.root.join("usr/bin/bash.exe")
        {
            return Err("RUNTIME_MISSING: invalid selected Git/Bash paths".into());
        }
        let utilities = [self.root.join("usr/bin/sh.exe"), self.root.join("usr/bin/grep.exe")];
        if [&self.git, &self.bash].into_iter().chain(utilities.iter()).any(|p| !p.is_file()) {
            return Err("RUNTIME_MISSING: selected Git/Bash or utility was removed".into());
        }
        Ok(())
    }
}
