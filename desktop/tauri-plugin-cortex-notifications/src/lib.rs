// input:  Tauri mobile plugin handle and notification arguments
// output: Android notification commands and shell-only configuration
// pos:    Rust entry for the native notification owner
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

use serde_json::{json, Value};
use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

pub struct CortexNotifications<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> CortexNotifications<R> {
    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        #[cfg(target_os = "android")]
        {
            self.handle.run_mobile_plugin(method, args).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (method, args);
            Err("Background notifications require Android".into())
        }
    }
}

#[tauri::command]
async fn post<R: Runtime>(
    app: tauri::AppHandle<R>, title: String, body: String,
    data: Option<std::collections::HashMap<String, String>>,
) -> Result<Value, String> {
    app.state::<CortexNotifications<R>>().call("post", json!({
        "title": title, "body": body, "data": data,
    }))
}

#[tauri::command]
async fn pending_actions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Value, String> {
    app.state::<CortexNotifications<R>>().call("pendingActions", json!({}))
}

#[tauri::command]
async fn ack_action<R: Runtime>(app: tauri::AppHandle<R>, action_id: String) -> Result<Value, String> {
    app.state::<CortexNotifications<R>>().call("ackAction", json!({"actionId": action_id}))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cortex-notifications")
        .invoke_handler(tauri::generate_handler![post, pending_actions, ack_action])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let state = CortexNotifications {
                handle: _api.register_android_plugin("dev.cortex.notifications", "NotificationsPlugin")?,
            };
            #[cfg(not(target_os = "android"))]
            let state = CortexNotifications::<R> { _marker: std::marker::PhantomData };
            app.manage(state);
            Ok(())
        })
        .build()
}
