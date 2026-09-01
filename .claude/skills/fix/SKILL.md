---
name: fix
description: Spawn a background coding agent in its own git worktree with mpeek repo rules baked in (yarn scripts, one command per Bash call). Use when delegating a well-scoped fix or implementation to a background agent.
---

# /fix — Spawn a background coding agent

When the user invokes /fix with a description:

1. Create the slot from the repo root — layout rules live in
   `~/.claude/docs/worktrees.md`:

   ```bash
   git worktree add .worktrees/<slot> -b agent/<slot> main
   ```

   Then install inside it (`cd .worktrees/<slot> && yarn install`); a worktree
   is its own checkout and its resolution state is gitignored, so it never
   arrives with the files.

2. Spawn a **background coding agent** (`subagent_type=routine-coder`,
   `run_in_background=true`). Named work belongs to `routine-coder` however
   large it is; the catch-all agent is for work nobody could specify. The brief
   must name the worktree path — that is also what satisfies the second-writer
   spawn guard.

3. Include these rules in the agent prompt:
   - Work only in `.worktrees/<slot>/` — never the repo root, never another
     worktree
   - Use `yarn <script>` for build/test/lint — read `package.json` scripts first
   - No compound bash commands (`&&`, `;`, `|`)
   - Use Read/Grep/Glob tools instead of bash for file operations
   - Read files before editing them
   - Commit on `agent/<slot>`; do NOT merge, do NOT push
   - Follow all rules in CLAUDE.md

4. The agent should:
   - Read relevant files to understand the code
   - Make the requested changes
   - Verify changes with appropriate build/test commands
   - Report what was changed and any issues found

5. When the agent completes, relay its findings to the user and route the diff
   through `/agent-review` for the land + verify loop.

## Usage

```
/fix "description of what to fix or implement"
```
