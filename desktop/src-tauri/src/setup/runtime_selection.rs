//! Selection-only policy. No download, installation, or repair side effects.
use super::Selection;
use std::{ffi::OsStr, path::Path, process::Command};

impl Selection {
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
        program == self.npm.as_os_str()
            || ["npm", "npm.cmd"].iter().any(|name| program == OsStr::new(name))
    }

    /// Use this instead of Command::new(&selected.npm), including prefix discovery.
    /// Legacy POSIX selections continue to execute their saved npm entry directly.
    pub fn npm_command(&self) -> Command {
        if let Some(cli) = &self.npm_cli {
            let mut command = Command::new(&self.node);
            command.arg(cli);
            return command;
        }
        Command::new(&self.npm)
    }
}

fn selected_file(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}
