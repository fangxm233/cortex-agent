mod platform;
mod queue;

use crate::AppState;
use queue::{Pending, Queue, RoutingData};
use std::sync::Mutex;
use tauri::State;
#[cfg(not(target_os = "android"))]
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct NotificationState {
    queue: Mutex<Queue>,
    #[cfg(target_os = "linux")]
    listeners: Mutex<platform::Listeners>,
}

#[tauri::command]
pub async fn desktop_notifications_post(
    app: tauri::AppHandle,
    title: String,
    body: String,
    data: Option<RoutingData>,
    action: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, title, body, data, action);
        Err("Desktop notifications are unavailable on Android".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let id = reserve(&app, data.unwrap_or_default())?;
        let action = action_label(action);
        let result = platform::post(app.clone(), title, body, action, id.clone()).await;
        if result.is_err() {
            forget(&app, &id);
        }
        result
    }
}

/// The SPA sends the action label in its own language with the title and body; older SPAs do not.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn action_label(action: Option<String>) -> String {
    action
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "Open Cortex".to_string())
}

#[tauri::command]
pub fn desktop_notifications_pending(
    state: State<AppState>,
    notifications: State<NotificationState>,
) -> Pending {
    let config = state.config.lock().unwrap();
    notifications.queue.lock().unwrap().pending(&config)
}

#[tauri::command]
pub fn desktop_notifications_ack(notifications: State<NotificationState>, action_id: String) {
    notifications.queue.lock().unwrap().ack(&action_id);
}

#[cfg(not(target_os = "android"))]
fn reserve(app: &tauri::AppHandle, data: RoutingData) -> Result<String, String> {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap();
    app.state::<NotificationState>()
        .queue
        .lock()
        .unwrap()
        .post(&config, data)
}

#[cfg(not(target_os = "android"))]
fn forget(app: &tauri::AppHandle, id: &str) {
    app.state::<NotificationState>()
        .queue
        .lock()
        .unwrap()
        .forget(id);
}

#[cfg(not(target_os = "android"))]
fn activate(app: &tauri::AppHandle, id: String) {
    let handle = app.clone();
    // Both the credential check and window operations run on the UI thread. No
    // routing payload (especially no token) goes through the OS or this event.
    let _ = app.run_on_main_thread(move || activate_on_main(&handle, &id));
}

#[cfg(not(target_os = "android"))]
fn activate_on_main(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap();
    let notifications = app.state::<NotificationState>();
    if !notifications.queue.lock().unwrap().activate(id, &config) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    // Failed emission or a frontend reload leaves the action available to drain.
    let _ = app.emit("desktop-notification-action", ());
}
