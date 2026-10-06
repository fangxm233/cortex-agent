use crate::connection::ConnectionConfig;
use crate::frontend::SCHEME;

// ─── Initialization script ─────────────────────────────────────────────────
// Injected into EVERY page load (connect.html and index.html). A per-platform
// PREFIX (see `init_script()`) sets the shell-detection flag first:
//   desktop → window.__CORTEX_DESKTOP__ = true   (desktop three-pane workbench)
//   Android → window.__CORTEX_MOBILE__  = true   (mobile bottom-Tab shell)
// then this shared body runs:
//
// 1. Async-fetches credentials from AppState via IPC and writes to
//    window.__CORTEX_DESKTOP_CONFIG (read by providers.tsx to switch the tRPC
//    client to absolute-URL + token-bearer mode). The IPC round-trip is
//    ~microseconds; the React bundle takes tens of milliseconds to download +
//    parse, so the global is set before providers.tsx reads it. Shared by both
//    platforms — the mobile shell reaches the same remote server the same way.
//
// Disconnect is no longer a shell-injected button — the SPA's daemon interface
// owns a discoverable Disconnect action (web/src/lib/shell-connection.ts) that
// invokes the `disconnect` command + navigates to connect.html.

/// Per-platform flag prefix prepended to `INIT_SCRIPT`.
#[cfg(target_os = "android")]
const SHELL_FLAG: &str = "window.__CORTEX_MOBILE__ = true;\n";
#[cfg(not(target_os = "android"))]
const SHELL_FLAG: &str = "window.__CORTEX_DESKTOP__ = true;\n";

/// Which OS the SPA is running on. The desktop bar needs it for three decisions the SPA cannot make
/// on its own: reserve the macOS traffic-light strip, draw caption buttons at the right edge, and
/// render ⌘ rather than Ctrl in accelerators.
#[cfg(target_os = "macos")]
const PLATFORM_FLAG: &str = "macos";
#[cfg(target_os = "windows")]
const PLATFORM_FLAG: &str = "windows";
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
const PLATFORM_FLAG: &str = "linux";
#[cfg(target_os = "android")]
const PLATFORM_FLAG: &str = "android";

