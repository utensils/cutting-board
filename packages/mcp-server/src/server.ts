// MCP server wiring for cutting-board.
//
// Registers the board tools and resources, each of which delegates to the
// injected BridgeClient. The server never imports tldraw; it speaks only the
// protocol-typed bridge methods.

import {
  FILL_STYLES,
  GEO_SHAPES,
  TLDRAW_COLORS,
  clampPixelRatio,
  type ListShapesResult,
  type ShapeSummary,
} from "@cutting-board/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { AppNotRunningError, BridgeRequestError, type BridgeClient } from "./bridge-client.js";

const SERVER_NAME = "cutting-board";
const SERVER_VERSION = "0.1.0";

const colorEnum = z.enum(TLDRAW_COLORS);
const shapeEnum = z.enum(GEO_SHAPES);
const fillEnum = z.enum(FILL_STYLES);

/** Turn any thrown bridge error into a human-readable message. */
function describeError(err: unknown): string {
  if (err instanceof AppNotRunningError) return err.message;
  if (err instanceof BridgeRequestError) {
    return `Bridge error (${err.code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorResult(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: describeError(err) }],
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function formatShapeLine(s: ShapeSummary): string {
  const parts = [`${s.id}`, `type=${s.type}${s.geo ? `(${s.geo})` : ""}`];
  parts.push(`@(${Math.round(s.x)},${Math.round(s.y)})`);
  if (s.w != null && s.h != null) parts.push(`${Math.round(s.w)}x${Math.round(s.h)}`);
  if (s.color) parts.push(s.color);
  if (s.text) parts.push(JSON.stringify(s.text));
  return `- ${parts.join(" ")}`;
}

function formatShapeList(result: ListShapesResult): string {
  if (result.shapes.length === 0) return "The board is empty.";
  const lines = result.shapes.map(formatShapeLine);
  return `${result.shapes.length} shape(s):\n${lines.join("\n")}`;
}

export interface CreateServerOptions {
  bridge: BridgeClient;
}

/** Build (but do not connect) the MCP server with all tools/resources wired. */
export function createServer({ bridge }: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Tools to view and edit the live Cutting Board whiteboard. The Cutting Board " +
        "macOS app must be running. Shape ids returned by add_* are stable only for the " +
        "current session — call list_shapes to re-resolve them before editing.",
    },
  );

  // --- Read tools --------------------------------------------------------

  server.registerTool(
    "get_status",
    {
      title: "Get board status",
      description: "Report whether the board is ready, visible, and how many shapes it holds.",
      inputSchema: {},
    },
    async () => {
      try {
        const s = await bridge.request("get_status", {});
        return textResult(
          `Cutting Board v${s.productVersion} — ` +
            `${s.ready ? "ready" : "not ready"}, ` +
            `window ${s.windowVisible ? "visible" : "hidden"}, ` +
            `${s.shapeCount} shape(s).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_board_image",
    {
      title: "Get board image",
      description: "Render the current board to a PNG image so you can see it.",
      inputSchema: {
        pixelRatio: z.number().min(0.5).max(4).optional().describe("Resolution multiplier (clamped to 1-2)."),
        background: z.boolean().optional().describe("Paint an opaque background (default true)."),
        padding: z.number().min(0).optional().describe("Padding in px around content (default 16)."),
        darkMode: z.boolean().optional().describe("Export with the dark theme (default false)."),
      },
    },
    async ({ pixelRatio, background, padding, darkMode }) => {
      try {
        const result = await bridge.request("get_board_image", {
          pixelRatio: clampPixelRatio(pixelRatio),
          background,
          padding,
          darkMode,
        });
        return {
          content: [
            { type: "image", data: result.pngBase64, mimeType: "image/png" },
            {
              type: "text",
              text: `Rendered board image (${result.width}x${result.height}px).`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_board_snapshot",
    {
      title: "Get board snapshot",
      description: "Return the full tldraw document snapshot as JSON.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await bridge.request("get_board_snapshot", {});
        return {
          content: [{ type: "text", text: JSON.stringify(result.snapshot, null, 2) }],
          structuredContent: { snapshot: result.snapshot, shapeCount: result.shapeCount },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_shapes",
    {
      title: "List shapes",
      description:
        "List the shapes on the board (id, type, text, position) so you can reference them.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await bridge.request("list_shapes", {});
        return textResult(formatShapeList(result));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Write tools -------------------------------------------------------

  server.registerTool(
    "add_sticky",
    {
      title: "Add sticky note",
      description: "Add a sticky note to the board.",
      inputSchema: {
        text: z.string().optional().describe("Text for the note."),
        color: colorEnum.optional(),
        x: z.number().optional().describe("Page x (defaults to viewport center)."),
        y: z.number().optional().describe("Page y (defaults to viewport center)."),
      },
    },
    async ({ text, color, x, y }) => {
      try {
        const result = await bridge.request("add_sticky", { text, color, x, y });
        return textResult(`Added sticky note ${result.id}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "add_shape",
    {
      title: "Add shape",
      description: "Add a geometric shape (rectangle, ellipse, etc.) to the board.",
      inputSchema: {
        shape: shapeEnum.describe("The geometry to draw."),
        text: z.string().optional(),
        color: colorEnum.optional(),
        fill: fillEnum.optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
      },
    },
    async ({ shape, text, color, fill, x, y, w, h }) => {
      try {
        const result = await bridge.request("add_shape", { shape, text, color, fill, x, y, w, h });
        return textResult(`Added ${shape} ${result.id}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "add_connector",
    {
      title: "Add connector",
      description:
        "Draw an arrow connecting two shapes; it re-routes automatically when they move.",
      inputSchema: {
        fromId: z.string().describe("Source shape id."),
        toId: z.string().describe("Target shape id."),
        text: z.string().optional(),
        color: colorEnum.optional(),
      },
    },
    async ({ fromId, toId, text, color }) => {
      try {
        const result = await bridge.request("add_connector", { fromId, toId, text, color });
        return textResult(`Added connector ${result.id} from ${fromId} to ${toId}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_shape",
    {
      title: "Update shape",
      description: "Update a shape's position, text, color, or arbitrary props.",
      inputSchema: {
        id: z.string().describe("The shape id to update."),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string().optional(),
        color: colorEnum.optional(),
        props: z.record(z.unknown()).optional().describe("Escape hatch for raw tldraw props."),
      },
    },
    async ({ id, x, y, text, color, props }) => {
      try {
        const result = await bridge.request("update_shape", { id, x, y, text, color, props });
        return textResult(
          result.ok ? `Updated shape ${id}.` : `Shape ${id} no longer exists (no-op).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "move_shape",
    {
      title: "Move shape",
      description: "Move a shape to an absolute page position.",
      inputSchema: {
        id: z.string().describe("The shape id to move."),
        x: z.number(),
        y: z.number(),
      },
    },
    async ({ id, x, y }) => {
      try {
        const result = await bridge.request("move_shape", { id, x, y });
        return textResult(
          result.ok
            ? `Moved shape ${id} to (${x}, ${y}).`
            : `Shape ${id} no longer exists (no-op).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_shape",
    {
      title: "Delete shape",
      description: "Delete a shape from the board.",
      inputSchema: {
        id: z.string().describe("The shape id to delete."),
      },
    },
    async ({ id }) => {
      try {
        const result = await bridge.request("delete_shape", { id });
        return textResult(
          result.ok ? `Deleted shape ${id}.` : `Shape ${id} no longer exists (no-op).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "clear_board",
    {
      title: "Clear board",
      description: "Delete every shape on the board.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await bridge.request("clear_board", {});
        return textResult(`Cleared the board (${result.deletedCount} shape(s) deleted).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Resources (for @-mention support) ---------------------------------

  server.registerResource(
    "board-snapshot",
    "board://snapshot",
    {
      title: "Board snapshot",
      description: "The live tldraw document snapshot as JSON.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await bridge.request("get_board_snapshot", {});
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result.snapshot, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "board-image",
    "board://image",
    {
      title: "Board image",
      description: "A PNG render of the live board.",
      mimeType: "image/png",
    },
    async (uri) => {
      const result = await bridge.request("get_board_image", {
        pixelRatio: clampPixelRatio(undefined),
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "image/png",
            blob: result.pngBase64,
          },
        ],
      };
    },
  );

  return server;
}
