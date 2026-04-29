---
name: jj-worktrees
description: Manage jj worktrees and merge agent work
user_invocable: true
---

# jj Worktree Management

Use `scripts/jj-worktrees.sh` for all jj workspace operations instead of compound bash commands.

## Commands

### Check status of all worktrees
```bash
scripts/jj-worktrees.sh status
```
Shows all workspaces with unmerged commits (commits not yet on main).

### Merge a specific workspace to main
```bash
scripts/jj-worktrees.sh merge <workspace-name>
```
Rebases the workspace's commits onto main and moves the main bookmark.

### Merge all unmerged workspaces to main
```bash
scripts/jj-worktrees.sh merge-all
```
Iterates all workspaces and merges any with unmerged commits.

### List worktree directories
```bash
scripts/jj-worktrees.sh clean
```
Shows worktree directories and their sizes for cleanup.

### Show recent main commits
```bash
scripts/jj-worktrees.sh log
```

## When to use

- **Always** use this script for checking worktree status, merging, and cleanup
- **Never** write compound jj commands inline — use this script
- Agents in worktrees should only `jj commit`, never move main or merge
