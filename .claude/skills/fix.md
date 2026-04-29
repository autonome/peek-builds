# /fix — Spawn background coding agent

When the user invokes /fix with a description:

1. Spawn a **background coding agent** (`subagent_type=general-purpose`, `run_in_background=true`) with the task description.

2. Include these rules in the agent prompt:
   - Use `jj` not `git` for version control
   - Use `yarn <script>` for build/test/lint — read `package.json` scripts first
   - No compound bash commands (`&&`, `;`, `|`)
   - Use Read/Grep/Glob tools instead of bash for file operations
   - Read files before editing them
   - Do NOT commit unless explicitly asked
   - Follow all rules in CLAUDE.md

3. The agent should:
   - Read relevant files to understand the code
   - Make the requested changes
   - Verify changes with appropriate build/test commands
   - Report what was changed and any issues found

4. When the agent completes, relay its findings to the user.

## Worktree mode

If the user passes `--worktree`, create an isolated jj worktree first:
```
jj workspace add ../.claude/worktrees/fix-<short-description>
```
Then run the agent in that worktree directory.

## Usage

```
/fix "description of what to fix or implement"
/fix "description" --worktree
```
