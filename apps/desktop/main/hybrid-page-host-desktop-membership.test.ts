/**
 * Regression coverage for peek `f46a44ad`: opening a URL from the cmd panel
 * (or any http/https/file/new-tab content open — `usePageHost` in ipc.ts)
 * built the content window as a `BaseWindow` + `WebContentsView` through
 * `assembleHybridPageHost` and registered it with the window-kernel
 * (`registerWindowWithMachine({ kind: 'page-host', ... })`), but never fed
 * the kernel a `SetDesktopMembership` command for it — on any path, fresh
 * open or key-reuse, regardless of which app was frontmost at open time.
 * The plain-`BrowserWindow` open path (`windowOpenHandler`'s non-hybrid
 * tail, same file) always fed this. Symptom: a hybrid content window stayed
 * visible over every other app (macOS `setVisibleOnAllWorkspaces(true)`,
 * never narrowed) until some unrelated later event coincidentally reshuffled
 * Space visibility.
 *
 * Real OS Spaces behavior is unobservable in macOS-headless (see
 * `apps/desktop/CLAUDE.md`'s hybrid page-host section), and
 * `assembleHybridPageHost` is a large, deeply-wired function (BaseWindow +
 * WebContentsView construction, dozens of closures over main-process
 * singletons) that cannot be invoked standalone without reproducing most of
 * `ipc.ts`'s module state. Per the same tradeoff `tile-ipc.test.ts` already
 * made for `tile:window:set-visible-on-all-workspaces` (see its "caller
 * options are inert by design" describe block), the cheapest honest check
 * is a source-grep of the compiled call site: it pins down THAT the fix's
 * call exists, in the right function, gated the same way the existing
 * BrowserWindow-branch call is, and routed through the same kernel dispatch
 * wrapper (`kernelSetDesktopMembership`) rather than a raw/ad-hoc native
 * `setVisibleOnAllWorkspaces` call — i.e. it still goes through the
 * window-kernel's command → effect → executor → backend pipeline, using the
 * SAME machine-minted id (`hostMachineId`) the hybrid host already
 * registers with a few lines above.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hereDir = dirname(fileURLToPath(import.meta.url));
const compiledIpc = join(hereDir, 'ipc.js');

function extractAssembleHybridPageHostBlock(src: string): string {
  const start = src.indexOf('function assembleHybridPageHost(');
  assert.ok(start >= 0, 'assembleHybridPageHost not found in compiled ipc.js');
  // The next top-level function declaration after it bounds the block —
  // assembleHybridPageHost is the last function defined before
  // inheritedModeForNewWindow in ipc.ts's source order.
  const nextFn = src.indexOf('function inheritedModeForNewWindow(', start + 1);
  assert.ok(nextFn > start, 'could not bound assembleHybridPageHost — next function marker not found');
  return src.slice(start, nextFn);
}

describe('hybrid page-host content windows get macOS Spaces/desktop-membership anchoring', () => {
  it('assembleHybridPageHost feeds the kernel a SetDesktopMembership command', () => {
    const block = extractAssembleHybridPageHostBlock(readFileSync(compiledIpc, 'utf8'));
    const callSite = block.match(/kernelSetDesktopMembership\([^)]*\)/);
    assert.ok(
      callSite,
      'kernelSetDesktopMembership call site not found inside assembleHybridPageHost — a hybrid ' +
      'content window (any http/https/file/new-tab open, including a cmd-panel URL open) would ' +
      'get no Spaces/desktop-membership anchoring at all (peek f46a44ad)',
    );
  });

  it('routes through the same kernel dispatch wrapper as the BrowserWindow branch, not a raw native call', () => {
    const block = extractAssembleHybridPageHostBlock(readFileSync(compiledIpc, 'utf8'));
    // The platform-leak check (scripts/check-platform-leak.mjs) already bans
    // AppKit/Electron vocabulary above electron-window-backend.ts; this pins
    // the SPECIFIC risk the coordinator flagged — a workaround that bolts a
    // raw setVisibleOnAllWorkspaces call onto the hybrid creation path
    // instead of dispatching through the machine.
    assert.ok(
      !block.includes('setVisibleOnAllWorkspaces') && !block.includes('setVisibleOnAllSpaces'),
      'the hybrid page-host assembly must not call a native Spaces API directly — dispatch ' +
      'through kernelSetDesktopMembership() so window-kernel.ts stays the single decider',
    );
    // Matches only the real function-call statement (first arg followed by
    // a comma, then the second arg).
    const callSite = block.match(/kernelSetDesktopMembership\(\s*(\w+)\s*,\s*[^)]*\)/);
    assert.ok(callSite, 'kernelSetDesktopMembership(id, membership) call statement not found');
    // Must be keyed on the window's own machine-minted registration id
    // (hostMachineId, returned by registerWindowWithMachine a few lines
    // above in this same function) — not a bare Electron window handle —
    // so the command targets a record the kernel actually knows about.
    assert.strictEqual(
      callSite![1],
      'hostMachineId',
      `kernelSetDesktopMembership call must be keyed on hostMachineId (the kernel-registered id ` +
      `this same function's registerWindowWithMachine() call mints): ${callSite![0]}`,
    );
  });

  it('derives the membership intention from the role, same as the BrowserWindow branch', () => {
    const block = extractAssembleHybridPageHostBlock(readFileSync(compiledIpc, 'utf8'));
    assert.ok(
      block.includes('desktopMembershipForRole(role)'),
      'membership must come from desktopMembershipForRole(role), the same platform-neutral ' +
      'policy the non-hybrid open path uses — not a hardcoded/ad-hoc intention',
    );
  });
});
