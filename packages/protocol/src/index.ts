/**
 * cutting-board bridge protocol.
 *
 * This is the single source of truth for the messages exchanged over the
 * loopback WebSocket bridge that connects the three processes:
 *
 *   Claude (stdio JSON-RPC)
 *     <-> MCP server (Node, WebSocket client)
 *       <-> Rust bridge (WebSocket server, pure relay)
 *         <-> WebView adapter (executes ops against the live tldraw Editor)
 *
 * The Rust side mirrors these JSON shapes with serde; see
 * docs/bridge-protocol.md for the wire-format reference.
 */

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** macOS bundle identifier; also the Application Support sub-directory name. */
export const APP_IDENTIFIER = "com.utensils.cutting-board";

/** File (under the app data dir) where the running app advertises its bridge. */
export const BRIDGE_INFO_FILENAME = "bridge.json";

/** Preferred loopback port; the app scans upward if it is taken. */
export const DEFAULT_BRIDGE_PORT = 9223;

/** Number of ports to scan starting at {@link DEFAULT_BRIDGE_PORT}. */
export const BRIDGE_PORT_SCAN_COUNT = 20;

// ---------------------------------------------------------------------------
// Style vocabularies (mirror tldraw's default style props)
// ---------------------------------------------------------------------------

/** tldraw's 13 default colors, usable for shapes, stickies and connectors. */
export const TLDRAW_COLORS = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;
export type TldrawColor = (typeof TLDRAW_COLORS)[number];

/** Geometric shapes exposed through the bridge (a subset of tldraw's `geo`). */
export const GEO_SHAPES = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "cloud",
  "star",
  "oval",
  "rhombus",
  "x-box",
  "check-box",
] as const;
export type GeoShape = (typeof GEO_SHAPES)[number];

/** tldraw fill styles. */
export const FILL_STYLES = ["none", "semi", "solid", "pattern"] as const;
export type FillStyle = (typeof FILL_STYLES)[number];

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

/**
 * The complete set of bridge methods. This array is the runtime source of
 * truth; {@link BridgeMethod} is derived from it, and the param/result maps
 * below are checked (at compile time) to cover exactly these keys.
 */
