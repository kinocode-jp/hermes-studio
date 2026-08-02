# Hermes integration boundary

> **Document status:** This records pinned upstream research, the current
> adapter boundary, and recommended compatibility behavior. Statements using
> “should”, “must”, “production”, or “future” are design requirements rather
> than guarantees that the current pre-1.0 implementation satisfies them. See
> the root README for the implemented product surface.

Checked against Hermes Agent `main` at commit
[`1f89f310`](https://github.com/NousResearch/hermes-agent/tree/1f89f3102f701dea3a2706d174197ecbefac20be)
on 2026-07-16. The locally installed Hermes 0.18.2 checkout was also inspected,
but the pinned upstream source is the contract reference.

## Decision

Hermes Studio follows Hermes without forking it. The product talks to a stock
`hermes serve` process through a small adapter and keeps Office-only concepts
(character appearance, global inheritance, window layout, remote device policy)
outside Hermes-owned files and databases.

`hermes serve` and `hermes dashboard` boot the same FastAPI backend. `serve` is
the headless mode used by Desktop and remote clients; it skips the dashboard SPA
build and mount. The command defaults to `127.0.0.1:9119`. See the official
[`dashboard`/`serve` parser](https://github.com/NousResearch/hermes-agent/blob/1f89f3102f701dea3a2706d174197ecbefac20be/hermes_cli/subcommands/dashboard.py)
and [Web Dashboard documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard).

The backend is a mixed protocol, not one JSON-RPC API:

| Concern | Official surface | Office adapter use |
| --- | --- | --- |
| Liveness and management | REST under `/api/*` | status, profiles, stored sessions, skills, memory config, schema-driven config (`/api/config`, `/api/config/schema`) |
| Live chat | JSON-RPC 2.0 over WebSocket `/api/ws` | create/resume multiple sessions, submit, interrupt, approvals |
| Gateway events | JSON-RPC notification `method: "event"` on `/api/ws` | streaming text, tools, status, prompts |
| Kanban | REST + `/api/plugins/kanban/events` WebSocket | board CRUD, assignment, comments, live task events |
| Terminal compatibility | `/api/pty` WebSocket | not used by the Office chat UI |

The authoritative implementations are
[`hermes_cli/web_server.py`](https://github.com/NousResearch/hermes-agent/blob/1f89f3102f701dea3a2706d174197ecbefac20be/hermes_cli/web_server.py),
[`tui_gateway/server.py`](https://github.com/NousResearch/hermes-agent/blob/1f89f3102f701dea3a2706d174197ecbefac20be/tui_gateway/server.py), and the official
[`JsonRpcGatewayClient`](https://github.com/NousResearch/hermes-agent/blob/1f89f3102f701dea3a2706d174197ecbefac20be/apps/shared/src/json-rpc-gateway.ts).

## Transport model

`packages/hermes-client` deliberately contains no `fetch`, WebSocket, Tauri, or
authentication implementation. It defines three operations:

1. `request` for REST.
2. `connectRpc` for one `/api/ws` connection.
3. `subscribe` for non-RPC streams such as Kanban events.

The Tauri shell can implement this boundary in Rust. The PWA should call the
Studio Server, which proxies to Hermes after enforcing the Office device
and role policy. This keeps Hermes administrative credentials and filesystem
paths out of browser JavaScript.

Profile scoping is not uniform in Hermes. Chat create/resume accepts a profile,
profile and SOUL routes name it in the path, and skills/config commonly accept a
`profile` query/body field. The current `/api/memory*` handlers are implicitly
scoped to the backend process and do not accept a profile selector. The adapter's
`profile` option therefore means “logical target profile”, not “always append a
query string”. A production runtime can keep one machine backend for chat and
explicitly scoped reads, then lazily start `hermes -p <name> serve --isolated`
on an OS-assigned loopback port only for profile-implicit management calls. Use
an idle TTL; do not keep one Hermes process per character permanently.

Office stage-1 advanced config uses profile-pinned backends and the official
dashboard endpoints `GET /api/config/schema`, `GET /api/config`, and
`PUT /api/config`. Hermes 0.18.2 schema inference maps `DEFAULT_CONFIG` null
leaves to `"string"` (`_infer_type`); Office value-aware projection denies
ambiguous leaves and exposes string-lists only. Hermes deep-merges PUT bodies
and does not offer conditional
writes; Office therefore serializes per-profile config mutations, re-reads the
safe-leaf projection, and enforces SHA-256 `expectedRevision` concurrency
itself. Browsers never call Hermes config routes directly.

UI code must preserve two session identities:

- `session_id` returned by `session.create`/`session.resume` is a live,
  process-local gateway handle used by `prompt.submit`, `session.interrupt`, and
  approval responses.
- `stored_session_id` (or `resumed`) is the durable `state.db` conversation id
  used by REST history, rename, archive, export, and later resume. It is unique
  only within its Profile, so Office indexes it as `(profile, stored_session_id)`.

Treating those ids as interchangeable creates reconnect and compression bugs.
Hermes can rotate a stored id during compression. Office forwards the exact
inventory id to native `session.resume` and learns the authoritative durable and
live identities from its response. Do not rewrite resume through
`/api/sessions/{id}/latest-descendant`: that REST traversal also follows newer
branch, delegate, and tool children that native resume intentionally excludes.

Studio Server multiplexes every Browser Chat WebSocket over one Hermes gateway
connection. This keeps Hermes' process-global live transport stable while
Office routes each normalized live event only to the Browser socket that owns
that live id. A Browser disconnect waits a bounded interval for its in-flight
create/resume identity to settle, then explicitly closes only that Browser's
owned live sessions. If the identity does not settle within that bound or an
owned close cannot be confirmed, Office treats the state as an ambiguous
shared-upstream failure: it closes the Hermes connection, reaps every
`close_on_disconnect` session, and makes all affected panes resynchronize.
Server shutdown and other shared-upstream failures use the same global fence.

Each Office lease owns exactly one Hermes live id. A second, different live id
returned while converging a durable compression alias is a duplicate `_sessions`
entry, not another name for the existing pane. Office discards its early events
and closes that duplicate directly; if the close cannot be confirmed, Office
resets the shared generation and requires every affected pane to resynchronize.
Live ids are process-global and are the only accepted targets for non-resume
chat RPCs, including prompt, interrupt, and explicit close. A raw durable id is
never resolved implicitly for those operations because equal durable ids may
belong to several Profiles.

## Live chat contract

JSON-RPC frames are ordinary JSON objects (one frame per WebSocket message):

```json
{"jsonrpc":"2.0","id":"office-1","method":"session.create","params":{"profile":"coder"}}
```

Hermes replies with `result` or `error`. Streaming arrives separately:

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"a1b2c3d4","payload":{"text":"..."}}}
```

The minimum Office chat set is:

- `session.create`, `session.resume`, `session.close`
- `prompt.submit`, `session.steer`, `session.interrupt`
- `clarify.respond`, `approval.respond`, `sudo.respond`, `secret.respond`
- `session.history`, `session.title`, `config.set`, `model.options`

Hermes currently registers 117 RPC methods. Office must not copy the full
dispatcher. Unknown features use the generic RPC escape hatch, and a JSON-RPC
`-32601`/“unknown method” response means “capability unavailable”, not a fatal
backend failure. The current GUI/backend compatibility marker is
`desktop_contract = 3`; it is useful as a warning floor but is not a complete
capabilities document.

Important behavior from the current server:

- `session.create` is cheap and creates no stored row until the first prompt.
- Agent construction is deferred, so `session.info` can arrive after the create
  response.
- A single server accepts an explicit `profile` on create/resume, allowing
  several profile chats to remain live concurrently.
- `session.close` returns `closed: false` when the live id is already absent.
  This is a successful idempotent close; only an RPC/transport failure leaves
  Office ownership unresolved and fail-closed.
- `prompt.submit` returns `{status: "streaming"}` before the model turn finishes.
  Completion is event-driven.
- A timeout, transport close, oversized/invalid response, or shared-generation
  change after `prompt.submit` may happen after Hermes accepted the prompt.
  Office returns JSON-RPC code `-32008` with
  `data.reason = "commit_unconfirmed"`; clients reload authoritative history and
  never automatically replay that prompt. Explicit Hermes RPC rejection remains
  a definitive failure.
- Sending while a turn is busy may queue/interrupt according to Hermes behavior;
  the UI must display backend state instead of inventing its own run state.
- `session.steer` returns `{status: "queued"}` or `{status: "rejected"}`.
  Office records only `queued` as **Hermes queue accepted**. This acknowledges
  the upstream in-memory queue, not model application. At pinned commit
  `1f89f310`, a steer arriving after the last tool batch can be drained by
  `turn_finalizer` as `pending_steer`, while `tui_gateway/server.py` does not
  forward that leftover to a later turn or emit an applied/deferred event.
  Delivery at this end-of-turn boundary is therefore not guaranteed. Office
  neither claims exactly-once delivery nor retries the text as a prompt, because
  stock Hermes exposes no operation identity and an automatic retry could
  duplicate a steer that was already applied.

## REST surfaces used by Office

### Profiles

- `GET/POST /api/profiles`
- `GET/POST /api/profiles/active`
- `PATCH/DELETE /api/profiles/{name}`
- `GET/PUT /api/profiles/{name}/soul`
- `PUT /api/profiles/{name}/description`
- `PUT /api/profiles/{name}/model`

A profile is a separate Hermes home with its own config, secrets, SOUL, memory,
sessions, skills, cron and gateway state. “Profile equals character” is therefore
a stable Office mapping. The default profile is still a profile; it is not a
global configuration layer. Office may show a local display-name alias for any
profile (including `default`); that alias never renames the Hermes profile id
or home directory. See [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/).

### Stored sessions

- `GET /api/profiles/sessions` is the preferred cross-profile, read-only list.
  It reads profile databases directly and does not start one backend per profile.
  Office follows its `limit`/`offset`/`total` contract in 100-row requests, with
  an overall deadline, response-byte budget, and row/page ceiling. Duplicate
  rows keep their first observed order. Hermes `errors`, an incomplete page, or
  a safety ceiling produce an explicit truncated inventory instead of a silent
  complete-looking list.
  Studio Server also converts each row's persisted `git_repo_root`/`cwd` into
  an opaque project-group id and a bounded basename for the Web sidebar. The
  absolute host path is never included in the browser snapshot, and this
  grouping does not start profile-scoped Hermes backends.
- `GET /api/sessions` is profile-scoped and supports pagination/filtering.
- `GET /api/sessions/{id}` and `/messages` load detail/history.
- `PATCH /api/sessions/{id}` renames or archives.
- `DELETE /api/sessions/{id}` is idempotent for an absent id.

List responses intentionally omit heavyweight `system_prompt` and `model_config`
unless `full=1`. Office should keep that default and page messages (maximum 500
per request) rather than loading every transcript at startup.

Hermes stores messages in insertion order and applies a zero-based `offset`.
Its messages response does not declare a total, so Office performs one bounded
message probe to resolve the resume descendant and reads that session's
`message_count`. It then fixes a tail window and pages from newest to older;
each returned page and the final assembled transcript remain in insertion order.
This ensures every safety stop retains the newest saved turns, and a session
with exactly 500 messages is complete rather than falsely marked partial.

Office history continuation is cumulatively bounded as well as response-bounded.
Signed, session/profile-bound cursors carry the resolved session, fixed window,
page count, delivered-message count, and UTF-8 wire-byte total. The server and
Web client independently stop at 40 pages, 500 messages, or 8 MiB. Reaching a
limit or losing a later, older page preserves the newest already-loaded messages
as an explicit partial result instead of attempting an unbounded render.

`GET /api/profiles` is not paginated by Hermes. Office reads its single bounded
response, then exposes both profile and session inventories as 100-row Office
pages with opaque continuation cursors. Snapshot metadata includes `hasMore`,
`truncated`, the cached/known totals, and partial-failure counts.

### Skills

- `GET /api/skills?profile=...`
- `PUT /api/skills/toggle`
- `GET /api/skills/content?name=...&profile=...`
- `POST /api/skills` and `PUT /api/skills/content`
- `/api/skills/hub/*` for install/search/update workflows

Hermes skills are profile-scoped. Office “global skills” must be an Office-owned
inheritance policy. The server should materialize an explicit selected set into
each profile through official endpoints and record provenance; it must not point
multiple profiles at one writable `SKILL.md` directory.

### Memory

- `GET /api/memory` returns the provider and sizes of `MEMORY.md`/`USER.md`.
- `PUT /api/memory/provider` selects a provider.
- `/api/memory/providers/{name}/config` manages provider-specific config.
- `POST /api/memory/reset` deletes built-in memory/user files.

Hermes does not currently publish a stable dashboard REST endpoint for arbitrary
raw editing of built-in `MEMORY.md` and `USER.md`. Office therefore provides its
own versioned raw-edit API under
`/api/v1/profiles/{profile}/memory/files…`, reading and writing only the
resolved profile home's `memories/MEMORY.md` and `memories/USER.md`, while
reset continues to use profile-pinned `POST /api/memory/reset`. Memory files
are frozen into a session at its start, so edits affect later sessions. See
[Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
and [HERMES-SETTINGS.md](HERMES-SETTINGS.md).

## Kanban

Kanban is intentionally shared across profiles, which matches the Office work
queue. It is a bundled dashboard plugin mounted under
`/api/plugins/kanban/`; do not read or mutate `kanban.db` directly. The current
router is
[`plugins/kanban/dashboard/plugin_api.py`](https://github.com/NousResearch/hermes-agent/blob/1f89f3102f701dea3a2706d174197ecbefac20be/plugins/kanban/dashboard/plugin_api.py).

Office Teams are **not** a Hermes concept. They are Office-owned metadata that
group Hermes profile IDs many-to-many for roster context, workload aggregation,
and Kanban filtering. Card assignment remains to one individual Hermes profile;
Office never invents a synthetic team assignee and never writes upstream
`kanban.db` for team membership.

Minimum UI routes:

- `GET /board`, `GET/POST/PATCH/DELETE /tasks...`
- `POST /tasks/{id}/comments`
- `POST/DELETE /links`
- `GET/POST/PATCH/DELETE /boards...`
- `GET /profiles`, `GET/PUT /orchestration`
- `POST /dispatch`
- WebSocket `/events?since=<event_id>&board=<slug>`

Current visible states are `triage`, `todo`, `scheduled`, `ready`, `running`,
`blocked`, `review`, `done`; archived is opt-in. The dispatcher owns promotion
to `running`; a drag operation must not directly force that state. Each event
has a monotonically increasing id. Reconnect with the last seen `since` cursor,
then refresh `/board` if the cursor cannot be reconciled. See the official
[Kanban reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban).

## Authentication and remote access

Keep the stock Hermes bind on loopback whenever Office and Hermes share a host.
For a non-loopback Hermes bind, current Hermes fails closed unless an auth
provider is configured; `--insecure` is deprecated and no longer bypasses that
gate.

`GET /api/status` is a public, low-sensitivity liveness probe and reports the
auth-gate shape. All other REST operations should be treated as authenticated.
WebSockets cannot set an Authorization header in browsers. In gated mode an
authenticated client calls `POST /api/auth/ws-ticket` and immediately spends
the returned single-use, 30-second ticket as `?ticket=...`. Mint a separate
ticket for every socket/reconnect. Never cache and retry an old ticket.

Recommended remote path:

```text
PWA / mobile browser
  -> HTTPS + Office session + device policy
Studio Server
  -> loopback REST / WS
stock hermes serve
```

Do not expose `hermes serve` directly as the public product endpoint. Office
needs its own CSRF protection, device revocation, audit trail, rate limits and
permissions separating chat/approval from secret, skill, memory and profile
administration.

## Compatibility policy

1. Probe `GET /api/status` before opening sockets and record Hermes version.
2. Require only the small core chat contract; detect optional RPC methods by
   calling them and handling `-32601`.
3. Keep wire payloads tolerant of additional fields. Do not destructively
   rewrite unknown config fields.
4. Keep all route names in the adapter/server layer, never spread them through
   UI components.
5. Pin CI contract fixtures to a known Hermes commit and periodically compare
   route/method inventories against upstream `main`.
6. If an endpoint disappears or changes semantics, fail the affected feature
   closed while preserving chat and read-only status where safe.
7. Inventory metadata is authoritative only when `partialFailures` is zero and
   `truncated` is false. A zero-row partial/unavailable read retains the
   client's last-known-good Profile, session and open-chat state; only a
   complete zero-row read confirms deletion or a genuinely empty runtime.
   A `total` that conflicts with the current page or changes between pages is
   partial metadata; full pages then continue under the fixed page/row/byte
   and deadline limits instead of using that `total` as a terminal condition.
8. A missing Hermes session timestamp is represented by the stable
   `UNKNOWN_INVENTORY_TIMESTAMP` DTO sentinel. Timestamp `0` remains the Unix
   epoch and is not treated as unknown; invalid present values make that row
   partial instead of receiving a time-dependent fallback.

## Known uncertainties

- Hermes does not expose a complete machine-readable capability manifest for
  the dashboard/serve surface. Version plus method-not-found fallback is still
  required.
- Some official docs lag source during rapid releases. The pinned source wins
  for wire behavior; docs win for user-supported intent.
- Raw built-in memory editing is not a stable official Hermes API; Office owns
  the versioned file surface under `/api/v1/profiles/{profile}/memory/files`
  (raw body GET/PUT require `memory.update`, not ordinary `state.read`).
- Profile selection is not consistent across every REST handler. In particular,
  current Hermes memory endpoints are process-scoped, so the runtime needs lazy
  per-profile routing or a future upstream profile parameter.
- Office global skills/memory/defaults are new product semantics and require an
  Office-owned inheritance/provenance model.
- Multi-user authorization is an Office responsibility; the Hermes dashboard
  auth gate protects a deployment but is not a granular tenant/RBAC boundary.
