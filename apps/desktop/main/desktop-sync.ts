/**
 * One read of the desktop provider, reported to the kernel (specs/kernel-desktops.md,
 * "Backend algorithm"). Split out of the Electron backend so a test can drive it with a fake
 * provider: the read is the only way a window's desktop changes after the user moves it between
 * desktops, and nothing else fires for that move.
 */
import type { DesktopProvider, PlatformWindowId, ProviderDisplayId } from './desktop-provider.js';
import type { DesktopId, ScreenId, State, WindowId } from './window-kernel.js';
import { windowById } from './window-kernel.js';

export interface DesktopSyncDeps {
  readonly provider: DesktopProvider | null;
  readonly getState: () => State;
  /** The provider's number for each registered window that has one. */
  readonly platformIds: () => Map<PlatformWindowId, WindowId>;
  readonly layoutReported: (
    screens: Array<{ id: ScreenId; current: DesktopId }>,
    desktops: Array<{ id: DesktopId; screen: ScreenId | null }>,
  ) => void;
  readonly currentDesktopChanged: (screen: ScreenId, desktop: DesktopId) => void;
  readonly placementReported: (id: WindowId, screen: ScreenId | null, desktop: DesktopId | null, onEveryDesktop: boolean) => void;
  readonly desktopsRead: (switchesSeen: number) => void;
  readonly log: (event: string, fields: Record<string, string | number | boolean | null | undefined>) => void;
}

// A screen is named by its display id; a provider screen standing for every display is `shared`.
export function screenIdOf(display: ProviderDisplayId | null): ScreenId {
  return display ?? 'shared';
}

// Every path ends with `desktopsRead`, a failed read included: a switch notice left uncovered
// would keep every window off the current desktop.
export async function syncDesktops(trigger: string, deps: DesktopSyncDeps): Promise<void> {
  const { provider, getState, log } = deps;
  const switchesSeen = getState().desktopSwitchCount;
  log('sync-desktops-start', { trigger, switchesSeen });
  if (!provider) {
    deps.desktopsRead(switchesSeen);
    log('sync-desktops-end', { trigger, switchesSeen, provider: false });
    return;
  }
  try {
    const layout = await provider.layout();
    const screens = layout.screens.map((s) => ({ id: screenIdOf(s.display), current: s.current }));
    const desktops = layout.desktops.map((d) => ({ id: d.id, screen: d.display === null ? null : screenIdOf(d.display) }));
    // A change of screens or desktops is a layout report; a change of only
    // which desktop a screen shows is a `CurrentDesktopChanged`.
    const before = getState();
    const sameLayout =
      JSON.stringify(before.desktops) === JSON.stringify(desktops) &&
      JSON.stringify(before.screens.map((s) => s.id)) === JSON.stringify(screens.map((s) => s.id));
    if (!sameLayout) deps.layoutReported(screens, desktops);
    for (const s of screens) {
      const known = getState().screens.find((k) => k.id === s.id);
      if (known?.current !== s.current) deps.currentDesktopChanged(s.id, s.current);
    }

    // Placements go before `desktopsRead`: the kernel ends a transient window left on another
    // desktop on that event, from these placements.
    const ids = deps.platformIds();
    const placements = await provider.placements([...ids.keys()]);
    const seen: string[] = [];
    for (const p of placements) {
      const id = ids.get(p.window);
      const record = id === undefined ? null : windowById(getState(), id);
      if (id === undefined || record === null) continue;
      seen.push(`${String(id)}:${p.desktop ?? '?'}${p.onEveryDesktop ? '*' : ''}`);
      const screenId = p.display === null ? null : screenIdOf(p.display);
      const changed =
        (screenId !== null && screenId !== record.screen) ||
        (p.desktop !== null && p.desktop !== record.desktop) ||
        p.onEveryDesktop !== (record.onEveryDesktop === true);
      if (changed) deps.placementReported(id, screenId, p.desktop, p.onEveryDesktop);
    }
    deps.desktopsRead(switchesSeen);
    log('sync-desktops-end', { trigger, switchesSeen, placements: seen.join(',') });
  } catch (err) {
    log('desktop-sync-failed', { trigger, error: err instanceof Error ? err.message : String(err) });
    deps.desktopsRead(switchesSeen);
    log('sync-desktops-end', { trigger, switchesSeen, failed: true });
  }
}
