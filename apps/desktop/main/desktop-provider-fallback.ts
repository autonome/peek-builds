/**
 * Fallback desktop provider — specs/kernel-desktops.md, section 5 "Fallback provider".
 *
 * Every platform has it; it is what runs where no platform provider exists (Wayland) and after
 * any platform-provider failure. Given the backend's screen list it reports one desktop per
 * screen, id `<screenId>/only`, always current. A window is on its screen's only desktop, and on
 * every desktop exactly when the backend declares so. It never reports a change of current
 * desktop, so every window is always on a current desktop and every rule acts as if desktops did
 * not exist. It cannot place windows or switch desktops.
 *
 * Its display ids are the backend's own screen ids, so the backend's display-to-screen mapping is
 * the identity for it.
 */
import type { DesktopId } from './window-kernel.js';
import type {
  DesktopChange,
  DesktopProvider,
  Placement,
  PlatformWindowId,
  ProviderDisplayId,
  ProviderLayout,
} from './desktop-provider.js';

/** What the backend feeds the fallback provider. Read on every request, never cached. */
export interface FallbackScreenSource {
  /** The backend's screen ids, first = the screen a window of unknown screen counts as on. */
  screens(): readonly ProviderDisplayId[];
  /** The screen a window is on, or `null` if the backend cannot tell. */
  windowScreen(win: PlatformWindowId): ProviderDisplayId | null;
  /** The backend's `onEveryDesktop` declaration for the window. */
  onEveryDesktop(win: PlatformWindowId): boolean;
}

export function onlyDesktopOf(screen: ProviderDisplayId): DesktopId {
  return `${screen}/only`;
}

export class FallbackDesktopProvider implements DesktopProvider {
  readonly name = 'fallback';
  readonly canPlaceWindows = false;
  readonly canShowDesktops = false;

  constructor(private readonly source: FallbackScreenSource) {}

  async start(_onChange: (change: DesktopChange) => void): Promise<void> {
    // Nothing to start and nothing ever to report: screen changes are the backend's own triggers.
  }

  async layout(): Promise<ProviderLayout> {
    const screens = this.source.screens();
    return {
      screens: screens.map((display) => ({ display, current: onlyDesktopOf(display) })),
      desktops: screens.map((display) => ({ id: onlyDesktopOf(display), display })),
    };
  }

  async placements(windows: PlatformWindowId[]): Promise<Placement[]> {
    const screens = this.source.screens();
    const known = new Set(screens);
    return windows.map((window) => {
      const reported = this.source.windowScreen(window);
      const display = reported !== null && known.has(reported) ? reported : (screens[0] ?? null);
      return {
        window,
        display,
        desktop: display === null ? null : onlyDesktopOf(display),
        onEveryDesktop: this.source.onEveryDesktop(window),
      };
    });
  }

  async placeWindow(_win: PlatformWindowId, _desktop: DesktopId): Promise<boolean> {
    return false;
  }

  async showDesktop(_desktop: DesktopId): Promise<boolean> {
    return false;
  }

  stop(): void {
    // Holds nothing.
  }
}
