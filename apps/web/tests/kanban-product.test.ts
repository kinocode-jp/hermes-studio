import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TaskComment, WorkTask } from "../src/domain.ts";
import { localizeRuntimeMessage } from "../src/i18n.ts";
import { OfficeHttpError } from "../src/office-api.ts";
import { createTaskCommentController } from "../src/kanban-comments.ts";
import {
  classifyKanbanMutationFailure,
  KanbanMutationFailure,
  MAX_VISIBLE_COMMENTS,
  normalizeCardDetail,
  type KanbanApi,
  type KanbanCardDetailResult
} from "../src/kanban-api.ts";
import { requestTaskMove } from "../src/kanban-board-logic.ts";
import {
  allowUnconfirmedCommentResend,
  allowUnconfirmedTaskResend,
  confirmUnconfirmedComment,
  confirmUnconfirmedTaskCreation,
  loadKanbanDemoRuntime,
  resetKanbanRuntimeState,
  taskCreationBusy,
  unconfirmedTaskComments,
  unconfirmedTaskCreation
} from "../src/kanban-store.ts";
import {
  addTaskComment,
  assignTask,
  createTask,
  kanbanState,
  moveTask,
  refreshKanbanBoard,
  registerKanbanRuntime,
  retryTaskComments,
  taskCommentDetail,
  tasks,
  toggleTaskComments
} from "../src/store.ts";

const CARD: WorkTask = {
  id: "card-1",
  title: "Keyboard and touch",
  status: "todo",
  priority: "normal",
  comments: 0
};

test("card detail normalization is identity-bound, strict, de-duplicated, and render-bounded", () => {
  const comments = Array.from({ length: MAX_VISIBLE_COMMENTS + 1 }, (_, index) => rawComment(index + 1));
  const detail = normalizeCardDetail({ card: rawCard(comments.length), comments }, CARD.id);

  assert.equal(detail.comments.length, MAX_VISIBLE_COMMENTS);
  assert.equal(detail.comments[0]?.id, 2);
  assert.equal(detail.availableCommentCount, MAX_VISIBLE_COMMENTS + 1);
  assert.equal(detail.truncated, true);
  assert.throws(() => normalizeCardDetail({ card: { ...rawCard(1), id: "other" }, comments: [] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), cardId: "other" }] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(2), comments: [rawComment(1), rawComment(1)] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), body: "x".repeat(16_001) }] }, CARD.id), /invalid/);
  assert.throws(() => normalizeCardDetail({ card: rawCard(1), comments: [{ ...rawComment(1), createdAt: Number.MAX_SAFE_INTEGER }] }, CARD.id), /invalid/);
});

test("comment detail ignores stale pane loads and supports retry", async () => {
  const requests = new Map<string, ReturnType<typeof deferred<KanbanCardDetailResult>>>();
  const api = fakeApi({
    fetchCard: (cardId) => {
      const request = deferred<KanbanCardDetailResult>();
      requests.set(cardId, request);
      return request.promise;
    }
  });
  const controller = createTaskCommentController(() => api);

  const first = controller.toggle("card-a");
  const second = controller.toggle("card-b");
  requests.get("card-b")!.resolve(detail("card-b", [comment(2, "card-b", "current")]));
  await second;
  requests.get("card-a")!.resolve(detail("card-a", [comment(1, "card-a", "stale")]));
  await first;
  assert.equal(controller.taskCommentDetail.value.cardId, "card-b");
  assert.deepEqual(controller.taskCommentDetail.value.comments.map((item) => item.body), ["current"]);

  const retryRequest = controller.retry();
  requests.get("card-b")!.reject(new Error("offline"));
  await retryRequest;
  assert.equal(controller.taskCommentDetail.value.state, "error");
  const recovered = controller.retry();
  requests.get("card-b")!.resolve(detail("card-b", [comment(3, "card-b", "recovered")]));
  await recovered;
  assert.equal(controller.taskCommentDetail.value.state, "ready");
  assert.deepEqual(controller.taskCommentDetail.value.comments.map((item) => item.body), ["recovered"]);
});

