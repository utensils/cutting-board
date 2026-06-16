//! Tauri v2 shell for the `cutting-board` macOS menu-bar whiteboard.
//!
//! This crate hosts the retained board window, the menu-bar tray, the global
//! hotkey, settings/board persistence, the macOS PNG clipboard integration, and
//! the loopback WebSocket bridge that the MCP server drives. See
//! `docs/app-ipc.md` (command/event surface) and `docs/bridge-protocol.md`.

mod bridge;
mod clipboard;
mod commands;
mod events;
mod persistence;
mod settings;
mod shortcut;
mod state;
mod tray;
mod window;

use tauri::{Manager, RunEvent, WindowEvent};

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: bring the existing window forward.
            // show() BEFORE set_focus() (focusing a hidden window is a no-op).
            window::show(app);
        }))
        .plugin(shortcut::plugin())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Load persisted settings and seed shared state.
            let loaded = settings::load(app.handle());
            let token = bridge::generate_token();
            app.manage(AppState::new(loaded.clone(), token));

            // Tray + global hotkey.
            tray::setup(app)?;
            shortcut::register(app.handle(), &loaded.hotkey);

            // Window event handling: keep the board warm; honor auto-hide.
            if let Some(main) = window::main_window(app.handle()) {
                let handle = app.handle().clone();
                main.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        window::hide(&handle);
                    }
                    WindowEvent::Focused(false) => {
                        let state = handle.state::<AppState>();
                        let auto_hide = state.settings.lock().unwrap().auto_hide_on_blur;
                        let suppressed = state
                            .suppress_auto_hide
                            .load(std::sync::atomic::Ordering::SeqCst);
                        if auto_hide && !suppressed {
                            window::hide(&handle);
                        }
                    }
                    _ => {}
                });
            }

            // Start the loopback bridge server.
            let bridge_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                bridge::start(bridge_app).await;
            });

            // In debug, show the window so `tauri dev` is testable; release
            // starts hidden (configured via `visible: false`).
            if cfg!(debug_assertions) {
                window::show(app.handle());
            } else {
                // Ensure we are an accessory app at idle (no Dock icon).
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_settings,
            persistence::load_board,
            persistence::save_board,
            persistence::clear_saved_board,
            clipboard::copy_png_to_clipboard,
            clipboard::read_clipboard_image,
            window::hide_main_window,
            commands::notify_adapter_ready,
            commands::bridge_reply,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            // Remove the bridge discovery file on graceful shutdown.
            bridge::remove_info(app_handle);
        }
    });
}