export const BRIDGE_METHODS = [
  "get_status",
  "get_board_snapshot",
  "list_shapes",
  "get_board_image",
  "add_sticky",
  "add_shape",
  "add_connector",
  "update_shape",
  "move_shape",
  "delete_shape",
  "clear_board",
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export interface GetBoardImageParams {
  /** Resolution multiplier; clamped to [1, 2] to respect MCP image limits. */
  pixelRatio?: number;
  /** Paint an opaque background (default true). */
  background?: boolean;
  /** Padding in px around the content bounds (default 16). */
  padding?: number;
  /** Export with the dark theme (default false). */
  darkMode?: boolean;
}

export interface AddStickyParams {
  text?: string;
  color?: TldrawColor;
  /** Page coordinates; defaults to the current viewport center. */
  x?: number;
  y?: number;
}

export interface AddShapeParams {
  shape: GeoShape;
  text?: string;
  color?: TldrawColor;
  fill?: FillStyle;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface AddConnectorParams {
  /** Source shape id; the connector binds to it and follows when it moves. */
  fromId: string;
  /** Target shape id; the connector binds to it and follows when it moves. */
  toId: string;
  text?: string;
  color?: TldrawColor;
}

export interface UpdateShapeParams {
  id: string;
  x?: number;
  y?: number;
  text?: string;
  color?: TldrawColor;
  /** Escape hatch for arbitrary tldraw shape props. */
  props?: Record<string, unknown>;
}

export interface MoveShapeParams {
  id: string;
  x: number;
  y: number;
}

export interface DeleteShapeParams {
  id: string;
}

/** A compact, model-friendly description of a shape on the board. */
export interface ShapeSummary {
  id: string;
  /** tldraw shape type: "geo" | "note" | "arrow" | "text" | "image" | ... */
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  color?: string;
  /** For geo shapes, the underlying geometry (e.g. "rectangle"). */
  geo?: string;
}

export interface StatusResult {
  /** True once the WebView adapter has registered an editor. */
  ready: boolean;
  windowVisible: boolean;
  shapeCount: number;
  productVersion: string;
}

export interface SnapshotResult {
  /** The document-only tldraw snapshot (no camera/selection session state). */
  snapshot: Record<string, unknown>;
  shapeCount: number;
}

export interface ListShapesResult {
  shapes: ShapeSummary[];
}

export interface BoardImageResult {
  /** Raw base64 PNG (no `data:` prefix), suitable for an MCP image block. */
  pngBase64: string;
  width: number;
  height: number;
}

export interface CreatedResult {
  id: string;
}

export interface MutatedResult {
  /** False when the target id no longer exists (treated as a no-op). */
  ok: boolean;
}

export interface ClearResult {
  deletedCount: number;
}

/** Maps each method to its request params. */
export interface MethodParams {
  get_status: Record<string, never>;
  get_board_snapshot: Record<string, never>;
  list_shapes: Record<string, never>;
  get_board_image: GetBoardImageParams;
  add_sticky: AddStickyParams;
  add_shape: AddShapeParams;
  add_connector: AddConnectorParams;
  update_shape: UpdateShapeParams;
  move_shape: MoveShapeParams;
  delete_shape: DeleteShapeParams;
  clear_board: Record<string, never>;
}

/** Maps each method to its success result. */
export interface MethodResult {
  get_status: StatusResult;
  get_board_snapshot: SnapshotResult;
  list_shapes: ListShapesResult;
  get_board_image: BoardImageResult;
  add_sticky: CreatedResult;
  add_shape: CreatedResult;
  add_connector: CreatedResult;
  update_shape: MutatedResult;
  move_shape: MutatedResult;
  delete_shape: MutatedResult;
  clear_board: ClearResult;
}

// Compile-time guarantee that the param/result maps cover exactly the methods
// declared in BRIDGE_METHODS (both directions). The `A extends B` constraints
// fail to compile if any method is missing from, or extra in, either map.
type Assignable<A extends B, B> = A extends B ? true : never;

/** @internal Enforces that {@link MethodParams} and {@link MethodResult} stay in sync. */
export type AssertBridgeMapsConsistent = [
  Assignable<BridgeMethod, keyof MethodParams>,
  Assignable<keyof MethodParams, BridgeMethod>,
  Assignable<BridgeMethod, keyof MethodResult>,
  Assignable<keyof MethodResult, BridgeMethod>,
];

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "editor_not_ready"
  | "unsupported_method"
  | "timeout"
  | "internal";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

/** First frame the client sends; the server replies with {@link AuthResultMessage}. */
export interface AuthMessage {
  kind: "auth";
  token: string;
  protocolVersion: number;
  clientName?: string;
}

export interface AuthResultMessage {
  kind: "auth_result";
  ok: boolean;
  error?: string;
  serverProtocolVersion: number;
}

export interface RequestMessage<M extends BridgeMethod = BridgeMethod> {
  kind: "request";
  id: string;
  method: M;
  params: MethodParams[M];
}

export interface SuccessResponse<M extends BridgeMethod = BridgeMethod> {
  kind: "response";
  id: string;
  ok: true;
  result: MethodResult[M];
}

export interface ErrorResponse {
  kind: "response";
  id: string;
  ok: false;
  error: BridgeError;
}

export type ResponseMessage = SuccessResponse | ErrorResponse;

/** Messages sent from the MCP server to the Rust bridge. */
export type ClientMessage = AuthMessage | RequestMessage;

/** Messages sent from the Rust bridge to the MCP server. */
export type ServerMessage = AuthResultMessage | ResponseMessage;

/** Contents of the {@link BRIDGE_INFO_FILENAME} discovery file. */
export interface BridgeInfo {
  port: number;
  token: string;
  /** PID of the running app, for liveness checks. */
  pid: number;
  protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by the adapter and the MCP server)
// ---------------------------------------------------------------------------

export const MIN_PIXEL_RATIO = 1;
export const MAX_PIXEL_RATIO = 2;

/** Clamp a requested export pixel ratio to the supported range. */
export function clampPixelRatio(value: number | undefined, fallback = 2): number {
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, value));
}

/** Type guard: is `value` one of the known bridge methods? */
export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && (BRIDGE_METHODS as readonly string[]).includes(value);
}

/** True when `value` is one of tldraw's known colors. */
export function isTldrawColor(value: unknown): value is TldrawColor {
  return typeof value === "string" && (TLDRAW_COLORS as readonly string[]).includes(value);
}
