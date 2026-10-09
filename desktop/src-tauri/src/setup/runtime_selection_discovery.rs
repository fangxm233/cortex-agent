//! Read-only Windows executable/npm layout discovery; no external shim execution.
use super::Selection;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(super) fn find_windows_bin(name: &str, path: &OsStr) -> Option<PathBuf> {
    let names = windows_names(name);
    std::env::split_paths(path).find_map(|dir| {
        names
            .iter()
            .map(|name| dir.join(name))
            .find(|file| file.is_absolute() && file.is_file())
    })
}

fn windows_names(name: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        return vec![name.into()];
    }
    if name.eq_ignore_ascii_case("npm") || name.eq_ignore_ascii_case("cortex") {
        return vec![format!("{name}.cmd"), format!("{name}.exe")];
    }
    vec![format!("{name}.exe")]
}

/// Only the standard colocated Node distribution layout is supported on Windows.
/// Match both shipped wrappers against npm's own templates; never guess through a
/// version-manager/global shim or run cmd.exe just to discover its target.
pub(super) fn npm_cli_layout(selected: &Selection) -> Option<PathBuf> {
    let dir = selected.node.parent()?;
    if !selected.node.is_absolute() || !selected.node.is_file() || selected.npm.parent()? != dir {
        return None;
    }
    let package = dir.join("node_modules/npm");
    let cli = package.join("bin/npm-cli.js");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("package.json")).ok()?).ok()?;
    if !cli.is_file() || manifest["name"] != "npm" || manifest["bin"]["npm"] != "bin/npm-cli.js" {
        return None;
    }
    let cmd = matching_shim(dir, &package, "npm.cmd")?;
    let shell = matching_shim(dir, &package, "npm")?;
    let targets = cmd.contains(r"%~dp0\node_modules\npm\bin\npm-cli.js")
        && shell.contains("$CLI_BASEDIR/node_modules/npm/bin/npm-cli.js");
    let named = [dir.join("npm.cmd"), dir.join("npm")].contains(&selected.npm);
    (targets && named).then_some(cli)
}

fn matching_shim(dir: &Path, package: &Path, name: &str) -> Option<String> {
    let shim = std::fs::read(dir.join(name)).ok()?;
    let template = std::fs::read(package.join("bin").join(name)).ok()?;
    (shim == template)
        .then(|| String::from_utf8(shim).ok())
        .flatten()
}

impl Selection {
    pub fn validate_windows_npm(&self) -> Result<(), String> {
        let cli = npm_cli_layout(self).ok_or("RUNTIME_MISSING: unsupported Windows npm layout")?;
        if self.npm_cli.as_ref() != Some(&cli) {
            return Err("RUNTIME_MISSING: Windows npm CLI has not been qualified".into());
        }
        Ok(())
    }

    /// Qualify the layout before probing npm with npm_command(). Unsupported
    /// external layouts require a separate private install, never an overwrite.
    pub fn qualify_windows_npm(&mut self) -> bool {
        self.npm_cli = npm_cli_layout(self);
        self.npm_cli.is_some()
    }
}
