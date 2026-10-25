//! Removes the local server this app installed, in the order that keeps it from coming back:
//! autostart first (launchd's KeepAlive would restart a daemon stopped any other way), then the
//! daemon and its local client, the terminal command, the runtime, and — only when asked — the
//! whole Cortex home.
use std::path::{Path, PathBuf};

use crate::uninstall::{remove_tree, Step, StepStatus};

/// The local server, as far as the uninstaller needs to know it.
pub struct LocalServer {
    pub home: PathBuf,
    /// The installed `cortex` entry, when the runtime record still names one.
    pub bin: Option<String>,
}

/// A server this app installed: its runtime directory exists under the Cortex home.
pub fn local_server() -> Option<LocalServer> {
    let home = super::cortex_home()?;
    if !home.join("runtime").is_dir() {
        return None;
    }
    let bin = super::runtime::Selection::read_saved(&home)
        .ok()
        .flatten()
        .and_then(|selected| selected.server)
        .map(|server| server.bin.to_string_lossy().into_owned());
    Some(LocalServer { home, bin })
}

/// What the teardown runs, injectable so the ordering and failure handling are testable.
pub struct Ports<'a> {
    /// Ok(true) = a registration was removed; Ok(false) = there was none.
    pub autostart: &'a mut dyn FnMut() -> Result<bool, String>,
    /// Run `cortex <args>`; Ok((succeeded, output)).
    pub cortex: &'a mut dyn FnMut(&str, &[&str]) -> Result<(bool, String), String>,
}

pub fn teardown(server: &LocalServer, purge: bool) -> Vec<Step> {
    let user_home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut autostart = autostart_off;
    let mut cortex = |bin: &str, args: &[&str]| {
        super::process::run_quiet(bin, args).map(|outcome| (outcome.ok(), outcome.combined()))
    };
    let mut ports = Ports { autostart: &mut autostart, cortex: &mut cortex };
    teardown_with(server, purge, user_home.as_deref(), &mut ports)
}

fn autostart_off() -> Result<bool, String> {
    super::autostart::remove()
}

/// A daemon that would not stop keeps the runtime and data in use, so nothing is deleted then.
pub fn teardown_with(
    server: &LocalServer,
    purge: bool,
    user_home: Option<&Path>,
    ports: &mut Ports<'_>,
) -> Vec<Step> {
    let mut steps = vec![outcome_step("autostart", (ports.autostart)())];
    let daemon = daemon_step(server, ports);
    let stopped = daemon.status != StepStatus::Failed;
    steps.push(daemon);
    if !stopped {
        return steps;
    }
    steps.push(terminal_step(server, ports));
    steps.push(outcome_step("runtime", remove_tree(&server.home.join("runtime"))));
    if purge {
        steps.push(data_step(&server.home, user_home));
    }
    steps
}

fn outcome_step(step: &'static str, outcome: Result<bool, String>) -> Step {
    match outcome {
        Ok(true) => Step::new(step, StepStatus::Done),
        Ok(false) => Step::new(step, StepStatus::Skipped),
        Err(error) => Step::new(step, StepStatus::Failed).detail(error),
    }
}

fn daemon_step(server: &LocalServer, ports: &mut Ports<'_>) -> Step {
    let Some(bin) = &server.bin else {
        return Step::new("daemon", StepStatus::Skipped);
    };
    match (ports.cortex)(bin, &["daemon", "stop"]) {
        Ok((true, _)) => Step::new("daemon", StepStatus::Done),
        Ok((false, output)) => Step::new("daemon", StepStatus::Failed).detail(output),
        Err(error) => Step::new("daemon", StepStatus::Failed).detail(error),
    }
}

