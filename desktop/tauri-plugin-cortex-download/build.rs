// Generates the plugin's permission set + wires the Android library into the app's Gradle project.
// `android_path("android")` tells the Tauri build to copy `android/` (the Kotlin DownloadManager
// bridge) into the app's `gen/android` on `tauri android init`/build. No iOS path — public Downloads
// is Android-only here (desktop uses the app's own `save_download` command).

const COMMANDS: &[&str] = &["download"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
