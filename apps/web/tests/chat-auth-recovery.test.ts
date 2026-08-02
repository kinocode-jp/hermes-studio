import assert from "node:assert/strict";
import test from "node:test";
import { connectChatApi, type ChatApiCallbacks } from "../src/chat-api.ts";
import { OfficeDeviceAuthRequiredError, OfficeSessionUnavailableError } from "../src/office-api.ts";
import { openSessionIds, reconnectChatSession, registerChatRuntime, sessions, setChatSessionError } from "../src/store.ts";

test("chat renews an expired open lease once and reconnects with the replacement revision", async () => {
  const sockets: FakeWebSocket[] = [];
  const recoveries: number[] = [];
  const states: string[] = [];
  let revision = 7;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async (_serverUrl, rejectedRevision) => {
      recoveries.push(rejectedRevision);
      revision = 8;
    },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();

  assert.deepEqual(recoveries, [7]);
  assert.equal(states.filter((state) => state === "ready").length, 2);
  api.stop();
});

test("an upgrade 401 represented by pre-open error/1000 performs bounded authentication recovery", async () => {
  const sockets: FakeWebSocket[] = [];
  let recoveries = 0;
  let revision = 11;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async (_serverUrl, rejectedRevision) => {
      assert.equal(rejectedRevision, 11);
      recoveries += 1;
      revision = 12;
    },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.failBeforeOpen();
  sockets[0]!.failBeforeOpen();
  await waitFor(() => sockets.length === 2);
  assert.equal(recoveries, 1);
  api.stop();
});

test("revoked recovery enters authentication-required error without a reconnect loop", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let recoveries = 0;
  let revision = 17;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async () => { recoveries += 1; throw new OfficeDeviceAuthRequiredError(); },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Device revoked");
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(sockets.length, 1);

  // A successful explicit login calls the registered Office retry, which also
  // invokes chat.retry(); that is the only path which resumes this transport.
  revision = 18;
  api.retry();
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
});

test("temporary recovery honors Retry-After and reconnects without requesting device login", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  const minimumDelays: number[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("rate limited", 60_000); },
    reconnectDelay: (_attempt, minimumDelayMs) => { minimumDelays.push(minimumDelayMs); return 0; },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.deepEqual(minimumDelays, [60_000]);
  assert.equal(states.includes("ready"), true);
  api.stop();
});

test("trusted proxy configuration failure waits for manual retry instead of looping", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  const delays: number[] = [];
  let proxyHealthy = false;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => {
      if (!proxyHealthy) throw new OfficeSessionUnavailableError("trusted proxy configuration required", 0, false);
    },
    reconnectDelay: (attempt) => { delays.push(attempt); return 0; },
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(sockets.length, 1);
  assert.deepEqual(delays, []);

  proxyHealthy = true;
  api.retry();
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
});

test("a synchronized Office recovery rearms a chat-only halt exactly once for active targets", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let synchronized!: (serverUrl: string, authRevision: number) => void;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("proxy configuration", 0, false); },
    reconnectDelay: () => 0,
    subscribeSessionSynchronizations(observer) { synchronized = observer; return () => {}; },
  });
  api.ensureSession({ clientSessionId: "active", profileId: "profile" });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await waitFor(() => states.at(-1) === "error");

  synchronized("https://other.example", 2);
  assert.equal(sockets.length, 1);
  synchronized("https://office.example", 1);
  assert.equal(sockets.length, 1);
  synchronized("https://office.example", 2);
  synchronized("https://office.example", 2);
  await waitFor(() => sockets.length === 2);
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
  synchronized("https://office.example", 3);
  await flush();
  assert.equal(sockets.length, 2);
});

test("stop aborts a barrier-blocked retry and a deleted target cannot resume", async () => {
  const sockets: FakeWebSocket[] = [];
  let opens = 0;
  let retryAborted = false;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async (_url, _serverUrl, signal) => {
      opens += 1;
      if (opens === 1) {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return { socket: socket as unknown as WebSocket, authRevision: 1 };
      }
      return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        retryAborted = true;
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true }));
    },
    recoverAuthentication: async () => { throw new OfficeSessionUnavailableError("proxy configuration", 0, false); },
    reconnectDelay: () => 0,
  });
  api.ensureSession({ clientSessionId: "deleted", profileId: "profile" });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await flush();
  api.retry();
  await waitFor(() => opens === 2);
  api.releaseSession("deleted");
  api.stop();
  await waitFor(() => retryAborted);
  assert.equal(sockets.length, 1);
});

test("manual Office retry supersedes a pending chat recovery without opening a duplicate socket", async () => {
  const sockets: FakeWebSocket[] = [];
  let finishRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: sockets.length };
    },
    recoverAuthentication: async () => await recovery,
    reconnectDelay: () => 0,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1008, "Session expired");
  await flush();
  api.retry();
  await waitFor(() => sockets.length === 2);
  finishRecovery();
  await flush();
  await flush();
  assert.equal(sockets.length, 2);
  api.stop();
});

