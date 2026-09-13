// Always-on structured logging for the window kernel's decision paths.
// Never gate this behind DEBUG or an env var: DEBUG fans detached devtools windows across every
// internal surface, and devtools themselves perturb the focus/first-responder state a live repro
// in this area needs to observe.
export type WmLogFields = Record<string, string | number | boolean | null | undefined>;

function formatField(key: string, value: string | number | boolean | null): string {
  if (value === null) return `${key}=null`;
  if (typeof value === 'string') return `${key}=${value.replace(/\s+/g, '_')}`;
  return `${key}=${String(value)}`;
}

// A caller with no value for a field should omit it, not pass a fake one — undefined fields
// are dropped rather than printed as `key=undefined`.
export function wmLog(event: string, fields: WmLogFields = {}): void {
  const parts = [`[wm]`, `t=${Date.now()}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(formatField(key, value));
  }
  console.log(parts.join(' '));
}