/// `cortex path remove` arrived after some installs; an older server simply has nothing to undo.
fn terminal_step(server: &LocalServer, ports: &mut Ports<'_>) -> Step {
    let Some(bin) = &server.bin else {
        return Step::new("terminal", StepStatus::Skipped);
    };
    match (ports.cortex)(bin, &["path", "remove", "--json"]) {
        Ok((true, output)) if path_removal_changed(&output) => Step::new("terminal", StepStatus::Done),
        Ok((true, _)) => Step::new("terminal", StepStatus::Skipped),
        Ok((false, output)) if output.contains("Unknown command") => {
            Step::new("terminal", StepStatus::Skipped)
        }
        Ok((false, output)) => Step::new("terminal", StepStatus::Failed).detail(output),
        Err(error) => Step::new("terminal", StepStatus::Failed).detail(error),
    }
}

fn path_removal_changed(output: &str) -> bool {
    let Ok(report) = serde_json::from_str::<serde_json::Value>(output.trim()) else {
        return false;
    };
    let removed = report["removed"].as_array().is_some_and(|files| !files.is_empty());
    let restored = report["path_targets"]
        .as_array()
        .is_some_and(|targets| targets.iter().any(|t| t["changed"] == true));
    removed || restored
}

fn data_step(home: &Path, user_home: Option<&Path>) -> Step {
    if !is_removable_home(home, user_home) {
        return Step::new("data", StepStatus::Failed).detail(format!(
            "{} does not look like a Cortex home; left in place",
            home.display()
        ));
    }
    outcome_step("data", remove_tree(home))
}

