//! Global hotkey registration via tauri-plugin-global-shortcut.
//!
//! The accelerator string comes from settings; the handler toggles the main
//! window and is gated on `ShortcutState::Pressed` (the plugin fires on both
//! press and release — without the gate the window would toggle twice).
//!
//! This plugin uses Carbon `RegisterEventHotKey` and needs NO Accessibility
//! permission, so there is no permission-request flow.

use std::str::FromStr;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Build the global-shortcut plugin with the toggle handler installed.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            // Fires on both Pressed and Released; only act on Pressed.
            if event.state() == ShortcutState::Pressed {
                crate::window::toggle(app);
            }
        })
        .build()
}

/// Parse an accelerator string (e.g. "CmdOrCtrl+Shift+Space") into a `Shortcut`.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator).map_err(|e| format!("invalid accelerator '{accelerator}': {e}"))
}

/// Register the accelerator from settings. Logs (does not crash) on failure;
/// the tray "Open" item is the permanent fallback.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    let shortcut = match parse(accelerator) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("global shortcut: {e}");
            return;
        }
    };
    if let Err(e) = app.global_shortcut().register(shortcut) {
        log::warn!(
            "global shortcut: could not register '{accelerator}' (combo may be taken): {e}. \
             Use the tray 'Open Cutting Board' item instead."
        );
    }
}

/// Re-register the hotkey when it changes: UNREGISTER the old accelerator FIRST
/// (re-registering without unregistering fails silently on macOS), then
/// register the new one.
pub fn reregister<R: Runtime>(app: &AppHandle<R>, old: &str, new: &str) {
    if let Ok(old_shortcut) = parse(old) {
        if let Err(e) = app.global_shortcut().unregister(old_shortcut) {
            log::warn!("global shortcut: could not unregister old '{old}': {e}");
        }
    }
    register(app, new);
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn parses_default_accelerator() {
        assert!(parse("CmdOrCtrl+Shift+Space").is_ok());
    }

    #[test]
    fn parses_common_accelerators() {
        assert!(parse("Alt+Shift+B").is_ok());
        assert!(parse("CmdOrCtrl+Shift+K").is_ok());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("not a real shortcut!!!").is_err());
        assert!(parse("").is_err());
    }
}