test("status select and drag/drop share the validated move path", async () => {
  const [source, mainSource] = await Promise.all([
    readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /onChange=.*requestTaskMove/s);
  assert.match(source, /onDrop=.*acceptDrop/s);
  assert.match(source, /requestTaskMove/);
  assert.match(source, /is-drop-target/);
  assert.match(source, /kanban-column-toggle/);
  assert.match(source, /isKanbanColumnCollapsed/);
  assert.match(mainSource, /KANBAN_BACKGROUND_REFRESH_MS = 10_000/);
  assert.match(mainSource, /refreshKanbanBoard\(\{ background: true \}\)/);
  assert.match(mainSource, /visibilitychange/);

  let boardCard = { ...CARD };
  const updates: Array<Record<string, unknown>> = [];
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async (_cardId, patch) => {
      updates.push(patch);
      boardCard = { ...boardCard, ...patch, assigneeId: patch.assignee ?? boardCard.assigneeId };
      return boardCard;
    }
  }));
  await refreshKanbanBoard();

  await requestTaskMove(CARD.id, "blocked");
  await requestTaskMove(CARD.id, "running");
  assert.deepEqual(updates, [{ status: "blocked" }]);
  assert.equal(tasks.value.find((task) => task.id === CARD.id)?.status, "blocked");
});

test("authoritative board refresh wins over an in-flight card mutation", async () => {
  let boardCard = { ...CARD };
  const patch = deferred<WorkTask>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async () => patch.promise
  }));
  await refreshKanbanBoard();

  const moving = requestTaskMove(CARD.id, "blocked");
  assert.equal(tasks.value[0]?.status, "blocked");
  boardCard = { ...boardCard, status: "done", assigneeId: "external-agent" };
  await refreshKanbanBoard();
  patch.resolve({ ...CARD, status: "blocked" });
  await moving;

  assert.equal(tasks.value[0]?.status, "done");
  assert.equal(tasks.value[0]?.assigneeId, "external-agent");
  assert.equal(tasks.value[0]?.pending, false);
});

test("a failed assignment cannot roll back an external board update", async () => {
  let boardCard = { ...CARD, assigneeId: "first-agent" };
  const patch = deferred<WorkTask>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    updateCard: async () => patch.promise
  }));
  await refreshKanbanBoard();

  const assigning = assignTask(CARD.id, "second-agent");
  boardCard = { ...boardCard, status: "ready", assigneeId: "external-agent" };
  await refreshKanbanBoard();
  patch.reject(new Error("conflict"));
  await assigning;

  assert.equal(tasks.value[0]?.status, "ready");
  assert.equal(tasks.value[0]?.assigneeId, "external-agent");
  assert.equal(tasks.value[0]?.pending, false);
});

test("comment submission reconciles from detail without duplicate local appends", async () => {
  let comments: TaskComment[] = [];
  let boardCard = { ...CARD };
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([boardCard]),
    fetchCard: async () => detail(CARD.id, comments),
    addComment: async (_cardId, body) => {
      comments = [...comments, comment(1, CARD.id, body)];
      boardCard = { ...boardCard, comments: comments.length };
    }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);

  assert.equal(await addTaskComment(CARD.id, "one note"), "success");
  await waitUntil(() => taskCommentDetail.value.state === "ready" && taskCommentDetail.value.comments.length === 1);
  await refreshKanbanBoard();
  await waitUntil(() => taskCommentDetail.value.state === "ready");
  assert.deepEqual(taskCommentDetail.value.comments.map((item) => item.body), ["one note"]);
  assert.equal(tasks.value[0]?.comments, 1);
  await toggleTaskComments(CARD.id);
});

