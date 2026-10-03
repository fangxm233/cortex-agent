//! Where the macOS traffic lights sit under `TitleBarStyle::Overlay`.
//!
//! tao's inset `y` is not a distance from the top of the window. It grows the buttons' container to
//! `button height + y` and leaves each button at AppKit's own offset from the container's bottom, so
//! a button's top lands at `y - offset`. That offset differs between macOS releases, so it is read
//! from a hidden window with the same style before the real window is built (Tauri only takes the
//! position at build time).

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

/// The SPA title bar the lights are centred on: `TOP_BAR_HEIGHT` in web/src/shell/TopBar.tsx. The
/// setup and connect headers use the same height in overlay mode.
const BAR_HEIGHT: f64 = 44.0;
const INSET_X: f64 = 20.0;
/// Used when the measurement fails; centres the lights on macOS 13-15.
const FALLBACK_Y: f64 = 22.0;

pub fn position() -> tauri::LogicalPosition<f64> {
    let y = match close_button_geometry() {
        Some((offset, height)) => (BAR_HEIGHT - height) / 2.0 + offset,
        None => FALLBACK_Y,
    };
    tauri::LogicalPosition::new(INSET_X, y)
}

/// The close button's offset from the bottom of its title bar view, and its height.
fn close_button_geometry() -> Option<(f64, f64)> {
    let mtm = MainThreadMarker::new()?;
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            style,
            NSBackingStoreType::Buffered,
            true,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    window.layoutIfNeeded();
    let frame = window
        .standardWindowButton(NSWindowButton::CloseButton)
        .map(|button| button.frame());
    window.close();
    let frame = frame?;
    let (offset, height) = (frame.origin.y, frame.size.height);
    (height > 4.0 && height < 40.0 && offset > 0.0 && offset < 30.0).then_some((offset, height))
}