test("ordinary open network loss reconnects without rotating authentication", async () => {
  const sockets: FakeWebSocket[] = [];
  let recoveries = 0;
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: 23 };
    },
    recoverAuthentication: async () => { recoveries += 1; },
    reconnectDelay: () => 0,
  });

  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  assert.equal(recoveries, 0);
  api.stop();
});

test("an idle local draft is unaffected by chat transport reconnects", async () => {
  const sockets: FakeWebSocket[] = [];
  const sessionErrors: string[] = [];
  const disconnected: string[] = [];
  const api = connectChatApi({
    ...callbacks([]),
    onSessionError(clientSessionId) { sessionErrors.push(clientSessionId); },
    onSessionDisconnected(clientSessionId) { disconnected.push(clientSessionId); },
  }, {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: 37 };
    },
    reconnectDelay: () => 0,
  });
  api.ensureSession({ clientSessionId: "local-draft", profileId: "profile" });
  await waitFor(() => sockets.length === 1);
  sockets[0]!.open();
  sockets[0]!.serverClose(1006, "network lost");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.open();

  assert.deepEqual(sessionErrors, []);
  assert.deepEqual(disconnected, []);
  api.stop();
});

test("a halted transport settles a lazy draft's pending first prompt", async () => {
  let rejectOpen!: (reason: unknown) => void;
  const states: string[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => await new Promise<never>((_resolve, reject) => { rejectOpen = reject; }),
  });
  api.ensureSession({ clientSessionId: "pending-draft", profileId: "profile" });
  const submission = api.submitPrompt("pending-draft", "first prompt", "first-operation");
  await waitFor(() => rejectOpen !== undefined);
  rejectOpen(new OfficeSessionUnavailableError("manual recovery required", 0, false));

  assert.deepEqual(await submission, { status: "rejected", message: "manual recovery required" });
  assert.equal(states.at(-1), "error");
  api.stop();
});

test("persistent pre-open failures spend one auth check and then stop after a bounded retry count", async () => {
  const sockets: FakeWebSocket[] = [];
  const states: string[] = [];
  let recoveries = 0;
  let revision = 31;
  const api = connectChatApi({ ...callbacks(states), onSessionError: setChatSessionError }, {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: revision };
    },
    recoverAuthentication: async () => { recoveries += 1; revision += 1; },
    reconnectDelay: () => 0,
  });
  sessions.value = [{
    id: "retry-client", storedSessionId: "stored-retry", profileId: "profile", title: "Retry",
    status: "ready", messages: [], connectionState: "connecting", historyState: "unloaded", remoteKind: "stored",
  }];
  openSessionIds.value = ["retry-client"];
  registerChatRuntime(api);

  for (let expected = 1; expected <= 3; expected += 1) {
    await waitFor(() => sockets.length === expected);
    sockets[expected - 1]!.failBeforeOpen();
  }
  await waitFor(() => states.at(-1) === "error");
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(sockets.length, 3);
  assert.equal(sessions.value[0]?.connectionState, "error");
  reconnectChatSession("retry-client");
  await waitFor(() => sockets.length === 4);
  sockets[3]!.open();
  assert.equal(states.at(-1), "ready");
  api.stop();
  sessions.value = [];
  openSessionIds.value = [];
});

test("reconnect scheduling is single-timer and increases attempts after repeated open failures", async () => {
  const attempts: number[] = [];
  let opens = 0;
  const socket = new FakeWebSocket();
  const api = connectChatApi(callbacks([]), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      opens += 1;
      if (opens <= 2) throw new Error("network unavailable");
      return { socket: socket as unknown as WebSocket, authRevision: 29 };
    },
    reconnectDelay: (attempt) => { attempts.push(attempt); return 0; },
  });

  await waitFor(() => opens === 3);
  assert.deepEqual(attempts, [0, 1]);
  socket.open();
  api.stop();
});

test("repeated network bootstrap failures stop after the bounded reconnect budget", async () => {
  const states: string[] = [];
  let opens = 0;
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => { opens += 1; throw new OfficeSessionUnavailableError("offline"); },
    reconnectDelay: () => 0,
  });
  await waitFor(() => opens === 6);
  assert.equal(opens, 6);
  assert.equal(states.at(-1), "error");
  api.stop();
});

