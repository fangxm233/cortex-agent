use super::*;

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cortex-funnel-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn fixture_host() -> Host {
    Host { version: "2026.10.24".into(), channel: "release", os: "linux", os_release: "6".into(), arch: "x64" }
}

const FIXTURE_ID: &str = "0f8b5c1e-3a7d-4e2b-9c41-6d2a8e5f7b90";
const FIXTURE_AT: &str = "2026-10-24T12:00:00.000Z";

/// Shared with web/src/lib/native-telemetry.contract.test.ts, which validates it against the
/// zod schema the ingest Worker uses. Regenerate by printing `fixture()` when the shape changes.
const FIXTURE: &str = include_str!("telemetry_fixture.json");

fn fixture() -> serde_json::Value {
    let failed = FunnelEvent { step: Step::InitFailed.name(), detail: Some("permission"), lang: Some("zh"), at: FIXTURE_AT };
    let started = FunnelEvent { step: Step::SetupStarted.name(), detail: None, lang: None, at: FIXTURE_AT };
    let crash = crate::telemetry::NativeCrash {
        at: FIXTURE_AT.into(),
        message: "boom at src/lib.rs:1:1".into(),
        stack: "0: frame".into(),
        app_version: "2026.10.24".into(),
    };
    serde_json::json!({
        "batches": [
            batch_json(&fixture_host(), FIXTURE_ID, &failed),
            batch_json(&fixture_host(), FIXTURE_ID, &started),
        ],
        "nativeCrash": crash,
    })
}

#[test]
fn the_batch_matches_the_schema_fixture() {
    let expected: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let actual = fixture();
    assert_eq!(actual, expected, "regenerate telemetry_fixture.json:\n{}", serde_json::to_string_pretty(&actual).unwrap());
}

fn claim(dir: &Path, step: Step) -> Option<PendingStep> {
    claim_step(dir, step, None, FIXTURE_AT)
}

#[test]
fn each_step_is_claimed_once_per_install() {
    let dir = tmp("once");
    assert!(claim(&dir, Step::SetupStarted).is_some());
    assert!(claim(&dir, Step::SetupStarted).is_none(), "queued, not yet answered");
    mark_sent(&dir, "setup_started");
    assert!(claim(&dir, Step::SetupStarted).is_none(), "sent");
    assert!(claim(&dir, Step::ServerInstalled).is_some());
    let state = load_state(&dir);
    assert_eq!(state.sent, ["setup_started"]);
    assert_eq!(state.pending.iter().map(|p| p.step.as_str()).collect::<Vec<_>>(), ["server_installed"]);
}

#[test]
fn a_step_stays_queued_with_its_detail_and_time_until_the_collector_answers() {
    let dir = tmp("queue");
    let entry = claim_step(&dir, Step::InitCompleted, Some("existing"), "2026-10-28T01:02:03.000Z").unwrap();
    assert_eq!(load_state(&dir).pending, [entry.clone()]);
    assert_eq!((entry.detail.as_deref(), entry.at.as_str()), (Some("existing"), "2026-10-28T01:02:03.000Z"));
    mark_sent(&dir, "init_completed");
    let state = load_state(&dir);
    assert!(state.pending.is_empty());
    assert_eq!(state.sent, ["init_completed"]);
}

#[test]
fn only_a_server_error_or_no_answer_is_sent_again() {
    for status in [200, 204, 400, 413, 429] {
        assert!(answered(status), "{status}");
    }
    for status in [0, 302, 500, 503] {
        assert!(!answered(status), "{status}");
    }
}

#[test]
fn the_setup_language_is_kept_beside_the_queue() {
    let dir = tmp("lang");
    claim(&dir, Step::SetupStarted).unwrap();
    set_lang(&dir, "zh".into());
    let state = load_state(&dir);
    assert_eq!(state.lang.as_deref(), Some("zh"));
    assert_eq!(state.pending.len(), 1, "the language keeps the queue");
}

