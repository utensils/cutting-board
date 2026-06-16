//! Menu-bar tray icon: the menu (Open / Settings / Quit) and left-click toggle.

use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, Emitter};

use crate::events;
use crate::window;

const MENU_OPEN: &str = "open";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";

/// Build and attach the tray icon. The "Open" item is the permanent fallback
/// for toggling the window if the global hotkey is unavailable.
pub fn setup(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Cutting Board", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&settings)
        .item(&sep)
        .item(&quit)
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Cutting Board")
        .menu(&menu)
        // We toggle on a left click ourselves, so don't pop the menu then.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => window::toggle(app),
            MENU_SETTINGS => {
                // Show the window first — otherwise the settings panel opens
                // inside the still-hidden window and is never seen.
                window::show(app);
                let _ = app.emit(events::UI_OPEN_SETTINGS, ());
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