/// The full initialization script: platform flag + **synchronously baked** credentials + shared body.
///
/// The credentials known at window-build time (loaded from the credential store) are serialized
/// straight into the injected script as the initial `window.__CORTEX_DESKTOP_CONFIG` value, so the
/// SPA sees them synchronously — BEFORE any bundle code runs — with no dependency on the async IPC.
/// This closes a race that surfaced on Android: on the second launch the WebView serves a
/// code-cached bundle that mounts React faster than the `get_connection_config` IPC round-trip could
/// resolve, so `providers.tsx` (which reads the config exactly once at mount) captured the stale
/// `{serverUrl:null}` and built a broken tRPC client — the mobile shell rendered (bottom Tab bar)
/// but every data screen failed, leaving "only the bottom bar". Baking removes the race entirely.
///
/// The async IPC in `INIT_SCRIPT` is kept as a REFRESH path: on the first-run connect flow the
/// window was built with empty creds (baked null), then the user saves creds on connect.html and
/// navigates to index.html within the same session — the re-injected script's baked value is still
/// null there, so the async `get_connection_config` fills in the freshly-saved creds.
pub fn init_script(config: &ConnectionConfig, title_bar: &str) -> String {
    // Serialize via serde so serverUrl/token are correctly JSON-escaped (quotes, backslashes, etc.),
    // never string-interpolated raw. A serialize failure falls back to async-IPC-only behaviour.
    let baked = serde_json::to_string(config)
        .unwrap_or_else(|_| r#"{"serverUrl":null,"token":null}"#.to_string());
    format!(r#"
(function () {{
  if (window !== window.top) return;
  // macOS/Linux: cortexui://localhost; Windows/Android: http://cortexui.localhost.
  var shellOrigin = location.port === '' && (
    (location.protocol === '{SCHEME}:' && location.hostname === 'localhost') ||
    (location.protocol === 'http:' && location.hostname === '{SCHEME}.localhost')
  );
  if (!shellOrigin) return;
  {SHELL_FLAG}window.__CORTEX_PLATFORM__ = "{PLATFORM_FLAG}";
  window.__CORTEX_TITLEBAR__ = "{title_bar}";
  window.__CORTEX_DESKTOP_CONFIG = {baked};
  {INIT_SCRIPT}
}}());
"#)
}

pub const TITLE_BRIDGE_SCRIPT: &str = r#"
(function () {
  if (window === window.top || window.parent !== window.top) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  var lastTitle;
  var observedHead;
  var headObserver;
  function report(phase, force) {
    var title = document.title || '';
    if (!force && title === lastTitle) return;
    lastTitle = title;
    window.parent.postMessage({
      type: '__cortexBrowserTitle:v1',
      title: title,
      href: location.href,
      timeOrigin: performance.timeOrigin,
      phase: phase
    }, '*');
  }
  function bindHead() {
    if (document.head === observedHead) return false;
    if (headObserver) headObserver.disconnect();
    observedHead = document.head;
    if (!observedHead) return false;
    headObserver = new MutationObserver(function () { report('update', false); });
    headObserver.observe(observedHead, { childList: true, subtree: true, characterData: true });
    return true;
  }
  function start() {
    bindHead();
    report('load', true);
    if (!document.documentElement) return;
    new MutationObserver(function () {
      if (bindHead()) report('update', false);
    }).observe(document.documentElement, { childList: true });
  }
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) report('restore', true);
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
"#;

const INIT_SCRIPT: &str = r#"
// Refresh path: re-read the current credentials via IPC and overwrite the baked value. Normally a
// no-op (baked value is already correct); it matters on the first-run connect flow, where the window
// was built before the user saved creds, so the baked value is null and this async call fills it in.
// The baked value already covers the common (subsequent-launch) case synchronously, so this no longer
// races the bundle — a stale read just keeps the correct baked creds.
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;
  tauri.core.invoke('get_connection_config').then(function (cfg) {
    if (cfg && cfg.serverUrl) {
      window.__CORTEX_DESKTOP_CONFIG = { serverUrl: cfg.serverUrl, token: cfg.token };
    }
  }).catch(function () {});
}());
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::ConnectionMode;

    #[test]
    fn the_injected_config_tells_the_page_which_mode_it_is_in() {
        let script = init_script(&ConnectionConfig {
            server_url: Some("http://127.0.0.1:3004".into()),
            token: Some("t".into()),
            mode: ConnectionMode::Local,
            cortex_bin: None,
        }, "native");
        assert!(script.contains("\"mode\":\"local\""));
    }

    #[test]
    fn credential_script_guards_secrets_before_any_assignment_or_ipc() {
        let script = init_script(&ConnectionConfig {
            server_url: Some("https://cortex.example.com".into()),
            token: Some("secret-token".into()),
            ..ConnectionConfig::default()
        }, "native");
        let guard = script.find("window !== window.top").expect("top-frame guard");
        let config = script.find("__CORTEX_DESKTOP_CONFIG").expect("baked config");
        let invoke = script.find("get_connection_config").expect("refresh invoke");
        assert!(guard < config && guard < invoke);
        assert!(script.contains("location.protocol === 'cortexui:'"));
        assert!(script.contains("location.hostname === 'localhost'"));
        assert!(script.contains("location.hostname === 'cortexui.localhost'"));
        assert!(script.contains("location.port === ''"));
    }

    #[test]
    fn title_bridge_contains_no_shell_credentials_or_ipc() {
        assert!(TITLE_BRIDGE_SCRIPT.contains("document.title"));
        assert!(TITLE_BRIDGE_SCRIPT.contains("postMessage"));
        assert!(TITLE_BRIDGE_SCRIPT.contains("performance.timeOrigin"));
        assert!(TITLE_BRIDGE_SCRIPT.contains("event.persisted"));
        assert!(TITLE_BRIDGE_SCRIPT.contains("'restore'"));
        assert!(TITLE_BRIDGE_SCRIPT.contains("__cortexBrowserTitle"));
        assert!(!TITLE_BRIDGE_SCRIPT.contains("secret-token"));
        assert!(!TITLE_BRIDGE_SCRIPT.contains("__CORTEX_DESKTOP_CONFIG"));
        assert!(!TITLE_BRIDGE_SCRIPT.contains("get_connection_config"));
    }
}
