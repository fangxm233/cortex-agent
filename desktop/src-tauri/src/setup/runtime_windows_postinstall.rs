//! PortableGit's own post-install (etc files, /dev directories) for a freshly unpacked copy.
//! It runs once, hidden, with a clean environment; its output and exit code are not inspected —
//! the caller decides only by whether git and bash then run.
#[cfg(windows)]
use std::path::PathBuf;
use std::{path::Path, process::Command};

#[cfg(windows)]
pub(super) fn run(root: &Path, token: &super::CancelToken) -> Result<(), String> {
    let home = tempfile::Builder::new()
        .prefix(".git-home-")
        .tempdir_in(root.parent().unwrap_or(root))
        .map_err(super::storage_error)?;
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let command = postinstall_command(root, home.path(), &system);
    let limit = Some(std::time::Duration::from_secs(180));
    match super::process::windows::run(command, token, limit, &|_| {}) {
        Err(e) if e == "SETUP_CANCELLED" => Err(e),
        _ => Ok(()),
    }
}

fn postinstall_command(root: &Path, home: &Path, system: &Path) -> Command {
    let mut command = Command::new(root.join("git-bash.exe"));
    command
        .current_dir(root)
        .args(["--no-needs-console", "--hide", "--no-cd", "--command=post-install.bat"]);
    sanitize(&mut command, root, home, system);
    command
}

/// Drop inherited shell/Git/MSYS settings that would change how the upstream scripts run.
fn removed(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "BASH_ENV" | "ENV" | "SYSCONFDIR" | "HOME" | "SHELLOPTS" | "BASHOPTS" | "CDPATH" | "GLOBIGNORE" | "PATH"
    ) || ["GIT_", "MSYS", "ORIGINAL_", "XDG_", "BASH_FUNC_"]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

fn sanitize(command: &mut Command, root: &Path, home: &Path, system: &Path) {
    let keys: Vec<_> = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string()))
        .filter(|key| removed(&key.to_string_lossy()))
        .collect();
    for key in keys {
        command.env_remove(key);
    }
    let path = std::env::join_paths([
        root.join("cmd"),
        root.join("ucrt64/bin"),
        root.join("usr/bin"),
        system.join("System32"),
        system.to_path_buf(),
        system.join("System32/WindowsPowerShell/v1.0"),
    ])
    .unwrap_or_default();
    command
        .env("HOME", home)
        .env("PATH", path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn post_install_runs_hidden_in_the_unpacked_root_with_a_clean_environment() {
        let root = Path::new("/runtime/.stage-x/git-2.56.0.2");
        let command = postinstall_command(root, Path::new("/home-x"), Path::new("/Windows"));
        assert_eq!(command.get_program(), root.join("git-bash.exe"));
        assert_eq!(command.get_current_dir(), Some(root));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["--no-needs-console", "--hide", "--no-cd", "--command=post-install.bat"]
        );
        let env = |key: &str| {
            command
                .get_envs()
                .find(|(k, _)| *k == OsStr::new(key))
                .and_then(|(_, v)| v.map(OsStr::to_os_string))
        };
        assert_eq!(env("HOME").as_deref(), Some(OsStr::new("/home-x")));
        assert!(env("PATH").unwrap().to_string_lossy().starts_with(&*root.join("cmd").to_string_lossy()));
        for key in ["GIT_DIR", "MSYSTEM", "BASH_ENV", "Path", "xdg_config_home"] {
            assert!(removed(key), "{key}");
        }
        assert!(!removed("SystemRoot") && !removed("USERPROFILE"));
    }
}