test("open sockets that never become gateway-ready exhaust the reconnect budget", async () => {
  const states: string[] = [];
  const sockets: FakeWebSocket[] = [];
  const attempts: number[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      setTimeout(() => socket.open(false), 0);
      return { socket: socket as unknown as WebSocket, authRevision: 41 };
    },
    reconnectDelay: (attempt) => { attempts.push(attempt); return 0; },
    gatewayReadyTimeoutMs: 5,
  });

  await waitFor(() => states.at(-1) === "error");
  assert.equal(sockets.length, 6, "one initial socket plus five bounded reconnects");
  assert.deepEqual(attempts, [0, 1, 2, 3, 4]);
  api.stop();
});

test("ready sockets that flap before the stability window still exhaust the reconnect budget", async () => {
  const states: string[] = [];
  const sockets: FakeWebSocket[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return { socket: socket as unknown as WebSocket, authRevision: 44 };
    },
    reconnectDelay: () => 0,
    reconnectStabilityMs: 60_000,
  });

  for (let expected = 1; expected <= 6; expected += 1) {
    await waitFor(() => sockets.length === expected);
    sockets[expected - 1]!.open();
    sockets[expected - 1]!.serverClose(1006, "flapping network");
  }
  await waitFor(() => states.at(-1) === "error");
  assert.equal(sockets.length, 6);
  api.stop();
});

test("gateway waiting progress preserves one socket until office.ready", async () => {
  const states: string[] = [];
  const socket = new FakeWebSocket(true);
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      setTimeout(() => socket.open(false), 0);
      return { socket: socket as unknown as WebSocket, authRevision: 42 };
    },
    reconnectDelay: () => 0,
    gatewayReadyTimeoutMs: 5,
    gatewayReadyAbsoluteTimeoutMs: 100,
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(states.at(-1), "connecting");
  assert.equal(states.includes("error"), false);
  socket.officeReady();
  await waitFor(() => states.at(-1) === "ready");
  api.stop();
});

test("gateway waiting progress cannot extend the absolute readiness deadline", async () => {
  const states: string[] = [];
  const sockets: FakeWebSocket[] = [];
  const api = connectChatApi(callbacks(states), {
    serverUrl: "https://office.example",
    openWebSocket: async () => {
      const socket = new FakeWebSocket(true);
      sockets.push(socket);
      setTimeout(() => socket.open(false), 0);
      return { socket: socket as unknown as WebSocket, authRevision: 43 };
    },
    reconnectDelay: () => 0,
    gatewayReadyTimeoutMs: 5,
    gatewayReadyAbsoluteTimeoutMs: 20,
  });

  await waitFor(() => states.at(-1) === "error");
  assert.equal(sockets.length, 1, "the terminal readiness deadline must not churn through replacement sockets");
  api.stop();
});

function callbacks(states: string[]): ChatApiCallbacks {
  return {
    onSocketState(state) { states.push(state); },
    onHistoryLoading() {}, onHistory() {}, onHistoryError() {},
    onSessionConnecting() {}, onSessionReady() {}, onSessionDisconnected() {}, onSessionError() {}, onEvent() {},
  };
}

class FakeWebSocket {
  readyState = WebSocket.CONNECTING;
  readonly #listeners = new Map<string, Set<(event: CloseEvent | Event | MessageEvent) => void>>();
  #closed = false;
  #waitingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly respondWaitingToHello = false) {}

  addEventListener(type: string, listener: (event: CloseEvent | Event | MessageEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(body: string): void {
    if (!this.respondWaitingToHello) return;
    let frame: { method?: string } | undefined;
    try { frame = JSON.parse(body) as { method?: string }; } catch { return; }
    if (frame.method === "office.hello" && this.#waitingTimer === undefined) {
      const emitWaiting = () => {
        if (this.#closed || !this.respondWaitingToHello) return;
        this.officeWaiting();
        this.#waitingTimer = setTimeout(emitWaiting, 1);
      };
      queueMicrotask(emitWaiting);
    }
  }
  open(sendOfficeReady = true): void {
    if (this.#closed) return;
    this.readyState = WebSocket.OPEN;
    this.#emit("open", new Event("open"));
    if (sendOfficeReady) this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.ready", params: {} }) } as MessageEvent);
  }
  officeWaiting(): void {
    if (this.#closed) return;
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.waiting", params: { phase: "attaching" } }) } as MessageEvent);
  }
  officeReady(): void {
    if (this.#closed) return;
    if (this.#waitingTimer !== undefined) clearTimeout(this.#waitingTimer);
    this.#waitingTimer = undefined;
    this.#emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "office.ready", params: {} }) } as MessageEvent);
  }
  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }
  serverClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waitingTimer !== undefined) clearTimeout(this.#waitingTimer);
    this.#waitingTimer = undefined;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", { code, reason } as CloseEvent);
  }
  failBeforeOpen(): void {
    if (this.#closed) return;
    this.#emit("error", new Event("error"));
  }
  #emit(type: string, event: CloseEvent | Event | MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Timed out waiting for chat authentication state");
}
