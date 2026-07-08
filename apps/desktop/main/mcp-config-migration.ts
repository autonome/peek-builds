/**
 * Pure logic for the MCP config-location migration — no electron `app`, no
 * filesystem. Kept in its own module so it can be imported by tests running
 * under `electron --test` (ELECTRON_RUN_AS_NODE), where importing anything
 * that does `import { app } from 'electron'` at module-eval time throws.
 *
 * Peek historically wrote its user-scope registration to
 * ~/.claude/settings.json — a location Claude Code silently ignores (it
 * reads user-scope `mcpServers` only from ~/.claude.json). This moves any
 * stale entry to ~/.claude.json and prunes the dead one.
 */

// Takes the two parsed JSON objects and returns mutated copies plus whether
// anything changed.
//   legacyObj  — parsed ~/.claude/settings.json (the dead location)
//   currentObj — parsed ~/.claude.json (the live user-scope file)
// Moves legacy's mcpServers.peek into current ONLY if current has none
// (respect an existing user-scope entry), then always removes peek from
// legacy (pruning an emptied mcpServers object). Idempotent: once legacy has
// no peek, returns changed:false.
export function applyMcpConfigMigration(
  legacyObj: Record<string, unknown>,
  currentObj: Record<string, unknown>,
): { legacyOut: Record<string, unknown>; currentOut: Record<string, unknown>; changed: boolean } {
  const legacyOut = { ...legacyObj };
  const currentOut = { ...currentObj };
  const legacyServers = legacyOut.mcpServers as Record<string, unknown> | undefined;
  const legacyPeek = legacyServers?.peek;
  if (!legacyPeek) {
    // Nothing to migrate — legacy has no peek entry.
    return { legacyOut, currentOut, changed: false };
  }

  // Copy into current only if it doesn't already carry a user-scope peek.
  const currentServers = currentOut.mcpServers as Record<string, unknown> | undefined;
  const currentHasPeek = !!currentServers?.peek;
  if (!currentHasPeek) {
    const nextServers = { ...(currentServers ?? {}) };
    nextServers.peek = legacyPeek;
    currentOut.mcpServers = nextServers;
  }

  // Always prune peek from legacy — the dead entry must not linger.
  const nextLegacyServers = { ...(legacyServers ?? {}) };
  delete nextLegacyServers.peek;
  if (Object.keys(nextLegacyServers).length === 0) {
    delete legacyOut.mcpServers;
  } else {
    legacyOut.mcpServers = nextLegacyServers;
  }

  return { legacyOut, currentOut, changed: true };
}

// Decides the full migration outcome, INCLUDING the boot-critical safety case
// that `applyMcpConfigMigration` can't see: "~/.claude.json is present but
// unparseable". Overwriting a corrupt current file would destroy Claude Code's
// live auth/state, so we must abort rather than start from `{}`. Kept pure (no
// filesystem, no electron) so this safety decision is unit-testable — the
// wrapper `migrateMcpConfigLocation` only does the IO around it.
//   currentExists — does ~/.claude.json exist on disk?
//   currentObj    — its parsed contents, or null (absent OR unparseable)
export type McpMigrationPlan =
  | { action: 'skip' }
  | { action: 'abort' }
  | { action: 'write'; legacyOut: Record<string, unknown>; currentOut: Record<string, unknown> };

export function planMcpConfigMigration(input: {
  legacyObj: Record<string, unknown> | null;
  currentObj: Record<string, unknown> | null;
  currentExists: boolean;
}): McpMigrationPlan {
  const { legacyObj, currentObj, currentExists } = input;

  // Nothing to move if legacy is unreadable or carries no peek entry.
  if (!legacyObj || !(legacyObj.mcpServers as Record<string, unknown> | undefined)?.peek) {
    return { action: 'skip' };
  }

  // Present-but-unparseable current file → refuse to overwrite it.
  // (Absent file is currentObj===null too, but currentExists is false there,
  // so we safely fall through and start from an empty object.)
  if (currentExists && currentObj === null) {
    return { action: 'abort' };
  }

  const { legacyOut, currentOut, changed } = applyMcpConfigMigration(legacyObj, currentObj ?? {});
  if (!changed) return { action: 'skip' };
  return { action: 'write', legacyOut, currentOut };
}