test("runtime switches invalidate delayed mutation success and failure without touching the replacement runtime", async () => {
  resetKanbanRuntimeState();
  const livePatch = deferred<WorkTask>();
  let liveReads = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => { liveReads += 1; return board([{ ...CARD, id: "live-old" }]); },
    updateCard: async () => livePatch.promise
  }));
  await refreshKanbanBoard();
  const oldMove = moveTask("live-old", "blocked");

  let demoReads = 0;
  const demoCard = { ...CARD, id: "demo-current", title: "Demo current" };
  loadKanbanDemoRuntime(fakeApi({ fetchBoard: async () => { demoReads += 1; return board([demoCard]); } }));
  await refreshKanbanBoard();
  const readsBeforeStaleFailure = demoReads;
  livePatch.reject(new Error("stale live failure"));
  await oldMove;
  assert.deepEqual(tasks.value.map((task) => task.id), [demoCard.id]);
  assert.equal(kanbanState.value.state, "ready");
  assert.equal(demoReads, readsBeforeStaleFailure);
  assert.ok(liveReads > 0);

  const demoPatch = deferred<WorkTask>();
  const oldDemoCard = { ...CARD, id: "demo-old" };
  loadKanbanDemoRuntime(fakeApi({
    fetchBoard: async () => board([oldDemoCard]),
    updateCard: async () => demoPatch.promise
  }));
  await refreshKanbanBoard();
  const demoMove = moveTask(oldDemoCard.id, "blocked");

  let replacementReads = 0;
  const replacement = { ...CARD, id: "live-current", title: "Live current" };
  registerKanbanRuntime(fakeApi({ fetchBoard: async () => { replacementReads += 1; return board([replacement]); } }));
  resetKanbanRuntimeState();
  await refreshKanbanBoard();
  const readsBeforeStaleSuccess = replacementReads;
  demoPatch.resolve({ ...oldDemoCard, status: "blocked" });
  await demoMove;
  assert.deepEqual(tasks.value.map((task) => task.id), [replacement.id]);
  assert.equal(kanbanState.value.state, "ready");
  assert.equal(replacementReads, readsBeforeStaleSuccess);
});

test("runtime switches also invalidate delayed non-idempotent POST completions", async () => {
  resetKanbanRuntimeState();
  const createRequest = deferred<WorkTask>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([CARD]),
    createCard: async () => createRequest.promise
  }));
  await refreshKanbanBoard();
  const creating = createTask("old live task");

  let demoReads = 0;
  const demoCard = { ...CARD, id: "demo-after-create" };
  const replacementCreate = deferred<WorkTask>();
  let demoCards = [demoCard];
  let replacementCreateCalls = 0;
  loadKanbanDemoRuntime(fakeApi({
    fetchBoard: async () => { demoReads += 1; return board(demoCards); },
    createCard: async () => { replacementCreateCalls += 1; return replacementCreate.promise; }
  }));
  await refreshKanbanBoard();
  const replacementCreating = createTask("new demo task");
  assert.equal(replacementCreateCalls, 1);
  assert.equal(taskCreationBusy.value, true);
  const readsBeforeCreateFailure = demoReads;
  createRequest.reject(new DOMException("old response lost", "AbortError"));
  assert.equal(await creating, "stale");
  assert.equal(demoReads, readsBeforeCreateFailure);
  assert.equal(taskCreationBusy.value, true, "the stale flight must not clear the replacement runtime's busy state");
  assert.equal(unconfirmedTaskCreation.value, undefined);
  const replacementCard = { ...CARD, id: "demo-new", title: "new demo task" };
  demoCards = [...demoCards, replacementCard];
  replacementCreate.resolve(replacementCard);
  assert.equal(await replacementCreating, "success");
  assert.equal(taskCreationBusy.value, false);
  assert.deepEqual(tasks.value.map((task) => task.id), [demoCard.id, replacementCard.id]);

  const commentRequest = deferred<void>();
  const oldDemoCard = { ...CARD, id: "demo-comment-old" };
  loadKanbanDemoRuntime(fakeApi({
    fetchBoard: async () => board([oldDemoCard]),
    addComment: async () => commentRequest.promise
  }));
  await refreshKanbanBoard();
  const commenting = addTaskComment(oldDemoCard.id, "old demo comment");

  let liveReads = 0;
  const liveCard = { ...CARD, id: "live-after-comment" };
  registerKanbanRuntime(fakeApi({ fetchBoard: async () => { liveReads += 1; return board([liveCard]); } }));
  resetKanbanRuntimeState();
  await refreshKanbanBoard();
  const readsBeforeCommentSuccess = liveReads;
  commentRequest.resolve();
  assert.equal(await commenting, "stale");
  assert.equal(liveReads, readsBeforeCommentSuccess);
  assert.deepEqual(unconfirmedTaskComments.value, {});
  assert.deepEqual(tasks.value.map((task) => task.id), [liveCard.id]);
});

