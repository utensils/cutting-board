# @cutting-board/mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets Claude **view and
edit the live whiteboard** inside the running Cutting Board macOS app.

It is a stdio MCP server that acts as a WebSocket **client** to a loopback
bridge hosted by the app. It never imports tldraw — it only ships
protocol-typed bridge requests (see
[`@cutting-board/protocol`](../protocol/src/index.ts) and
[`docs/bridge-protocol.md`](../../docs/bridge-protocol.md)).

> The **Cutting Board app must be running.** On launch the app advertises its
> bridge in `~/Library/Application Support/com.utensils.cutting-board/bridge.json`;
> this server reads that file, connects over `127.0.0.1`, and authenticates with
> the per-launch token. If the app isn't running, every tool returns a friendly
> error instead of crashing.

## Tools

| Tool                 | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `get_status`         | Whether the board is ready/visible and how many shapes it holds. |
| `get_board_image`    | A PNG render of the board (returned as an MCP image block).      |
| `get_board_snapshot` | The full tldraw document snapshot as JSON.                       |
| `list_shapes`        | A readable list of shapes (id, type, text, position).            |
| `add_sticky`         | Add a sticky note.                                               |
| `add_shape`          | Add a geometric shape (rectangle, ellipse, …).                   |
| `add_connector`      | Draw an arrow that binds two shapes and re-routes when they move.|
| `update_shape`       | Update a shape's position, text, color, or raw props.            |
| `move_shape`         | Move a shape to an absolute page position.                       |
| `delete_shape`       | Delete a shape.                                                  |
| `clear_board`        | Delete every shape on the board.                                 |

## Resources

For `@`-mention support:

- `board://snapshot` — the document snapshot (JSON).
- `board://image` — a PNG render of the board.

## Register with Claude Code

Build first, then register the stdio server using the **absolute path** to the
bundled entry point:

```sh
pnpm --filter @cutting-board/mcp-server build

claude mcp add cutting-board -- node /absolute/path/to/cutting-board/packages/mcp-server/dist/index.js
```

(Replace `/absolute/path/to/cutting-board` with your checkout path.)

## Environment

- `CUTTING_BOARD_AUTO_LAUNCH=1` — if set, when the app isn't running the server
  attempts to launch it (`open -b com.utensils.cutting-board`) and polls the
  discovery file for ~8s before giving up. Off by default.

```sh
claude mcp add cutting-board --env CUTTING_BOARD_AUTO_LAUNCH=1 -- node /absolute/path/.../dist/index.js
```

## Development

```sh
pnpm --filter @cutting-board/mcp-server dev        # tsx watch
pnpm --filter @cutting-board/mcp-server typecheck
pnpm --filter @cutting-board/mcp-server test       # vitest
pnpm --filter @cutting-board/mcp-server build      # tsup -> dist/index.js
```

The server reconnects to the bridge with backoff (Claude Code does not
auto-reconnect stdio servers), and keeps `stdout` pure JSON-RPC — all logging
goes to `stderr`.
