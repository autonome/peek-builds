# Cutting the window-manager docblocks

The window-manager modules under `apps/desktop/main/` carry their design reasoning in
`/** ... */` blocks above functions and types. Most of that prose restates the code or duplicates
`docs/design/window-manager.md`. The target is near zero docblocks: short `//` lines only where a
reader must not break something, and design reasoning in the design doc.

## Measured at `a22e81a3`

A line counts as docblock if it sits inside `/** ... */`, inclusive.

| File | lines | docblock | share | target |
|---|---|---|---|---|
| `window-kernel.ts` | 5149 | 2227 | 43% | ~3040 |
| `electron-window-backend.ts` | 2189 | 897 | 41% | ~1360 |
| `window-kernel-dispatch.ts` | 1138 | 500 | 44% | ~675 |
| `window-kernel-executor.ts` | 1280 | 439 | 34% | ~880 |
| `window-escape.ts` | 595 | 388 | 65% | ~235 |
| `izui-roles.ts` | 869 | 559 | 64% | ~370 |
| `window-backend.ts` | 434 | 341 | 79% | ~130 |
| `window-machine.ts` | 483 | 242 | 50% | ~260 |
| `windows.ts` | 792 | 222 | 28% | ~595 |
| `window-placement.ts` | 363 | 122 | 34% | ~255 |
| `window-presenter.ts` | 316 | 98 | 31% | ~225 |
| `window-registry.ts` | 157 | 87 | 55% | ~80 |
| `window-escape-runtime.ts` | 276 | 84 | 30% | ~200 |
| `tile-window-enforcement.ts` | 188 | 65 | 35% | ~130 |
| `hybrid-window-gesture.ts` | 121 | 50 | 41% | ~75 |
| `window-kernel-singleton.ts` | 64 | 49 | 77% | ~20 |
| `window-escape-renderer-handled.ts` | 77 | 43 | 56% | ~40 |
| `window-diag.ts` | 57 | 39 | 68% | ~22 |
| `window-open-registry.ts` | 64 | 33 | 52% | ~35 |
| `window-address.ts` | 43 | 24 | 56% | ~22 |
| `window-kernel-properties.test.ts` | 2184 | 366 | 17% | ~1860 |
| `window-kernel.test.ts` | 7716 | 201 | 3% | ~7540 |
| total | 24555 | 7076 | 29% | ~18050 |

About 6,500 lines go; about 590 survive as `//` lines.

## Classification

Every block falls into one of three kinds.

- **Restates the code.** Delete.
- **Design decision or rejected alternative.** Delete when `window-manager.md` already carries it,
  which is the common case. Move it into the doc otherwise.
- **An invariant a reader must not break.** Keep as one or two `//` lines directly on the code.

The largest blocks and their kind:

- `window-kernel.ts isContentWindow` (116 lines), `isAppResignSweepEligible` (81),
  `topmostBaseLayerPageHost` (84), `selectTransientAutoclose` (80), `isBaseLayerPageHost` (55),
  `isTransientAutocloseCandidate` (47): all covered by the doc's sections 0.1.5, 0.1.7, 0.1.11 and
  4.4. Survivors: the `pendingHidden` clause on `isTransientAutocloseCandidate` (removing it
  reintroduces the double sweep) and the disjointness of `isAppResignSweepEligible` from
  `selectTransientAutoclose` (asserted by a property test).
- `electron-window-backend.ts raiseWindow` (49), `pendingSelfCausedFocus` (41),
  `pendingMachineClose` (38), `quitPromptPending` (33), `setDesktopMembership` (39): covered by
  section 4.3. Survivors: "already visible and already key means `moveTop()`, never `show()`";
  the pending maps count per producer; a machine-initiated op must not feed its own side effect
  back in as OS evidence.
- `window-kernel-executor.ts planRaise` (47), `RaisePlan` (44), `RaiseRealization` (34),
  `planRestoreFocus` (34), module header (27): covered. Survivors: the panel arm keys on
  `nonActivating`, never role or class; the `'suppressed'` plan is slated for deletion.
- `window-kernel-dispatch.ts` module header (44), `setKernelExecutorProvider` (36),
  `kernelWindowShown` (32), `kernelAppResignSettled` (25): covered by sections 5 and 6.
  Survivors: no exception from the kernel path escapes a feed helper; `NoopKernelBackend` is
  reached only with no provider installed; `kernelWindowShown`'s `focused` parameter is idempotent
  with the real OS echo.
- `window-escape.ts` module header (116), `resolveEscapeTarget` (55), `interpretEscape` (29),
  `shouldArmEscapeGrab` (34): covered by section 0.1.3 and the escape defect entries. Survivors:
  `globalShortcut` pre-empts `before-input-event`; `undefined !== false` on the three-valued
  `contentFocused`.
