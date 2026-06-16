# MCP server

`@cutting-board/mcp-server` is a standalone [MCP](https://modelcontextprotocol.io)
server that lets an AI assistant (e.g. Claude) **view and edit the live
whiteboard** inside the running Cutting Board macOS app.

It is a stdio MCP server that acts as a WebSocket **client** to a loopback
bridge hosted by the app. It never imports tldraw — it only ships
protocol-typed bridge requests (see
[`@cutting-board/protocol`](../packages/protocol/src/index.ts) and
[`bridge-protocol.md`](./bridge-protocol.md)).

## Build & register

Build the server, then register the stdio entry point with Claude Code using
its **absolute path**:

```sh
pnpm --filter @cutting-board/mcp-server build
# produces packages/mcp-server/dist/index.js

claude mcp add --transport stdio cutting-board -- \
  node /ABS/PATH/cutting-board/packages/mcp-server/dist/index.js
```

Replace `/ABS/PATH/cutting-board` with your checkout path.

### Optional auto-launch

By default, if the app isn't running every tool returns a friendly error. Set
`CUTTING_BOARD_AUTO_LAUNCH=1` and the server will instead try to launch the app
(`open -b com.utensils.cutting-board`) and poll the discovery file for ~8s
before giving up:

```sh
claude mcp add --transport stdio cutting-board \
  --env CUTTING_BOARD_AUTO_LAUNCH=1 -- \
  node /ABS/PATH/cutting-board/packages/mcp-server/dist/index.js
```

## Connection model

- **The Cutting Board app must be running.** On launch the app advertises its
  bridge in `~/Library/Application Support/com.utensils.cutting-board/bridge.json`
  (port, per-launch token, pid). The server reads that file, connects over
  `127.0.0.1`, and authenticates with the token.
- The bridge binds **loopback only** and rejects any socket that doesn't present
  the current token, so other local users/processes can't drive the board.
- **Single controller:** only one authenticated client is active at a time — the
  newest connection wins, dropping any previous controller.
- The live tldraw store is the source of truth. Shape ids returned by the
  `add_*` tools are stable only for the current session — **re-resolve them with
  `list_shapes` before editing** rather than caching them across calls.
- The server reconnects to the bridge with backoff and keeps `stdout` pure
  JSON-RPC (all logging goes to `stderr`).

## Tools

11 tools — 4 read, 7 write. Optional params are marked `?`.

| Tool                 | Params                                                          | What it does |
| -------------------- | -------------------------------------------------------------- | ------------ |
| `get_status`         | —                                                               | Reports whether the board is ready and visible, and how many shapes it holds (plus the product version). |
| `get_board_image`    | `pixelRatio?` (clamped to 1–2, default 2), `background?` (default true), `padding?` (px, default 16), `darkMode?` (default false) | Renders the board to a PNG, returned as an MCP image block. |
| `get_board_snapshot` | —                                                               | Returns the full tldraw document snapshot as JSON. |
| `list_shapes`        | —                                                               | Lists shapes (id, type, geometry, position, size, color, text) so you can reference them. |
| `add_sticky`         | `text?`, `color?`, `x?`, `y?` (page coords; default viewport center) | Adds a sticky note. Returns its id. |
| `add_shape`          | `shape` (required), `text?`, `color?`, `fill?`, `x?`, `y?`, `w?`, `h?` | Adds a geometric shape. Returns its id. |
| `add_connector`      | `fromId` (required), `toId` (required), `text?`, `color?`       | Draws an arrow that **binds to both shapes** and re-routes when either moves. Returns its id. |
| `update_shape`       | `id` (required), `x?`, `y?`, `text?`, `color?`, `props?` (raw tldraw props escape hatch) | Updates a shape. No-op if the id no longer exists. |
| `move_shape`         | `id`, `x`, `y` (all required)                                   | Moves a shape to an absolute page position. No-op if the id is gone. |
| `delete_shape`       | `id` (required)                                                 | Deletes a shape. No-op if the id is gone. |
| `clear_board`        | —                                                               | Deletes every shape; reports how many were removed. |

**Vocabularies** (from `@cutting-board/protocol`):

- `color` — tldraw's 13 defaults: `black`, `grey`, `light-violet`, `violet`,
  `blue`, `light-blue`, `yellow`, `orange`, `green`, `light-green`,
  `light-red`, `red`, `white`.
- `shape` (`add_shape`) — `rectangle`, `ellipse`, `triangle`, `diamond`,
  `hexagon`, `cloud`, `star`, `oval`, `rhombus`, `x-box`, `check-box`.
- `fill` (`add_shape`) — `none`, `semi`, `solid`, `pattern`.

## Resources

For `@`-mention support:

| Resource           | MIME type          | What it is |
| ------------------ | ------------------ | ---------- |
| `board://snapshot` | `application/json` | The live tldraw document snapshot. |
| `board://image`    | `image/png`        | A PNG render of the live board. |

## Example prompts

With the app running and the server registered, you can ask things like:

- _"Show me the board."_ → the assistant calls `get_board_image` and renders it.
- _"Add a yellow sticky that says 'Ship Friday' in the top-left."_ → `add_sticky`.
- _"Draw two rectangles labelled 'API' and 'DB' and connect them with an arrow."_
  → two `add_shape` calls, then `add_connector` between the returned ids; move
  the boxes and the arrow re-routes itself.
- _"Clear everything and start fresh."_ → `clear_board`.
