//! Pure Windows layout policy, not a Windows execution qualification.
use super::selection_environment::{prefix_bin_for, windows_paths};
use super::*;

fn touch(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "fixture").unwrap();
}

fn windows_selection(root: &Path) -> Selection {
    Selection::new(
        root.join("node/node.exe"),
        root.join("node/npm.cmd"),
        root.join("prefix"),
    )
}

#[test]
fn windows_layout_prefix_is_flat_and_paths_pin_only_same_root_tools() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = windows_selection(root.path());
    let git = root.path().join("Git");
    for name in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        touch(&git.join(name));
    }
    selected.git = GitSelection::from_root(git.clone(), false);
    assert_eq!(prefix_bin_for(&selected.prefix, true), selected.prefix);
    assert_eq!(
        prefix_bin_for(&selected.prefix, false),
        selected.prefix.join("bin")
    );
    assert_eq!(
        windows_paths(&selected).unwrap(),
        vec![
            root.path().join("node"),
            selected.prefix.clone(),
            git.join("cmd"),
            git.join("usr/bin")
        ]
    );
    assert!(!root.path().join("bin").exists());
}

#[test]
fn windows_git_layout_rejects_bare_git_mingit_and_unrelated_bash() {
    let root = tempfile::tempdir().unwrap();
    touch(&root.path().join("cmd/git.exe"));
    touch(&root.path().join("bin/bash.exe"));
    assert!(GitSelection::from_root(root.path().into(), false).is_none());
    for name in ["usr/bin/bash.exe", "usr/bin/sh.exe", "usr/bin/grep.exe"] {
        touch(&root.path().join(name));
    }
    let mut git = GitSelection::from_root(root.path().into(), false).unwrap();
    assert_eq!(git.bash, root.path().join("usr/bin/bash.exe"));
    git.bash = root.path().join("bin/bash.exe");
    assert!(git.validate().is_err());
}

#[test]
fn windows_npm_runs_through_the_selected_node_case_insensitively() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = windows_selection(root.path());
    let cli = root.path().join("node/node_modules/npm/bin/npm-cli.js");
    selected.npm_cli = Some(cli.clone());
    assert!(selected.is_npm_for(OsStr::new("NPM.CMD"), true));
    assert!(selected.is_npm_for(OsStr::new("NPM"), true));
    assert!(!selected.is_npm_for(OsStr::new("NPM"), false));
    let command = selected.npm_command();
    assert_eq!(command.get_program(), selected.node);
    assert_eq!(command.get_args().collect::<Vec<_>>(), [cli.as_os_str()]);
}