- `window-backend.ts`: every port method carries a 15-23 line contract note, and section 3
  "Constraints" already states all of them. 341 lines become about 35.
- `window-kernel-properties.test.ts`: the 69-line op-rate measurement compresses to three `//`
  lines. The `checkAutocloseWiring`, `checkStrandedHideAgreesWithSelector` and
  `checkTransientHideIsNotDismiss` blocks restate the assertion beneath them.

## Prose that exists nowhere in `docs/design/` and must move, not vanish

| Symbol | File | What it carries |
|---|---|---|
| `ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER` | `window-escape.ts` | An open policy question: should a key holder that reports nothing about its content first responder arm the Escape grab. Currently `false`. The doc's "Open design decisions" section says "None"; that word is wrong. |
| `downloadCloseTarget` / `DownloadCloseTarget` | `izui-roles.ts` | Hybrid-host precedence must beat BrowserWindow because `fromWebContents` returns the owning BaseWindow for hybrid content; mis-ordering was the alt+click bug `02e0a4fa`. The fresh-vs-painted host rule is `a060a75f`. |
| `deriveWindowLayer`, `deriveCanBecomeKey`, `deriveAcceptsInput` | `izui-roles.ts` | Each keys on the declared open-time fact, not on role or class, with the production window that refutes each role-based alternative. |
| `windowFromWebContents` | `window-registry.ts` | The declared return type lies at runtime: hybrid content resolves to a BaseWindow absent from `getAllWindows()`, so a truthiness check cannot answer "is this a BrowserWindow". Keep as two `//` lines. |
| op-rate measurement | `window-kernel-properties.test.ts` | 190/524 at POOL_SIZE=6, LOG_LENGTH=30, 200 seeds; trajectory-sensitive, re-measure after any generator change. |

## Commits, in order

Comments do not affect emit, so `tsc` plus the main-process unit runner is the check per commit
and the full gate runs once at the end.

1. `window-backend.ts`. Delete all port-method blocks, add a five-line `//` header pointing at
   section 3. Sets the house style.
2. `izui-roles.ts` with its doc move in the same commit. Add a "Window attribute derivation"
   section under 4.1 of `window-manager.md` carrying the three `derive*` arguments and
   `downloadCloseTarget`, then cut 559 to about 60. The only commit that moves prose rather
   than deleting it.
3. `window-escape.ts`, `window-escape-runtime.ts`, `window-escape-renderer-handled.ts`. Move
   `ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER` into "Open design decisions" and replace "None" there.
4. `window-kernel-executor.ts`. 439 to about 40.
5. `window-kernel-dispatch.ts`. 500 to about 35.
6. `electron-window-backend.ts`. 897 to about 70. Run `scripts/check-platform-leak.mjs` after.
7. `window-kernel.ts`. 2227 to about 120. Predicates in one pass, the ~160 small blocks in a
   second if the diff is unreviewable as one. `window-manager.md` line "`isFrontEligibleWindow`'s
   docblock prescribes the composition" must state the composition inline in this commit.
8. The small modules as one commit: `window-machine.ts`, `windows.ts`, `window-presenter.ts`,
   `window-placement.ts`, `window-registry.ts`, `window-open-registry.ts`, `window-address.ts`,
   `window-diag.ts`, `window-kernel-singleton.ts`, `tile-window-enforcement.ts`,
   `hybrid-window-gesture.ts`. Keep the `windowFromWebContents` trap.
9. `window-kernel-properties.test.ts`. 366 to about 40.
10. `window-kernel.test.ts`. Optional; already at 3%.

Every commit also rewrites the cross-references the deleted blocks orphan. The blocks cite each
other 42 times ("see that field's doc", "see the module header", "the docblock prescribes"):
18 in `window-kernel.ts`, 9 in `window-kernel-dispatch.ts`, 8 in `electron-window-backend.ts`,
4 in `window-kernel-executor.ts`, 3 in `window-escape.ts`. Each becomes a citation of the doc
section or is dropped.

## Tooling

Nothing reads these comments.

- No eslint, biome or oxlint config exists; root `lint` is a no-op echo. No typedoc.
- `scripts/check-r2-window-ops.mjs` and `scripts/check-platform-leak.mjs` strip comments before
  matching.
- `scripts/lint-test-honesty.mjs` scans raw test source for import specifiers; deleting a test
  docblock can only remove a phantom match. Its `@no-product-import` escape hatch has zero
  occurrences under `apps/desktop/main/`.
- No `@ts-ignore`, `@ts-expect-error` or `eslint-disable` directive sits inside any block in the
  four largest files.
