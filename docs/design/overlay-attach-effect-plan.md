# Plan: the overlay's attach target becomes an effect the kernel emits

Status: **scoped, not implemented.** Derived from `docs/design/window-manager.md` § "0. The
governing rule set — derive everything from this".

## What is wrong today

`hybrid-overlay.ts retarget()` runs from a `subscribeFrontChange()` callback
(`window-state-singleton.ts`), which `window-kernel-executor.ts subscribe()` fires at the tail of
`apply()`. The callback re-reads `topmostBaseLayerPageHost` and issues an `AttachOverlay` command
back into the executor while its pump is still draining.

Three defects follow, and only the third is the one usually named:

- **A second decider.** § 1 R1 admits no "helper that only handles the overlay". Which host the
  chrome frames is a window decision, and it is currently made in `hybrid-overlay.ts`.
- **The dedup key is the wrong fact.** The subscription dedups on the ordering query
  (`topmostBaseLayerPageHost`), while the fact that matters is the stored relation
  (`WindowRecord.overlayFor`). A query that goes `A → null → A` fires twice — a detach and an
  attach — and each is a full transition carrying a stacking replay, even though the relation ends
  where it began. That is a self-sustaining input to the show/hide loop, and it sits outside the
  machine where nothing can damp it.
- **Re-entrancy.** The command is decided from inside the pump. `window-kernel-executor.ts pump()`
  queues re-entrant events, so a command issued from a `subscribe()` callback can be decided
  against a state that does not contain events already queued. This is what rejected the overlay's
  first attach (fixed by minting the singleton at boot, not by removing the re-entrancy).

`window-kernel-executor.ts subscribe()`'s own docblock already prescribes the replacement and names
what blocked it: the replacement query had to be band-aware. **That blocker is discharged** —
`window-kernel.ts isBaseLayerPageHost` carries a `layer === BASE_LAYER` clause, which is the
one-band contract `topmost` requires.

## The rule this derives from, and the trap next to it

The design doc says both of the following, and they are in tension:

- "The preferred replacement is an effect, not a subscription" — with the mid-dispatch re-entrancy
  named as the reason.
- No kernel invariant may make attachment and order agree: "enforcing it would mean either
  constraining order to follow attachment — a second ordering rule, which § 0 forbids — or
  constraining attachment to follow order, which is impossible."

**The resolution is the shape of the emission.** A rule that emits whenever `overlayFor` disagrees
with `topmostBaseLayerPageHost` is a repair loop, and it is exactly the forbidden invariant. A rule
that emits when the *answer to the query changes across the transition* is a structural diff, which
is what `react` is allowed to be and what every other rule in it already is.

    forbidden:  next.overlayFor !== topmostBaseLayerPageHost(next)        // a repair loop
    correct:    topmostBaseLayerPageHost(prev) !== topmostBaseLayerPageHost(next)

The correct form preserves all three ways the doc says attachment legitimately diverges from order:
the predicates differ; registration inserts below the key window and shown/hidden never reorder, so
a divergence can be a stable steady state rather than a transient; and `retarget` has liveness
conditions with no kernel counterpart. None of these are corrected, because nothing re-emits. The
effect is a **request the outside may decline**, not an assertion the kernel enforces.

## The design

### 1. A declared fact: which window tracks the base-layer top

`react` must know which record to name as `overlayId`, and when the overlay is detached there is no
`overlayFor` edge to find it by. Add one intrinsic property, written at registration and never
revisited — § 0 stored fact 3, "each window's own lifecycle state, plus its intrinsic properties as
created":

    tracksBaseLayerTop?: boolean   // WindowRecord

`hybrid-overlay.ts ensureOverlay()` declares it in its `registerWindowWithMachine` call.

*Rejected alternative:* keying on `role === 'overlay'`. The doc's repeated correction is that these
relations are structural, not role checks, and a role check would silently capture any future
overlay-role window that is not the shared chrome.

**This field must be added in four places or it will be dropped**, exactly as `keepLive`,
`parentId` and `overlayFrame` each were: the `WindowRegistered` re-registration merge in
`window-kernel.ts evolve` (as a *declared* fact, so it is overwritten, not preserved), the property
invariants in `window-kernel-properties.test.ts`, the pinned describe `the re-registration merge
preserves every lived fact`, and the record constructor.

### 2. A new effect

    | { type: 'AttachOverlayTo'; overlayId: WindowId; hostId: WindowId | null }

The 17th variant, and the first that names a relation rather than a per-window operation. It
carries **no frame** — see § 3.

### 3. `react` emits it as a structural diff

A new loop in `react(prev, ev, next)`, alongside the existing overlay frame and visibility loops:

- compute `topmostBaseLayerPageHost(prev)?.id ?? null` and the same over `next`;
- if they are equal, emit nothing;
- otherwise, for every record in `next.order` with `tracksBaseLayerTop`, emit
  `AttachOverlayTo { overlayId: r.id, hostId: <next's answer> }`.

No branch on `ev.type`, no event payload read, no guard — it stays inside the rule that `react` is
a pure projection of the transition.

**Emission order matters.** It must be emitted *before* the frame and visibility loops, for the
same reason those two are already ordered against each other: the attach decides the frame, and a
reveal must never paint at a stale one. Since the frame arrives later as an event (§ 4), the effect
ordering here only fixes the request, not the paint.

### 4. Realization: through the port, as a command out and an event back

