// Android removes an app and its data through the system; there is no uninstaller to open.
const UNSUPPORTED: &str = "UNINSTALL_UNSUPPORTED";

#[tauri::command]
pub fn uninstall_info() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn uninstall_run() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn uninstall_exit() {}

#[tauri::command]
pub fn uninstall_open() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
