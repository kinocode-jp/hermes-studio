import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { HermesChatTransportError, type HermesChatEvent, type HermesChatRequest, type HermesChatResult } from "./hermes-chat.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { OfficeAuth, type OfficeAuthSession } from "./office-auth.js";

const SESSION: OfficeAuthSession = {
  principal: { id: "close-settlement", tier: "operator", local: false, deviceName: "Close settlement" },
  csrfToken: "c".repeat(32), expiresAt: "2099-01-01T00:00:00.000Z",
};

for (const closedValue of [true, false]) {
  test(`disconnect cleanup joins an authoritative closed:${closedValue} close without resetting peers`, async () => {
    const hermes = new CloseSettlementFakeHermes({ closedValue });
    const closeGate = deferred<void>();
    hermes.delayFirstSessionClose(closeGate.promise);
    const { coordinator, hub, dependencies } = setup(hermes);
    const owner = new FakeWebSocket();
    const peer = new FakeWebSocket();
    handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
    handleOfficeChatConnection(peer as unknown as WebSocket, dependencies);
    await settle(4);
    owner.rpc(1, "session.resume", { session_id: "owner", profile: "coder" });
    peer.rpc(2, "session.resume", { session_id: "peer", profile: "reviewer" });
    await settle(6);

    owner.rpc(3, "session.close", { session_id: "live-owner" });
    await settle(2);
    assert.deepEqual(hermes.sessionCloseRequests, ["live-owner"]);
    owner.close(1006, "network lost while close was pending");
    let historyStarted = false;
    const history = hub.readStableHistory(async () => { historyStarted = true; return "stable"; });
    const replacement = new FakeWebSocket();
    handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
    hermes.emit("live-peer", "peer remains live while owner close settles");
    await settle(5);

    assert.equal(historyStarted, false);
    assert.equal(replacement.hasMethod("office.ready"), false);
    assert.equal(peer.events("live-peer").at(-1)?.payload?.text, "peer remains live while owner close settles");
    assert.equal(peer.closed, undefined);
    assert.equal(hermes.connectionCloseCount, 0);

    closeGate.resolve();
    assert.equal(await history, "stable");
    await settle(10);
    assert.equal(replacement.hasMethod("office.ready"), true);
    assert.equal(coordinator.ownerForLive("live-owner"), undefined);
    assert.ok(coordinator.ownerForLive("live-peer"));
    assert.equal(hermes.connectionCloseCount, 0);
    assert.deepEqual(hermes.sessionCloseRequests, ["live-owner"], "cleanup joins rather than duplicating the successful close");
    hermes.emit("live-peer", "peer still routed after close settlement");
    await settle();
    assert.equal(peer.events("live-peer").at(-1)?.payload?.text, "peer still routed after close settlement");
  });
}

test("a joined close failure retries owner-locally, then resets peers behind history and readiness barriers", async () => {
  const hermes = new CloseSettlementFakeHermes({ failSessionClose: true });
  const closeGate = deferred<void>();
  const resetGate = deferred<void>();
  hermes.delayFirstSessionClose(closeGate.promise);
  hermes.delayConnectionClose(resetGate.promise);
  const { coordinator, hub, dependencies } = setup(hermes);
  const owner = new FakeWebSocket();
  const peer = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  handleOfficeChatConnection(peer as unknown as WebSocket, dependencies);
  await settle(4);
  owner.rpc(10, "session.resume", { session_id: "owner", profile: "coder" });
  peer.rpc(11, "session.resume", { session_id: "peer", profile: "reviewer" });
  await settle(6);

  owner.rpc(12, "session.close", { session_id: "live-owner" });
  await settle(2);
  owner.close(1006, "network lost while close was pending");
  let historyStarted = false;
  const history = hub.readStableHistory(async () => { historyStarted = true; return "after-reset"; });
  const replacement = new FakeWebSocket();
  handleOfficeChatConnection(replacement as unknown as WebSocket, dependencies);
  closeGate.resolve();
  await waitFor(() => hermes.sessionCloseRequests.length === 4 && hermes.connectionCloseCount === 1);

  assert.equal(peer.events("live-peer").at(-1)?.payload?.status, "resync_required");
  assert.equal(peer.closed?.code, 1013);
  assert.equal(historyStarted, false);
  assert.equal(replacement.hasMethod("office.ready"), false);
  assert.equal(coordinator.ownerForLive("live-peer"), undefined);

  resetGate.resolve();
  assert.equal(await history, "after-reset");
  await settle(8);
  assert.equal(replacement.hasMethod("office.ready"), false, "a socket fenced by the reset cannot become ready later");
  const recovered = new FakeWebSocket();
  handleOfficeChatConnection(recovered as unknown as WebSocket, dependencies);
  await settle(8);
  assert.equal(recovered.hasMethod("office.ready"), true);
});

