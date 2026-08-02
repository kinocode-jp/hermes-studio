# Hermes Studio — product and interface direction

> **Document status:** This is a product and design direction document. It
> intentionally includes proposed interactions and performance targets that may
> not be implemented. The current feature inventory is in the root README;
> security behavior is documented separately in `docs/SECURITY.md`.

## The subject

Hermes Studio is a lightweight control room for people who run several Hermes Agent profiles at once. Its single job is to make agents feel spatial and legible without hiding the serious controls needed to supervise their work.

The office is not a decorative landing page. It is the application's live index: **one character is one Profile**, desks show current activity, and every session, task, skill, and memory item remains reachable from that character.

## Design thesis: the night shift studio

The visual world is a compact creative studio seen late at night: blueprint-dark flooring, pools of warm desk light, paper-colored working surfaces, and a few precise signal colors. The pixel office occupies the visual center; functional panels feel like flat metal drawers pulled over the scene.

This direction deliberately avoids three familiar templates:

- no generic SaaS grid of interchangeable rounded cards;
- no neon cyberpunk dashboard with decorative glow everywhere;
- no game HUD that forces chat, code, or settings into low-density pixel typography.

Pixel art belongs to the spatial layer—characters, desks, status props, and motion. Reading and editing surfaces use crisp DOM text, native selection, accessible controls, and dense but calm layouts.

## Core model

| Hermes concept | Office representation | Interaction |
| --- | --- | --- |
| Profile | Character and permanent desk | Click to open the Profile workbench |
| Session | Monitor/tab at that desk | Open, split, pin, pause, or close independently |
| Tool activity | Desk prop and compact status strip | Inspect the event stream; approve when required |
| Skill | Tool card in the Profile's kit drawer | Enable, disable, configure, or inherit |
| Memory / SOUL | Notebook in the Profile's memory drawer | Edit with source and inheritance visible |
| Kanban task | Paper ticket on the rail | Drag to a character/desk to assign |
| Global setting | Building utility layer | Profiles inherit unless they explicitly override |

A Profile never multiplies into several characters when several sessions run. Its desk gains additional lit monitors and a numeric session badge. This preserves spatial memory: the same character is always found in the same place.

## Palette

Six colors form the entire authored palette. Tints and alpha overlays may be derived from them; do not introduce additional brand colors.

| Token name | Hex | Use |
| --- | --- | --- |
| Night blueprint | `#101827` | App background, deepest office floor |
| Drafting blue | `#1B2B43` | Raised surfaces, panels, inactive desks |
| Ledger paper | `#F3E8D1` | Primary text, editor paper, selected surfaces |
| Signal coral | `#F06A57` | Needs attention, destructive actions, direct manipulation |
| Terminal aqua | `#55D6BE` | Running, connected, focus, successful assignment |
| Worklight amber | `#F2B84B` | Waiting, inherited values, desk lamps, queued work |

Color is never the sole status cue. Every state pairs color with a shape and a verb: aqua rotating cog + “Running”; amber hourglass + “Waiting for you”; coral diamond + “Blocked”.

### Contrast and surfaces

- Default text is Ledger paper on Night blueprint.
- Secondary text uses Ledger paper at 68% opacity on Night blueprint or Drafting blue.
- Interactive focus uses a 2px Terminal aqua outline plus a 2px Night blueprint separation ring.
- Editors may use Ledger paper as a light canvas with Night blueprint text; this inversion is reserved for writing, diffs, and long-form memory.
- Coral is not used for ordinary decoration, so it retains its urgency.

## Typography

The type system mixes the workshop's Japanese character with highly legible operational text. All sans-serif UI text uses a single family so windows read consistently across surfaces.

- **Unified sans (display + body):** `Noto Sans JP`, fallback `system-ui, sans-serif`, tokenized as `--font-sans` and `--font-display`. Body and controls use weights 400–600; page and window titles use 800–900.
- **Titles:** page titles (`h1` on Office, Kanban, Teams, Settings) share `--title-page-size` / `--title-page-weight`; modal, panel, and popover titles share `--title-window-size` / `--title-weight` with `--title-leading` and `--title-tracking`. Do not add one-off title sizes per window.
- **Utility / data:** `Martian Mono`, fallback `ui-monospace, monospace`. Use for timestamps, session IDs, tool names, keybindings, token counts, and compact status labels.

