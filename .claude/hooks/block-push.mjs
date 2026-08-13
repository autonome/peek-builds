#!/usr/bin/env node
// PreToolUse:Bash hook — surfaces push/main-move commands to the user
// for explicit approval instead of letting agents run them silently.
// Emits the documented `permissionDecision: "ask"` shape so Claude Code
// shows the standard tool-permission prompt; the user approves or denies.
//
// `main` moves only via scripts/finalize-isolated-clone.sh and
// scripts/push-main.sh — never by hand.

import { readFileSync } from "node:fs";

// `main` matched as a whole branch token (not e.g. `main-feature`):
// `(?:\s+\S+)*\s+main(?:\s|$)` — any number of preceding args, then `main`
// (bare or as a `<src>:main` refspec) at a whitespace boundary.
const PATTERNS = [
  {
    re: /^\s*git\s+branch\s+(?:-f|--force)\b(?:\s+\S+)*\s+main(?:\s|$)/,
    why: "force-moves the main branch by hand",
  },
  {
    re: /^\s*git\s+reset\s+--hard\b/,
    why: "hard-resets the current branch (moves main if it's checked out)",
  },
  {
    re: /^\s*git\s+push\b(?:\s+\S+)*\s+(?:\S*:)?main(?:\s|$)/,
    why: "pushes a ref targeting main by hand",
  },
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