/// Deleting the data must never reach the user's own home or a filesystem root, and an unusual
/// CORTEX_HOME has to actually be one.
pub fn is_removable_home(home: &Path, user_home: Option<&Path>) -> bool {
    if home.parent().is_none() || user_home.is_some_and(|user| crate::install_site::same_dir(user, home)) {
        return false;
    }
    home.file_name().is_some_and(|name| name == ".cortex") || home.join("config/machines.json").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Calls {
        autostart: Result<bool, String>,
        daemon: Result<(bool, String), String>,
        path: Result<(bool, String), String>,
        log: Vec<String>,
    }

    impl Calls {
        fn ok() -> Self {
            Calls {
                autostart: Ok(true),
                daemon: Ok((true, "Stopped".into())),
                path: Ok((true, r#"{"removed":["cortex"],"path_targets":[]}"#.into())),
                log: Vec::new(),
            }
        }

        fn run(&mut self, server: &LocalServer, purge: bool, user: Option<&Path>) -> Vec<Step> {
            let autostart = self.autostart.clone();
            let (daemon, path) = (self.daemon.clone(), self.path.clone());
            let log = &mut self.log;
            let mut autostart_port = || autostart.clone();
            let mut cortex_port = |bin: &str, args: &[&str]| {
                log.push(format!("{bin} {}", args.join(" ")));
                if args[0] == "daemon" { daemon.clone() } else { path.clone() }
            };
            let mut ports = Ports { autostart: &mut autostart_port, cortex: &mut cortex_port };
            teardown_with(server, purge, user, &mut ports)
        }
    }

    fn installed_home() -> (tempfile::TempDir, LocalServer) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join(".cortex");
        fs::create_dir_all(home.join("runtime/node")).unwrap();
        fs::write(home.join("runtime/node/node"), b"fixture").unwrap();
        fs::create_dir_all(home.join("config")).unwrap();
        fs::write(home.join("config/machines.json"), b"{}").unwrap();
        let server = LocalServer { home, bin: Some("/x/cortex".into()) };
        (root, server)
    }

    fn statuses(steps: &[Step]) -> Vec<(&str, StepStatus)> {
        steps.iter().map(|s| (s.step, s.status)).collect()
    }

    #[test]
    fn keeping_data_removes_only_the_runtime_after_the_daemon_stops() {
        let (_root, server) = installed_home();
        let mut calls = Calls::ok();
        let steps = calls.run(&server, false, None);
        assert_eq!(statuses(&steps), vec![
            ("autostart", StepStatus::Done),
            ("daemon", StepStatus::Done),
            ("terminal", StepStatus::Done),
            ("runtime", StepStatus::Done),
        ]);
        assert_eq!(calls.log, vec!["/x/cortex daemon stop", "/x/cortex path remove --json"]);
        assert!(!server.home.join("runtime").exists());
        assert!(server.home.join("config/machines.json").is_file());
    }

    #[test]
    fn deleting_data_removes_the_whole_home_last() {
        let (root, server) = installed_home();
        let steps = Calls::ok().run(&server, true, Some(root.path()));
        assert_eq!(steps.last().map(|s| (s.step, s.status)), Some(("data", StepStatus::Done)));
        assert!(!server.home.exists());
        assert!(root.path().exists());
    }

    #[test]
    fn a_daemon_that_will_not_stop_leaves_runtime_and_data_in_place() {
        let (_root, server) = installed_home();
        let mut calls = Calls::ok();
        calls.daemon = Ok((false, "Local client cortex (PID 9) did not exit.".into()));
        let steps = calls.run(&server, true, None);
        assert_eq!(statuses(&steps), vec![("autostart", StepStatus::Done), ("daemon", StepStatus::Failed)]);
        assert!(steps[1].detail.as_deref().unwrap().contains("did not exit"));
        assert!(server.home.join("runtime/node/node").is_file());
    }

    #[test]
    fn a_foreign_autostart_is_reported_but_does_not_stop_the_teardown() {
        let (_root, server) = installed_home();
        let mut calls = Calls::ok();
        calls.autostart = Err("cortex.service was not created by Cortex; preserved unchanged".into());
        let steps = calls.run(&server, false, None);
        assert_eq!(steps[0].status, StepStatus::Failed);
        assert_eq!(steps[3], Step::new("runtime", StepStatus::Done));
    }

    #[test]
    fn an_older_server_without_path_remove_or_nothing_to_remove_is_skipped() {
        let (_root, server) = installed_home();
        let mut calls = Calls::ok();
        calls.path = Ok((false, "Unknown command: 'path'. Use --help".into()));
        assert_eq!(calls.run(&server, false, None)[2].status, StepStatus::Skipped);
        let (_root, server) = installed_home();
        let mut calls = Calls::ok();
        calls.path = Ok((true, r#"{"removed":[],"path_targets":[{"target":"~/.bashrc","changed":false}]}"#.into()));
        assert_eq!(calls.run(&server, false, None)[2].status, StepStatus::Skipped);
    }

    #[test]
    fn a_runtime_without_a_server_record_still_has_its_files_removed() {
        let (_root, mut server) = installed_home();
        server.bin = None;
        let mut calls = Calls::ok();
        let steps = calls.run(&server, false, None);
        assert_eq!(statuses(&steps)[1..], [
            ("daemon", StepStatus::Skipped),
            ("terminal", StepStatus::Skipped),
            ("runtime", StepStatus::Done),
        ]);
        assert!(calls.log.is_empty());
    }

    #[test]
    fn only_a_cortex_home_is_ever_deleted() {
        let root = tempfile::tempdir().unwrap();
        let custom = root.path().join("work");
        fs::create_dir_all(&custom).unwrap();
        assert!(!is_removable_home(&custom, None));
        fs::create_dir_all(custom.join("config")).unwrap();
        fs::write(custom.join("config/machines.json"), b"{}").unwrap();
        assert!(is_removable_home(&custom, None));
        assert!(!is_removable_home(&custom, Some(&custom)));
        assert!(is_removable_home(&root.path().join(".cortex"), Some(root.path())));
        assert!(!is_removable_home(Path::new("/"), None));
        let steps = Calls::ok().run(&LocalServer { home: root.path().join("work2"), bin: None }, true, None);
        assert_eq!(steps.last().map(|s| (s.step, s.status)), Some(("data", StepStatus::Failed)));
    }
}
