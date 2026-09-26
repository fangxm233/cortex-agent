// input:  Notification queue and connection snapshots
// output: Scoped routing, acknowledgement and privacy tests
// pos:    Native notification queue regression tests
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
use super::*;

fn config(server: &str, token: &str) -> ConnectionConfig {
    ConnectionConfig {
        server_url: Some(server.into()),
        token: Some(token.into()),
        ..Default::default()
    }
}

fn post(queue: &mut Queue, config: &ConnectionConfig) -> String {
    queue
        .post(
            config,
            RoutingData {
                session_id: Some("session".into()),
                project_id: Some("project".into()),
            },
        )
        .unwrap()
}

#[test]
fn default_action_mapping_excludes_dismissal_and_other_actions() {
    assert!(is_default_action(None)); // Windows body click has no arguments.
    assert!(is_default_action(Some("")));
    assert!(is_default_action(Some("default")));
    assert!(!is_default_action(Some("__closed")));
    assert!(!is_default_action(Some("other")));
}

#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn typed_response_accepts_body_and_default_button_only() {
    use notify_rust::{CloseReason, NotificationResponse};
    assert!(is_default_response(&NotificationResponse::Default));
    assert!(is_default_response(&NotificationResponse::Action(
        "default".into()
    )));
    assert!(!is_default_response(&NotificationResponse::Closed(
        CloseReason::Dismissed
    )));
    assert!(!is_default_response(&NotificationResponse::Action(
        "other".into()
    )));
    assert!(!is_default_response(&NotificationResponse::Reply(
        "default".into()
    )));
}

#[test]
fn pending_survives_reload_until_individual_idempotent_ack() {
    let mut queue = Queue::default();
    let config = config("server", "secret");
    let first = post(&mut queue, &config);
    let second = post(&mut queue, &config);
    assert_ne!(first, second);
    assert!(queue.activate(&first, &config));
    assert!(!queue.activate(&first, &config));
    assert!(queue.activate(&second, &config));
    assert_eq!(queue.pending(&config).actions.len(), 2);
    assert_eq!(queue.pending(&config).actions.len(), 2);
    queue.ack(&first);
    queue.ack(&first);
    queue.ack("unknown");
    assert_eq!(queue.pending(&config).actions[0].action_id, second);
}

#[test]
fn activation_rejects_server_token_changes_and_disconnect() {
    for changed in [
        config("other", "secret"),
        config("server", "changed"),
        ConnectionConfig::default(),
    ] {
        let mut queue = Queue::default();
        let original = config("server", "secret");
        let id = post(&mut queue, &original);
        assert!(!queue.activate(&id, &changed));
        assert!(queue.pending(&original).actions.is_empty());
        assert!(!queue.activate(&id, &original));
    }
}

#[test]
fn pending_filters_changed_credentials_permanently() {
    for changed in [
        config("other", "secret"),
        config("server", "changed"),
        ConnectionConfig::default(),
    ] {
        let mut queue = Queue::default();
        let original = config("server", "secret");
        let id = post(&mut queue, &original);
        assert!(queue.activate(&id, &original));
        assert!(queue.pending(&changed).actions.is_empty());
        assert!(queue.pending(&original).actions.is_empty());
    }
}

#[test]
fn payload_contains_routing_but_never_credentials() {
    let mut queue = Queue::default();
    let config = config("server", "secret");
    let id = post(&mut queue, &config);
    assert!(queue.activate(&id, &config));
    let payload = serde_json::to_value(queue.pending(&config)).unwrap();
    assert_eq!(
        payload["actions"][0],
        serde_json::json!({
            "actionId": id, "serverUrl": "server", "sessionId": "session", "projectId": "project"
        })
    );
    assert!(!payload.to_string().contains("secret"));
}

#[test]
fn system_notice_without_session_is_focus_only() {
    let mut queue = Queue::default();
    let config = config("server", "secret");
    let id = queue.post(&config, RoutingData::default()).unwrap();
    assert!(queue.activate(&id, &config));
    let payload = serde_json::to_value(queue.pending(&config)).unwrap();
    assert_eq!(
        payload["actions"][0],
        serde_json::json!({"actionId": id, "serverUrl": "server"})
    );
}

#[test]
fn queues_are_bounded_and_failed_posts_cannot_activate() {
    let mut queue = Queue::default();
    let config = config("server", "secret");
    let oldest = post(&mut queue, &config);
    for _ in 0..CAPACITY {
        post(&mut queue, &config);
    }
    assert!(!queue.activate(&oldest, &config));
    for _ in 0..CAPACITY + 1 {
        let id = post(&mut queue, &config);
        assert!(queue.activate(&id, &config));
    }
    assert_eq!(queue.pending(&config).actions.len(), CAPACITY);
    let failed = post(&mut queue, &config);
    queue.forget(&failed);
    assert!(!queue.activate(&failed, &config));
    assert!(queue
        .post(&ConnectionConfig::default(), RoutingData::default())
        .is_err());
}
