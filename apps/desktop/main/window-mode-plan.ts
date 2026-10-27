/**
 * The pure half of window modes: the package shape, reading a manifest, and
 * working out what a change of mode does. No window, database or platform
 * access, so it runs under plain node.
 */

export interface WindowModeAsks {
  /** Every eligible window fills the screen, through maximize-all. */
  maximize: boolean;
  /** The frame each eligible window draws. */
  chrome: 'normal' | 'none';
  /** True when the mode wants translucent cards; false wants the opaque theme colors. */
  transparency: boolean;
}

export interface WindowModePackage {
  id: string;
  name: string;
  /** The palette command that toggles the mode. */
  command: string;
  description?: string;
  asks: WindowModeAsks;
  /** Class added to the body of every card view while the mode is active. */
  bodyClass?: string;
  /** Stylesheet path, relative to the package, for card views while the mode is active. */
  css?: string;
  /** Directory the package was found in. */
  dir: string;
}


/** Read a window-mode manifest, or null when it is not one or is malformed. */
export function parseWindowModeManifest(manifest: unknown, dir: string, fallbackId: string): WindowModePackage | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as Record<string, unknown>;
  if (m.type !== 'window-mode') return null;
  const asks = m.asks as Record<string, unknown> | undefined;
  if (typeof m.name !== 'string' || typeof m.command !== 'string' || !asks) return null;
  const id = typeof m.id === 'string' ? m.id : fallbackId;
  return {
    id,
    name: m.name,
    command: m.command,
    description: typeof m.description === 'string' ? m.description : undefined,
    asks: {
      maximize: asks.maximize === true,
      chrome: asks.chrome === 'none' ? 'none' : 'normal',
      transparency: asks.transparency === true,
    },
    bodyClass: typeof m.bodyClass === 'string' ? m.bodyClass : undefined,
    css: typeof m.css === 'string' ? m.css : undefined,
    dir,
  };
}


export interface WindowModeChangeInput {
  from: WindowModePackage | null;
  to: WindowModePackage | null;
  maximizeAllOn: boolean;
  /** Whether the mode being left is the one that turned maximize-all on. */
  fromEnteredMaximizeAll: boolean;
  seeThroughEverywhereOn: boolean;
}

export interface WindowModeChangePlan {
  /** Turn the app-wide see-through look off first (opaque cards wanted). */
  seeThroughOff: boolean;
  enterMaximizeAll: boolean;
  leaveMaximizeAll: boolean;
  /** Whether the new state of maximize-all was entered by the new mode. */
  enteredMaximizeAll: boolean;
  chrome: 'normal' | 'none';
}

/**
 * What changing from one mode to another does. Leaving a mode leaves
 * maximize-all only if that mode entered it; maximize-all that was already on
 * stays on. Switching straight between modes that both want it keeps it on.
 */
export function planWindowModeChange(input: WindowModeChangeInput): WindowModeChangePlan {
  const { from, to, maximizeAllOn, fromEnteredMaximizeAll, seeThroughEverywhereOn } = input;
  const wantsMaximize = to?.asks.maximize === true;
  let enterMaximizeAll = false;
  let leaveMaximizeAll = false;
  let enteredMaximizeAll = false;

  if (wantsMaximize) {
    if (maximizeAllOn) {
      // Already on: keep whoever's it was.
      enteredMaximizeAll = from !== null && fromEnteredMaximizeAll;
    } else {
      enterMaximizeAll = true;
      enteredMaximizeAll = true;
    }
  } else if (from !== null && fromEnteredMaximizeAll && maximizeAllOn) {
    leaveMaximizeAll = true;
  }

  return {
    seeThroughOff: to !== null && !to.asks.transparency && seeThroughEverywhereOn,
    enterMaximizeAll,
    leaveMaximizeAll,
    enteredMaximizeAll,
    chrome: to?.asks.chrome ?? 'normal',
  };
}

