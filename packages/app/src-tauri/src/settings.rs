//! User settings: the persisted struct, its defaults, JSON persistence under
//! the app data dir, and the `get_settings` / `set_settings` Tauri commands.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::shortcut;
use crate::state::AppState;

/// The default global hotkey accelerator.
pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";
/// The default PNG export resolution multiplier.
pub const DEFAULT_EXPORT_SCALE: f32 = 2.0;

const SETTINGS_FILENAME: &str = "settings.json";

/// Persisted user settings. Field names are serialized as camelCase to match
/// the frontend `Settings` interface in `docs/app-ipc.md`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Global hotkey accelerator, e.g. "CmdOrCtrl+Shift+Space".
    pub hotkey: String,
    /// Auto-hide the board when it loses focus.
    pub auto_hide_on_blur: bool,
    /// PNG export resolution multiplier (1–3).
    pub export_scale: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            auto_hide_on_blur: false,
            export_scale: DEFAULT_EXPORT_SCALE,
        }
    }
}

/// Path to `settings.json` in the app data dir, creating the dir if missing.
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(SETTINGS_FILENAME))
}

/// Load settings from disk, falling back to defaults if absent or unreadable.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("settings: {e}; using defaults");
            return Settings::default();
        }
    };
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
            log::warn!("settings: parse {}: {e}; using defaults", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

/// Write settings to disk as pretty JSON.
pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Read the persisted settings.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Persist settings, re-register the global hotkey if it changed, and return
/// the effective settings.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let old_hotkey = { state.settings.lock().unwrap().hotkey.clone() };

    save(&app, &settings)?;

    if settings.hotkey != old_hotkey {
        // A failed re-registration must not lose the new settings; the tray
        // "Open" item is the permanent fallback.
        shortcut::reregister(&app, &old_hotkey, &settings.hotkey);
    }

    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.hotkey, "CmdOrCtrl+Shift+Space");
        assert!(!s.auto_hide_on_blur);
        assert_eq!(s.export_scale, 2.0);
    }

    #[test]
    fn serializes_camel_case() {
        let s = Settings::default();
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert!(v.get("hotkey").is_some());
        assert!(v.get("autoHideOnBlur").is_some());
        assert!(v.get("exportScale").is_some());
        // Snake-case keys must NOT appear.
        assert!(v.get("auto_hide_on_blur").is_none());
        assert!(v.get("export_scale").is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let s = Settings {
            hotkey: "Alt+Shift+B".to_string(),
            auto_hide_on_blur: true,
            export_scale: 3.0,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn deserializes_from_camel_case_document() {
        let json = r#"{ "hotkey": "F1", "autoHideOnBlur": true, "exportScale": 1.5 }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.hotkey, "F1");
        assert!(s.auto_hide_on_blur);
        assert_eq!(s.export_scale, 1.5);
    }
}