test("a sent comment refreshes expanded detail even when board refresh fails", async () => {
  resetKanbanRuntimeState();
  let failBoard = false;
  let comments: TaskComment[] = [];
  let detailReads = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => {
      if (failBoard) throw new Error("board offline");
      return board([{ ...CARD, comments: comments.length }]);
    },
    fetchCard: async () => {
      detailReads += 1;
      return detail(CARD.id, comments);
    },
    addComment: async (_cardId, body) => {
      comments = [comment(1, CARD.id, body)];
      failBoard = true;
    }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);
  const readsBefore = detailReads;

  assert.equal(await addTaskComment(CARD.id, "committed note"), "success");
  assert.equal(detailReads, readsBefore + 1);
  assert.deepEqual(taskCommentDetail.value.comments.map((item) => item.body), ["committed note"]);
  assert.equal(kanbanState.value.state, "error");
  assert.match(localizeRuntimeMessage(kanbanState.value.message), /コメントは送信済み/);
  await toggleTaskComments(CARD.id);
});

test("a sent comment keeps GET-only retry visible when detail refresh fails", async () => {
  resetKanbanRuntimeState();
  let failDetail = false;
  let comments: TaskComment[] = [];
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([{ ...CARD, comments: comments.length }]),
    fetchCard: async () => {
      if (failDetail) throw new Error("detail offline");
      return detail(CARD.id, comments);
    },
    addComment: async (_cardId, body) => {
      comments = [comment(1, CARD.id, body)];
      failDetail = true;
    }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);

  assert.equal(await addTaskComment(CARD.id, "sent once"), "success");
  assert.equal(taskCommentDetail.value.state, "error");
  assert.equal(kanbanState.value.state, "error");
  assert.match(localizeRuntimeMessage(kanbanState.value.message), /コメントは送信済み/);
  await toggleTaskComments(CARD.id);
});

test("an unrelated successful mutation cannot clear a concurrent mutation error", async () => {
  resetKanbanRuntimeState();
  const cardA = { ...CARD, id: "card-a", assigneeId: "first" };
  const cardB = { ...CARD, id: "card-b" };
  let boardCards = [cardA, cardB];
  const requests = new Map<string, ReturnType<typeof deferred<WorkTask>>>();
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board(boardCards),
    updateCard: async (cardId, patch) => {
      const request = deferred<WorkTask>();
      requests.set(cardId, request);
      void request.promise.then(() => {
        boardCards = boardCards.map((card) => card.id === cardId ? { ...card, ...patch } as WorkTask : card);
      }, () => undefined);
      return request.promise;
    }
  }));
  await refreshKanbanBoard();

  const failing = assignTask(cardA.id, "second");
  const succeeding = moveTask(cardB.id, "blocked");
  requests.get(cardA.id)!.reject(new Error("assignment A failed"));
  await failing;
  assert.equal(kanbanState.value.state, "error");
  requests.get(cardB.id)!.resolve({ ...cardB, status: "blocked" });
  await succeeding;
  assert.equal(kanbanState.value.state, "error");
  assert.match(localizeRuntimeMessage(kanbanState.value.message), /assignment A failed/);

  await refreshKanbanBoard({ acknowledgeErrors: true });
  const succeedingFirst = moveTask(cardB.id, "done");
  const failingLast = assignTask(cardA.id, "third");
  requests.get(cardB.id)!.resolve({ ...cardB, status: "done" });
  await succeedingFirst;
  requests.get(cardA.id)!.reject(new Error("assignment A failed last"));
  await failingLast;
  assert.equal(kanbanState.value.state, "error");
  assert.match(localizeRuntimeMessage(kanbanState.value.message), /failed last/);
});

