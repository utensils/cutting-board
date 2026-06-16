//! Frontend → Rust commands that complete the bridge round-trip:
//! `notify_adapter_ready` and `bridge_reply`.

use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::state::AppState;

/// The frontend calls this once the tldraw editor + bridge adapter are mounted.
/// Until then the bridge answers requests with `editor_not_ready`.
#[tauri::command]
pub fn notify_adapter_ready(state: State<'_, AppState>) {
    state.adapter_ready.store(true, Ordering::SeqCst);
    log::info!("bridge: adapter is ready");
}

/// The structured error payload the adapter may return.
#[derive(Debug, Deserialize)]
pub struct ReplyError {
    pub code: String,
    pub message: String,
}

/// The bridge adapter returns the result of an `mcp:request`. We look up the
/// correlated, in-flight request by `id` and complete its oneshot so the bridge
/// server can write the `response` frame.
#[tauri::command]
pub fn bridge_reply(
    state: State<'_, AppState>,
    id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<ReplyError>,
) {
    let sender = { state.pending.lock().unwrap().remove(&id) };
    let Some(sender) = sender else {
        // Already timed out / unknown id: nothing to do.
        log::debug!("bridge_reply: no pending request for id {id}");
        return;
    };

    let outcome = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        let err = error.unwrap_or(ReplyError {
            code: "internal".to_string(),
            message: "adapter reported failure without an error body".to_string(),
        });
        Err((err.code, err.message))
    };

    // The receiver may be gone if the request already timed out; ignore.
    let _ = sender.send(outcome);
}
