//! How the record's tools are invoked. No unpacking, installation, or saving.
use super::Selection;
use std::{ffi::OsStr, path::Path, process::Command};

impl Selection {
    pub(super) fn validate_optional_tools(&self) -> Result<(), String> {
        if self.npm_cli.as_ref().is_some_and(|p| !selected_file(p)) {
            return Err("RUNTIME_MISSING: npm was removed".into());
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

    /// Use this instead of Command::new(&selected.npm).
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
