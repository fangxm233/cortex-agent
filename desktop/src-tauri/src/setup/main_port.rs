//! The local server's main port, resolved the way the server resolves it, and the record the server
//! leaves when it could not bind that port (app.js exit 78, `data/app-stopped.json`).

use serde::Deserialize;
use std::path::Path;
use std::time::{Duration, SystemTime};

/// The server's default main port; its own free-port pick starts here too.
pub const DEFAULT_MAIN_PORT: u16 = 26789;
/// Last port a suggestion tries: 26789-26999 is unassigned and below every ephemeral range.
const MAIN_PORT_SEARCH_END: u16 = 26999;
const MAIN_PORT_ENV: &str = "CORTEX_UI_PORT";
/// app.js exit code for a main port it could not bind.
const EXIT_PORT_UNAVAILABLE: i32 = 78;
/// Coarse filesystem clocks (1-2 s) must not hide a record written just after a start was issued.
const MTIME_SLACK: Duration = Duration::from_secs(2);

/// The port this home's server binds: `CORTEX_UI_PORT` from the environment (a daemon this app
/// starts inherits it), then from the home's `config/.env`, else the default.
pub fn resolve_main_port(home: &Path) -> u16 {
    let from_env = std::env::var(MAIN_PORT_ENV).ok().and_then(|v| parse_port(&v));
    from_env
        .or_else(|| env_file_value(&home.join("config").join(".env"), MAIN_PORT_ENV).and_then(|v| parse_port(&v)))
        .unwrap_or(DEFAULT_MAIN_PORT)
}

/// A TCP port in 1..=65535 written as plain digits, as the server accepts it.
fn parse_port(value: &str) -> Option<u16> {
    let text = value.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|port| *port >= 1)
}

/// One key of a dotenv file; the last assignment wins, as in the server's parser.
fn env_file_value(file: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (name, value) = line.split_once('=')?;
            (name.trim() == key).then(|| unquote(value))
        })
        .last()
}

fn unquote(raw: &str) -> String {
    let value = raw.trim();
    for quote in ['"', '\'', '`'] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.split(" #").next().unwrap_or_default().trim().to_string()
}

#[derive(Deserialize)]
struct AppStopRecord {
    code: i32,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    message: Option<String>,
}

/// The server's last start ended because its main port could not be bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortConflict {
    pub port: Option<u16>,
    pub message: String,
}

/// The port-conflict record of this home, when there is one written at or after `since`. The daemon
/// removes the record whenever it starts app.js, so without `since` it describes the latest start.
pub fn port_conflict(home: &Path, since: Option<SystemTime>) -> Option<PortConflict> {
    let file = home.join("data").join("app-stopped.json");
    if let Some(since) = since {
        let modified = std::fs::metadata(&file).ok()?.modified().ok()?;
        if modified + MTIME_SLACK < since {
            return None;
        }
    }
    let record: AppStopRecord = serde_json::from_str(&std::fs::read_to_string(&file).ok()?).ok()?;
    (record.code == EXIT_PORT_UNAVAILABLE).then(|| PortConflict {
        port: record.port,
        message: record.message.unwrap_or_default(),
    })
}

/// The first port from the default up that can be bound on loopback right now, other than `taken`.
pub fn suggest_free_port(taken: Option<u16>) -> Option<u16> {
    (DEFAULT_MAIN_PORT..=MAIN_PORT_SEARCH_END)
        .filter(|port| Some(*port) != taken)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

/// The wizard error for a port conflict: `PORT_IN_USE: <free port to offer>`.
pub fn port_in_use_error(conflict: &PortConflict) -> String {
    match suggest_free_port(conflict.port) {
        Some(port) => format!("PORT_IN_USE: {port}"),
        None => "PORT_IN_USE".to_string(),
    }
}

/// `url` with its port replaced, when it is a loopback URL on another port; None otherwise.
pub fn loopback_url_on_port(url: &str, port: u16) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !loopback || parsed.port_or_known_default() == Some(port) {
        return None;
    }
    parsed.set_port(Some(port)).ok()?;
    Some(parsed.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(env: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        if let Some(text) = env {
            std::fs::write(dir.path().join("config").join(".env"), text).unwrap();
        }
        dir
    }

    #[test]
    fn the_env_file_port_wins_over_the_default_and_bad_values_fall_back() {
        // CORTEX_UI_PORT is not set in the test process; the file decides.
        if std::env::var(MAIN_PORT_ENV).is_ok() {
            return;
        }
        assert_eq!(resolve_main_port(home(None).path()), DEFAULT_MAIN_PORT);
        assert_eq!(resolve_main_port(home(Some("CORTEX_UI_PORT=3004\n")).path()), 3004);
        assert_eq!(resolve_main_port(home(Some("A=1\nexport CORTEX_UI_PORT=\"26790\"\n")).path()), 26790);
        assert_eq!(resolve_main_port(home(Some("CORTEX_UI_PORT=3004\nCORTEX_UI_PORT=3010\n")).path()), 3010);
        for bad in ["CORTEX_UI_PORT=0\n", "CORTEX_UI_PORT=70000\n", "CORTEX_UI_PORT=http\n", "CORTEX_UI_PORT=\n"] {
            assert_eq!(resolve_main_port(home(Some(bad)).path()), DEFAULT_MAIN_PORT, "{bad}");
        }
    }

    #[test]
    fn a_port_conflict_is_read_from_the_stop_record() {
        let dir = home(None);
        assert_eq!(port_conflict(dir.path(), None), None);
        let record = dir.path().join("data").join("app-stopped.json");
        std::fs::write(&record, r#"{"code":78,"reason":"port-in-use","port":26789,"message":"Port 26789 is already in use"}"#).unwrap();
        let conflict = port_conflict(dir.path(), None).unwrap();
        assert_eq!(conflict.port, Some(26789));
        assert!(conflict.message.contains("already in use"));
        assert!(port_conflict(dir.path(), Some(SystemTime::now())).is_some(), "just written");
        let later = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(port_conflict(dir.path(), Some(later)), None, "older than the start it is checked against");
        std::fs::write(&record, r#"{"code":1}"#).unwrap();
        assert_eq!(port_conflict(dir.path(), None), None);
    }

    #[test]
    fn the_suggestion_skips_the_taken_port_and_ports_in_use() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let held_port = held.local_addr().unwrap().port();
        let suggestion = suggest_free_port(Some(DEFAULT_MAIN_PORT)).unwrap();
        assert_ne!(suggestion, DEFAULT_MAIN_PORT);
        assert_ne!(suggestion, held_port);
        assert!((DEFAULT_MAIN_PORT..=MAIN_PORT_SEARCH_END).contains(&suggestion));
        let error = port_in_use_error(&PortConflict { port: Some(DEFAULT_MAIN_PORT), message: String::new() });
        assert!(error.starts_with("PORT_IN_USE: "), "{error}");
    }

    #[test]
    fn only_a_loopback_url_on_another_port_is_rewritten() {
        assert_eq!(loopback_url_on_port("http://127.0.0.1:3004", 26790).as_deref(), Some("http://127.0.0.1:26790"));
        assert_eq!(loopback_url_on_port("http://localhost:3004/", 3010).as_deref(), Some("http://localhost:3010"));
        assert_eq!(loopback_url_on_port("http://127.0.0.1:26789", 26789), None);
        assert_eq!(loopback_url_on_port("https://cortex.example.com", 26789), None);
        assert_eq!(loopback_url_on_port("not a url", 26789), None);
    }
}