UI text sizes are tokenized as `--text-xs` (12px), `--text-sm` (13px), `--text-md` (14px), and `--text-lg` (16px), each defined as `calc(Npx * var(--font-scale, 1))` so the appearance font-scale setting applies everywhere. 12px is the minimum UI text size; hardcoded pixel sizes below that are not allowed. Chat body is 16px/1.65. Display text is 24–32px/1.05 and should never appear as a paragraph.

Webfonts must use `font-display: swap`; the initial render must remain usable with fallbacks. Noto Sans JP is packaged locally as unicode-range woff2 chunks (`apps/web/public/fonts/noto-sans-jp/`, declared in `apps/web/src/fonts.css`) so the desktop app works within its `default-src 'self'` CSP; the browser fetches only the ranges it renders, and the PWA caches them at runtime.

## Signature element: task cables

When a Kanban ticket is assigned, a thin orthogonal cable is drawn from the board rail to the Profile's desk. It takes a route along the office floor grid and terminates at the character's task lamp.

- Cable color communicates state: amber queued, aqua active, coral blocked.
- A single square pulse moving along the cable indicates recent activity. There are no ambient particles.
- Selecting a cable highlights its ticket, Profile, and active session as one connected set.
- Dragging a ticket previews a dashed cable to candidate desks; dropping commits assignment and the cable “plugs in” once.
- Multiple tasks share a trunk near the desk and fan out at the rail, preventing spaghetti lines.
- Cables are hidden by default below 768px and replaced by explicit assignee chips.

The design risk is treating assignment as architecture rather than another dropdown. It is justified because the product's unique promise is spatial supervision. The fallback assignee menu remains available for keyboard, screen-reader, and mobile use.

## Desktop information architecture

The shell has three stable layers:

1. **Office floor** — profiles, status, assignment, and spatial navigation.
2. **Workbench panes** — one or more Profile workspaces for active supervision.
3. **Utility drawers** — Skills, Memory, Global inheritance, event detail, and settings.

The office remains partially visible while workbenches are open. A user should never lose the sense that other agents are still working.

### Office-first desktop, no pane open

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ HERMES STUDIO    Floor: Studio 1       ⌘K Jump      ● Local     08:42    │
├───────────────┬─────────────────────────────────────────────┬────────────┤
│ TASK RAIL     │                                             │ ACTIVITY   │
│               │    ┌──────────┐         ┌──────────┐        │            │
│ Queue (3)     │    │ MIKA  ◉2 │─────────│ REN   ◉1 │        │ Waiting  1 │
│ ▣ Research    │    │  desk    │ cable   │  desk    │        │ Running  3 │
│ ▣ Compare     │    └──────────┘         └──────────┘        │ Blocked  1 │
│               │                                             │            │
│ Active (4)    │           ┌──────────┐      meeting table   │ 08:41 Mika │
│ ▣ Draft API ──┼──────────▶│ SORA  ◉3 │                      │ used Search│
│ ▣ Audit       │           │  desk    │                      │            │
│               │           └──────────┘                      │ [Inspect]  │
│ Done (12)     │              PIXEL OFFICE FLOOR             │            │
├───────────────┴─────────────────────────────────────────────┴────────────┤
│ 3 running  ·  1 waiting for you  ·  7 sessions              New session │
└──────────────────────────────────────────────────────────────────────────┘
```

The task rail is resizable from 240–360px. The activity strip is collapsible. Removing both leaves the office as a focused supervision canvas.

### Two Profile workbenches open

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ HERMES STUDIO     [Floor] [Mika · 2] [Ren · 1]                  ● Local   │
├───────────────────────────┬──────────────────────────────────────────────┤
│ MIKA  Running             │ REN  Waiting for approval                    │
│ [Chat A] [Chat B ●] [+]   │ [Release notes ●] [+]                       │
├───────────────────────────┼──────────────────────────────────────────────┤
│ assistant message         │ tool request                                 │
│ code / markdown / files   │ ┌──────────────────────────────────────────┐ │
│                           │ │ Run deploy preview?                      │ │
│                           │ │ Command · scope · risk                  │ │
│                           │ │               [Deny] [Allow once]       │ │
│                           │ └──────────────────────────────────────────┘ │
│                           │                                              │
├───────────────────────────┼──────────────────────────────────────────────┤
│ Ask Mika…          [Send] │ Ask Ren…                            [Send]   │
├───────────────────────────┴──────────────────────────────────────────────┤
│ peek:  ▥ office floor  Mika──task cable──Draft API   [Open Skills]      │
└──────────────────────────────────────────────────────────────────────────┘
```

