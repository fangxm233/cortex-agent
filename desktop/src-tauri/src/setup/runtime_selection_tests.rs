//! Selection persistence/command tests; no Windows executables are run on POSIX.
use super::*;
use serde_json::{json, Value};

fn selection_record(home: &Path) -> Value {
    for name in ["node.exe", "npm.cmd", "npm-cli.js"] {
        std::fs::write(home.join(name), "fixture").unwrap();
    }
    json!({"node": home.join("node.exe"), "npm": home.join("npm.cmd"),
        "prefix": home.join("runtime/prefix")})
}

fn git_record(home: &Path) -> Value {
    let root = home.join("Git with 空格 %!");
    for name in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        let file = root.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "fixture").unwrap();
    }
    json!({"root": root, "git": root.join("cmd/git.exe"),
        "bash": root.join("usr/bin/bash.exe"), "managed": false})
}

#[test]
fn selection_old_node_only_defaults_remain_loadable_without_git() {
    let home = tempfile::tempdir().unwrap();
    let selected: Selection = serde_json::from_value(selection_record(home.path())).unwrap();
    selected.save(home.path()).unwrap();
    let loaded = Selection::load(home.path()).unwrap().unwrap();
    let record = serde_json::to_value(loaded).unwrap();
    assert_eq!(record["node_managed"], false);
    assert!(record["git"].is_null());
    assert!(record["npm_cli"].is_null());
}

#[test]
fn selection_roundtrip_preserves_git_and_node_ownership_and_cli() {
    let home = tempfile::tempdir().unwrap();
    let mut record = selection_record(home.path());
    record["git"] = git_record(home.path());
    record["node_managed"] = json!(true);
    record["npm_cli"] = json!(home.path().join("npm-cli.js"));
    let selected: Selection = serde_json::from_value(record.clone()).unwrap();
    selected.save(home.path()).unwrap();
    let loaded = Selection::load(home.path()).unwrap().unwrap();
    let saved = serde_json::to_value(loaded).unwrap();
    for field in ["git", "node_managed", "npm_cli"] {
        assert_eq!(saved[field], record[field], "{field}");
    }
}

#[test]
fn selection_missing_saved_git_utilities_or_cli_is_not_silently_reselected() {
    for missing in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut record = selection_record(home.path());
        record["git"] = git_record(home.path());
        let selected: Selection = serde_json::from_value(record.clone()).unwrap();
        selected.save(home.path()).unwrap();
        let root = Path::new(record["git"]["root"].as_str().unwrap());
        std::fs::remove_file(root.join(missing)).unwrap();
        assert!(Selection::load(home.path())
            .unwrap_err()
            .starts_with("RUNTIME_MISSING"));
    }
}

#[test]
fn selection_missing_saved_npm_cli_is_rejected() {
    let home = tempfile::tempdir().unwrap();
    let mut record = selection_record(home.path());
    record["npm_cli"] = json!(home.path().join("missing-cli.js"));
    let selected: Selection = serde_json::from_value(record).unwrap();
    assert!(selected.validate().is_err());
}

#[test]
fn selection_npm_aliases_use_selected_node_and_literal_cli_argument() {
    let home = tempfile::tempdir().unwrap();
    let mut record = selection_record(home.path());
    let cli = home.path().join("space 空格 %PATH% !/npm-cli.js");
    record["npm_cli"] = json!(cli);
    let selected: Selection = serde_json::from_value(record).unwrap();
    for alias in [
        OsStr::new("npm"),
        OsStr::new("npm.cmd"),
        selected.npm.as_os_str(),
    ] {
        let command = selected.command(alias);
        assert_eq!(command.get_program(), selected.node);
        assert_eq!(command.get_args().collect::<Vec<_>>(), [cli.as_os_str()]);
    }
}
