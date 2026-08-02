export type BrowserLocation = {
  protocol: string;
  hostname: string;
  origin: string;
  desktopCapability?: string | null;
  desktopInvoke?: (command: string) => Promise<string | boolean | null>;
  fastTimers?: boolean;
  timerDelays?: number[];
};

export async function withBrowserEnvironment(locationValue: BrowserLocation, run: () => Promise<void>): Promise<void> {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const bridge = locationValue.desktopInvoke !== undefined
    ? { invoke: locationValue.desktopInvoke }
    : locationValue.desktopCapability === undefined
      ? undefined
      : {
          invoke: async (command: string) => command === "desktop_owned"
            ? locationValue.desktopCapability !== null
            : locationValue.desktopCapability!,
        };
  Object.defineProperty(globalThis, "location", { configurable: true, value: locationValue });
  const browserWindow = {
    __TAURI_INTERNALS__: bridge,
    setTimeout: (handler: TimerHandler, timeout?: number) => {
      locationValue.timerDelays?.push(timeout ?? 0);
      return globalThis.setTimeout(handler, locationValue.fastTimers ? Math.min(timeout ?? 0, 1) : timeout);
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
  };
  BareWebSocket.created.length = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BareWebSocket });
  try {
    await run();
  } finally {
    restoreProperty("location", locationDescriptor);
    restoreProperty("window", windowDescriptor);
    restoreProperty("WebSocket", webSocketDescriptor);
  }
}

export class BareWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly created: BareWebSocket[] = [];
  readyState = BareWebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(event: Event | MessageEvent | CloseEvent) => void>>();
  #closed = false;

  constructor(readonly url: string, readonly protocols?: string | string[]) { BareWebSocket.created.push(this); }
  static byPath(path: string): BareWebSocket[] { return BareWebSocket.created.filter((socket) => new URL(socket.url).pathname === path); }
  addEventListener(type: string, listener: (event: Event | MessageEvent | CloseEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  send(): void {}
  open(): void {
    if (this.#closed) return;
    this.readyState = BareWebSocket.OPEN;
    this.#emit("open", new Event("open"));
    if (new URL(this.url).pathname === "/api/v1/chat") {
      this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.ready", params: {} }) } as MessageEvent);
    }
  }
  close(code = 1000, reason = ""): void { this.serverClose(code, reason); }
  serverClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = BareWebSocket.CLOSED;
    this.#emit("close", { code, reason } as CloseEvent);
  }
  #emit(type: string, event: Event | MessageEvent | CloseEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

export function snapshot(sequence = 1, sessionCount = 0, hasMore = false): unknown {
  const snapshotSessions = Array.from({ length: sessionCount }, (_, index) => ({ id: `session-${index + 1}`, profileId: "profile", title: `Session ${index + 1}`, activity: "idle" }));
  return {
    generatedAt: new Date(sequence).toISOString(), sequence,
    capabilities: {
      protocolVersion: 1, serverVersion: "test", runtime: { state: "ready", adapterVersion: "test" },
      access: { deviceId: "device-test", tier: "operator", exposure: "public", authentication: "device-cookie", allowedOperations: ["state.read"] },
      features: ["chat", "profiles"],
    },
    profiles: [{ id: "profile", name: "Profile", activity: "idle", activeSessionCount: sessionCount }], sessions: snapshotSessions, boards: [],
    inventory: {
      profiles: { returned: 1, available: 1, total: 1, hasMore: false, truncated: false, partialFailures: 0 },
      sessions: { returned: sessionCount, available: hasMore ? sessionCount + 1 : sessionCount, total: hasMore ? sessionCount + 1 : sessionCount, hasMore, truncated: false, partialFailures: 0, ...(hasMore ? { nextCursor: `cursor-${sequence}` } : {}) },
    },
  };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Office WebSocket state");
}
