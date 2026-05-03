#!/usr/bin/env node
// PreToolUse:Bash hook — blocks pushing/main-moving from agent sessions.
// User-typed `!` commands run client-side and bypass PreToolUse hooks.

import { readFileSync } from "node:fs";

const PATTERNS = [
  { re: /^\s*jj\s+bookmark\s+set\s+main\b/, why: "moves the main bookmark" },
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
    const head = command.split("\n")[0].slice(0, 100);
    process.stderr.write(
      `BLOCKED: \`${head}\` ${why}.\n` +
        `mpeek policy: jj bookmark set main / jj git push / git push are user-only.\n` +
        `If the user wants this, they run it themselves via the \`!\` prefix.\n`,
    );
    process.exit(2);
  }
}

process.exit(0);