test("a failed explicit close preserves ordered live events and interaction state on the open socket", async () => {
  const hermes = new CloseSettlementFakeHermes({ failSessionClose: true });
  const closeGate = deferred<void>();
  hermes.delayFirstSessionClose(closeGate.promise);
  const { coordinator, dependencies } = setup(hermes);
  const owner = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  await settle(4);
  owner.rpc(20, "session.resume", { session_id: "owner", profile: "coder" });
  await settle(6);

  owner.rpc(21, "session.close", { session_id: "live-owner" });
  await settle(2);
  hermes.emitEvent({ type: "message.delta", sessionId: "live-owner", payload: { text: "during close" } });
  hermes.emitEvent({
    type: "approval.request", sessionId: "live-owner",
    payload: { choices: ["once", "deny"], allowPermanent: false },
  });
  hermes.emitEvent({
    type: "clarify.request", sessionId: "live-owner",
    payload: { requestId: "q-during-close", question: "Continue?" },
  });
  await settle(2);

  const duringCloseEvents = owner.events("live-owner");
  assert.deepEqual(duringCloseEvents.map((event) => event.type), [
    "message.delta", "approval.request", "clarify.request",
  ]);
  assert.equal(duringCloseEvents[0]?.payload?.text, "during close");
  assert.equal(owner.errorCode(21), undefined, "the close remains pending while events are routed");
  const approvalId = String(duringCloseEvents[1]?.payload?.approvalId ?? "");
  assert.notEqual(approvalId, "");

  owner.rpc(22, "prompt.submit", { session_id: "live-owner", text: "must wait" });
  owner.rpc(23, "approval.respond", {
    session_id: "live-owner", approval_id: approvalId, choice: "once",
  });
  owner.rpc(24, "clarify.respond", { session_id: "live-owner", request_id: "q-during-close", answer: "wait" });
  await settle(4);
  assert.equal(owner.errorCode(22), -32006, "commands remain fenced during close settlement");
  assert.equal(owner.errorCode(23), -32004);
  assert.equal(owner.errorCode(24), -32004);
  assert.deepEqual(hermes.interactionRequests, []);

  closeGate.resolve();
  await waitFor(() => owner.errorCode(21) === -32000);
  assert.ok(coordinator.ownerForLive("live-owner"), "a failed close retains the original lease");
  assert.equal(owner.closed, undefined, "a definitive owner-local close failure does not fence the socket");

  owner.rpc(25, "approval.respond", {
    session_id: "live-owner", approval_id: approvalId, choice: "once",
  });
  owner.rpc(26, "clarify.respond", { session_id: "live-owner", request_id: "q-during-close", answer: "continue" });
  await settle(6);
  assert.equal(owner.errorCode(25), undefined);
  assert.equal(owner.errorCode(26), undefined);
  assert.deepEqual(hermes.interactionRequests, ["approval.respond", "clarify.respond"]);
  assert.deepEqual(hermes.sessionCloseRequests, ["live-owner", "live-owner"]);
});

