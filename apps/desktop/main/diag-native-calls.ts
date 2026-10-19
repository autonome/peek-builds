// DIAG (peek 4fa36692): logs every native call that can show, order, focus or
// move a window across desktops, or activate the app, with the caller's stack,
// so a desktop switch in a trace can be matched against the call that preceded
// it, whichever module made it. Wraps the Electron prototypes once at startup.
import { app, BaseWindow, BrowserWindow } from 'electron';
import { wmLog } from './window-diag.js';

const WINDOW_METHODS = [
  'show',
  'showInactive',
  'focus',
  'blur',
  'moveTop',
  'hide',
  'restore',
  'setVisibleOnAllWorkspaces',
  'setAlwaysOnTop',
  'setParentWindow',
  'addChildWindow',
  'removeChildWindow',
  'setFullScreen',
  'setSimpleFullScreen',
] as const;

const APP_METHODS = ['focus', 'show', 'hide', 'setActivationPolicy'] as const;

let resolveId: (win: unknown) => string | null | undefined = () => undefined;

export function setDiagWindowIdResolver(fn: (win: unknown) => string | null | undefined): void {
  resolveId = fn;
}

function callerStack(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(3, 9);
  return lines
    .map((l) => {
      const m = l.match(/at (?:(\S+) )?\(?(?:.*\/)?([^/]+?\.(?:js|ts|cjs|mjs)):(\d+)/);
      return m ? `${m[1] ?? '?'}@${m[2]}:${m[3]}` : '';
    })
    .filter(Boolean)
    .join('<');
}

function fmtArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a === undefined) return 'u';
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a).slice(0, 80);
        } catch {
          return 'obj';
        }
      }
      return String(a);
    })
    .join(',');
}

export function installNativeCallDiag(): void {
  if (process.platform !== 'darwin') return;
  wrapWindowPrototype(BaseWindow.prototype as unknown as Record<string, (...args: unknown[]) => unknown>);
  // A subclass prototype that defines its own copy would bypass the base wrap.
  const bwProto = BrowserWindow.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  if (WINDOW_METHODS.some((n) => Object.prototype.hasOwnProperty.call(bwProto, n))) {
    wrapWindowPrototype(bwProto, true);
  }
  // Web contents `focus()` makes its window key and activates the app.
  let wcWrapped = false;
  app.on('web-contents-created', (_e, wc) => {
    if (wcWrapped) return;
    wcWrapped = true;
    const wcProto = Object.getPrototypeOf(wc) as Record<string, (...args: unknown[]) => unknown>;
    const original = wcProto.focus;
    if (typeof original !== 'function') return;
    wcProto.focus = function (this: { id?: number }, ...args: unknown[]) {
      wmLog('diag-native-call', { call: 'wc.focus', wcid: this.id, stack: callerStack() });
      return original.apply(this, args);
    };
  });
  const appRec = app as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of APP_METHODS) {
    const original = appRec[name];
    if (typeof original !== 'function') continue;
    appRec[name] = function (this: unknown, ...args: unknown[]) {
      wmLog('diag-native-call', { call: `app.${name}`, args: fmtArgs(args), stack: callerStack() });
      return original.apply(app, args);
    };
  }
}

function wrapWindowPrototype(proto: Record<string, (...args: unknown[]) => unknown>, ownOnly = false): void {
  for (const name of WINDOW_METHODS) {
    if (ownOnly && !Object.prototype.hasOwnProperty.call(proto, name)) continue;
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function (this: { id?: number; isDestroyed?: () => boolean }, ...args: unknown[]) {
      let wm: string | null | undefined;
      try {
        wm = this.isDestroyed?.() ? 'destroyed' : resolveId(this);
      } catch {
        wm = undefined;
      }
      wmLog('diag-native-call', { call: `win.${name}`, eid: this.id, id: wm ?? 'none', args: fmtArgs(args), stack: callerStack() });
      return original.apply(this, args);
    };
  }
}