One to four workbenches may be visible. Layout presets are 1-up, 2-column, primary+side, and 2×2. A session is moved between panes via tab drag or keyboard command, but it remains owned by its Profile.

### Profile workbench anatomy

- Header: character portrait, Profile name, current state, model, resource indicator.
- Session strip: horizontal, reorderable tabs with running/waiting badges; never a dropdown-only switcher.
- Main surface: virtualized chat/event timeline.
- Composer: text, attachments, skill mention, stop/continue controls.
- Drawer tabs: `Kit`, `Memory`, `Identity`, `Tasks`, `History`.
- Drawer origin label: every inherited control shows `Global`; overridden controls show `This Profile` and offer “Use global value”.

## Kanban and assignment

The Kanban has two presentations over the same data:

- **Task rail:** a compact office-side queue optimized for drag assignment and supervision.
- **Board room:** a full-width board for planning, dependencies, comments, and batch actions.

Dragging a ticket over a character enlarges only the desk's task lamp and shows the active Profile name plus workload. A drop changes the assignee; it does not automatically start execution unless the ticket's policy says `Start on assignment`. After drop, focus moves to a confirmation toast containing Undo.

Profile-to-Profile handoff is represented as a task event, not chat masquerading as work. Comments may mention Profiles, attach a session result, and request a handoff. The receiving character enters the amber `Reviewing handoff` state until accepted.

Keyboard alternative: focus a ticket, choose `Assign…` (`A`), search Profiles, and confirm. Screen readers announce Profile workload and assignment outcome.

## Skills, memory, and inheritance

The settings model has three explicit layers:

```text
Global defaults
    ↓ inherited unless overridden
Profile configuration
    ↓ copied into the session at creation
Session override (temporary)
```

Do not imitate a Git diff for ordinary users. Use a narrow source gutter on each setting row:

- amber vertical dash + `Global` — inherited;
- aqua square + `Profile` — owned here;
- paper outline + `Session` — temporary;
- coral corner flag — conflict or unavailable dependency.

### Kit drawer

Skills appear as a compact tool inventory: name, source, version, permission summary, and enabled state. The drawer supports list density, search, and category filters; it is not an icon marketplace. Selecting a skill reveals its documentation and configuration beside the list.

### Memory drawer

Memory is separated into `Shared context`, `Profile memory`, and `Identity / SOUL`. Each document shows source, last writer, updated time, and sessions that currently hold an older snapshot. Saving offers `Apply to new sessions` or `Refresh selected sessions`; it never silently rewrites active context.

## Responsive behavior

### Wide desktop — 1280px and above

- Office uses the center; rail and activity strip may both remain open.
- Up to four workbench panes.
- Full task cables and desk labels.
- Board room uses true multi-column Kanban.

### Compact desktop / tablet — 768–1279px

- Activity becomes a drawer; task rail is collapsible.
- Up to two workbench panes.
- Desk labels shorten to Profile names; task cables show only when a ticket or Profile is selected.
- Kanban columns snap horizontally with one full and part of the next visible.

### Phone — below 768px

The phone does not shrink the office. It changes navigation:

The packaged desktop window may be resized down to 320px, so it enters this
same phone navigation mode when its content width falls below 768px.

