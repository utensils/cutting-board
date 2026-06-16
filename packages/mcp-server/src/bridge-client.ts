// WebSocket bridge client for the cutting-board MCP server.
//
// This module knows how to:
//   - discover the running app via its `bridge.json` discovery file,
//   - connect over loopback WebSocket and authenticate,
//   - send framed requests and correlate responses by id,
//   - reconnect with backoff (Claude Code does not auto-reconnect stdio servers),
//   - surface a typed `AppNotRunningError` when the app is unavailable.
//
// It never imports tldraw; it only ships protocol-typed bridge requests.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  APP_IDENTIFIER,
  BRIDGE_INFO_FILENAME,
  PROTOCOL_VERSION,
  type BridgeError,
  type BridgeInfo,
  type BridgeMethod,
  type MethodParams,
  type MethodResult,
  type ServerMessage,
} from "@cutting-board/protocol";
import WebSocket from "ws";

const CLIENT_NAME = "cutting-board-mcp";
const REQUEST_TIMEOUT_MS = 10_000;
const AUTO_LAUNCH_POLL_MS = 8_000;
const AUTO_LAUNCH_INTERVAL_MS = 250;

/** Public contract the MCP server depends on; lets tests inject a fake. */
export interface BridgeClient {
  request<M extends BridgeMethod>(method: M, params: MethodParams[M]): Promise<MethodResult[M]>;
  close(): void;
}

/**
 * Thrown when the app cannot be reached (no discovery file, connection
 * refused, or auth failed). The MCP tool layer converts this into a friendly
 * `isError` result instead of crashing the server.
 */
export class AppNotRunningError extends Error {
  constructor(message = APP_NOT_RUNNING_MESSAGE) {
    super(message);
    this.name = "AppNotRunningError";
  }
}

/** Thrown when the bridge replies with `{ ok: false, error }`. */
export class BridgeRequestError extends Error {
  readonly code: BridgeError["code"];
  constructor(error: BridgeError) {
    super(error.message);
    this.name = "BridgeRequestError";
    this.code = error.code;
  }
}

export const APP_NOT_RUNNING_MESSAGE =
  "Cutting Board isn't running — open it from the menu bar and try again.";

/** Resolve the absolute path to the discovery file. */
export function discoveryFilePath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    APP_IDENTIFIER,
    BRIDGE_INFO_FILENAME,
  );
}

/** Read and parse the discovery file, or return null if it is absent/garbage. */
export async function readBridgeInfo(filePath = discoveryFilePath()): Promise<BridgeInfo | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isBridgeInfo(parsed)) return null;
  return parsed;
}

function isBridgeInfo(value: unknown): value is BridgeInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.port === "number" &&
    typeof v.token === "string" &&
    typeof v.pid === "number" &&
    typeof v.protocolVersion === "number"
  );
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal subset of the `ws` socket the client relies on (for testability). */
export interface SocketLike {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface WsBridgeClientOptions {
  /** Override discovery (tests). Defaults to reading the on-disk bridge.json. */
  loadBridgeInfo?: () => Promise<BridgeInfo | null>;
  /** Override the socket factory (tests). Defaults to real `ws`. */
  createSocket?: (url: string) => SocketLike;
  /** Attempt `open -a "Cutting Board"` when discovery fails. */
  autoLaunch?: boolean;
  requestTimeoutMs?: number;
  /** Logger; defaults to stderr so stdout stays pure JSON-RPC. */
  log?: (message: string) => void;
}

/**
 * Reconnecting WebSocket bridge client. A single shared connection is reused
 * across requests; if it drops, the next request triggers a reconnect with
 * exponential backoff.
 */
export class WsBridgeClient implements BridgeClient {
  private readonly loadBridgeInfo: () => Promise<BridgeInfo | null>;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly autoLaunch: boolean;
  private readonly requestTimeoutMs: number;
  private readonly log: (message: string) => void;

  private socket: SocketLike | null = null;
  private connecting: Promise<SocketLike> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private closed = false;
  private counter = 0;

