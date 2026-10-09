//! Source contracts for the Tauri boundary; no window, daemon, download or product build.
//! Runtime command/environment behavior is covered by the adjacent selection tests.
const SETUP: &str = include_str!("../../../src/setup.rs");
const PROCESS: &str = include_str!("../../../src/setup/process.rs");
const CLAUDE: &str = include_str!("../../../src/setup/claude.rs");
const DESKTOP: &str =
    "#[cfg(any(target_os = \"macos\", target_os = \"linux\", target_os = \"windows\"))]";
const POSIX: &str = "#[cfg(any(target_os = \"macos\", target_os = \"linux\"))]";

fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source
        .split_once(start)
        .expect(start)
        .1
        .split_once(end)
        .expect(end)
        .0
}

fn preceding_gate<'a>(source: &'a str, needle: &str) -> &'a str {
    let before = source.split_once(needle).expect(needle).0;
    let start = before.rfind("#[cfg(").expect("platform gate");
    before[start..].lines().next().unwrap()
}

#[test]
fn windows_install_and_cancel_share_the_guarded_runtime() {
    assert_eq!(preceding_gate(SETUP, "mod runtime;"), DESKTOP);
    assert_eq!(preceding_gate(SETUP, "fn install_server("), DESKTOP);
    let install = section(SETUP, "fn install_server(", "/// `cortex init");
    assert!(install.contains("runtime::InstallGuard::begin()?"));
    assert!(install.contains("runtime::ensure_server("));
    assert!(install.contains("owner.token()"));
    let cancel = section(SETUP, "pub fn setup_cancel_install()", "fn install_server(");
    assert!(cancel.contains(DESKTOP));
    assert!(cancel.contains("runtime::cancel_install()"));
    let legacy = preceding_gate(install, "fn install_server(");
    assert!(legacy.contains("not(any(") && legacy.contains("target_os = \"windows\""));
}

#[test]
fn windows_commands_lookup_and_repair_use_saved_selection() {
    for needle in [
        "pub(super) fn selected_runtime()",
        "return super::runtime::redact_line(line);",
    ] {
        assert_eq!(preceding_gate(PROCESS, needle), DESKTOP);
    }
    for (start, end) in [
        ("fn effective_path()", "pub(super) fn inherited_path()"),
        ("fn setup_command(", "/// Each pipe"),
        ("fn resolve_cli_bin(", "fn resolve_legacy_cli_bin("),
    ] {
        assert!(section(PROCESS, start, end).contains(DESKTOP), "{start}");
    }
    let repair = section(
        SETUP,
        "pub fn local_runtime_needs_repair()",
        "/// Bring the local daemon",
    );
    assert!(repair.contains(DESKTOP));
    assert!(repair.contains("process::selected_runtime().is_err()"));
}

#[test]
fn windows_saved_tools_require_bound_npm_and_git_before_normal_launch() {
    let load = section(
        PROCESS,
        "pub(super) fn selected_runtime()",
        "fn redact_log_line(",
    );
    assert!(load.contains("Selection::load(&home)?"));
    assert!(load.contains("#[cfg(target_os = \"windows\")]"));
    assert!(load.contains("selected.validate_windows_npm()?"));
    assert!(load.contains("selected.git.is_none()"));
    assert!(load.contains("RUNTIME_MISSING:"));
    let path = section(
        PROCESS,
        "fn effective_path()",
        "pub(super) fn inherited_path()",
    );
    assert!(path.contains("Some(inherited_path().to_string_lossy().into_owned())"));
}

#[test]
fn probing_a_missing_saved_tool_does_not_block_the_install_repair_step() {
    let probe = section(SETUP, "fn probe_machine()", "/// Result of the install");
    assert!(
        !probe.contains("selected_runtime()?"),
        "probe must allow ensure_server to repair"
    );
    assert!(
        probe.contains("p.join(\"config\").is_dir()"),
        "runtime-only home is not initialized"
    );
}

#[test]
fn restart_is_explicit_and_service_registration_stays_posix_only() {
    let start = section(SETUP, "pub async fn setup_start_daemon(", "#[cfg(test)]");
    assert!(start.contains("restart.unwrap_or(false)"));
    assert_eq!(preceding_gate(SETUP, "mod service;"), POSIX);
    assert_eq!(preceding_gate(SETUP, "fn enable_autostart(app:"), POSIX);
    let answers = section(SETUP, "pub fn answers_json(", "/// The Cortex home");
    assert!(
        answers.contains("target_os = \"windows\""),
        "Windows init must not install a service"
    );
}

#[test]
fn optional_claude_uses_selected_private_prefix_on_windows() {
    let args = section(CLAUDE, "fn install_args()", "#[tauri::command]");
    assert!(args.contains(DESKTOP));
    assert!(args.contains("super::process::selected_runtime()?"));
    assert!(args.contains("selected.prefix.into_os_string()"));
    assert!(CLAUDE.contains("run_streaming(app, INSTALL_RUN, npm_bin(), &args)"));
}

#[test]
fn shared_commands_delegate_without_reimplementing_environment_or_owning_daemon() {
    let command = section(PROCESS, "fn setup_command(", "/// Each pipe");
    assert!(command.contains("selected.command(OsStr::new(program))"));
    assert!(command.contains("selected.apply(&mut command, &home, &inherited_path())?"));
    assert!(
        !command.contains("env_remove"),
        "normal shell startup is not sanitized"
    );
    assert!(!PROCESS.contains("run_install("));
    assert!(!PROCESS.contains("runtime_process"));
    let run = section(
        PROCESS,
        "pub(super) fn run_streaming(",
        "/// Missing/failing probes",
    );
    assert!(run.contains(".spawn()"));
    assert!(run.contains(".wait()"));
    assert!(!run.contains("kill"));
    let daemon = section(SETUP, "pub fn start_local_daemon(", "// ─── Tauri commands");
    assert!(daemon.contains("!restart && endpoint_answers(url, token)"));
    assert!(daemon.contains("if restart {"));
}

#[test]
fn legacy_windows_discovery_keeps_cmd_exe_order_and_rejects_other_shims() {
    let lookup = section(PROCESS, "fn first_cli_path(", "fn npm_cli_path(");
    assert!(lookup.contains(".find(|path| !windows || is_windows_cli_entry(path))"));
    assert!(lookup.contains("path.to_ascii_lowercase()"));
    assert!(lookup.contains("path.ends_with(\".cmd\") || path.ends_with(\".exe\")"));
    assert!(!lookup.contains(".sort"));
}

#[test]
fn final_install_probe_keeps_the_install_token() {
    let install = section(SETUP, "fn install_server(", "/// `cortex init");
    let managed = install.split("#[cfg(not(any(").next().unwrap();
    assert!(managed.contains("runtime::install_server_version("));
    assert!(!managed.contains("probe_server_version(&cortex_bin)"));
}

#[test]
fn desktop_readonly_probes_use_bounded_runtime_output() {
    let probe = section(PROCESS, "pub(super) fn probe_output(", "pub(super) fn probe_server_version");
    assert!(probe.contains("super::runtime::output("));
    let runtime = include_str!("../../../src/setup/runtime.rs");
    let output = section(runtime, "pub fn output(", "pub fn selected_output(");
    assert!(output.contains("probe::output("));
    assert!(!output.contains(".output()"));
}
