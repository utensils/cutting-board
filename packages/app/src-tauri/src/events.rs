//! Names of the Tauri events emitted from Rust to the WebView frontend.
//! These MUST match `docs/app-ipc.md` exactly.

/// A bridge request to execute against the live editor; payload
/// `{ id, method, params }`. The adapter replies via the `bridge_reply` command.
pub const MCP_REQUEST: &str = "mcp:request";

/// Tray "Settings" was chosen; the frontend opens its settings panel.
pub const UI_OPEN_SETTINGS: &str = "ui:open-settings";

/// The window was just shown; the frontend can focus the canvas.
pub const WINDOW_SHOWN: &str = "window:shown";
