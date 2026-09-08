//! macOS system menu bar, built from the model the SPA already owns.
//!
//! The alternative — hard-coding File/Edit/View/Help in Rust — would fork the menu definition in
//! two: the labels would have to be translated a second time (the shell has no idea which language
//! the SPA is running in), and every check mark would need its own sync command. Instead the SPA
//! sends the whole tree it already assembled in `shell/menu/useAppMenus.ts` and this module turns it
//! into a real `tauri::menu::Menu`. Re-sending replaces the menu, so language switches and check
//! marks need no extra machinery.
//!
//! macOS only. Windows and Linux draw the bar inside the window, so `set_native_menu` is a no-op
//! there and the command stays callable from one code path on the JS side.

use serde::Deserialize;

/// Emitted to the webview when the user picks a native menu item; the payload is the item id from
/// the SPA's own model, which dispatches it back into the same `run()` the in-window bar calls.
pub const MENU_EVENT: &str = "native-menu";

// Off macOS nothing reads these fields — the spec is still deserialized so the command validates
// its payload identically on every platform, which is what keeps the JS side single-path.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuNodeSpec {
    /// `item` | `separator` | `submenu`
    kind: String,
    id: Option<String>,
    label: Option<String>,
    /// muda accelerator syntax (`CmdOrCtrl+KeyN`), pre-translated by the SPA.
    accelerator: Option<String>,
    /// Names a `PredefinedMenuItem` (undo, redo, cut, copy, paste, selectAll, fullscreen). Those
    /// carry the real AppKit behaviour, which is why the Edit block is worth routing natively
    /// instead of round-tripping through the webview.
    role: Option<String>,
    checked: Option<bool>,
    enabled: Option<bool>,
    items: Option<Vec<MenuNodeSpec>>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
pub struct MenuSpec {
    menus: Vec<MenuNodeSpec>,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{MenuNodeSpec, MenuSpec};
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Manager, Wry};

    fn predefined(app: &AppHandle<Wry>, role: &str, label: Option<&str>) -> tauri::Result<Option<PredefinedMenuItem<Wry>>> {
        let item = match role {
            "undo" => PredefinedMenuItem::undo(app, label)?,
            "redo" => PredefinedMenuItem::redo(app, label)?,
            "cut" => PredefinedMenuItem::cut(app, label)?,
            "copy" => PredefinedMenuItem::copy(app, label)?,
            "paste" => PredefinedMenuItem::paste(app, label)?,
            "selectAll" => PredefinedMenuItem::select_all(app, label)?,
            "fullscreen" => PredefinedMenuItem::fullscreen(app, label)?,
            "closeWindow" => PredefinedMenuItem::close_window(app, label)?,
            _ => return Ok(None),
        };
        Ok(Some(item))
    }

    /// Append one spec node to a submenu under construction.
    ///
    /// An unusable node (a submenu with no label, an accelerator muda rejects) is skipped rather
    /// than failing the whole menu: losing one item is recoverable, losing the menu bar is not.
    fn append(app: &AppHandle<Wry>, parent: &Submenu<Wry>, node: &MenuNodeSpec) -> tauri::Result<()> {
        match node.kind.as_str() {
            "separator" => parent.append(&PredefinedMenuItem::separator(app)?)?,
            "submenu" => {
                let Some(label) = node.label.as_deref() else { return Ok(()) };
                let child = Submenu::new(app, label, true)?;
                for item in node.items.iter().flatten() {
                    append(app, &child, item)?;
                }
                parent.append(&child)?;
            }
            "item" => {
                let label = node.label.as_deref().unwrap_or_default();
                let enabled = node.enabled.unwrap_or(true);
                let accel = node.accelerator.as_deref();
                if let Some(role) = node.role.as_deref() {
                    if let Some(item) = predefined(app, role, node.label.as_deref())? {
                        parent.append(&item)?;
                        return Ok(());
                    }
                }
                let Some(id) = node.id.as_deref() else { return Ok(()) };
                match node.checked {
                    Some(checked) => {
                        let item = CheckMenuItem::with_id(app, id, label, enabled, checked, accel)?;
                        parent.append(&item)?;
                    }
                    None => {
                        let item = MenuItem::with_id(app, id, label, enabled, accel)?;
                        parent.append(&item)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The first submenu on macOS is the application menu, and the system expects it to carry
    /// About / Services / Hide / Quit. It is pure platform convention with no web counterpart, so
    /// the shell owns it rather than asking the SPA to model it.
    fn app_submenu(app: &AppHandle<Wry>) -> tauri::Result<Submenu<Wry>> {
        let menu = Submenu::new(app, "Cortex", true)?;
        menu.append(&PredefinedMenuItem::about(app, None, None)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&PredefinedMenuItem::services(app, None)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&PredefinedMenuItem::hide(app, None)?)?;
        menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
        menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&PredefinedMenuItem::quit(app, None)?)?;
        Ok(menu)
    }

    pub fn apply(app: &AppHandle<Wry>, spec: &MenuSpec) -> tauri::Result<()> {
        let menu = Menu::new(app)?;
        menu.append(&app_submenu(app)?)?;
        for top in &spec.menus {
            let Some(label) = top.label.as_deref() else { continue };
            let submenu = Submenu::new(app, label, true)?;
            for item in top.items.iter().flatten() {
                append(app, &submenu, item)?;
            }
            menu.append(&submenu)?;
        }
        app.set_menu(menu)?;
        Ok(())
    }
}

#[tauri::command]
pub fn set_native_menu(app: tauri::AppHandle, spec: MenuSpec) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        imp::apply(&app, &spec).map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Keeps the JS side single-path: it always offers the menu, and the shell decides.
        let _ = (app, spec);
        Ok(false)
    }
}