test("an accepted approval ACK crossing a failed close consumes only the original pending approval", async () => {
  const hermes = new CloseSettlementFakeHermes({ failSessionClose: true });
  const approvalGate = deferred<void>();
  const closeGate = deferred<void>();
  hermes.delayFirstApprovalResponse(approvalGate.promise);
  hermes.delayFirstSessionClose(closeGate.promise);
  const { coordinator, dependencies } = setup(hermes);
  const owner = new FakeWebSocket();
  handleOfficeChatConnection(owner as unknown as WebSocket, dependencies);
  await settle(4);
  owner.rpc(30, "session.resume", { session_id: "owner", profile: "coder" });
  await settle(6);

  hermes.emitEvent({
    type: "approval.request", sessionId: "live-owner",
    payload: { choices: ["once", "deny"], allowPermanent: false },
  });
  await settle(2);
  const firstApprovalId = owner.approvalId("live-owner");
  owner.rpc(31, "approval.respond", {
    session_id: "live-owner", approval_id: firstApprovalId, choice: "once",
  });
  await waitFor(() => hermes.approvalChoices.length === 1);

  hermes.emitEvent({
    type: "approval.request", sessionId: "live-owner",
    payload: { choices: ["once", "deny"], allowPermanent: false },
  });
  owner.rpc(32, "session.close", { session_id: "live-owner" });
  await waitFor(() => hermes.sessionCloseRequests.length === 1);
  assert.equal(coordinator.liveLeaseToken(coordinator.ownerForLive("live-owner")!, "live-owner"), undefined);

  approvalGate.resolve();
  await waitFor(() => owner.hasResult(31) && owner.approvalIds("live-owner").length === 2);
  const secondApprovalId = owner.approvalIds("live-owner")[1]!;
  assert.notEqual(secondApprovalId, firstApprovalId);
  assert.deepEqual(hermes.approvalChoices, ["once"]);

  closeGate.resolve();
  await waitFor(() => owner.errorCode(32) === -32000);
  assert.ok(coordinator.ownerForLive("live-owner"), "the failed close retains the original routing lease");

  owner.rpc(33, "approval.respond", {
    session_id: "live-owner", approval_id: firstApprovalId, choice: "deny",
  });
  await waitFor(() => owner.errorCode(33) === -32004);
  assert.deepEqual(hermes.approvalChoices, ["once"], "the consumed Office ID cannot reach the next Hermes approval");

  owner.rpc(34, "approval.respond", {
    session_id: "live-owner", approval_id: secondApprovalId, choice: "deny",
  });
  await waitFor(() => owner.hasResult(34));
  assert.deepEqual(hermes.approvalChoices, ["once", "deny"]);
});

function setup(hermes: CloseSettlementFakeHermes) {
  const coordinator = new ChatSessionCoordinator();
  const runtime = hermes.runtime();
  const hub = new ChatUpstreamHub(runtime, coordinator, 64 * 1024);
  return {
    coordinator,
    hub,
    dependencies: {
      auth: new OfficeAuth(), officeSession: SESSION, runtimeSource: runtime,
      maxJsonBytes: 64 * 1024, deviceLimiter: new ChatDeviceRateLimiter({ capacity: 100, ratePerSecond: 0 }),
      sessionCoordinator: coordinator, chatHub: hub,
    },
  };
}

class CloseSettlementFakeHermes {
  readonly sessionCloseRequests: string[] = [];
  readonly interactionRequests: string[] = [];
  readonly approvalChoices: string[] = [];
  connectionCloseCount = 0;
  readonly #closedValue: boolean;
  readonly #failSessionClose: boolean;
  readonly #live = new Set<string>();
  #onEvent: ((event: HermesChatEvent) => void) | undefined;
  #firstSessionCloseGate: Promise<void> | undefined;
  #firstApprovalResponseGate: Promise<void> | undefined;
  #connectionCloseGate: Promise<void> | undefined;
  #connectionClosed = false;

  constructor(options: { closedValue?: boolean; failSessionClose?: boolean }) {
    this.#closedValue = options.closedValue ?? true;
    this.#failSessionClose = options.failSessionClose ?? false;
  }