test("commit-unknown comments are never blindly resent and use GET-only confirmation", async () => {
  const source = await readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8");
  assert.match(source, /disabled=\{task\.pending \|\| Boolean\(unconfirmedComment\)\}/);
  assert.match(source, /confirmUnconfirmedComment/);
  assert.match(source, /allowUnconfirmedCommentResend/);

  resetKanbanRuntimeState();
  let comments: TaskComment[] = [];
  let postCalls = 0;
  let boardReads = 0;
  let detailReads = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => { boardReads += 1; return board([{ ...CARD, comments: comments.length }]); },
    fetchCard: async () => { detailReads += 1; return detail(CARD.id, comments); },
    addComment: async (_cardId, body) => {
      postCalls += 1;
      comments = [comment(1, CARD.id, body)];
      throw new DOMException("response lost", "AbortError");
    }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);
  const readsBeforePost = { board: boardReads, detail: detailReads };

  assert.equal(await addTaskComment(CARD.id, "maybe committed"), "commit-unknown");
  assert.equal(postCalls, 1);
  assert.deepEqual({ board: boardReads, detail: detailReads }, readsBeforePost);
  assert.equal(unconfirmedTaskComments.value[CARD.id]?.checked, false);
  assert.equal(await addTaskComment(CARD.id, "maybe committed"), "commit-unknown");
  assert.equal(postCalls, 1);

  assert.equal(await confirmUnconfirmedComment(CARD.id), true);
  assert.equal(postCalls, 1);
  assert.equal(unconfirmedTaskComments.value[CARD.id]?.checked, true);
  assert.deepEqual(taskCommentDetail.value.comments.map((item) => item.body), ["maybe committed"]);
  allowUnconfirmedCommentResend(CARD.id);
  assert.equal(unconfirmedTaskComments.value[CARD.id], undefined);
  assert.equal(kanbanState.value.state, "ready");
  await toggleTaskComments(CARD.id);
});

test("comment confirmation requires a successful detail GET started after confirmation", async (context) => {
  const cases = [
    { name: "board and detail both fail", boardFails: true, detailFails: true, expected: false, expectedDetailReads: 1 },
    { name: "board succeeds but detail fails", boardFails: false, detailFails: true, expected: false, expectedDetailReads: 2 },
    { name: "board fails but explicit detail succeeds", boardFails: true, detailFails: false, expected: true, expectedDetailReads: 1 }
  ] as const;

  for (const scenario of cases) await context.test(scenario.name, async () => {
    resetKanbanRuntimeState();
    let failBoard = false;
    let failDetail = false;
    let detailReads = 0;
    registerKanbanRuntime(fakeApi({
      fetchBoard: async () => {
        if (failBoard) throw new Error("board offline");
        return board([CARD]);
      },
      fetchCard: async () => {
        detailReads += 1;
        if (failDetail) throw new Error("detail offline");
        return detail(CARD.id, []);
      },
      addComment: async () => { throw new DOMException("response lost", "AbortError"); }
    }));
    await refreshKanbanBoard();
    await toggleTaskComments(CARD.id);
    assert.equal(taskCommentDetail.value.state, "ready");
    assert.equal(await addTaskComment(CARD.id, "maybe committed"), "commit-unknown");

    const readsBeforeConfirmation = detailReads;
    failBoard = scenario.boardFails;
    failDetail = scenario.detailFails;
    assert.equal(await confirmUnconfirmedComment(CARD.id), scenario.expected);
    assert.equal(detailReads - readsBeforeConfirmation, scenario.expectedDetailReads);
    assert.equal(unconfirmedTaskComments.value[CARD.id]?.checked, scenario.expected);

    allowUnconfirmedCommentResend(CARD.id);
    assert.equal(unconfirmedTaskComments.value[CARD.id] === undefined, scenario.expected);
  });
});

