//! Loopback WebSocket bridge server (a PURE RELAY).
//!
//! Binds `127.0.0.1` only, scanning ports from `DEFAULT_BRIDGE_PORT`. Writes a
//! `0600` `bridge.json` discovery file with a per-launch token. For each
//! authenticated `request` frame it correlates an id, emits `mcp:request` to
//! the WebView, awaits the matching `bridge_reply` (with a timeout), and writes
//! a protocol `response` frame back. It never parses method params.
//!
//! Security boundary: loopback bind + per-launch token. Only one controller is
//! active at a time (newest authenticated socket wins).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::events;
use crate::state::{AppState, BridgeOutcome};

/// Protocol version we speak (mirrors PROTOCOL_VERSION in the TS protocol).
pub const PROTOCOL_VERSION: u32 = 1;
/// Preferred loopback port; we scan upward if it is taken.
pub const DEFAULT_BRIDGE_PORT: u16 = 9223;
/// Number of ports to scan starting at `DEFAULT_BRIDGE_PORT`.
pub const BRIDGE_PORT_SCAN_COUNT: u16 = 20;
/// How long to wait for the WebView adapter to answer an `mcp:request`.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Discovery filename (under the app data dir).
pub const BRIDGE_INFO_FILENAME: &str = "bridge.json";
/// Length (in bytes) of the random token before hex encoding.
const TOKEN_BYTES: usize = 32;

/// Contents of the `bridge.json` discovery file. Matches the TS `BridgeInfo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
}

/// Monotonic id distinguishing controller connections, so a task can tell
/// whether it still owns the single controller slot at teardown.
static CONTROLLER_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A handle the relay keeps for the single active controller socket. Replacing
/// it signals the previous connection task to close (newest authenticated
/// socket wins).
pub struct ControllerHandle {
    /// Identifies which connection currently owns the controller slot.
    pub generation: u64,
    /// Sending `()` (or dropping the channel) asks the owning task to close.
    pub close: oneshot::Sender<()>,
}

/// Generate a per-launch token: `TOKEN_BYTES` random bytes, hex-encoded.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut buf);
    to_hex(&buf)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// The ports, in scan order, that we will try to bind.
pub fn candidate_ports() -> impl Iterator<Item = u16> {
    (0..BRIDGE_PORT_SCAN_COUNT).map(|i| DEFAULT_BRIDGE_PORT + i)
}

/// Bind a loopback `TcpListener`, scanning the candidate ports in order.
async fn bind_listener() -> Option<(TcpListener, u16)> {
    for port in candidate_ports() {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Some((listener, port)),
            Err(e) => log::debug!("bridge: port {port} unavailable: {e}"),
        }
    }
    None
}

