# Peek documentation

## Where to start

1. [features.md](./features.md) — building a Peek feature, end to end. The best
   first read for anyone adding anything.
2. [architecture.md](./architecture.md) — the map: the tile model, the state
   machines that govern runtime behaviour, and the implementation conventions.
3. [api.md](./api.md) — reference for `window.app`, the API every `peek://` page
   calls.
4. [feature-tour.md](./feature-tour.md) — every user-visible feature, what it
   does and where it lives in the UI.

The engineering task queue is not in this directory: it lives in Peek itself, as
items tagged `peek:todo` (narrow with `peek:desktop`, `peek:bug`,
`peek:feature`, …). Reach it over MCP with
`mcp__peek__list_items({tags: ["peek:todo"]})`, or type `#peek:todo` in the cmd
panel.

## Tiles and the feature API

- [tiles-single-file.md](./tiles-single-file.md) — what a tile is, the residency
  and visibility axes, and the manifest v3 shape.
- [tile-api.md](./tile-api.md) — every surface a tile gets, and the capability
  each one requires.
- [tile-lifecycle-fsm.md](./tile-lifecycle-fsm.md) — the single path by which a
  tile window is created, and the manifest cache that makes a tile's
  declarations visible while it is unloaded.
- [page-widgets.md](./page-widgets.md) — how a feature hooks the page-host
  lifecycle, runs content scripts, and shows a widget beside the page.
- [feature-settings-api.md](./feature-settings-api.md) — proposal for a uniform
  way to read global settings from a feature.
- [design/tile-protocols.md](./design/tile-protocols.md) — proposal for
  declaring tile APIs as Web Tiles protocols instead of hand-wiring each one.

## Core runtime

- [pubsub-state-machine.md](./pubsub-state-machine.md) — which messages may flow
  between tiles in each state, and why a dropped publish should be impossible.
- [izui.md](./izui.md) — the invocation state machine: whether Peek was focused
  when a command ran, and what that changes.
- [cmd.md](./cmd.md) — the command palette: chaining, MIME-typed data flow,
  registering commands.
- [cmd-chain-architecture.md](./cmd-chain-architecture.md) — one-page map of the
  cmd renderers, the pubsub topics between them, and the fragile joints.
- [cmd-state-machine.md](./cmd-state-machine.md) — the cmd bar's states,
  transitions, guards and invariants.
- [cmd-palette-spec.md](./cmd-palette-spec.md) — the proposed palette behaviour:
  affordances, completion, result feedback, chaining discoverability.

## Windows, placement and desktops

- [design/window-manager.md](./design/window-manager.md) — the governing
  description of the window kernel: the rule set, the model, the effects.
- [design/window-rules.md](./design/window-rules.md) — the rules themselves, one
  line each, with the gestures they compose into.
- [design/kernel-desktops-cheatsheet.md](./design/kernel-desktops-cheatsheet.md)
  — facts to hold while changing how windows behave across virtual desktops.
- [design/kernel-desktops-implementation.md](./design/kernel-desktops-implementation.md)
  — implementation notes and probe findings for `specs/kernel-desktops.md`.
- [design/space-desktop-return-plan.md](./design/space-desktop-return-plan.md) —
  how opening a space returns the user to its virtual desktop: markers, restore
  holds, desktop choice.
- [design/page-host-resilience.md](./design/page-host-resilience.md) — a page
  host stays usable whatever its page does.
- [window-placement.md](./window-placement.md) — the placement spec: intents,
  proportional geometry, display selection, persistence.
- [global-hotkeys-on-wayland.md](./global-hotkeys-on-wayland.md) — why
  `globalShortcut` cannot work on Wayland, what ships instead, and the CLI verbs
  a desktop environment binds.

## Data

- [datastore.md](./datastore.md) — the schema and the datastore API.
- [feeds-api.md](./feeds-api.md) — series and feed items, and the event table
  both store their values in.
- [sync.md](./sync.md) — the sync protocol between mobile, desktop and server.
- [sync-coverage-gaps.md](./sync-coverage-gaps.md) — what a restore from the
  server would not bring back, and what settles each gap.
- [profiles.md](./profiles.md) — isolated data environments on desktop and
  server.
- [themes.md](./themes.md) — theme structure, the CSS variable contract, and the
  theme API.
- [reactivity-research.md](./reactivity-research.md) — the datastore change
  events a feature subscribes to so its UI does not go stale.

## Designs not yet built

Each of these is a live proposal: read it before building the thing it
describes, and change it if the design changed.

- [entity-correlation-design.md](./entity-correlation-design.md) — co-occurrence,
  entity resolution and clustering over extracted entities.
- [collab-notes-design.md](./collab-notes-design.md) and
  [collab-notes-ux.md](./collab-notes-ux.md) — multi-user notes with no
  Peek-operated server in the data path, and the UX that goes with it.
- [mcp-remote-backend-design.md](./mcp-remote-backend-design.md) — giving the
  MCP server a remote data backend so a client with no local Peek can read and
  write the same store.
- [workers-design.md](./workers-design.md) — features that run on remote compute
  with no window and no user present.
- [workers-capabilities.md](./workers-capabilities.md) — what authority a worker
  holds and what bounds it.
- [worker-runtime-portability.md](./worker-runtime-portability.md) — one worker
  module against four hosts, and where the seam belongs.

## Platforms and operations

- [mobile.md](./mobile.md) — the iOS app: share extension, frecency, sync,
  build workflow.
- [server-backup-and-deploy.md](./server-backup-and-deploy.md) — deploying the
  hosted sync server, and what its backups actually do.

## History

[historical/](./historical/) holds records of finished work — migration plans,
investigations, research spikes and audits. They are kept for their reasoning,
not as current guidance, and each one says so on its first line.

Two more directories hold measurements rather than prose: `perf/` carries
page-host cost baselines, and `research/` carries the raw benchmark data behind
the session save/restore audit in `historical/`.
