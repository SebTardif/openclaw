import {
  SSEClientTransport,
  SseError,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CancelledNotificationSchema,
  isJSONRPCRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_CATALOG_MAX_BYTES } from "./mcp-catalog-limits.js";

const STREAM_RETRY_EXHAUSTED_RE = /^Maximum reconnection attempts \(\d+\) exceeded\.$/;
const SESSION_TERMINATION_TIMEOUT_MS = 5_000;

class McpHttpResponseTooLargeError extends Error {
  readonly code = "MCP_HTTP_RESPONSE_TOO_LARGE";

  constructor(unit: "SSE event" | "tools/list response") {
    super(`MCP ${unit} exceeds ${MCP_CATALOG_MAX_BYTES} bytes`);
    this.name = "McpHttpResponseTooLargeError";
  }
}

function isWrappedMcpHttpResponseTooLargeError(error: Error): boolean {
  return (
    !(error instanceof McpHttpResponseTooLargeError) &&
    error.message.includes(`${McpHttpResponseTooLargeError.name}:`)
  );
}

function isToolsListRequest(init?: RequestInit): boolean {
  // SDK 1.30.0 serializes JSON-RPC POST bodies before it calls the injected fetch.
  if (typeof init?.body !== "string") {
    return false;
  }
  try {
    const value: unknown = JSON.parse(init.body);
    const messages = Array.isArray(value) ? value : [value];
    return messages.some((message) => isJSONRPCRequest(message) && message.method === "tools/list");
  } catch {
    return false;
  }
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

const JSON_RPC_ID_MAX_CHARS = 256;

// Find the top-level JSON-RPC id without materializing the event. An id that
// arrives late stays under the catalog cap, so field ordering cannot bypass it.
class JsonRpcEventIdScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringRole: "id" | "key" | "other" = "other";
  private stringValue = "";
  private key: string | undefined;
  private expectsKey = false;
  private expectsId = false;
  private numberId = "";
  private requestId: string | number | undefined;

  push(byte: number): string | number | undefined {
    const character = String.fromCharCode(byte);
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        this.stringValue += character;
      } else if (character === "\\") {
        this.escaped = true;
        this.stringValue += character;
      } else if (character === '"') {
        this.finishString();
      } else if (this.stringValue.length < JSON_RPC_ID_MAX_CHARS) {
        this.stringValue += character;
      } else {
        this.stringRole = "other";
      }
      return this.requestId;
    }
    if (this.numberId) {
      if (/[-\d]/.test(character)) {
        this.numberId += character;
        return undefined;
      }
      const requestId = Number(this.numberId);
      this.numberId = "";
      if (Number.isSafeInteger(requestId)) {
        this.requestId = requestId;
      }
    }
    if (character === '"') {
      this.inString = true;
      this.stringRole =
        this.depth === 1 && this.expectsKey
          ? "key"
          : this.depth === 1 && this.expectsId
            ? "id"
            : "other";
      this.stringValue = "";
      return this.requestId;
    }
    if (this.depth === 1 && this.expectsId && /[-\d]/.test(character)) {
      this.numberId = character;
      this.expectsId = false;
      return undefined;
    }
    if (character === "{") {
      this.depth += 1;
      if (this.depth === 1) {
        this.expectsKey = true;
      }
    } else if (character === "}") {
      this.depth -= 1;
    } else if (character === ":" && this.depth === 1) {
      this.expectsId = this.key === "id";
      this.key = undefined;
    } else if (character === "," && this.depth === 1) {
      this.expectsKey = true;
      this.expectsId = false;
    }
    return this.requestId;
  }

  private finishString(): void {
    this.inString = false;
    if (this.stringRole === "key") {
      try {
        this.key = JSON.parse(`"${this.stringValue}"`) as string;
      } catch {
        this.key = undefined;
      }
      this.expectsKey = false;
    } else if (this.stringRole === "id") {
      try {
        const value: unknown = JSON.parse(`"${this.stringValue}"`);
        if (typeof value === "string") {
          this.requestId = value;
        }
      } catch {
        this.requestId = undefined;
      }
      this.expectsId = false;
    }
    this.stringRole = "other";
    this.stringValue = "";
  }
}

