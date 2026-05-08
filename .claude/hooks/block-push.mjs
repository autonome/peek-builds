#!/usr/bin/env node
// PreToolUse:Bash hook — surfaces push/main-move commands to the user
// for explicit approval instead of letting agents run them silently.
// Emits the documented `permissionDecision: "ask"` shape so Claude Code
// shows the standard tool-permission prompt; the user approves or denies.

import { readFileSync } from "node:fs";

// `main` matched as a whole bookmark token (not e.g. `main-feature`):
// `(?:\s+\S+)*\s+main(?:\s|$)` — any number of preceding args, then `main`
// at a whitespace boundary.
const PATTERNS = [
  {
    re: /^\s*jj\s+bookmark\s+(?:set|move|create|delete|forget|rename|track|untrack)\b(?:\s+\S+)*\s+main(?:\s|$)/,
    why: "modifies the main bookmark",
  },
  {
    re: /^\s*jj\s+op\s+(?:restore|undo|abandon)\b/,
    why: "rewinds jj operation history (can move main as a side effect)",
  },
  { re: /^\s*jj\s+git\s+push\b/, why: "pushes via jj" },
  { re: /^\s*git\s+push\b/, why: "bare git push" },
];

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command;
if (typeof command !== "string") process.exit(0);

for (const { re, why } of PATTERNS) {
  if (re.test(command)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            `mpeek policy: this command ${why}. Please confirm before allowing.`,
        },
      }),
    );
    process.exit(0);
  }
}

process.exit(0);