/// Create `dir` if missing and (on unix) restrict it to the owner (`0700`).
/// Shared by the modules that store secrets/state there (token, settings, board).
pub fn ensure_private_dir(dir: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create app data dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod dir {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Write `bytes` to `path` as an owner-only (`0600`) file. On unix the mode is
/// applied at creation so there is no world-readable window (the token is the
/// sole secret authorizing the bridge). Replaces any existing file.
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // Remove any pre-existing file so the mode applies to a fresh inode.
        let _ = fs::remove_file(path);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("write {}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

/// Path to `bridge.json` in the app data dir, creating the (private) dir if missing.
fn info_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    ensure_private_dir(&dir)?;
    Ok(dir.join(BRIDGE_INFO_FILENAME))
}

/// Write the discovery file, owner-only from creation.
fn write_info<R: Runtime>(app: &AppHandle<R>, info: &BridgeInfo) -> Result<(), String> {
    let path = info_path(app)?;
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    write_private_file(&path, json.as_bytes())
}

/// Remove the discovery file (best effort), called on graceful shutdown.
pub fn remove_info<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(path) = info_path(app) {
        let _ = fs::remove_file(path);
    }
}

/// Start the bridge: bind the listener, advertise it via `bridge.json`, and
/// spawn the accept loop. Returns the chosen port (also stored in `AppState`).
pub async fn start<R: Runtime>(app: AppHandle<R>) -> Option<u16> {
    let Some((listener, port)) = bind_listener().await else {
        log::warn!(
            "bridge: no free port in [{DEFAULT_BRIDGE_PORT}, {}); MCP control disabled",
            DEFAULT_BRIDGE_PORT + BRIDGE_PORT_SCAN_COUNT
        );
        return None;
    };

    let token = {
        let state = app.state::<AppState>();
        state.bridge_token.clone()
    };

    let info = BridgeInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        protocol_version: PROTOCOL_VERSION,
    };
    if let Err(e) = write_info(&app, &info) {
        log::warn!("bridge: could not write discovery file: {e}");
    }

    {
        let state = app.state::<AppState>();
        *state.bridge_port.lock().unwrap() = Some(port);
    }

    log::info!("bridge: listening on 127.0.0.1:{port}");

    let accept_app = app.clone();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    log::debug!("bridge: connection from {peer}");
                    let conn_app = accept_app.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(conn_app, stream, token).await {
                            log::debug!("bridge: connection ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("bridge: accept failed: {e}");
                    break;
                }
            }
        }
    });

    Some(port)
}

/// The bridge security decision: a frame authenticates iff it is a JSON object
/// with `kind == "auth"` and a `token` equal to the per-launch secret. Kept as a
/// pure function so the security boundary is unit-testable.
fn is_authed(first_frame: &str, expected_token: &str) -> bool {
    match serde_json::from_str::<Value>(first_frame) {
        Ok(v) => {
            v.get("kind").and_then(Value::as_str) == Some("auth")
                && v.get("token").and_then(Value::as_str) == Some(expected_token)
        }
        Err(_) => false,
    }
}

/// Handle a single socket: enforce auth, become the sole controller, then relay
/// `request` frames until the socket closes or it is superseded.
async fn handle_connection<R: Runtime>(
    app: AppHandle<R>,
    stream: TcpStream,
    token: String,
) -> Result<(), String> {
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake: {e}"))?;
    let (mut write, mut read) = ws.split();

    // --- Authentication: the FIRST frame must be a valid `auth`. ------------
    let first = match read.next().await {
        Some(Ok(Message::Text(t))) => t.to_string(),
        Some(Ok(Message::Close(_))) | None => return Ok(()),
        Some(Ok(_)) => {
            let _ = write
                .send(auth_result(false, Some("expected text auth frame")))
                .await;
            return Ok(());
        }
        Some(Err(e)) => return Err(format!("read auth: {e}")),
    };

    if !is_authed(&first, &token) {
        let _ = write.send(auth_result(false, Some("unauthorized"))).await;
        return Ok(());
    }
    write
        .send(auth_result(true, None))
        .await
        .map_err(|e| format!("send auth_result: {e}"))?;

    // --- Become the sole controller (newest authenticated socket wins). -----
    // We wrap the sink so the request-dispatch task can write responses, while
    // a `close_rx` lets a newer controller signal us to shut down.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let (close_tx, mut close_rx) = oneshot::channel::<()>();
    let generation = CONTROLLER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let state = app.state::<AppState>();
        let mut controller = state.controller.lock().await;
        if let Some(prev) = controller.take() {
            // Ask the previous controller to close; ignore if already gone.
            let _ = prev.close.send(());
        }
        *controller = Some(ControllerHandle {
            generation,
            close: close_tx,
        });
    }

    // Writer task: drains `out_rx` to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    // --- Relay loop. --------------------------------------------------------
    let result = loop {
        tokio::select! {
            // Superseded by a newer controller.
            _ = &mut close_rx => {
                log::debug!("bridge: controller superseded");
                break Ok(());
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let text = t.to_string();
                        let app = app.clone();
                        let out_tx = out_tx.clone();
                        // Dispatch concurrently so a slow request doesn't block
                        // the read loop (the WebView is single-writer, but the
                        // 10s timeout shouldn't stall pings/other frames).
                        tokio::spawn(async move {
                            if let Some(resp) = handle_request_frame(&app, &text).await {
                                let _ = out_tx.send(Message::text(resp));
                            }
                        });
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = out_tx.send(Message::Pong(payload));
                    }
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Ok(_)) => { /* ignore binary/pong */ }
                    Some(Err(e)) => break Err(format!("read: {e}")),
                }
            }
        }
    };

    // --- Teardown: relinquish the controller slot only if it is still ours. -
    // If a newer connection already replaced us, its generation differs and we
    // must leave it intact.
    //
    // We do not abort in-flight dispatch tasks spawned by this socket: each
    // self-clears its `pending` entry on the request timeout, request ids are
    // globally unique, and a late `bridge_reply` for an unknown id is a no-op,
    // so an orphaned request is bounded (<= REQUEST_TIMEOUT) and harmless.
    {
        let state = app.state::<AppState>();
        let mut controller = state.controller.lock().await;
        if controller.as_ref().map(|c| c.generation) == Some(generation) {
            *controller = None;
        }
    }

    drop(out_tx);
    writer.abort();
    result
}