  runtime(): HermesRuntimeSource {
    return {
      chat: () => ({
        connect: async (onEvent: (event: HermesChatEvent) => void) => {
          this.#onEvent = onEvent;
          this.#connectionClosed = false;
          return {
            get closed() { return false; },
            request: async (request: HermesChatRequest) => await this.#request(request),
            close: async () => {
              this.connectionCloseCount += 1;
              const gate = this.#connectionCloseGate;
              this.#connectionCloseGate = undefined;
              await gate;
              this.#connectionClosed = true;
              this.#live.clear();
            },
          };
        },
        inspectHistory: async ({ sessionId }: { sessionId: string }) => ({ sessionId, total: 0 }),
        fetchHistory: async () => { throw new Error("unused"); },
      }),
    } as unknown as HermesRuntimeSource;
  }

  delayFirstSessionClose(gate: Promise<void>): void { this.#firstSessionCloseGate = gate; }
  delayFirstApprovalResponse(gate: Promise<void>): void { this.#firstApprovalResponseGate = gate; }
  delayConnectionClose(gate: Promise<void>): void { this.#connectionCloseGate = gate; }
  emit(liveSessionId: string, text: string): void {
    this.#onEvent?.({ type: "message.delta", sessionId: liveSessionId, payload: { text } });
  }
  emitEvent(event: HermesChatEvent): void { this.#onEvent?.(event); }

  async #request(request: HermesChatRequest): Promise<HermesChatResult> {
    if (this.#connectionClosed) throw new Error("generation closed");
    if (request.method === "session.resume") {
      const storedId = String(request.params?.session_id);
      const liveSessionId = `live-${storedId}`;
      this.#live.add(liveSessionId);
      return { method: request.method, value: { liveSessionId, storedSessionId: storedId, running: false } };
    }
    if (request.method === "session.close") {
      const liveSessionId = String(request.params?.session_id);
      this.sessionCloseRequests.push(liveSessionId);
      const gate = this.#firstSessionCloseGate;
      this.#firstSessionCloseGate = undefined;
      await gate;
      if (this.#failSessionClose) throw new HermesChatTransportError("timed_out", "fake close timeout");
      this.#live.delete(liveSessionId);
      return { method: request.method, value: { closed: this.#closedValue } };
    }
    if (request.method === "approval.respond" || request.method === "clarify.respond") {
      this.interactionRequests.push(request.method);
      if (request.method === "approval.respond") {
        this.approvalChoices.push(String(request.params?.choice));
        const gate = this.#firstApprovalResponseGate;
        this.#firstApprovalResponseGate = undefined;
        await gate;
      }
      return request.method === "approval.respond"
        ? { method: request.method, value: { resolved: true } }
        : { method: request.method, value: { status: "ok" } };
    }
    return { method: request.method, value: { status: "ok" } };
  }
}

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };

  send(body: string, callback?: (error?: Error) => void): void { this.sent.push(body); callback?.(); }
  close(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  rpc(id: number, method: string, params: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), false);
  }
  hasMethod(method: string): boolean { return this.frames().some((frame) => frame.method === method); }
  errorCode(id: number): number | undefined {
    return (this.frames().find((frame) => frame.id === id)?.error as { code?: number } | undefined)?.code;
  }
  hasResult(id: number): boolean {
    return this.frames().some((frame) => frame.id === id && frame.result !== undefined);
  }
  approvalId(liveSessionId: string): string { return this.approvalIds(liveSessionId).at(-1) ?? ""; }
  approvalIds(liveSessionId: string): string[] {
    return this.events(liveSessionId).flatMap((event) => event.type === "approval.request"
      && typeof event.payload?.approvalId === "string" ? [event.payload.approvalId] : []);
  }
  events(liveSessionId: string): Array<{ type?: string; payload?: Record<string, unknown> }> {
    return this.frames().flatMap((frame) => {
      if (frame.method !== "event") return [];
      const params = frame.params as { sessionId?: string; session_id?: string; type?: string; payload?: Record<string, unknown> } | undefined;
      if (params === undefined || (params.sessionId ?? params.session_id) !== liveSessionId) return [];
      return [{ ...(typeof params.type === "string" ? { type: params.type } : {}), ...(params.payload === undefined ? {} : { payload: params.payload }) }];
    });
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((body) => JSON.parse(body) as Record<string, unknown>);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error("Condition was not reached.");
}
