/**
 * CLI verb dispatcher.
 *
 * Receives `{verb, args}` messages from the cli-socket and turns them
 * into pubsub publishes on a `cli:<verb>` topic. Feature backgrounds
 * (cmd, peeks, slides) subscribe to those topics and call their
 * existing dispatch paths — no new IPC, no main-process reaching into
 * renderer guts.
 *
 * Verbs are sanitised with a strict regex so a malicious socket peer
 * can't inject arbitrary topic names like `cli:foo;internal:bad`.
 */

import { publish } from './pubsub.js';

const SYSTEM_ADDRESS = 'peek://system/';
const VERB_RE = /^[a-z][a-z0-9-]*$/;

export interface CliMessage {
  verb: string;
  args?: unknown[];
}

export interface CliResult {
  ok: boolean;
  error?: string;
}

export function dispatch(msg: CliMessage): CliResult {
  if (!msg || typeof msg.verb !== 'string') {
    return { ok: false, error: 'missing verb' };
  }
  if (!VERB_RE.test(msg.verb)) {
    return { ok: false, error: `invalid verb: ${msg.verb}` };
  }
  const args = Array.isArray(msg.args) ? msg.args : [];
  publish(SYSTEM_ADDRESS, `cli:${msg.verb}`, { args });
  return { ok: true };
}

/**
 * The set of verbs this build advertises. Adding a verb here doesn't
 * register it — the corresponding feature background still has to
 * subscribe to `cli:<verb>` — but it's the canonical list the settings
 * UI renders for users to bind shortcuts to. Keep alphabetical.
 */
export const KNOWN_VERBS: ReadonlyArray<{ verb: string; argHint?: string; description: string }> = [
  { verb: 'cmd-open',   description: 'Open the command panel' },
  { verb: 'peek-open',  argHint: '<n>',    description: 'Open peek N (0–9)' },
  { verb: 'slide-open', argHint: '<edge>', description: 'Open slide on edge (Up|Down|Left|Right)' },
];
