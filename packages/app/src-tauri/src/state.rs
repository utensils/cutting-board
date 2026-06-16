//! Shared application state managed by Tauri (`app.manage(AppState)`).
//!
//! Holds the live settings, the pending bridge requests awaiting a WebView
//! reply, the bridge auth token, the "adapter ready" flag, and the auto-hide
//! suppression flag.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex as StdMutex;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::bridge::ControllerHandle;
use crate::settings::Settings;

/// The outcome the WebView adapter sends back for a single `mcp:request`.
///
/// `Ok(value)` is the JSON `result`; `Err((code, message))` is a bridge error.
pub type BridgeOutcome = Result<Value, (String, String)>;

/// A registered, in-flight bridge request waiting for its `bridge_reply`.
pub type PendingSender = oneshot::Sender<BridgeOutcome>;

/// Application-wide state shared across commands, the tray, the shortcut
/// handler, and the bridge server.
pub struct AppState {
    /// Current effective settings (mirrors the persisted `settings.json`).
    pub settings: StdMutex<Settings>,

    /// Per-launch bridge auth token (hex). Generated once at startup.
    pub bridge_token: String,

    /// The TCP port the bridge bound to, if it started successfully.
    pub bridge_port: StdMutex<Option<u16>>,

    /// In-flight bridge requests, keyed by correlation id. The bridge server
    /// inserts a sender before emitting `mcp:request`; `bridge_reply` removes
    /// and completes it.
    pub pending: StdMutex<HashMap<String, PendingSender>>,

    /// Handle to the single active controller socket, so a newer authenticated
    /// connection can drop the previous one ("newest wins").
    pub controller: tokio::sync::Mutex<Option<ControllerHandle>>,

    /// True once the frontend has called `notify_adapter_ready`. Until then the
    /// bridge answers requests with `editor_not_ready` instead of timing out.
    pub adapter_ready: AtomicBool,

    /// While set, `Focused(false)` will NOT auto-hide the window. Used to guard
    /// native pickers / paste flows that transiently steal focus.
    pub suppress_auto_hide: AtomicBool,
}

impl AppState {
    pub fn new(settings: Settings, bridge_token: String) -> Self {
        Self {
            settings: StdMutex::new(settings),
            bridge_token,
            bridge_port: StdMutex::new(None),
            pending: StdMutex::new(HashMap::new()),
            controller: tokio::sync::Mutex::new(None),
            adapter_ready: AtomicBool::new(false),
            suppress_auto_hide: AtomicBool::new(false),
        }
    }
}
