import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Editor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  tipTapDefaultExtensions,
  defaultAddFontsFromNode,
  type TLShapeId,
} from "tldraw";
import {
  createSticky,
  createGeoShape,
  createConnector,
  updateShape,
  moveShape,
  deleteShape,
  clearBoard,
  listShapes,
  getStatus,
  getBoardSnapshot,
  executeBridgeOp,
  BridgeOpError,
} from "../src/board/tldraw-ops";

function makeEditor(): Editor {
  const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils });
  return new Editor({
    store,
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    getContainer: () => document.createElement("div"),
    // Mirror the text options <Tldraw> sets so rich-text measurement works.
    textOptions: {
      addFontsFromNode: defaultAddFontsFromNode,
      tipTapConfig: { extensions: tipTapDefaultExtensions },
    },
  });
}

let editor: Editor;
beforeEach(() => {
  editor = makeEditor();
});
afterEach(() => {
  editor.dispose();
});

const get = (id: string) => editor.getShape(id as TLShapeId);

describe("createSticky", () => {
  it("creates a note shape with color and text", () => {
    const id = createSticky(editor, { text: "hello", color: "orange" });
    const shape = get(id)!;
    expect(shape.type).toBe("note");
    expect((shape.props as { color: string }).color).toBe("orange");
  });

  it("falls back to the default color for an unknown color", () => {
    const id = createSticky(editor, { color: "chartreuse" as never });
    expect((get(id)!.props as { color: string }).color).toBe("yellow");
  });
});

describe("createGeoShape", () => {
  it("creates the requested geometry", () => {
    const id = createGeoShape(editor, { shape: "ellipse", color: "blue" });
    const shape = get(id)!;
    expect(shape.type).toBe("geo");
    expect((shape.props as { geo: string }).geo).toBe("ellipse");
  });

  it("falls back to rectangle for an unknown shape", () => {
    const id = createGeoShape(editor, { shape: "octagon" as never });
    expect((get(id)!.props as { geo: string }).geo).toBe("rectangle");
  });
});

describe("createConnector", () => {
  it("binds an arrow to both endpoints", () => {
    const a = createGeoShape(editor, { shape: "rectangle", x: 0, y: 0 });
    const b = createGeoShape(editor, { shape: "rectangle", x: 400, y: 0 });
    const arrowId = createConnector(editor, { fromId: a, toId: b });
    expect(get(arrowId)!.type).toBe("arrow");
    const bindings = editor.getBindingsFromShape(arrowId as TLShapeId, "arrow");
    expect(bindings).toHaveLength(2);
    const terminals = bindings.map((bnd) => (bnd.props as { terminal: string }).terminal).sort();
    expect(terminals).toEqual(["end", "start"]);
  });

  it("throws not_found when an endpoint is missing", () => {
    const a = createGeoShape(editor, { shape: "rectangle" });
    try {
      createConnector(editor, { fromId: a, toId: "shape:missing" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeOpError);
      expect((err as BridgeOpError).code).toBe("not_found");
    }
  });
});

describe("update/move/delete", () => {
  it("returns false for missing shapes (graceful no-op)", () => {
    expect(updateShape(editor, { id: "shape:nope" })).toBe(false);
    expect(moveShape(editor, { id: "shape:nope", x: 0, y: 0 })).toBe(false);
    expect(deleteShape(editor, "shape:nope")).toBe(false);
  });

  it("moves and deletes a real shape", () => {
    const id = createGeoShape(editor, { shape: "rectangle" });
    expect(moveShape(editor, { id, x: 123, y: 456 })).toBe(true);
    const moved = get(id)!;
    expect(moved.x).toBe(123);
    expect(moved.y).toBe(456);
    expect(deleteShape(editor, id)).toBe(true);
    expect(get(id)).toBeUndefined();
  });

  it("updates color and text", () => {
    const id = createGeoShape(editor, { shape: "rectangle" });
    expect(updateShape(editor, { id, color: "red", text: "label" })).toBe(true);
    expect((get(id)!.props as { color: string }).color).toBe("red");
  });
});

describe("reads", () => {
  it("clearBoard removes everything and reports the count", () => {
    createSticky(editor, {});
    createGeoShape(editor, { shape: "rectangle" });
    const removed = clearBoard(editor);
    expect(removed).toBe(2);
    expect(editor.getCurrentPageShapeIds().size).toBe(0);
  });

  it("listShapes summarizes shapes including text", () => {
    createSticky(editor, { text: "note text" });
    const shapes = listShapes(editor);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.type).toBe("note");
    expect(shapes[0]!.text).toBe("note text");
  });

  it("getStatus and getBoardSnapshot report the shape count", () => {
    createGeoShape(editor, { shape: "rectangle" });
    expect(getStatus(editor).shapeCount).toBe(1);
    expect(getBoardSnapshot(editor).shapeCount).toBe(1);
  });
});

describe("updateShape props escape hatch", () => {
  it("merges raw props and moves via x/y", () => {
    const id = createGeoShape(editor, { shape: "rectangle", w: 100, h: 100 });
    expect(updateShape(editor, { id, props: { w: 321 } })).toBe(true);
    expect((get(id)!.props as { w: number }).w).toBe(321);
    expect(updateShape(editor, { id, x: 10, y: 20 })).toBe(true);
    const moved = get(id)!;
    expect(moved.x).toBe(10);
    expect(moved.y).toBe(20);
  });

  it("ignores an invalid top-level color but still applies raw props", () => {
    const id = createGeoShape(editor, { shape: "rectangle", color: "blue" });
    expect(updateShape(editor, { id, color: "chartreuse" as never, props: { w: 222 } })).toBe(true);
    const shape = get(id)!;
    expect((shape.props as { color: string }).color).toBe("blue");
    expect((shape.props as { w: number }).w).toBe(222);
  });
});

describe("executeBridgeOp", () => {
  it("wraps each op result in the documented response shape", async () => {
    expect(await executeBridgeOp(editor, "add_sticky", { text: "hi" })).toMatchObject({
      id: expect.any(String),
    });
    const shape = (await executeBridgeOp(editor, "add_shape", { shape: "rectangle" })) as { id: string };
    expect(typeof shape.id).toBe("string");
    expect(await executeBridgeOp(editor, "list_shapes", {})).toHaveProperty("shapes");
    expect(await executeBridgeOp(editor, "update_shape", { id: shape.id, x: 5, y: 5 })).toEqual({ ok: true });
    expect(await executeBridgeOp(editor, "move_shape", { id: "shape:gone", x: 0, y: 0 })).toEqual({ ok: false });
    expect(await executeBridgeOp(editor, "clear_board", {})).toMatchObject({
      deletedCount: expect.any(Number),
    });
  });

  it("rejects an unknown method with code unsupported_method", async () => {
    await expect(executeBridgeOp(editor, "frobnicate", {})).rejects.toMatchObject({
      code: "unsupported_method",
    });
  });
});