test("a detail GET started before confirmation cannot authorize resend when it finishes later", async () => {
  resetKanbanRuntimeState();
  let deferDetails = false;
  let deferBoard = false;
  let boardRequest: ReturnType<typeof deferred<ReturnType<typeof board>>> | undefined;
  const detailRequests: Array<ReturnType<typeof deferred<KanbanCardDetailResult>>> = [];
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => {
      if (!deferBoard) return board([CARD]);
      boardRequest = deferred<ReturnType<typeof board>>();
      return boardRequest.promise;
    },
    fetchCard: async () => {
      if (!deferDetails) return detail(CARD.id, []);
      const request = deferred<KanbanCardDetailResult>();
      detailRequests.push(request);
      return request.promise;
    },
    addComment: async () => { throw new DOMException("response lost", "AbortError"); }
  }));
  await refreshKanbanBoard();
  await toggleTaskComments(CARD.id);
  assert.equal(await addTaskComment(CARD.id, "maybe committed"), "commit-unknown");

  deferDetails = true;
  const oldDetail = retryTaskComments();
  assert.equal(detailRequests.length, 1);
  deferBoard = true;
  const confirmation = confirmUnconfirmedComment(CARD.id);
  await waitUntil(() => boardRequest !== undefined);

  detailRequests[0]!.resolve(detail(CARD.id, []));
  await oldDetail;
  boardRequest!.reject(new Error("board offline"));
  await waitUntil(() => detailRequests.length === 2);
  detailRequests[1]!.reject(new Error("new detail offline"));

  assert.equal(await confirmation, false);
  assert.equal(unconfirmedTaskComments.value[CARD.id]?.checked, false);
  allowUnconfirmedCommentResend(CARD.id);
  assert.notEqual(unconfirmedTaskComments.value[CARD.id], undefined);
});

test("commit-unknown card creation is blocked until an authoritative board check", async () => {
  const source = await readFile(new URL("../src/components/kanban-board.tsx", import.meta.url), "utf8");
  assert.match(source, /Boolean\(unconfirmedTaskCreation\.value\)/);
  assert.match(source, /confirmUnconfirmedTaskCreation/);
  assert.match(source, /allowUnconfirmedTaskResend/);
  assert.match(source, /<input[\s\S]*?disabled=\{boardState\.state === "loading" \|\| taskCreationBusy\.value \|\| Boolean\(unconfirmedTaskCreation\.value\)\}/);
  assert.match(source, /type="submit" disabled=\{busy \|\| !title\.trim\(\)\}/);

  resetKanbanRuntimeState();
  let cards = [{ ...CARD }];
  let postCalls = 0;
  let boardReads = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => { boardReads += 1; return board(cards); },
    createCard: async (title) => {
      postCalls += 1;
      cards = [...cards, { ...CARD, id: "created-remotely", title }];
      throw new DOMException("response lost", "AbortError");
    }
  }));
  await refreshKanbanBoard();
  const readsBeforePost = boardReads;

  assert.equal(await createTask("maybe created"), "commit-unknown");
  assert.equal(postCalls, 1);
  assert.equal(boardReads, readsBeforePost);
  assert.equal(await createTask("maybe created"), "commit-unknown");
  assert.equal(postCalls, 1);
  assert.equal(await confirmUnconfirmedTaskCreation(), true);
  assert.equal(postCalls, 1);
  assert.equal(unconfirmedTaskCreation.value?.checked, true);
  assert.ok(tasks.value.some((task) => task.id === "created-remotely"));
  allowUnconfirmedTaskResend();
  assert.equal(unconfirmedTaskCreation.value, undefined);
  assert.equal(kanbanState.value.state, "ready");
});

