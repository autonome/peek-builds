// window-backend.ts — the WindowBackend port: the interface through which
// the kernel's effects (window-kernel-executor.ts) become real OS operations.
// electron-window-backend.ts is the Electron implementation, and the only
// window-manager module allowed to import Electron. Contract, shape and
// constraints: docs/design/window-manager.md.

import type { WindowId, WindowKind, DesktopMembership, Rectangle as Rect } from './window-kernel.js';
import type { WindowClass, StackingLevel } from './izui-roles.js';

export type EscapeMode = 'ignore';

export type { Rectangle as Rect } from './window-kernel.js';

export interface WindowSpec {
  kind: WindowKind;
  role: string;
  // REQUIRED — every registration site must declare a classification explicitly.
  class: WindowClass;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  // Drives the parent-refocus transition on WINDOW_CLOSED.
  parentId?: WindowId | null;
  source?: string;
  params?: Record<string, unknown>;
  alwaysOnTop?: boolean;
  // Every registration site that knows this flag must pass it here — the
  // reducer branches on it at close time (hide vs. the resolved close).
  keepLive?: boolean;
  // Defaults true for browser windows; ignored for page-hosts (Escape rides
  // the content surface instead). The chrome overlay (hybrid-overlay.ts) is
  // the one browser window that opts out — it handles Escape itself.
  attachEscHandler?: boolean;
  // Required explicitly on every site — no guessed default — but unread here;
  // it rides the spec only for the future window-kernel.ts cutover.
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
}

// Fire-and-forget against a window that is gone: a backend resolves the id
// internally and silently no-ops on an unknown/destroyed window. Command
// names below are deliberately not platform method names —
// scripts/check-r2-window-ops.mjs greps for the platform names verbatim.
export interface WindowBackend {
  // Whether restacking a window hands it focus on this platform, so the focus
  // report that follows a restack is the platform's choice, not the user's.
  // Absent means it does not.
  readonly restackingTakesFocus?: boolean;

  attachAppListeners(): void;

  // opSeq arms "expecting a self-caused focus, op N" before the native call,
  // so the focus it provokes returns as OS_FOCUS_GAINED{cause:{kind:'machine',
  // opSeq}} instead of masquerading as a user gesture.
  raiseWindow(id: WindowId, opSeq: number, intent?: 'user'): void;

  focusContent(id: WindowId, opSeq: number): void;

  setFullscreen(id: WindowId, on: boolean): void;

  // The one sanctioned OS read, kept behind the port: reads real fullscreen
  // state once and emits OS_FULLSCREEN_ENTERED/OS_FULLSCREEN_LEFT.
  reconcileFullscreen(id: WindowId): void;

  closeOrHide(id: WindowId): Promise<void>;

  // The one exception to command+event: resolves the renderer's own
  // `handled` verdict directly rather than through a later event.
  askRendererHandledEscape(id: WindowId): Promise<boolean>;

  attachEscHandler(id: WindowId): void;

  // Idempotent — tracks its own registration state, including a failed
  // register, so a later call retries.
  setEscGrab(on: boolean): void;

  // Destroys any registered guest WebContents first, and waits for them to
  // actually go away, before closing the host — a use-after-free guard.
  closeWindow(id: WindowId): Promise<void>;

  destroyWindow(id: WindowId): void;

  closeContent(id: WindowId): void;

  // opSeq arms the same self-caused-focus expectation as raiseWindow when the
  // show activates; a non-activating show arms nothing.
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void;

  // opSeq is carried to the confirming WINDOW_HIDDEN echo so the kernel can
  // tell it apart from a later show that already superseded it
  // (window-kernel.ts isStaleWindowEcho).
  hideWindow(id: WindowId, opSeq?: number): void;

  // Hold a window above other applications' windows (`on`), or return it to
  // ordinary stacking (`!on`). Never activates the app, never focuses the
  // window, and acts on the existing window. A backend whose platform keeps an
  // inactive app's windows where they were shown may answer with a no-op.
  pinAlwaysOnTop(id: WindowId, on: boolean): void;

  // Bounded per guest and over the whole batch, so it can never turn a quit
  // into a hang; webContents.destroy() returning is not the teardown.
  destroyAllContentGuests(): Promise<void>;

  hideApp(): void;

  // `level` rides the call rather than record state, so a pinned window (the
  // chrome overlay) realizes as a floating-level re-assert instead of a plain
  // relative raise.
  setStacking(id: WindowId, level: StackingLevel): void;

  setWindowBounds(id: WindowId, rect: Rect): void;

  // Which of 'follow'/'anchor' a role wants is decided above the port; HOW a
  // backend satisfies either — or answers a platform with no such concept
  // with a no-op — is entirely its own decision.
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void;

  // Same boundary as setDesktopMembership: the intention crosses the port,
  // the realization is entirely the backend's business.
  setAcceptsInput(id: WindowId, acceptsInput: boolean): void;

  // A REQUEST, not an assertion — the kernel does not enforce that
  // attachment agrees with stacking order, so a backend may decline it.
  // `hostId: null` means detach.
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void;
}
