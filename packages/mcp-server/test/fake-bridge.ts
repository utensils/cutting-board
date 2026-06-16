// A tiny in-memory board model implementing the BridgeClient contract, so the
// server tools can be exercised end-to-end without a real app.

import type {
  BridgeError,
  BridgeMethod,
  MethodParams,
  MethodResult,
  ShapeSummary,
} from "@cutting-board/protocol";

import { AppNotRunningError, BridgeRequestError, type BridgeClient } from "../src/bridge-client.js";

interface FakeShape extends ShapeSummary {}

export class FakeBridge implements BridgeClient {
  private shapes = new Map<string, FakeShape>();
  private seq = 0;
  /** When true, every request rejects as if the app were closed. */
  notRunning = false;
  /** When set, every request rejects with this typed bridge error. */
  failWith?: BridgeError;

  private id(prefix: string): string {
    this.seq += 1;
    return `shape:${prefix}${this.seq}`;
  }

  async request<M extends BridgeMethod>(
    method: M,
    params: MethodParams[M],
  ): Promise<MethodResult[M]> {
    if (this.notRunning) throw new AppNotRunningError();
    if (this.failWith) throw new BridgeRequestError(this.failWith);
    const result = this.handle(method, params as Record<string, unknown>);
    return result as MethodResult[M];
  }

  close(): void {
    // no-op
  }

  private handle(method: BridgeMethod, params: Record<string, unknown>): unknown {
    switch (method) {
      case "get_status":
        return {
          ready: true,
          windowVisible: true,
          shapeCount: this.shapes.size,
          productVersion: "0.1.0-test",
        };
      case "get_board_snapshot":
        return {
          snapshot: { schema: 1, shapes: [...this.shapes.values()] },
          shapeCount: this.shapes.size,
        };
      case "list_shapes":
        return { shapes: [...this.shapes.values()] };
      case "get_board_image":
        // 1x1 transparent PNG, raw base64 (no data: prefix).
        return {
          pngBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          width: 1,
          height: 1,
        };
      case "add_sticky": {
        const id = this.id("note");
        this.shapes.set(id, {
          id,
          type: "note",
          x: (params.x as number) ?? 0,
          y: (params.y as number) ?? 0,
          text: params.text as string | undefined,
          color: params.color as string | undefined,
        });
        return { id };
      }
      case "add_shape": {
        const id = this.id("geo");
        this.shapes.set(id, {
          id,
          type: "geo",
          geo: params.shape as string,
          x: (params.x as number) ?? 0,
          y: (params.y as number) ?? 0,
          w: params.w as number | undefined,
          h: params.h as number | undefined,
          text: params.text as string | undefined,
          color: params.color as string | undefined,
        });
        return { id };
      }
      case "add_connector": {
        const id = this.id("arrow");
        this.shapes.set(id, {
          id,
          type: "arrow",
          x: 0,
          y: 0,
          text: params.text as string | undefined,
          color: params.color as string | undefined,
        });
        return { id };
      }
      case "update_shape": {
        const shape = this.shapes.get(params.id as string);
        if (!shape) return { ok: false };
        if (params.x != null) shape.x = params.x as number;
        if (params.y != null) shape.y = params.y as number;
        if (params.text != null) shape.text = params.text as string;
        if (params.color != null) shape.color = params.color as string;
        return { ok: true };
      }
      case "move_shape": {
        const shape = this.shapes.get(params.id as string);
        if (!shape) return { ok: false };
        shape.x = params.x as number;
        shape.y = params.y as number;
        return { ok: true };
      }
      case "delete_shape": {
        const existed = this.shapes.delete(params.id as string);
        return { ok: existed };
      }
      case "clear_board": {
        const deletedCount = this.shapes.size;
        this.shapes.clear();
        return { deletedCount };
      }
      default:
        throw new Error(`unhandled method ${method}`);
    }
  }
}