/// Process one incoming frame text. Returns the JSON response to send back, or
/// `None` if the frame is not a `request` (e.g. a stray `auth`).
async fn handle_request_frame<R: Runtime>(app: &AppHandle<R>, text: &str) -> Option<String> {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if value.get("kind").and_then(Value::as_str) != Some("request") {
        return None;
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let params = value.get("params").cloned().unwrap_or(Value::Null);

    let outcome = dispatch(app, &id, &method, params).await;
    Some(encode_response(&id, outcome))
}

/// Emit the request to the WebView and await the adapter's reply. Short-circuits
/// with `editor_not_ready` if the adapter hasn't registered yet.
async fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    method: &str,
    params: Value,
) -> BridgeOutcome {
    let state = app.state::<AppState>();

    if !state.adapter_ready.load(Ordering::SeqCst) {
        return Err((
            "editor_not_ready".to_string(),
            "the WebView adapter has not registered an editor yet".to_string(),
        ));
    }

    let (tx, rx) = oneshot::channel::<BridgeOutcome>();
    {
        let mut pending = state.pending.lock().unwrap();
        pending.insert(id.to_string(), tx);
    }

    // Emit to the main window so the bridge adapter can run the op.
    let emitted = app.emit_to(
        crate::window::MAIN_WINDOW_LABEL,
        events::MCP_REQUEST,
        json!({ "id": id, "method": method, "params": params }),
    );
    if let Err(e) = emitted {
        state.pending.lock().unwrap().remove(id);
        return Err(("internal".to_string(), format!("emit failed: {e}")));
    }

    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_canceled)) => {
            // Sender dropped without replying.
            Err((
                "internal".to_string(),
                "adapter reply channel closed".to_string(),
            ))
        }
        Err(_elapsed) => {
            // Timed out: drop the pending entry so a late reply is a no-op.
            state.pending.lock().unwrap().remove(id);
            Err((
                "timeout".to_string(),
                "the WebView did not respond in time".to_string(),
            ))
        }
    }
}

/// Encode a protocol `response` frame from an outcome.
fn encode_response(id: &str, outcome: BridgeOutcome) -> String {
    let value = match outcome {
        Ok(result) => json!({
            "kind": "response",
            "id": id,
            "ok": true,
            "result": result,
        }),
        Err((code, message)) => json!({
            "kind": "response",
            "id": id,
            "ok": false,
            "error": { "code": code, "message": message },
        }),
    };
    value.to_string()
}

