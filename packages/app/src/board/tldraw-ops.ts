/**
 * Pure operations against a live tldraw {@link Editor}. These translate bridge
 * methods (and the Done export) into editor calls, and are unit-tested against
 * a headless Editor. They never touch React or Tauri — that wiring lives in the
 * bridge adapter and the Board component.
 */
import {
  type Editor,
  type TLShapeId,
  type TLShape,
  createShapeId,
  toRichText,
  getSnapshot,
} from "tldraw";
import {
  type AddStickyParams,
  type AddShapeParams,
  type AddConnectorParams,
  type UpdateShapeParams,
  type MoveShapeParams,
  type GetBoardImageParams,
  type ShapeSummary,
  type StatusResult,
  type SnapshotResult,
  type BoardImageResult,
  type BridgeErrorCode,
  GEO_SHAPES,
  isTldrawColor,
  clampPixelRatio,
} from "@cutting-board/protocol";
import { uint8ToBase64 } from "../lib/base64";
import { plainTextFromRichText } from "../lib/richtext";
import {
  APP_VERSION,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_SIZE,
  DEFAULT_STICKY_COLOR,
} from "../lib/constants";

/** Error carrying a bridge error code, surfaced to the MCP client. */
export class BridgeOpError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeOpError";
  }
}

const asShapeId = (id: string) => id as TLShapeId;

/** Center of the current viewport, the default drop point for new shapes. */
function viewportCenter(editor: Editor): { x: number; y: number } {
  const bounds = editor.getViewportPageBounds();
  return { x: bounds.center.x, y: bounds.center.y };
}

const colorOr = (value: string | undefined, fallback: string) =>
  value && isTldrawColor(value) ? value : fallback;

// --- Mutations --------------------------------------------------------------

export function createSticky(editor: Editor, params: AddStickyParams): string {
  const id = createShapeId();
  const center = viewportCenter(editor);
  editor.createShape({
    id,
    type: "note",
    x: params.x ?? center.x - 100,
    y: params.y ?? center.y - 100,
    props: {
      color: colorOr(params.color, DEFAULT_STICKY_COLOR),
      richText: toRichText(params.text ?? ""),
    },
  });
  return id;
}

export function createGeoShape(editor: Editor, params: AddShapeParams): string {
  const id = createShapeId();
  const center = viewportCenter(editor);
  const w = params.w ?? DEFAULT_SHAPE_SIZE.w;
  const h = params.h ?? DEFAULT_SHAPE_SIZE.h;
  const geo = (GEO_SHAPES as readonly string[]).includes(params.shape)
    ? params.shape
    : "rectangle";
  editor.createShape({
    id,
    type: "geo",
    x: params.x ?? center.x - w / 2,
    y: params.y ?? center.y - h / 2,
    props: {
      geo,
      w,
      h,
      color: colorOr(params.color, DEFAULT_SHAPE_COLOR),
      fill: params.fill ?? "none",
      richText: toRichText(params.text ?? ""),
    },
  });
  return id;
}

/**
 * Create an arrow that BINDS to both endpoints, so it re-routes when either
 * shape moves. Just setting start/end points would not bind it.
 */
export function createConnector(editor: Editor, params: AddConnectorParams): string {
  const from = editor.getShape(asShapeId(params.fromId));
  const to = editor.getShape(asShapeId(params.toId));
  if (!from) throw new BridgeOpError("not_found", `no shape ${params.fromId}`);
  if (!to) throw new BridgeOpError("not_found", `no shape ${params.toId}`);

  const fromBounds = editor.getShapePageBounds(from.id);
  const toBounds = editor.getShapePageBounds(to.id);

  const arrowId = createShapeId();
  editor.run(() => {
    editor.createShape({
      id: arrowId,
      type: "arrow",
      props: {
        color: colorOr(params.color, DEFAULT_SHAPE_COLOR),
        // Arrows use a plain `text` label (only note/geo use richText).
        text: params.text ?? "",
        // Initial geometry; the bindings below take over positioning.
        start: fromBounds ? { x: fromBounds.center.x, y: fromBounds.center.y } : { x: 0, y: 0 },
        end: toBounds ? { x: toBounds.center.x, y: toBounds.center.y } : { x: 100, y: 0 },
      },
    });
    editor.createBindings([
      {
        fromId: arrowId,
        toId: from.id,
        type: "arrow",
        props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      },
      {
        fromId: arrowId,
        toId: to.id,
        type: "arrow",
        props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      },
    ]);
  });
  return arrowId;
}

