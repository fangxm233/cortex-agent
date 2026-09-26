// input:  Native AppState and notification bridge module
// output: Filtered notification routing and listener tests
// pos:    Test notification logic without embedding an Android seed
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
use cortex_desktop_lib::{AppState, ConnectionConfig};

// Compile the production module without the unrelated Android seed test cfg.
#[allow(dead_code)]
#[path = "../src/desktop_notifications/mod.rs"]
mod desktop_notifications;
