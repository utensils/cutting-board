//! Main-window lifecycle: show / hide / toggle, monitor-under-cursor
//! centering, macOS activation-policy switching (no Dock icon at idle), and the
//! auto-hide suppression guard.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow};

use crate::state::AppState;

/// Logical label of the single retained window.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// RAII guard that sets the auto-hide suppression flag for its lifetime, so a
/// transient `Focused(false)` (native picker, paste) does not hide the window.
pub struct SuppressGuard<'a> {
    state: &'a AppState,
}

impl<'a> SuppressGuard<'a> {
    pub fn new(state: &'a AppState) -> Self {
        state.suppress_auto_hide.store(true, Ordering::SeqCst);
        Self { state }
    }
}

impl Drop for SuppressGuard<'_> {
    fn drop(&mut self) {
        self.state.suppress_auto_hide.store(false, Ordering::SeqCst);
    }
}

/// Fetch the main window, if it exists.
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
}

/// Center `window` on the monitor under the cursor, falling back to the primary
/// monitor (and finally leaving the position untouched).
fn center_on_cursor_monitor<R: Runtime>(window: &WebviewWindow<R>) {
    let cursor = window.cursor_position().ok();
    let monitors = window.available_monitors().unwrap_or_default();

    let under_cursor = cursor.and_then(|c| {
        monitors
            .iter()
            .find(|m| {
                let pos = m.position();
                let size = m.size();
                let cx = c.x as i32;
                let cy = c.y as i32;
                cx >= pos.x
                    && cx < pos.x + size.width as i32
                    && cy >= pos.y
                    && cy < pos.y + size.height as i32
            })
            .cloned()
    });

    let monitor = match under_cursor
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned())
    {
        Some(m) => m,
        None => return,
    };

    let win_size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };

    let mpos = monitor.position();
    let msize = monitor.size();
    let x = mpos.x + ((msize.width as i32 - win_size.width as i32) / 2);
    let y = mpos.y + ((msize.height as i32 - win_size.height as i32) / 2);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Show + focus the window, repositioning it under the cursor's monitor, switch
/// macOS to a regular (Dock-visible, focusable) app, and emit `window:shown`.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        log::warn!("show: main window not found");
        return;
    };

    // Become a regular app so we can take key focus reliably.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    center_on_cursor_monitor(&window);

    // show() MUST precede set_focus() — focusing a hidden window is a no-op.
    let _ = window.show();
    let _ = window.set_focus();

    let _ = app.emit(crate::events::WINDOW_SHOWN, ());
}

/// Hide the window and switch macOS back to an accessory app (no Dock icon).
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Toggle the window: hide if currently visible, otherwise show.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let visible = main_window(app)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide(app);
    } else {
        show(app);
    }
}

/// Hide the board window. Exposed as a command for the frontend's Done/Esc.
#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    hide(&app);
}
