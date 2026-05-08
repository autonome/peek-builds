#!/usr/bin/env node
// PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit.
//
// Blocks file mutations when `@` already has a description — that means it
// was finalized and the next edit would silently amend the finished commit.
// The fix is `jj new` first to create a fresh working commit.
//
// Override: set JJ_AMEND=1 in the environment to bypass (e.g. intentional
// amend, or describe-first workflow where description is set up front).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

if (process.env.JJ_AMEND === "1") process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !filePath) process.exit(0);

const dir = dirname(filePath);

function jj(...args) {
  try {
    return execFileSync("jj", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

const description = jj("log", "-r", "@", "-T", "description", "--no-graph");
if (description === null) process.exit(0); // not in a jj repo

const trimmed = description.trim();
if (!trimmed) process.exit(0); // empty description — working commit, fine

const firstLine = trimmed.split("\n")[0];
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `mpeek policy: @ is the finished commit "${firstLine}" with a clean working copy. Run \`jj new\` to start a fresh commit before editing — otherwise this edit silently amends the finished commit. Override: set JJ_AMEND=1.`,
    },
  }),
);
process.exit(0);
