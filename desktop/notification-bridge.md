# Native desktop notification bridge

Implementation status: Linux compilation and scoped logic tests pass. Native
presentation, clicks and focus still require platform smoke testing. Android's
existing notification plugin/service is unchanged.

## IPC

- `desktop_notifications_post({ title, body, data?: { sessionId?, projectId? } })`
  returns `Result<(), String>`. Native send errors propagate to the frontend.
- `desktop_notifications_pending()` returns
  `{ actions: [{ actionId, serverUrl, sessionId?, projectId? }] }`.
- `desktop_notifications_ack({ actionId })` removes that pending action;
  acknowledgement is idempotent.
- `desktop-notification-action` carries null and prompts a pending-action drain.

At post time, Rust retains the native server URL/token snapshot. OS callbacks
capture an opaque process-local ID, not credentials or route arguments. Before
restoring the main window and queuing a click, Rust checks the current URL and
token again. Pending reads also discard mismatched connections. The token is
neither serialized in a pending action nor included in the OS notification.

Restoration (`show`, `unminimize`, `set_focus`) and event emission run on the main
thread. Window/focus failures do not discard the queued action. Frontend reloads
can drain again until acknowledgement. Unclicked records and pending actions are
each capped at 64, oldest first. Nothing persists across process exit, and no
cold-start activation, tray service or push transport is added.

Android registers the same command names/state, but desktop post returns an
unsupported error. The existing mobile notification commands remain untouched.

## Backend semantics and limits

- **Linux:** locked notify-rust 4.18.0, default action, `show_async` and
  `wait_for_action_async`. At most 64 async response listeners are retained;
  eviction and state drop abort listeners, dropping their D-Bus connections.
  There is no per-notification blocking thread. Servers can omit actions and
  Wayland/compositors can deny focus. The crate installs response signal matches
  after posting; instantaneous clicks during registration remain an upstream
  timing limitation. The wait API does not return signal-registration errors.
- **Windows:** locked tauri-winrt-notification 0.7.3 `on_activated` handles body
  clicks with no arguments. `show()` registers the delegate before native Show;
  the native toast owns the registration. The crate exposes no native toast or
  registration-token handle; retaining its Rust builder would not retain that
  native handle. Routing records stay bounded in Rust. Notification-center
  history activation and callback lifetime beyond banner dismissal need an
  installed-app smoke test; there is no claim of cold-start support.
- **macOS:** locked notify-rust/mac-notification-sys legacy
  NSUserNotificationCenter backend. Both body clicks (`Default`) and the default
  action button (`Action("default")`) route; dismissals/replies do not. `show()`
  only creates a lazy handle, so `wait_for_response()` performs the actual send
  on a blocking worker. The post promise therefore resolves on interaction, not
  immediately on display, preserving send-error propagation. At most 16 workers
  wait concurrently; excess sends return an error for frontend fallback. The
  legacy wait is not cancellable and requires the application's main run loop.
  Modern macOS permission, deprecated API behavior and notification-center
  interactions remain unverified.

## Verification

Run from `/home/fangxin/Cortex-wt-desktop-web-notifications/desktop/src-tauri`:

```sh
export CARGO_TARGET_DIR=/home/fangxin/Cortex/desktop/src-tauri/target
export TAURI_CONFIG='{"build":{"frontendDist":"/home/fangxin/Cortex/web/dist"},"bundle":{"resources":[]}}'
cargo check --offline
cargo test --offline --test desktop_notifications desktop_notifications:: -- --nocapture
rustfmt --edition 2021 --check src/desktop_notifications/*.rs tests/desktop_notifications.rs
cargo tree --offline --target aarch64-linux-android --edges normal
```

Results: Linux check passed; all 10 scoped tests passed. Only the existing
`install_site.rs` dead-code warnings remain. Android dependency-tree inspection
confirms neither new native backend is in the Android normal dependency graph.
No Windows/macOS/Android cross-compilation or real OS interaction was performed.
The Linux host has a session bus but no DISPLAY or WAYLAND_DISPLAY.

The shared target reuses existing artifacts. The temporary Tauri config points
at existing built assets because this worktree lacks `web/dist`; no web files or
production config were changed. `cargo test --lib desktop_notifications::`
initially failed because the unrelated Android seed test embeds that missing
folder. The integration target instead compiles the real bridge with production
AppState/ConnectionConfig without that unrelated test-only seed embedding.

TDD: the initial queue tests failed against unimplemented methods (7 failures in
a temporary external harness), then passed after implementation. The typed
macOS default-button regression was separately run red (1 failed, 9 filtered)
and green in the integration target. Listener tests verify cancellation both
on eviction and on state drop. No full test suite or production build was run.
