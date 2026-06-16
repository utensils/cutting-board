//! Board autosave persistence: read/write/delete the opaque tldraw snapshot
//! string at `app_data_dir/board.tldr`.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

const BOARD_FILENAME: &str = "board.tldr";

/// Path to `board.tldr` in the app data dir, creating the dir if missing.
fn board_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(BOARD_FILENAME))
}

/// Read the autosaved tldraw snapshot JSON, or `None` if there is none.
#[tauri::command]
pub fn load_board(app: AppHandle) -> Result<Option<String>, String> {
    let path = board_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write the tldraw snapshot JSON (called throttled by the frontend). The
/// snapshot is opaque; we just store the string verbatim.
#[tauri::command]
pub fn save_board(app: AppHandle, snapshot: String) -> Result<(), String> {
    let path = board_path(&app)?;
    fs::write(&path, snapshot).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Delete the autosaved snapshot (used by "Copy & Discard").
#[tauri::command]
pub fn clear_saved_board(app: AppHandle) -> Result<(), String> {
    let path = board_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}
