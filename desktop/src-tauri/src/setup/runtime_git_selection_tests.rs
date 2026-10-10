//! Linux command fixtures test qualification policy, not Windows execution.
use super::selection_environment::remove_env;
use super::*;
use std::ffi::OsString;

mod fixture {
    use super::*;
    pub(super) fn script(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{contents}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn git_fixture(root: &Path) -> GitSelection {
    for name in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        fixture::script(&root.join(name), "echo fixture");
    }
    GitSelection::from_root(root.into(), false).unwrap()
}

fn value(command: &Command, key: &str) -> Option<OsString> {
    command
        .get_envs()
        .find(|(k, _)| *k == OsStr::new(key))
        .and_then(|(_, v)| v.map(OsStr::to_os_string))
}

fn stale_command() -> Command {
    let mut command = Command::new("fixture");
    for key in [
        "Path",
        "npm_config_prefix",
        "Original_Path",
        "msys2_path_type",
        "cortex_git_bash_path",
        "Cortex_Home",
        "Cortex_Npm_Prefix",
    ] {
        command.env(key, "stale");
    }
    command.env("BASH_ENV", "user-startup").arg("-l");
    command
}

#[test]
fn windows_child_environment_replaces_case_aliases_but_preserves_login_startup() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = Selection::new(
        root.path().join("node.exe"),
        root.path().join("npm.cmd"),
        root.path().join("prefix"),
    );
    selected.git = Some(git_fixture(&root.path().join("Git")));
    let mut command = stale_command();
    selected.apply_environment(&mut command, root.path(), OsStr::new("selected"), true);
    assert_eq!(value(&command, "PATH"), Some("selected".into()));
    assert_eq!(
        value(&command, "NPM_CONFIG_PREFIX"),
        Some(selected.prefix.into())
    );
    assert_eq!(value(&command, "MSYS2_PATH_TYPE"), Some("inherit".into()));
    assert_eq!(
        value(&command, "CORTEX_GIT_BASH_PATH"),
        Some(selected.git.unwrap().bash.into())
    );
    assert_eq!(value(&command, "BASH_ENV"), Some("user-startup".into()));
    assert_eq!(command.get_args().collect::<Vec<_>>(), ["-l"]);
    assert!(!command
        .get_envs()
        .any(|(_, v)| v == Some(OsStr::new("stale"))));
}

#[test]
fn git_probe_sanitizes_startup_injections_case_insensitively_only_for_probe() {
    let mut command = Command::new("fixture");
    for key in [
        "BASH_ENV",
        "Env",
        "Shellopts",
        "BASHOPTS",
        "CDPATH",
        "GLOBIGNORE",
        "BASH_FUNC_git%%",
        "Original_Path",
    ] {
        command.env(key, "injection");
    }
    super::git_selection::sanitize_probe(&mut command);
    assert!(!command
        .get_envs()
        .any(|(_, v)| v == Some(OsStr::new("injection"))));
    assert_eq!(value(&command, "MSYS2_PATH_TYPE"), Some("inherit".into()));
    remove_env(&mut command, "msys2_path_type", true);
    assert!(value(&command, "MSYS2_PATH_TYPE").is_none());
}

#[test]
fn git_qualification_uses_bounded_probes_and_no_profile_no_rc_arguments() {
    let root = tempfile::tempdir().unwrap();
    let git = git_fixture(root.path());
    fixture::script(
        &git.git,
        "test \"$1\" = --version || exit 1; echo git version 2.54.0.windows.1",
    );
    fixture::script(&git.bash, "test \"$1\" = --noprofile && test \"$2\" = --norc && test \"$3\" = -c || exit 2; echo cortex-git-qualified");
    assert!(git.qualify(&CancelToken::default()).unwrap());
    fixture::script(&git.bash, "exit 9");
    assert!(!git.qualify(&CancelToken::default()).unwrap());
    assert!(!root.path().join("selection.json").exists());
}

#[test]
fn git_probe_script_requires_selected_sh_and_grep_to_run() {
    let root = tempfile::tempdir().unwrap();
    let git = git_fixture(root.path());
    fixture::script(&git.git, "echo git version 2.54.0.windows.1");
    fixture::script(&git.bash, "exec /bin/bash \"$@\"");
    fixture::script(&root.path().join("usr/bin/sh.exe"), "exec /bin/sh \"$@\"");
    fixture::script(
        &root.path().join("usr/bin/grep.exe"),
        "exec /bin/grep \"$@\"",
    );
    // Linux-only adapters model MSYS .exe suffix resolution, not Windows proof.
    for name in ["cmd/git", "usr/bin/sh", "usr/bin/grep"] {
        fixture::script(&root.path().join(name), "exec \"${0}.exe\" \"$@\"");
    }
    assert!(git.qualify(&CancelToken::default()).unwrap());
    fixture::script(&root.path().join("usr/bin/grep.exe"), "exit 1");
    assert!(!git.qualify(&CancelToken::default()).unwrap());
}

#[test]
fn missing_git_tools_fail_validation_without_a_path_substitute() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = Selection::new(
        root.path().join("node.exe"),
        root.path().join("npm.cmd"),
        root.path().join("prefix"),
    );
    for file in [&selected.node, &selected.npm] {
        std::fs::write(file, "fixture").unwrap();
    }
    selected.git = Some(git_fixture(&root.path().join("Git")));
    selected.save(root.path()).unwrap();
    assert!(Selection::load(root.path()).is_ok());
    std::fs::remove_file(&selected.git.as_ref().unwrap().bash).unwrap();
    assert!(Selection::load(root.path()).unwrap_err().starts_with("RUNTIME_MISSING"));
    assert!(Selection::read_saved(root.path()).unwrap().is_some());
}