function limitMcpResponseStream(params: {
  body: ReadableStream<Uint8Array>;
  maxBodyBytes?: number;
  maxEventBytes?: number;
  shouldLimitEvent?: (requestId: string | number | undefined) => boolean;
}): ReadableStream<Uint8Array> {
  let bodyBytes = 0;
  let eventBytes = 0;
  let lineHasContent = false;
  let previousByteWasCr = false;
  let dataPrefixIndex = 0;
  let dataLine = false;
  let skipDataSpace = false;
  let eventHasData = false;
  let eventRequestId: string | number | undefined;
  let idScanner = new JsonRpcEventIdScanner();

  return params.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bodyBytes += chunk.byteLength;
        if (params.maxBodyBytes !== undefined && bodyBytes > params.maxBodyBytes) {
          throw new McpHttpResponseTooLargeError("tools/list response");
        }

        if (params.maxEventBytes !== undefined && params.shouldLimitEvent?.(undefined) === true) {
          for (const byte of chunk) {
            eventBytes += 1;
            if (previousByteWasCr && byte === 0x0a) {
              previousByteWasCr = false;
            } else if (byte === 0x0d || byte === 0x0a) {
              if (dataLine) {
                eventRequestId = idScanner.push(0x0a) ?? eventRequestId;
              }
              if (lineHasContent) {
                lineHasContent = false;
              } else {
                eventBytes = 0;
                eventHasData = false;
                eventRequestId = undefined;
                idScanner = new JsonRpcEventIdScanner();
              }
              previousByteWasCr = byte === 0x0d;
              dataPrefixIndex = 0;
              dataLine = false;
              skipDataSpace = false;
            } else {
              lineHasContent = true;
              previousByteWasCr = false;
              if (!dataLine && dataPrefixIndex >= 0) {
                if (byte === "data:".charCodeAt(dataPrefixIndex)) {
                  dataPrefixIndex += 1;
                  if (dataPrefixIndex === 5) {
                    dataLine = true;
                    eventHasData = true;
                    skipDataSpace = true;
                  }
                } else {
                  dataPrefixIndex = -1;
                }
              } else if (dataLine && skipDataSpace && byte === 0x20) {
                skipDataSpace = false;
              } else if (dataLine) {
                skipDataSpace = false;
                eventRequestId = idScanner.push(byte) ?? eventRequestId;
              }
            }
            if (
              eventHasData &&
              params.shouldLimitEvent(eventRequestId) &&
              eventBytes > params.maxEventBytes
            ) {
              throw new McpHttpResponseTooLargeError("SSE event");
            }
          }
        } else {
          eventBytes = 0;
          lineHasContent = false;
          previousByteWasCr = false;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function limitMcpHttpResponse(
  response: Response,
  init: RequestInit | undefined,
  catalogRequestIds: ReadonlySet<string | number>,
): Response {
  if (!response.body) {
    return response;
  }
  const eventStream = isEventStreamResponse(response);
  const catalogResponse = isToolsListRequest(init);
  const maxBodyBytes = catalogResponse && !eventStream ? MCP_CATALOG_MAX_BYTES : undefined;
  const maxEventBytes = eventStream ? MCP_CATALOG_MAX_BYTES : undefined;
  if (maxBodyBytes === undefined && maxEventBytes === undefined) {
    return response;
  }
  return new Response(
    limitMcpResponseStream({
      body: response.body,
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
      ...(eventStream
        ? {
            // Legacy SSE multiplexes responses on one stream. Match the event id
            // so a concurrent large tool result does not inherit the catalog cap.
            shouldLimitEvent: (requestId: string | number | undefined) =>
              catalogResponse ||
              (requestId === undefined
                ? catalogRequestIds.size > 0
                : catalogRequestIds.has(requestId)),
          }
        : {}),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

function withMcpHttpResponseLimits(
  fetchFn: FetchLike,
  catalogRequestIds: ReadonlySet<string | number>,
): FetchLike {
  return async (input, init) =>
    limitMcpHttpResponse(await fetchFn(input, init), init, catalogRequestIds);
}

abstract class OpenClawMcpHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protected closed = false;
  private closeEmitted = false;
  protected readonly catalogRequestIds = new Set<string | number>();

  protected emitClose(): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.catalogRequestIds.clear();
    this.onclose?.();
  }

  protected emitError(error: Error): void {
    if (!this.closed) {
      this.onerror?.(error);
    }
  }

  protected trackCatalogRequest(message: JSONRPCMessage): string | number | undefined {
    if (isJSONRPCRequest(message) && message.method === "tools/list") {
      this.catalogRequestIds.add(message.id);
      return message.id;
    }
    const cancelled = CancelledNotificationSchema.safeParse(message);
    if (cancelled.success) {
      this.catalogRequestIds.delete(cancelled.data.params.requestId);
    }
    return undefined;
  }

  protected emitMessage(message: JSONRPCMessage): void {
    if ("id" in message) {
      this.catalogRequestIds.delete(message.id);
    }
    this.onmessage?.(message);
  }

  protected async sendTracked(message: JSONRPCMessage, send: () => Promise<void>): Promise<void> {
    const catalogRequestId = this.trackCatalogRequest(message);
    try {
      await send();
    } catch (error) {
      if (catalogRequestId !== undefined) {
        this.catalogRequestIds.delete(catalogRequestId);
      }
      throw error;
    }
  }

  abstract start(): Promise<void>;
  abstract close(): Promise<void>;
  abstract send(message: JSONRPCMessage): Promise<void>;
}

/** Converts legacy SSE terminal HTTP failures into the lifecycle close the SDK omits. */
export class OpenClawSSEClientTransport extends OpenClawMcpHttpTransport {
  private readonly transport: SSEClientTransport;

  constructor(url: URL, options?: SSEClientTransportOptions) {
    super();
    const limitedFetch = withMcpHttpResponseLimits(options?.fetch ?? fetch, this.catalogRequestIds);
    const eventSourceInit = options?.eventSourceInit;
    const configuredEventSourceFetch = eventSourceInit?.fetch;
    this.transport = new SSEClientTransport(url, {
      ...options,
      fetch: limitedFetch,
      ...(eventSourceInit
        ? {
            eventSourceInit: {
              ...eventSourceInit,
              fetch: configuredEventSourceFetch
                ? withMcpHttpResponseLimits(
                    (input, init) =>
                      configuredEventSourceFetch(
                        input instanceof Request ? input.url : input,
                        init,
                      ),
                    this.catalogRequestIds,
                  )
                : limitedFetch,
            },
          }
        : {}),
    });
  }

  async start(): Promise<void> {
    // The SDK transport exposes callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onmessage = (message) => this.emitMessage(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onclose = () => this.emitClose();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onerror = (error) => {
      this.emitError(error);
      if (
        isWrappedMcpHttpResponseTooLargeError(error) ||
        (error instanceof SseError && error.code !== undefined)
      ) {
        void this.close();
      }
    };
    await this.transport.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.emitClose();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error("MCP SSE transport is closed");
    }
    await this.sendTracked(message, async () => await this.transport.send(message));
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion(version);
  }
}

type OpenClawStreamableHttpOptions = StreamableHTTPClientTransportOptions & {
  fetch?: FetchLike;
  requestInit?: RequestInit;
};

/** Owns Streamable HTTP notification recovery and stateful cleanup around SDK 1.30.0. */
export class OpenClawStreamableHTTPClientTransport extends OpenClawMcpHttpTransport {
  private readonly transport: StreamableHTTPClientTransport;
  private readonly url: URL;
  private readonly cleanupFetch: FetchLike;
  private readonly requestInit?: RequestInit;
  private pendingExpiredNotificationGet = false;
  private terminatedSessionId?: string;

  constructor(url: URL, options: OpenClawStreamableHttpOptions = {}) {
    super();
    this.url = url;
    this.cleanupFetch = options.fetch ?? fetch;
    this.requestInit = options.requestInit;
    const runtimeFetch: FetchLike = async (input, init) => {
      if (this.closed) {
        throw new Error("MCP Streamable HTTP transport is closed");
      }
      const response = limitMcpHttpResponse(
        await this.cleanupFetch(input, init),
        init,
        this.catalogRequestIds,
      );
      if (init?.method === "GET" && response.status === 404 && this.sessionId !== undefined) {
        this.pendingExpiredNotificationGet = true;
      }
      return response;
    };
    this.transport = new StreamableHTTPClientTransport(url, {
      ...options,
      fetch: runtimeFetch,
    });
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  get protocolVersion(): string | undefined {
    return this.transport.protocolVersion;
  }

  async start(): Promise<void> {
    // The SDK transport exposes callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onmessage = (message) => this.emitMessage(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onclose = () => this.emitClose();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onerror = (error) => {
      if (this.closed) {
        // SDK reconnect callbacks can finish after close() cleared their old timer.
        // Defer a second close so any timer armed later in that callback is cancelled.
        setTimeout(() => void this.transport.close(), 0).unref?.();
        return;
      }
      this.emitError(error);
      const sessionExpired =
        this.pendingExpiredNotificationGet &&
        error instanceof StreamableHTTPError &&
        error.code === 404;
      if (sessionExpired) {
        this.pendingExpiredNotificationGet = false;
      }
      if (
        isWrappedMcpHttpResponseTooLargeError(error) ||
        sessionExpired ||
        STREAM_RETRY_EXHAUSTED_RE.test(error.message)
      ) {
        void this.close();
      }
    };
    await this.transport.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.emitClose();
  }

  async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    await this.sendTracked(message, async () => await this.transport.send(message, options));
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion(version);
  }

  /** Uses a fresh request signal because failed initialization makes the SDK's signal unusable. */
  async terminateSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || sessionId === this.terminatedSessionId) {
      return;
    }
    const headers = new Headers(this.requestInit?.headers);
    headers.set("mcp-session-id", sessionId);
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    const response = await this.cleanupFetch(this.url, {
      ...this.requestInit,
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(SESSION_TERMINATION_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 405) {
      throw new StreamableHTTPError(
        response.status,
        `Failed to terminate session: ${response.statusText}`,
      );
    }
    this.terminatedSessionId = sessionId;
  }
}
