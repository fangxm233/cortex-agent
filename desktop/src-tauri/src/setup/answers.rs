use serde::Deserialize;

/// The new server's telemetry setting. The shell adds its install id before init sees it.
#[derive(Debug, Clone, Deserialize)]
pub struct SetupTelemetry {
    pub enabled: bool,
}

/// Choices for a new local App installation; existing connections bypass init.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAnswers {
    pub lang: String,
    pub machine_name: String,
    pub backends: Vec<String>,
    pub install_service: bool,
    pub port: u16,
    #[serde(default)]
    pub telemetry: Option<SetupTelemetry>,
}

/// The machine-driven init document for the native host platform.
pub fn answers_document(answers: &SetupAnswers) -> serde_json::Value {
    answers_for_platform(answers, std::env::consts::OS)
}

/// The same document, serialized.
#[cfg(test)]
pub fn answers_json(answers: &SetupAnswers) -> String {
    answers_document(answers).to_string()
}

fn answers_for_platform(answers: &SetupAnswers, platform: &str) -> serde_json::Value {
    let mut doc = serde_json::json!({
        "lang": answers.lang,
        "machineName": answers.machine_name,
        "backends": answers.backends,
        "platforms": [],
        "installService": answers.install_service && !matches!(platform, "macos" | "linux" | "windows"),
        "localUi": { "enabled": true, "port": answers.port },
        "localClient": { "enabled": true },
    });
    if platform == "windows" {
        doc["clientListenHost"] = serde_json::json!("127.0.0.1");
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choices() -> SetupAnswers {
        SetupAnswers {
            lang: "en".into(),
            machine_name: "workbench".into(),
            backends: vec!["pi".into()],
            install_service: true,
            port: 3004,
            telemetry: None,
        }
    }

    #[test]
    fn only_new_windows_local_app_answers_request_loopback_client_listening() {
        let windows = answers_for_platform(&choices(), "windows");
        assert_eq!(windows["clientListenHost"], "127.0.0.1");
        println!("WINDOWS_INIT_ANSWERS={windows}");
        for platform in ["linux", "macos", "android"] {
            let doc = answers_for_platform(&choices(), platform);
            assert!(doc.get("clientListenHost").is_none(), "{platform}");
        }
    }

    #[test]
    fn native_answers_keep_the_existing_setup_contract() {
        let doc: serde_json::Value = serde_json::from_str(&answers_json(&choices())).unwrap();
        assert_eq!(doc, answers_for_platform(&choices(), std::env::consts::OS));
        for platform in ["windows", "linux", "macos"] {
            let doc = answers_for_platform(&choices(), platform);
            assert_eq!(doc["installService"], false);
            assert_eq!(
                doc["localUi"],
                serde_json::json!({ "enabled": true, "port": 3004 })
            );
            assert_eq!(doc["localClient"], serde_json::json!({ "enabled": true }));
            assert_eq!(doc["platforms"], serde_json::json!([]));
            assert_eq!(doc["machineName"], "workbench");
            assert_eq!(doc["backends"], serde_json::json!(["pi"]));
        }
    }
}
