use cortex_desktop_lib::{AppState, ConnectionConfig};

// Compile the production module without the unrelated Android seed test cfg.
#[allow(dead_code)]
#[path = "../src/desktop_notifications/mod.rs"]
mod desktop_notifications;
