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
    let failed = FunnelEvent { step: Step::InitFailed, detail: Some("permission"), lang: Some("zh"), at: FIXTURE_AT };
    let started = FunnelEvent { step: Step::SetupStarted, detail: None, lang: None, at: FIXTURE_AT };
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

#[test]
fn each_step_is_claimed_once_per_install() {
    let dir = tmp("once");
    assert!(claim_step(&dir, Step::SetupStarted).is_some());
    assert!(claim_step(&dir, Step::SetupStarted).is_none());
    assert!(claim_step(&dir, Step::ServerInstalled).is_some());
    assert_eq!(load_state(&dir).sent, ["setup_started", "server_installed"]);
}

#[test]
fn turning_the_opt_in_off_stops_every_later_step() {
    let dir = tmp("consent");
    assert!(load_state(&dir).consent, "steps before the opt-in is shown are sent");
    set_consent(&dir, false, Some("en".into()));
    assert!(claim_step(&dir, Step::InitCompleted).is_none());
    set_consent(&dir, true, None);
    let state = claim_step(&dir, Step::InitCompleted).unwrap();
    assert_eq!(state.lang.as_deref(), Some("en"), "a consent without a language keeps the known one");
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
