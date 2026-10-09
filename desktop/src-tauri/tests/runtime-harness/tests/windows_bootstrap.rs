//! Compile the exact shared Windows runtime without Tauri or any package execution.
#![cfg(windows)]
#[path = "../../../src/setup/runtime.rs"]
#[allow(dead_code)]
mod runtime;
static CANCEL_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());
