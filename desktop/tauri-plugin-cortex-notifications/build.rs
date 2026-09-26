fn main() {
    tauri_plugin::Builder::new(&[
        "post", "visible_session", "pending_actions", "ack_action",
        "register_listener", "remove_listener",
    ])
        .android_path("android")
        .build();
}
