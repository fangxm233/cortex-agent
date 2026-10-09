//! Selection-only policy. No download, installation, or repair side effects.
use super::Selection;
use std::{ffi::OsStr, path::Path, process::Command};

/// Presence/layout only. Bootstrap must still run bounded version/tool probes.
/// Repair into a new private location; these flags grant no permission to replace
/// saved external installations (ownership remains in the selection record).
#[derive(Debug, PartialEq, Eq)]
pub struct RepairNeeds {
    pub node: bool,
    pub git: bool,
}

impl Selection {
    pub fn windows_repair_needs(&self) -> RepairNeeds {
        let cli = super::selection_discovery::npm_cli_layout(self);
        RepairNeeds {
            node: cli.is_none()
                || self
                    .npm_cli
                    .as_ref()
                    .is_some_and(|p| Some(p) != cli.as_ref()),
            git: self.git.as_ref().is_none_or(|git| git.validate().is_err()),
        }
    }

    /// Bounded Node/npm version probes; bind Windows npm first. No saving/repair.
    pub fn qualify_node(
        &self,
        home: &Path,
        path: &OsStr,
        floor: &str,
        token: &super::CancelToken,
    ) -> Result<bool, String> {
        let mut node_only = self.clone();
        node_only.git = None;
        super::qualified_install(&node_only, home, path, floor, token)
    }

    pub(super) fn validate_optional_tools(&self) -> Result<(), String> {
        if self.npm_cli.as_ref().is_some_and(|p| !selected_file(p)) {
            return Err("RUNTIME_MISSING: selected npm CLI was removed".into());
        }
        if let Some(git) = &self.git {
            git.validate()?;
        }
        Ok(())
    }

    pub(super) fn is_npm(&self, program: &OsStr) -> bool {
        self.is_npm_for(program, cfg!(windows))
    }

    pub(super) fn is_npm_for(&self, program: &OsStr, windows: bool) -> bool {
        [
            self.npm.as_os_str(),
            OsStr::new("npm"),
            OsStr::new("npm.cmd"),
        ]
        .iter()
        .any(|name| {
            if windows {
                name.to_string_lossy()
                    .eq_ignore_ascii_case(&program.to_string_lossy())
            } else {
                program == *name
            }
        })
    }

    /// Use this instead of Command::new(&selected.npm), including prefix discovery.
    /// Legacy POSIX selections continue to execute their saved npm entry directly.
    pub fn npm_command(&self) -> Command {
        if let Some(cli) = &self.npm_cli {
            let mut command = Command::new(&self.node);
            command.arg(cli);
            return command;
        }
        // Legacy Node-only records can load, but Windows must bind/qualify an
        // actual CLI before launch. An empty program fails closed, never cmd.exe.
        #[cfg(windows)]
        return Command::new("");
        #[cfg(not(windows))]
        Command::new(&self.npm)
    }
}

fn selected_file(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}
