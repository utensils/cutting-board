# Bridge protocol

The **bridge** is a loopback WebSocket channel that lets the MCP server view and
edit the whiteboard that lives inside the running app's WebView. It is the spine
that connects three processes:

```
Claude / MCP client
   │  stdio JSON-RPC
   ▼
MCP server (Node)                packages/mcp-server
   │  WebSocket (127.0.0.1, token-authenticated)
   ▼
Rust bridge (WebSocket server)   packages/app/src-tauri  ── pure relay
   │  Tauri events + invoke
   ▼
WebView adapter (TypeScript)     packages/app/src/bridge ── runs editor.* ops
   │
   ▼
tldraw Editor (the live board)
```

The canonical TypeScript types live in [`@cutting-board/protocol`](../packages/protocol/src/index.ts).
The Rust side mirrors these JSON shapes with `serde`. This document is the
human-readable reference.

## Discovery & authentication

1. On launch the app binds a WebSocket server to `127.0.0.1`, starting at port
   **9223** and scanning up to 20 ports if it is taken.
2. It writes a `0600` discovery file, `bridge.json`, into the app data dir
   (`~/Library/Application Support/com.utensils.cutting-board/`):

   ```json
   { "port": 9223, "token": "<random per-launch secret>", "pid": 12345, "protocolVersion": 1 }
   ```

   The file is rewritten on every launch and removed on graceful shutdown.
3. The MCP server reads `bridge.json`, connects, and sends an **auth** frame as
   its first message. The server replies with **auth_result**; on failure it
   closes the socket.
4. Only one controller is active at a time — the newest authenticated socket
   wins, and any previous controller is dropped.

The server binds loopback only and rejects any socket that does not present the
current token, so other local users/processes cannot drive the board.

## Message envelope

All messages are JSON objects with a `kind` discriminator.

### Client → server

```jsonc
// auth (first frame)
{ "kind": "auth", "token": "…", "protocolVersion": 1, "clientName": "claude-code" }

// request
{ "kind": "request", "id": "r1", "method": "add_sticky", "params": { "text": "Hi", "color": "yellow" } }
```

### Server → client

```jsonc
// auth_result
{ "kind": "auth_result", "ok": true, "serverProtocolVersion": 1 }

// response (success)
{ "kind": "response", "id": "r1", "ok": true, "result": { "id": "shape:abc123" } }

// response (error)
{ "kind": "response", "id": "r1", "ok": false, "error": { "code": "not_found", "message": "no shape shape:xyz" } }
```

Requests and responses are correlated by `id`. Writes are serialized
single-writer; the live tldraw store is always the source of truth, so the MCP
server must never cache shape ids across calls.

## Error codes

| code                  | meaning                                              |
| --------------------- | ---------------------------------------------------- |
| `unauthorized`        | missing/incorrect token                              |
| `bad_request`         | malformed params                                     |
| `not_found`           | referenced shape id does not exist                   |
| `editor_not_ready`    | the WebView adapter has not registered an editor yet |
| `unsupported_method`  | unknown method                                       |
| `timeout`             | the WebView did not respond in time                  |
| `internal`            | unexpected failure                                   |

## Methods

| method               | params                                                        | result                                  |
| -------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `get_status`         | —                                                             | `{ ready, windowVisible, shapeCount, productVersion }` |
| `get_board_snapshot` | —                                                             | `{ snapshot, shapeCount }`              |
| `list_shapes`        | —                                                             | `{ shapes: ShapeSummary[] }`            |
| `get_board_image`    | `{ pixelRatio?, background?, padding?, darkMode? }`           | `{ pngBase64, width, height }`          |
| `add_sticky`         | `{ text?, color?, x?, y? }`                                   | `{ id }`                                |
| `add_shape`          | `{ shape, text?, color?, fill?, x?, y?, w?, h? }`             | `{ id }`                                |
| `add_connector`      | `{ fromId, toId, text?, color? }`                             | `{ id }`                                |
| `update_shape`       | `{ id, x?, y?, text?, color?, props? }`                       | `{ ok }`                                |
| `move_shape`         | `{ id, x, y }`                                                | `{ ok }`                                |
| `delete_shape`       | `{ id }`                                                      | `{ ok }`                                |
| `clear_board`        | —                                                             | `{ deletedCount }`                      |

- **Colors** are tldraw's 13 defaults: `black, grey, light-violet, violet, blue,
  light-blue, yellow, orange, green, light-green, light-red, red, white`.
- **Shapes** (`add_shape.shape`): `rectangle, ellipse, triangle, diamond,
  hexagon, cloud, star, oval, rhombus, x-box, check-box`.
- **`add_connector`** creates a tldraw `arrow` and binds *both* terminals to the
  given shapes, so the connector re-routes automatically when either shape moves.
- **`get_board_image`** clamps `pixelRatio` to `[1, 2]` to stay within MCP image
  size limits and returns raw base64 (no `data:` prefix).
- Mutating a missing shape is a graceful no-op (`{ ok: false }`), not an error.