test("card creation is runtime-scoped single-flight and cannot overwrite commit-unknown state", async () => {
  resetKanbanRuntimeState();
  const request = deferred<WorkTask>();
  let postCalls = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([CARD]),
    createCard: async () => { postCalls += 1; return request.promise; }
  }));
  await refreshKanbanBoard();

  const first = createTask("first title");
  assert.equal(postCalls, 1);
  assert.equal(taskCreationBusy.value, true);
  assert.deepEqual(tasks.value.filter((task) => task.id.startsWith("pending-")).map((task) => task.title), ["first title"]);

  assert.equal(await createTask("second title"), "rejected");
  assert.equal(postCalls, 1);
  assert.deepEqual(tasks.value.filter((task) => task.id.startsWith("pending-")).map((task) => task.title), ["first title"]);

  request.reject(new DOMException("response lost", "AbortError"));
  assert.equal(await first, "commit-unknown");
  assert.equal(taskCreationBusy.value, false);
  assert.equal(unconfirmedTaskCreation.value?.input, "first title");
  assert.equal(await createTask("overwrite attempt"), "commit-unknown");
  assert.equal(postCalls, 1);
  assert.equal(unconfirmedTaskCreation.value?.input, "first title");
});

test("deterministic mutation rejection remains distinct from commit-unknown", async () => {
  const rejected = new KanbanMutationFailure("rejected", new Error("invalid card"));
  assert.equal(classifyKanbanMutationFailure(rejected), "rejected");
  assert.equal(classifyKanbanMutationFailure(new OfficeHttpError(422)), "rejected");
  assert.equal(classifyKanbanMutationFailure(new OfficeHttpError(409, "commit_unconfirmed")), "commit-unknown");
  assert.equal(classifyKanbanMutationFailure(new OfficeHttpError(408)), "commit-unknown");
  assert.equal(classifyKanbanMutationFailure(new DOMException("timeout", "AbortError")), "commit-unknown");

  resetKanbanRuntimeState();
  let calls = 0;
  registerKanbanRuntime(fakeApi({
    fetchBoard: async () => board([CARD]),
    createCard: async () => { calls += 1; throw rejected; }
  }));
  await refreshKanbanBoard();
  assert.equal(await createTask("invalid"), "rejected");
  assert.equal(unconfirmedTaskCreation.value, undefined);
  assert.equal(await createTask("corrected"), "rejected");
  assert.equal(calls, 2);
});

function fakeApi(overrides: Partial<KanbanApi>): KanbanApi {
  return {
    fetchBoard: async () => board([CARD]),
    fetchCard: async (cardId) => detail(cardId, []),
    createCard: async () => CARD,
    updateCard: async () => CARD,
    addComment: async () => {},
    ...overrides
  };
}

function board(cards: WorkTask[]) {
  return { tasks: cards, assignees: ["external-agent"], latestEventId: 1 };
}

function detail(cardId: string, comments: TaskComment[]): KanbanCardDetailResult {
  return {
    card: { ...CARD, id: cardId, comments: comments.length },
    comments,
    availableCommentCount: comments.length,
    truncated: false
  };
}

function comment(id: number, cardId: string, body: string): TaskComment {
  return { id, cardId, author: "hermes-studio", body, createdAt: 100 + id };
}

function rawCard(commentCount: number) {
  return {
    id: CARD.id,
    title: CARD.title,
    body: null,
    assignee: null,
    status: CARD.status,
    priority: 0,
    createdAt: 100,
    startedAt: null,
    completedAt: null,
    latestSummary: null,
    commentCount
  };
}

function rawComment(id: number) {
  return { id, cardId: CARD.id, author: "hermes-studio", body: `note ${id}`, createdAt: 100 + id };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for Kanban state.");
}
