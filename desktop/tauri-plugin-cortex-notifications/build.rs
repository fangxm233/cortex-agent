// input:  Tauri plugin build support and Android sources
// output: Notification command permissions and Android wiring
// pos:    Native notification plugin build entry
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

fn main() {
    tauri_plugin::Builder::new(&[
        "post", "visible_session", "pending_actions", "ack_action",
        "register_listener", "remove_listener",
    ])
        .android_path("android")
        .build();
}