export function updateShape(editor: Editor, params: UpdateShapeParams): boolean {
  const shape = editor.getShape(asShapeId(params.id));
  if (!shape) return false;
  const props: Record<string, unknown> = { ...(params.props ?? {}) };
  if (params.color && isTldrawColor(params.color)) props.color = params.color;
  if (params.text !== undefined) props.richText = toRichText(params.text);
  editor.run(() => {
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      ...(params.x !== undefined ? { x: params.x } : {}),
      ...(params.y !== undefined ? { y: params.y } : {}),
      ...(Object.keys(props).length ? { props } : {}),
    });
  });
  return true;
}

export function moveShape(editor: Editor, params: MoveShapeParams): boolean {
  const shape = editor.getShape(asShapeId(params.id));
  if (!shape) return false;
  editor.updateShape({ id: shape.id, type: shape.type, x: params.x, y: params.y });
  return true;
}

export function deleteShape(editor: Editor, id: string): boolean {
  const shape = editor.getShape(asShapeId(id));
  if (!shape) return false;
  editor.deleteShapes([shape.id]);
  return true;
}

export function clearBoard(editor: Editor): number {
  const ids = [...editor.getCurrentPageShapeIds()];
  if (ids.length) editor.deleteShapes(ids);
  return ids.length;
}

// --- Reads ------------------------------------------------------------------

function toSummary(editor: Editor, shape: TLShape): ShapeSummary {
  const bounds = editor.getShapePageBounds(shape.id);
  const props = shape.props as Record<string, unknown>;
  const text =
    "richText" in props
      ? plainTextFromRichText(props.richText)
      : typeof props.text === "string"
        ? props.text
        : undefined;
  return {
    id: shape.id,
    type: shape.type,
    x: shape.x,
    y: shape.y,
    w: bounds?.w,
    h: bounds?.h,
    text: text || undefined,
    color: typeof props.color === "string" ? props.color : undefined,
    geo: typeof props.geo === "string" ? props.geo : undefined,
  };
}

export function listShapes(editor: Editor): ShapeSummary[] {
  return editor.getCurrentPageShapes().map((s) => toSummary(editor, s));
}

export function getStatus(editor: Editor): StatusResult {
  return {
    ready: true,
    windowVisible:
      typeof document !== "undefined" ? document.visibilityState === "visible" : true,
    shapeCount: editor.getCurrentPageShapeIds().size,
    productVersion: APP_VERSION,
  };
}

export function getBoardSnapshot(editor: Editor): SnapshotResult {
  const { document } = getSnapshot(editor.store);
  return {
    snapshot: document as unknown as Record<string, unknown>,
    shapeCount: editor.getCurrentPageShapeIds().size,
  };
}

/** Export the whole page to PNG bytes. Returns null when the board is empty. */
export async function exportBoardPng(
  editor: Editor,
  opts: { scale?: number; background?: boolean; padding?: number; darkMode?: boolean } = {},
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const ids = [...editor.getCurrentPageShapeIds()];
  if (ids.length === 0) return null;
  const result = await editor.toImage(ids, {
    format: "png",
    background: opts.background ?? true,
    scale: opts.scale ?? 2,
    padding: opts.padding ?? 16,
    darkMode: opts.darkMode ?? false,
  });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  return { bytes, width: result.width, height: result.height };
}

export async function getBoardImage(
  editor: Editor,
  params: GetBoardImageParams,
): Promise<BoardImageResult> {
  const exported = await exportBoardPng(editor, {
    scale: clampPixelRatio(params.pixelRatio),
    background: params.background,
    padding: params.padding,
    darkMode: params.darkMode,
  });
  if (!exported) throw new BridgeOpError("bad_request", "the board is empty");
  return {
    pngBase64: uint8ToBase64(exported.bytes),
    width: exported.width,
    height: exported.height,
  };
}

// --- Dispatch ---------------------------------------------------------------

/** Execute a single bridge method against the editor and return its result. */
export async function executeBridgeOp(
  editor: Editor,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "get_status":
      return getStatus(editor);
    case "get_board_snapshot":
      return getBoardSnapshot(editor);
    case "list_shapes":
      return { shapes: listShapes(editor) };
    case "get_board_image":
      return getBoardImage(editor, params as GetBoardImageParams);
    case "add_sticky":
      return { id: createSticky(editor, params as AddStickyParams) };
    case "add_shape":
      return { id: createGeoShape(editor, params as unknown as AddShapeParams) };
    case "add_connector":
      return { id: createConnector(editor, params as unknown as AddConnectorParams) };
    case "update_shape":
      return { ok: updateShape(editor, params as unknown as UpdateShapeParams) };
    case "move_shape":
      return { ok: moveShape(editor, params as unknown as MoveShapeParams) };
    case "delete_shape":
      return { ok: deleteShape(editor, String((params as { id: string }).id)) };
    case "clear_board":
      return { deletedCount: clearBoard(editor) };
    default:
      throw new BridgeOpError("unsupported_method", `unknown method: ${method}`);
  }
}
