// One page-wide cursor rule per webContents, inserted with insertCSS.
//
// A webContents has one intended cursor at a time; its producers (the
// page-host edge-resize hover cursor, the hold-to-drag hand) never want one
// at the same moment, and routing them through one reconciler means a
// webContents can never end up carrying two rules. A single in-flight applier
// serializes the async insert/remove and re-checks afterwards, so rapid
// changes cannot leave a stale cursor behind.

export interface CursorWebContents {
  isDestroyed(): boolean;
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
}

export interface CursorRule {
  cursor: string;
  // Also stop text selection while the rule is in place (a window drag).
  noSelect?: boolean;
}

interface Reconciler {
  want: string | null;
  applied: string | null;
  key: string | null;
  applying: boolean;
}

const reconcilers = new WeakMap<CursorWebContents, Reconciler>();

function cssFor(rule: CursorRule | null): string | null {
  if (!rule) return null;
  const select = rule.noSelect ? ';user-select:none !important;-webkit-user-select:none !important' : '';
  return `*{cursor:${rule.cursor} !important${select}}`;
}

function reconcile(wc: CursorWebContents, r: Reconciler): void {
  if (r.applying || r.want === r.applied) return;
  r.applying = true;
  void (async () => {
    try {
      if (r.key != null && !wc.isDestroyed()) {
        try { await wc.removeInsertedCSS(r.key); } catch { /* gone */ }
      }
      r.key = null;
      r.applied = null;
      const want = r.want;
      if (want != null && !wc.isDestroyed()) {
        try {
          r.key = await wc.insertCSS(want);
          r.applied = want;
        } catch { /* gone */ }
      }
    } finally {
      r.applying = false;
      if (r.want !== r.applied) reconcile(wc, r);
    }
  })();
}

export function setWebContentsCursor(wc: CursorWebContents, rule: CursorRule | null): void {
  let r = reconcilers.get(wc);
  if (!r) {
    r = { want: null, applied: null, key: null, applying: false };
    reconcilers.set(wc, r);
  }
  const want = cssFor(rule);
  if (want === r.want) return;
  r.want = want;
  reconcile(wc, r);
}

// Whether a rule is currently wanted for this webContents.
export function webContentsHasCursor(wc: CursorWebContents): boolean {
  return reconcilers.get(wc)?.want != null;
}
