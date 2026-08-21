/**
 * window-diag.ts — always-on structured logging for the window kernel's
 * decision paths.
 *
 * DELIBERATELY NOT DEBUG-GATED. Every close/dismiss/focus path in this app
 * is normally logged behind `DEBUG`, and `DEBUG` cannot be turned on during a
 * live focus repro: it fans detached devtools windows across every internal
 * surface and the devtools themselves perturb the focus/first-responder state
 * under observation (`apps/desktop/CLAUDE.md`'s hybrid-focus LESSON records
 * the same hazard for headless specs). The result was that live defects in
 * exactly this area were undiagnosable without corrupting the thing being
 * diagnosed. This module exists so the window kernel's decisions are on the
 * record in an ordinary run, with nothing to flip first. Do not gate this
 * behind `DEBUG` or an env var — that reintroduces the exact hole it exists
 * to close.
 *
 * Cheap enough to leave on forever: one `console.log` call per record (which
 * `main-log.ts` already mirrors to `<userData>/logs/main.log` for free — this
 * module owns no file handle of its own), a fixed `[wm]` prefix, a millisecond
 * timestamp, and a flat `key=value` field list — greppable by humans, and
 * parsable by a script without a JSON decoder.
 *
 * THE BIAS THIS FILE IS BUILT AROUND: the recurring bug shape in this
 * subsystem is a fact that never became an event because something upstream
 * swallowed it — a stale keystroke dropped, a renderer answer suppressing a
 * close, an ask never issued — and no state snapshot can show an absence.
 * Callers should log a suppression, an early return, or a "did nothing"
 * decision as deliberately as they log an action; a line that only ever
 * appears for actions taken reintroduces the same blind spot this file exists
 * to remove.
 */

/** One structured field on a diagnostic line. `undefined` fields are omitted. */
export type WmLogFields = Record<string, string | number | boolean | null | undefined>;

/** Render one field as `key=value`, collapsing whitespace so a line stays one grep-able token per field. */
function formatField(key: string, value: string | number | boolean | null): string {
  if (value === null) return `${key}=null`;
  if (typeof value === 'string') return `${key}=${value.replace(/\s+/g, '_')}`;
  return `${key}=${String(value)}`;
}

/**
 * Emit one always-on `[wm]` log line: `event=<event>` plus every field in
 * `fields`, in insertion order. `undefined` fields are dropped rather than
 * printed as `key=undefined` — a caller that doesn't have a value (e.g. no
 * target window resolved) should omit the field, not fake one.
 */
export function wmLog(event: string, fields: WmLogFields = {}): void {
  const parts = [`[wm]`, `t=${Date.now()}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(formatField(key, value));
  }
  console.log(parts.join(' '));
}