#[test]
fn a_state_file_from_the_old_setup_checkbox_still_loads() {
    let dir = tmp("legacy");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(STATE_FILE), r#"{"consent":false,"lang":"en","sent":["setup_started"]}"#).unwrap();
    claim(&dir, Step::InitCompleted).expect("the old opt-out no longer silences steps");
    let state = load_state(&dir);
    assert_eq!(state.sent, ["setup_started"]);
    assert_eq!(state.pending[0].step, "init_completed");
}

const HOME_ID: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

fn home_id(home: &Path) -> Option<String> {
    crate::telemetry::read_install_id(&home.join(HOME_INSTALL_ID))
}

#[test]
fn the_shell_takes_the_id_of_a_home_that_has_one() {
    let (dir, home) = (tmp("align-shell"), tmp("align-home"));
    let shell = crate::telemetry::install_id(&dir);
    crate::telemetry::write_install_id(&home.join(HOME_INSTALL_ID), HOME_ID);
    align_install_id(&dir, &home, true);
    assert_ne!(shell, HOME_ID);
    assert_eq!(crate::telemetry::install_id(&dir), HOME_ID);
}

#[test]
fn an_initialized_home_without_an_id_takes_the_shells() {
    let (dir, home) = (tmp("give-shell"), tmp("give-home"));
    align_install_id(&dir, &home, true);
    assert_eq!(home_id(&home), Some(crate::telemetry::install_id(&dir)));
}

#[test]
fn a_home_init_has_yet_to_create_is_left_to_init() {
    let (dir, home) = (tmp("new-shell"), tmp("new-home"));
    align_install_id(&dir, &home, false);
    assert_eq!(home_id(&home), None);
    assert!(!home.exists());
}

#[test]
fn failures_are_reduced_to_their_class() {
    assert_eq!(failure_class("EACCES"), "permission");
    assert_eq!(failure_class("SETUP_CANCELLED"), "cancelled");
    assert_eq!(failure_class("DAEMON_TIMEOUT"), "timeout");
    assert_eq!(failure_class("SERVER_INSTALL_FAILED: npm ERR! code ENOTFOUND registry"), "network");
    assert_eq!(failure_class("INIT_FAILED: ENOSPC: no space left on device, write"), "disk");
    assert_eq!(failure_class("INIT_FAILED: /home/alice/.cortex is broken"), "other");
}

#[test]
fn release_strings_keep_only_their_major_number() {
    assert_eq!(major_release("6.8.0-138-generic"), "6");
    assert_eq!(major_release("Microsoft Windows [Version 10.0.22631.4317]"), "10");
    assert_eq!(major_release("24.1.0"), "24");
    assert_eq!(major_release(""), "");
}

#[test]
fn the_ui_language_is_named_by_family() {
    assert_eq!(ui_lang(Some("zh-CN")), "zh");
    assert_eq!(ui_lang(Some("en")), "en");
    assert_eq!(ui_lang(Some("fr")), "other");
    assert_eq!(ui_lang(None), "other");
}

fn opts_out(vars: &[(&str, &str)]) -> bool {
    env_opts_out(|name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string()))
}

#[test]
fn the_environment_silences_setup_steps_as_it_does_the_server() {
    assert!(!opts_out(&[]));
    assert!(opts_out(&[("CORTEX_TELEMETRY", "0")]));
    assert!(opts_out(&[("CORTEX_TELEMETRY", " 0 ")]));
    assert!(!opts_out(&[("CORTEX_TELEMETRY", "1")]));
    assert!(opts_out(&[("DO_NOT_TRACK", "1")]));
    assert!(opts_out(&[("DO_NOT_TRACK", "TRUE")]));
    for off in ["", " ", "0", "false", "No", "OFF"] {
        assert!(!opts_out(&[("DO_NOT_TRACK", off)]), "DO_NOT_TRACK={off:?}");
    }
    // A hard switch wins even when the other variable asks for telemetry.
    assert!(opts_out(&[("CORTEX_TELEMETRY", "1"), ("DO_NOT_TRACK", "1")]));
}
