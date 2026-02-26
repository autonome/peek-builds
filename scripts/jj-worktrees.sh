#!/bin/bash
# jj worktree management for multi-agent workflow
# Usage: scripts/jj-worktrees.sh <command> [args]

set -euo pipefail

CMD="${1:-help}"

case "$CMD" in
  status)
    # Show all workspaces with unmerged commits
    for ws in $(jj workspace list 2>/dev/null | awk -F: '{print $1}'); do
      commits=$(jj log -r "::$ws ~ ::main" --no-graph -T 'description.first_line() ++ "\n"' 2>/dev/null | grep -v '^$' || true)
      if [ -n "$commits" ]; then
        echo "=== $ws ==="
        echo "$commits"
        echo
      fi
    done
    ;;

  merge)
    # Merge a specific workspace to main
    WS="${2:?Usage: jj-worktrees.sh merge <workspace-name>}"
    commits=$(jj log -r "::$WS ~ ::main" --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"' 2>/dev/null | grep -v '^$' || true)
    if [ -z "$commits" ]; then
      echo "No unmerged commits in $WS"
      exit 0
    fi
    echo "Merging $WS to main:"
    echo "$commits"
    # Get the tip commit of the workspace
    tip=$(jj log -r "$WS-" --no-graph -T 'change_id.short()' 2>/dev/null | head -1)
    if [ -z "$tip" ]; then
      echo "Could not find tip commit for $WS"
      exit 1
    fi
    jj rebase -s "roots(::$WS ~ ::main)" -d main
    jj bookmark set main -r "$tip"
    echo "Done. Main now at: $(jj log -r main --no-graph -T 'change_id.short() ++ " " ++ description.first_line()' 2>/dev/null)"
    ;;

  merge-all)
    # Merge all workspaces with unmerged commits
    for ws in $(jj workspace list 2>/dev/null | awk -F: '{print $1}'); do
      [ "$ws" = "default" ] && continue
      commits=$(jj log -r "::$ws ~ ::main" --no-graph -T 'description.first_line() ++ "\n"' 2>/dev/null | grep -v '^$' || true)
      if [ -n "$commits" ]; then
        echo "=== Merging $ws ==="
        bash "$0" merge "$ws"
        echo
      fi
    done
    ;;

  clean)
    # Show worktree directories and sizes
    echo "=== .claude/worktrees ==="
    if [ -d ".claude/worktrees" ]; then
      du -sh .claude/worktrees/*/ 2>/dev/null || echo "(empty)"
    fi
    echo
    echo "=== jj workspaces ==="
    jj workspace list 2>/dev/null
    ;;

  log)
    # Show recent main commits
    jj log -r 'ancestors(main, 10)' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"' 2>/dev/null
    ;;

  help|*)
    echo "Usage: scripts/jj-worktrees.sh <command>"
    echo
    echo "Commands:"
    echo "  status     Show all workspaces with unmerged commits"
    echo "  merge <ws> Merge a specific workspace to main"
    echo "  merge-all  Merge all unmerged workspaces to main"
    echo "  clean      Show worktree directories and sizes"
    echo "  log        Show recent main commits"
    ;;
esac
