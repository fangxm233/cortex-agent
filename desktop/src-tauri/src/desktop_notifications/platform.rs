#[cfg(target_os = "linux")]
use super::{queue::CAPACITY, NotificationState};
#[cfg(target_os = "linux")]
use std::collections::VecDeque;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[cfg(all(test, target_os = "linux"))]
#[path = "listener_tests.rs"]
mod listener_tests;

#[cfg(target_os = "linux")]
#[derive(Default)]
pub struct Listeners(VecDeque<tauri::async_runtime::JoinHandle<()>>);

#[cfg(target_os = "linux")]
impl Listeners {
    fn retain(&mut self, listener: tauri::async_runtime::JoinHandle<()>) {
        if self.0.len() == CAPACITY {
            if let Some(oldest) = self.0.pop_front() {
                oldest.abort();
            }
        }
        self.0.push_back(listener);
    }
}

#[cfg(target_os = "linux")]
impl Drop for Listeners {
    fn drop(&mut self) {
        for listener in self.0.drain(..) {
            listener.abort();
        }
    }
}

#[cfg(target_os = "linux")]
pub async fn post(
    app: tauri::AppHandle,
    title: String,
    body: String,
    id: String,
) -> Result<(), String> {
    let handle = notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .appname("Cortex")
        .action("default", "Open Cortex")
        .show_async()
        .await
        .map_err(|error| error.to_string())?;
    listen(&app, handle, id);
    Ok(())
}

// Dropping an aborted future drops its dedicated D-Bus connection. A server
// that never sends NotificationClosed cannot accumulate blocked threads.
#[cfg(target_os = "linux")]
fn listen(app: &tauri::AppHandle, handle: notify_rust::NotificationHandle, id: String) {
    let callback_app = app.clone();
    let listener = tauri::async_runtime::spawn(async move {
        handle
            .wait_for_action_async(|response| {
                respond(&callback_app, id, response);
            })
            .await;
    });
    app.state::<NotificationState>()
        .listeners
        .lock()
        .unwrap()
        .retain(listener);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn respond(app: &tauri::AppHandle, id: String, response: &notify_rust::NotificationResponse) {
    if super::queue::is_default_response(response) {
        super::activate(app, id);
    } else {
        super::forget(app, &id);
    }
}

#[cfg(target_os = "windows")]
pub async fn post(
    app: tauri::AppHandle,
    title: String,
    body: String,
    id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_windows(app, title, body, id))
        .await
        .map_err(|error| error.to_string())?
}

// show() registers the delegate on the native ToastNotification before Show;
// WinRT retains that delegate, not the Rust Toast builder. The crate exposes
// no event-registration handle to retain or unregister. Capture only the
// opaque ID; bounded Rust state owns routing/secrets, even after dismissal.
#[cfg(target_os = "windows")]
fn show_windows(
    app: tauri::AppHandle,
    title: String,
    body: String,
    id: String,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    let app_id = windows_app_id(&app)?;
    Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated(move |argument| {
            if super::queue::is_default_action(argument.as_deref()) {
                super::activate(&app, id.clone());
            }
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn windows_app_id(app: &tauri::AppHandle) -> Result<String, String> {
    // Match the stock plugin: unpackaged cargo binaries have no registered AUMID.
    let exe = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let directory = exe.parent().ok_or("Executable has no parent directory")?;
    if directory.ends_with("target/debug") || directory.ends_with("target/release") {
        return Ok(tauri_winrt_notification::Toast::POWERSHELL_APP_ID.into());
    }
    Ok(app.config().identifier.clone())
}

#[cfg(target_os = "macos")]
pub async fn post(
    app: tauri::AppHandle,
    title: String,
    body: String,
    id: String,
) -> Result<(), String> {
    let permit = mac_worker_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        show_mac(app, title, body, id)
    })
    .await
    .map_err(|error| error.to_string())?
}

// The legacy backend blocks until interaction; show() alone does not send.
// Await the response off the UI thread so real send errors reach the frontend.
#[cfg(target_os = "macos")]
fn show_mac(app: tauri::AppHandle, title: String, body: String, id: String) -> Result<(), String> {
    let identifier = if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        &app.config().identifier
    };
    mac_application_ready(notify_rust::set_application(identifier))?;
    notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .action("default", "Open Cortex")
        .show()
        .map_err(|error| error.to_string())?
        .wait_for_response(|response: &notify_rust::NotificationResponse| {
            respond(&app, id, response)
        })
        .map_err(|error| error.to_string())
}

// The backend sets its application once per process. A previous post or the
// stock notification plugin may already have initialized it; only that typed
// error is benign, while actual initialization failures must reach the caller.
#[cfg(target_os = "macos")]
fn mac_application_ready(result: Result<(), notify_rust::error::MacOsError>) -> Result<(), String> {
    use notify_rust::error::{ApplicationError, MacOsError};
    match result {
        Ok(()) | Err(MacOsError::Application(ApplicationError::AlreadySet(_))) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod mac_application_tests {
    use super::mac_application_ready;
    use notify_rust::error::{ApplicationError, MacOsError, NotificationError};

    #[test]
    fn first_and_repeated_initialization_can_deliver() {
        assert_eq!(mac_application_ready(Ok(())), Ok(()));
        for _ in 0..2 {
            let repeated =
                MacOsError::Application(ApplicationError::AlreadySet("com.apple.Terminal".into()));
            assert_eq!(mac_application_ready(Err(repeated)), Ok(()));
        }
    }

    #[test]
    fn application_already_initialized_by_plugin_can_deliver() {
        let preset = MacOsError::Application(ApplicationError::AlreadySet("app.cortex".into()));
        assert_eq!(mac_application_ready(Err(preset)), Ok(()));
    }

    #[test]
    fn real_initialization_errors_are_propagated() {
        let failures = [
            MacOsError::Application(ApplicationError::CouldNotSet("app.cortex".into())),
            MacOsError::Notification(NotificationError::UnableToDeliver),
        ];
        for error in failures {
            let message = error.to_string();
            assert_eq!(mac_application_ready(Err(error)), Err(message));
        }
    }
}

// This API cannot cancel a wait, so refuse excess work rather than grow threads.
#[cfg(target_os = "macos")]
fn mac_worker_permit() -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    static WORKERS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    WORKERS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(16)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Notification response workers are busy".into())
}

#[cfg(not(any(
    target_os = "android",
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
)))]
pub async fn post(
    _app: tauri::AppHandle,
    _title: String,
    _body: String,
    _id: String,
) -> Result<(), String> {
    Err("Native notifications are unsupported on this platform".into())
}