/// Build an `auth_result` frame.
fn auth_result(ok: bool, error: Option<&str>) -> Message {
    let mut value = json!({
        "kind": "auth_result",
        "ok": ok,
        "serverProtocolVersion": PROTOCOL_VERSION,
    });
    if let Some(err) = error {
        value["error"] = Value::String(err.to_string());
    }
    Message::text(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_expected_length_and_charset() {
        let token = generate_token();
        assert_eq!(token.len(), TOKEN_BYTES * 2, "hex doubles the byte length");
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "token must be lowercase hex"
        );
    }

    #[test]
    fn tokens_are_distinct() {
        assert_ne!(generate_token(), generate_token());
    }

    #[test]
    fn port_scan_covers_the_documented_range() {
        let ports: Vec<u16> = candidate_ports().collect();
        assert_eq!(ports.len(), BRIDGE_PORT_SCAN_COUNT as usize);
        assert_eq!(*ports.first().unwrap(), DEFAULT_BRIDGE_PORT);
        assert_eq!(
            *ports.last().unwrap(),
            DEFAULT_BRIDGE_PORT + BRIDGE_PORT_SCAN_COUNT - 1
        );
    }

    #[test]
    fn bridge_info_serializes_to_protocol_shape() {
        let info = BridgeInfo {
            port: 9223,
            token: "deadbeef".to_string(),
            pid: 4242,
            protocol_version: 1,
        };
        let v: Value = serde_json::to_value(&info).unwrap();
        assert_eq!(v["port"], 9223);
        assert_eq!(v["token"], "deadbeef");
        assert_eq!(v["pid"], 4242);
        // Must be camelCase to match the TS `BridgeInfo`.
        assert_eq!(v["protocolVersion"], 1);
        assert!(v.get("protocol_version").is_none());
    }

    #[test]
    fn success_response_matches_protocol() {
        let s = encode_response("r1", Ok(json!({ "id": "shape:abc" })));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["kind"], "response");
        assert_eq!(v["id"], "r1");
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["id"], "shape:abc");
        assert!(v.get("error").is_none());
    }

    #[test]
    fn error_response_matches_protocol() {
        let s = encode_response(
            "r2",
            Err(("not_found".to_string(), "no shape shape:xyz".to_string())),
        );
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["kind"], "response");
        assert_eq!(v["id"], "r2");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "not_found");
        assert_eq!(v["error"]["message"], "no shape shape:xyz");
        assert!(v.get("result").is_none());
    }

    #[test]
    fn is_authed_accepts_correct_kind_and_token() {
        assert!(is_authed(r#"{"kind":"auth","token":"secret"}"#, "secret"));
    }

    #[test]
    fn is_authed_rejects_wrong_or_missing_token() {
        assert!(!is_authed(r#"{"kind":"auth","token":"nope"}"#, "secret"));
        assert!(!is_authed(r#"{"kind":"auth"}"#, "secret"));
        assert!(!is_authed(r#"{"kind":"auth","token":null}"#, "secret"));
    }

    #[test]
    fn is_authed_rejects_non_auth_kind() {
        assert!(!is_authed(
            r#"{"kind":"request","token":"secret"}"#,
            "secret"
        ));
        assert!(!is_authed(r#"{"token":"secret"}"#, "secret"));
    }

    #[test]
    fn is_authed_rejects_malformed_frames() {
        assert!(!is_authed("not json", "secret"));
        assert!(!is_authed(r#""just a string""#, "secret"));
        assert!(!is_authed("42", "secret"));
    }

    #[test]
    fn auth_result_frame_shape() {
        let Message::Text(t) = auth_result(true, None) else {
            panic!("expected text frame");
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        assert_eq!(v["kind"], "auth_result");
        assert_eq!(v["ok"], true);
        assert_eq!(v["serverProtocolVersion"], 1);
        assert!(v.get("error").is_none());

        let Message::Text(t) = auth_result(false, Some("unauthorized")) else {
            panic!("expected text frame");
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "unauthorized");
    }
}
