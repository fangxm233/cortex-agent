use crate::connection::PageConfig;
use crate::frontend::SCHEME;

// ─── Initialization script ─────────────────────────────────────────────────
// Injected into EVERY page load of the shell origin. A per-platform PREFIX (see `init_script()`)
// sets the shell-detection flag first:
//   desktop → window.__CORTEX_DESKTOP__ = true   (desktop three-pane workbench)
//   Android → window.__CORTEX_MOBILE__  = true   (mobile bottom-Tab shell)
// then publishes the connection as window.__CORTEX_DESKTOP_CONFIG = {serverUrl, token} (read by
// providers.tsx to switch the tRPC client to absolute-URL + token-bearer mode) and refreshes it
// over IPC. Disconnect is the SPA's own action (web/src/lib/shell-connection.ts): it invokes the
// `disconnect` command and navigates to connect.html.

/// Query parameter marking the document the window was opened with. Only that document may use
/// the credentials baked into the initialization script: they were read when the window was built,
/// and every later connect/disconnect is followed by a navigation to a document without it.
const LAUNCH_QUERY: &str = "launch";

/// The URL the main window opens on: `file` (index.html or connect.html) marked as the launch
/// document.
pub fn launch_url(file: &str) -> String {
    format!("{SCHEME}://localhost/{file}?{LAUNCH_QUERY}")
}

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
/// straight into the injected script, so the launch document sees them synchronously — BEFORE any
/// bundle code runs — with no dependency on the async IPC. This closes a race that surfaced on
/// Android: on the second launch the WebView serves a code-cached bundle that mounts React faster
/// than the `get_connection_config` IPC round-trip could resolve, and a dead tRPC client left "only
/// the bottom bar".
///
/// The script is fixed for the window's lifetime, so the baked value goes stale once the user
/// connects or disconnects. Later documents therefore start from null and take the async
/// `get_connection_config` refresh, which `providers.tsx` waits for.
pub fn init_script(config: &PageConfig, title_bar: &str) -> String {
    // Serialize via serde so serverUrl/token are correctly JSON-escaped (quotes, backslashes, etc.),
    // never string-interpolated raw. A serialize failure falls back to async-IPC-only behaviour.
    let baked = serde_json::to_string(config).unwrap_or_else(|_| "null".to_string());
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
  var launch = new URLSearchParams(location.search).has('{LAUNCH_QUERY}');
  window.__CORTEX_DESKTOP_CONFIG = launch ? {baked} : null;
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
// Refresh path: re-read the current credentials via IPC. On the launch document this normally
// confirms the baked value; on every later document it is the only source.
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;
  tauri.core.invoke('get_connection_config').then(function (cfg) {
    if (cfg && cfg.serverUrl) window.__CORTEX_DESKTOP_CONFIG = cfg;
  }).catch(function () {});
}());
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionConfig, ConnectionMode};

    fn page_config(url: &str, token: &str) -> PageConfig {
        PageConfig::from(&ConnectionConfig {
            server_url: Some(url.into()),
            token: Some(token.into()),
            mode: ConnectionMode::Local,
            cortex_bin: Some("/home/someone/.npm/bin/cortex".into()),
            provider_setup_pending: false,
        })
    }

    #[test]
    fn the_page_never_sees_the_local_install() {
        let script = init_script(&page_config("http://127.0.0.1:3004", "t"), "native");
        assert!(script.contains(r#"{"serverUrl":"http://127.0.0.1:3004","token":"t","providerSetupPending":false}"#));
        assert!(!script.contains("cortexBin"));
        assert!(!script.contains("/home/someone"));
        assert!(!script.contains("\"mode\""));
    }

    #[test]
    fn only_the_launch_document_uses_the_baked_credentials() {
        let script = init_script(&page_config("https://cortex.example.com", "t"), "native");
        assert!(launch_url("index.html").ends_with("/index.html?launch"));
        assert!(script.contains("has('launch')"));
        assert!(script.contains(r#"launch ? {"serverUrl":"https://cortex.example.com","token":"t","providerSetupPending":false} : null"#));
    }

    #[test]
    fn credential_script_guards_secrets_before_any_assignment_or_ipc() {
        let script = init_script(&page_config("https://cortex.example.com", "secret-token"), "native");
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