  constructor(options: WsBridgeClientOptions = {}) {
    this.loadBridgeInfo = options.loadBridgeInfo ?? readBridgeInfo;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.autoLaunch = options.autoLaunch ?? process.env.CUTTING_BOARD_AUTO_LAUNCH === "1";
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.log = options.log ?? ((m) => process.stderr.write(`[bridge] ${m}\n`));
  }

  async request<M extends BridgeMethod>(
    method: M,
    params: MethodParams[M],
  ): Promise<MethodResult[M]> {
    const socket = await this.ensureConnected();
    const id = this.nextId();

    return new Promise<MethodResult[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRequestError({ code: "timeout", message: `request ${method} timed out` }));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        socket.send(JSON.stringify({ kind: "request", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge client closed"));
      this.pending.delete(id);
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  private nextId(): string {
    this.counter += 1;
    return `r${this.counter}-${randomUUID()}`;
  }

  /** Return the live socket, connecting (and authenticating) if necessary. */
  private async ensureConnected(): Promise<SocketLike> {
    if (this.closed) throw new Error("bridge client closed");
    if (this.socket) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectWithBackoff().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithBackoff(): Promise<SocketLike> {
    // First attempt; on transient failure, retry with backoff a few times.
    const maxAttempts = 4;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const socket = await this.connectOnce();
        this.reconnectAttempt = 0;
        return socket;
      } catch (err) {
        lastError = err;
        // App-not-running is not worth retrying many times — fail fast after
        // an optional auto-launch attempt on the first miss.
        if (err instanceof AppNotRunningError) {
          if (this.autoLaunch && attempt === 0) {
            this.log("app not running; attempting auto-launch");
            const launched = await this.tryAutoLaunch();
            if (launched) continue;
          }
          throw err;
        }
        const delay = Math.min(2_000, 200 * 2 ** this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.log(`connect failed (${String(err)}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new AppNotRunningError();
  }

  private async connectOnce(): Promise<SocketLike> {
    const info = await this.loadBridgeInfo();
    if (!info) throw new AppNotRunningError();

    const url = `ws://127.0.0.1:${info.port}`;
    const socket = this.createSocket(url);

    return new Promise<SocketLike>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      socket.on("error", () => {
        // Connection refused / app gone: treat as not running.
        fail(new AppNotRunningError());
      });

      socket.on("close", () => {
        if (!settled) {
          fail(new AppNotRunningError());
          return;
        }
        // Established socket dropped: clear it so the next request reconnects.
        this.handleDisconnect();
      });

      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            kind: "auth",
            token: info.token,
            protocolVersion: PROTOCOL_VERSION,
            clientName: CLIENT_NAME,
          }),
        );
      });

      socket.on("message", (data: unknown) => {
        const message = parseServerMessage(data);
        if (!message) return;

        if (!settled) {
          // First message must be the auth_result.
          if (message.kind !== "auth_result") return;
          if (!message.ok) {
            fail(new AppNotRunningError(`bridge auth failed: ${message.error ?? "unauthorized"}`));
            return;
          }
          settled = true;
          this.socket = socket;
          resolve(socket);
          return;
        }

        if (message.kind === "response") {
          this.handleResponse(message);
        }
      });
    });
  }

  private handleResponse(message: Extract<ServerMessage, { kind: "response" }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new BridgeRequestError(message.error));
    }
  }

  private handleDisconnect(): void {
    this.socket = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AppNotRunningError("bridge connection lost"));
      this.pending.delete(id);
    }
  }

  private async tryAutoLaunch(): Promise<boolean> {
    try {
      spawn("open", ["-b", APP_IDENTIFIER], { stdio: "ignore", detached: true }).unref();
    } catch (err) {
      this.log(`auto-launch failed: ${String(err)}`);
      return false;
    }
    const deadline = Date.now() + AUTO_LAUNCH_POLL_MS;
    while (Date.now() < deadline) {
      await sleep(AUTO_LAUNCH_INTERVAL_MS);
      const info = await this.loadBridgeInfo();
      if (info) return true;
    }
    return false;
  }
}

function parseServerMessage(data: unknown): ServerMessage | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof Buffer) {
    text = data.toString("utf8");
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString("utf8");
  } else {
    text = String(data);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
      return parsed as ServerMessage;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
