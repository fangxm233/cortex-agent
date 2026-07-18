// tauri-plugin-cortex-download — save agent-sent files to the PUBLIC Downloads folder on Android.
//
// Why a plugin (and not the app's `save_download` command): Android scoped storage forbids a plain
// `std::fs` write into `/storage/emulated/0/Download`, and Tauri 2.x exposes no public API to run raw
// JNI/MediaStore from app code (`run_on_android_context` is crate-internal). The sanctioned path is a
// mobile plugin with a Kotlin bridge. This one hands the file's authenticated URL to the system
// `DownloadManager`, which downloads straight into the public Downloads collection AND raises the
// native download-progress / "download complete" notification — no MediaStore boilerplate, no extra
// storage permission. The app's desktop `save_download` (OS download dir) is unchanged.
//
// Flow: SPA (mobile shell) invokes `plugin:cortex-download|download` with the absolute file URL, the
// `x-cortex-token`, and the file name → this Rust command → `run_mobile_plugin("download", …)` →
// Kotlin `DownloadPlugin.download` enqueues a `DownloadManager.Request`.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// Arguments forwarded to the Kotlin side (serialized camelCase to match the `@InvokeArg` class).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadArgs {
    /// Absolute URL the DownloadManager fetches (e.g. `https://server/api/files/download?path=…`).
    pub url: String,
    /// Destination file name inside the public Downloads folder.
    pub file_name: String,
    /// Bearer token added as the `x-cortex-token` request header (server auth). Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Optional MIME type hint for the saved file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// The Kotlin `download` reply: the DownloadManager enqueue id. Only read on Android (the desktop
/// stub never calls `run_mobile_plugin`), so it is dead code on other targets.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, Deserialize)]
struct DownloadResponse {
    id: i64,
}

/// Handle to the registered mobile plugin (Android) — a stub marker on every other platform.
pub struct CortexDownload<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R` (not `R`) so the stub is unconditionally `Send + Sync` — a plain `PhantomData<R>`
    // would tie those to `R` and break `Manager::state` (which requires `Send + Sync`).
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> CortexDownload<R> {
    /// Enqueue a system download. Returns the DownloadManager id on Android; errors elsewhere (the
    /// desktop app never calls this — it uses its own `save_download`).
    pub fn download(&self, args: DownloadArgs) -> Result<i64, String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin::<DownloadResponse>("download", args)
                .map(|r| r.id)
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = args;
            Err("public Downloads is only supported on Android".to_string())
        }
    }
}

#[tauri::command]
async fn download<R: Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
    file_name: String,
    token: Option<String>,
    mime_type: Option<String>,
) -> Result<i64, String> {
    app.state::<CortexDownload<R>>().inner().download(DownloadArgs {
        url,
        file_name,
        token,
        mime_type,
    })
}

/// Initialize the plugin. On Android it registers the Kotlin `DownloadPlugin`; on every other
/// platform it installs a stub so the `download` command still compiles (and returns an error).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cortex-download")
        .invoke_handler(tauri::generate_handler![download])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let state = CortexDownload {
                handle: _api.register_android_plugin("dev.cortex.download", "DownloadPlugin")?,
            };
            #[cfg(not(target_os = "android"))]
            let state = CortexDownload::<R> {
                _marker: std::marker::PhantomData,
            };
            app.manage(state);
            Ok(())
        })
        .build()
}