```text
┌──────────────────────────┐
│ Hermes Studio    ● Remote│
│ 1 waiting · 3 running    │
├──────────────────────────┤
│ PROFILES                 │
│ [Mika portrait] Running 2│
│ Drafting API comparison  │
│                          │
│ [Ren portrait] Waiting   │
│ Approve shell command    │
│                          │
│ [Sora portrait] Idle     │
├──────────────────────────┤
│ Office  Chats  Tasks  You│
└──────────────────────────┘
```

- `Office` is a vertically scrollable Profile roster with small pixel desk vignettes, not a miniature canvas.
- Tapping a Profile opens a full-screen workbench; its sessions use a swipeable/tabbed strip.
- Only one chat is rendered at a time. Other sessions continue through the shared event connection.
- `Tasks` uses status sections or a horizontally snapping board; drag assignment is supplemented by a bottom-sheet assignee picker.
- Approval requests appear as native-feeling bottom sheets with the exact command, scope, and risk.
- Skills and memory editors are full-screen routes with sticky Save/Discard controls.

## Motion

Motion reports causality; it does not make the office continuously busy.

- Character walk: 120ms grid step, maximum 600ms total, only when task context changes.
- Task cable plug-in: 220ms stepped reveal after assignment.
- Activity pulse: one 500ms pass after a meaningful event, no perpetual loop.
- Drawer and pane transitions: 160ms ease-out transform/opacity.
- Waiting characters use a static amber lamp; no bobbing ellipses.

With `prefers-reduced-motion: reduce`:

- characters teleport between grid positions;
- cables appear instantly without a traveling pulse;
- panes use no transform and at most a 60ms opacity change;
- no auto-scrolling except when initiated by the user;
- status changes remain visible through text, icons, and a brief non-animated outline.

The app also exposes `Motion: System / Reduced / Full`; System is the default.

## Interaction and accessibility rules

- All office entities participate in a logical DOM overlay matching visual coordinates; Canvas alone is never the interaction tree.
- Character/desk targets are buttons with Profile name, state, session count, and workload in their accessible name/description.
- Minimum pointer target is 40×40px desktop and 44×44px mobile.
- Every hover action is also available on focus and in an explicit context menu.
- Pane dividers are keyboard-adjustable separators with announced values.
- New agent output does not steal focus. Approval requests raise a live-region message and notification badge.
- Chat, event logs, and long documents use virtualization, but focused elements remain mounted.
- Remote connection state is persistent in the shell. Offline composers save local drafts and state exactly what will or will not sync.

## Performance budget

The design assumes lightness is a product feature.

- The office canvas targets 30fps while visible and stops rendering when obscured or backgrounded.
- Static furniture is cached as one layer; characters, cables, and selection form separate dirty regions.
- Only visible chat rows render; closed panes retain normalized state, not DOM.
- Character sprites use one packed atlas. Default office assets target under 500KB compressed.
- Avoid runtime blur and broad box-shadow animation. Light pools are pre-rendered or static gradients.
- Mobile roster mode does not initialize the office canvas.

## Voice and labels

Use plain verbs tied to an observable result: `Assign to Mika`, `Allow once`, `Stop session`, `Use global value`, `Refresh selected sessions`. Avoid anthropomorphic ambiguity in critical states. A character may “work” visually, but the status says `Running Search` or `Waiting for approval`, not `Thinking hard…`.

Empty states direct action:

- No Profiles: `Create a Profile to place its desk on the floor.`
- No sessions: `Start Mika's first session.`
- No tasks: `Add a task, or keep chatting without the board.`
- Disconnected: `The host is offline. Messages stay as drafts until it reconnects.`

## Final restraint check

The task cable is the single expressive flourish. Panels use consistent corner radii (`--radius-sm/md/lg`, 6–14px) and soft diffused shadows (`--shadow-sm/md/lg`); hard offset "retro" shadows and sharp-cornered inputs were removed in favor of a clean, modern control surface. Typography is disciplined, decorative eyebrow/kicker text is removed in favor of plain headings plus `InfoTip` affordances, and pixel art is restricted to the office layer. Remove ornamental scanlines, random particles, faux terminal chrome, and excessive status glows: none improves control of Hermes Profiles.