`window-kernel-executor.ts performEffect` may only call the `WindowBackend` port — it touches no
Electron, no pubsub, no `screen`. The frame math (`overlay-frame.ts expandToOverlayFrame` plus the
nearest display's work area) needs all three, and `window-kernel.ts` has zero value imports by rule.

So the port gains one method carrying one intention:

    attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void

`electron-window-backend.ts` implements it: resolve the host through the hybrid registry, and

- host missing, destroyed, or not registered → report an attach to `null`;
- otherwise compute the frame from the host's live outer bounds and report the attach with it.

It reports by emitting the **existing** `OVERLAY_ATTACHED` feed, so the frame reaches the kernel as
an event the same way every other OS-observed fact does. This satisfies § 3's "the port is COMMAND
+ EVENT, never QUERY", and it means the frame is computed exactly where work areas are already a
known concept. The backend already computes overlay frames with the same helper for
`BOUNDS_CHANGED.overlayFrame`, so this is not new capability, only a second call site.

Two consequences worth stating plainly:

- **`AttachOverlay` stops being a production command.** The relation is written only by the
  backend's report. The command survives for the test bridge and for `detachOverlayFromMachine`'s
  explicit teardown; if nothing else needs it, it can be deleted with the old machine.
- **Attachment becomes asynchronous.** Today `retarget()` writes the relation synchronously within
  the callback. After this change the relation lands one hop later. Any spec asserting attachment
  immediately after driving order must await `waitForPendingWindowEffects()`. This is the single
  largest migration cost and the most likely source of new red specs.

### 5. What replaces `subscribeFrontChange`

Delete it. Its one production caller is `hybrid-overlay.ts initHybridOverlay`, and deleting it
removes the last `getShadowKernelExecutor().subscribe` consumer.

The overlay renderer still needs `sendActiveHandoff` — url, title, favicon, nav state, bounds,
gutters — which is renderer payload, not window management, and which `retarget()`'s own docblock
already says stays. It subscribes to the **read-back relation**, not the ordering query:

    subscribeOverlayAttachment(cb: (hostId: WindowId | null) => void)   // dedup on hostForOverlay

This is still a subscription, and legitimately so: it issues no command, decides nothing about
windows, and paints. It is not a second decider.

**`unsubscribeActive` doubles as `initHybridOverlay`'s idempotence latch** and disappears with the
subscription; the new subscription's handle takes that role.

### 6. The boot seed

`initHybridOverlay`'s trailing `if (currentId != null) retarget(currentId)` exists because the
overlay is minted after windows may already be registered. Under the new design nothing re-emits,
so a steady-state divergence at boot would persist forever.

The seed must therefore stay, in one of two forms. **Recommended:** `ensureOverlay()`'s
`registerWindowWithMachine` is itself a transition — the `WindowRegistered` that adds a record with
`tracksBaseLayerTop` set. Emitting the attach on that transition is not the forbidden repair loop
(it is a diff: before, there was no such overlay record; after, there is), and it removes the
explicit seed entirely. This wants an explicit test.

## What this does and does not fix

- **Fixes:** the second decider; the query-vs-relation dedup mismatch that turns an `A → null → A`
  flicker into two full transitions; the mid-drain command.
- **Does not fix by itself:** the unbounded show/hide loop. That loop's engine is
  `SetStacking`-steals-focus on non-darwin. This change is a prerequisite because it moves the
  overlay's contribution to that loop inside the machine, where the emission is a diff and a
  no-change transition emits nothing at all.
- **Unverified:** whether removing the outside feedback path alone damps the loop enough for the
  minimal-stacking commit to be restored. Measure it; do not assume it.

## Order of work

1. Add `tracksBaseLayerTop` — record, merge, property invariants, pinned merge describe. Unit only.
2. Add the `AttachOverlayTo` effect and the `react` diff loop, with the op-token biconditional
   left untouched (this effect issues no show and must not stamp `opSeq`).
3. Add the port method and its `NoopKernelBackend` arm; implement it in
   `electron-window-backend.ts` and have it report through the existing overlay-attached feed.
4. Swap `hybrid-overlay.ts`: delete the `subscribeFrontChange` driver, keep `sendActiveHandoff` on
   the new attachment subscription, keep `detachOverlayFromMachine` for explicit teardown.
5. Delete `subscribeFrontChange`.
6. Re-measure the six window-operation patterns against the pre-change head before restoring the
   minimal-stacking commit.

## Traps carried forward

- The op-token biconditional in `window-kernel-properties.test.ts checkOpSeqInvariants` requires
  `opSeqCounter` to advance by exactly 1 iff the transition emits a `ShowWindow`/`RaiseWindow`.
  `AttachOverlayTo` emits neither and must not touch it.
- `decide` has no `never` default, so a missing case falls through silently, and
  `window-kernel-shadow.ts shadowExecute` swallows rejections behind a DEBUG log. A wrongly
  rejected command is invisible.
- `ensureOverlay()`'s `'closed'` handler nulls the ids and would re-mint from inside a dispatch.
  This change does not touch that hazard, and an effect-driven attach makes it worse rather than
  better, because the re-mint would then be provoked from inside `runEffects`.
- `topmost`'s docblock does not state the one-layer contract that `topmostBaseLayerPageHost` cites
  as living there. Fix the docblock while in the file.
- The § 5 migration checklist items 3 and 7 still prescribe the repointed-subscription shape that
  the later sections supersede. Amend them.
