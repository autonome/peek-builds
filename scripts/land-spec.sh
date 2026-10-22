#!/usr/bin/env bash
# Lands one spec-driven track on the base branch without a person, for the
# coordinator's tick (tracks.json -> specWatch.landScript).
#
#   scripts/land-spec.sh [--check] <spec-name> <reviewed-spec-sha> <reviewed-branch-tip>
#
# <reviewed-spec-sha> and <reviewed-branch-tip> are the full shas the tick's
# passing review recorded: the commit that last changed the spec on base, and the
# track branch's tip. The script refuses unless its own reads match both, so what
# it lands is what was reviewed. The old one-argument form is refused with a
# message saying so. A run that only finishes an earlier run's merge (see "After
# the merge" below) lands nothing new, so there the two are only checked to be
# shas; its "owed" line names the exact values a rerun can pass.
#
# Run from anywhere inside the repo. Prints exactly one line on stdout saying
# what happened; everything else (gate output, git chatter, diagnostics) goes to
# stderr. `--check` (accepted anywhere; other options are refused) runs every
# condition and check below and then stops without merging, tagging, removing,
# pushing or creating anything; the branch is put back at the tip it had.
#
#   exit 0  landed: merged and tagged (with --check: every condition and check
#           passed). Once the merge has happened the exit status stays 0 and the
#           line names any step still owed, e.g. "; owed: worktree not removed";
#           a rerun finishes what is owed.
#   exit 1  not eligible, or something failed before the merge, or the run was
#           interrupted before the merge ("not landed: interrupted"); the line
#           names the condition and the track branch is left as it was found
#   exit 2  the branch is behind base and rebasing it conflicts; the line lists
#           the conflicting paths, the rebase is aborted, and the branch is
#           unchanged
#
# It lands only when all of these hold:
#   - `flock` exists and no other run of this script is in progress
#   - the primary checkout is clean and on base; the track's worktree is clean
#     (a rebase or detached HEAD left by an earlier killed run is undone first)
#   - the branch has commits beyond base, and its tip is <reviewed-branch-tip>
#   - the spec on base was last changed by <reviewed-spec-sha>
#   - the spec declares `touches`, none of them a glob that matches everything or
#     reaches the gate's own files; the diff stays inside those globs and touches
#     nothing that defines the gate or the landing (see "Why the gate's own files
#     are off limits" and the isDenied list below), whatever `touches` says,
#     compared without case; the spec's `spec/<name>/<sha>` tag is not already
#     there, and the spec is the version first read (a spec edited on base while
#     the gate runs means the track needs review again)
#   - the name is letters, digits, '.', '_' and '-' with no '..', since it becomes
#     a branch, a worktree directory and land-pending/<name>
#   - base is an ancestor of the branch (rebased onto base first when it is not)
#   - the declared `verify` passes on the tip, then every command in
#     tracks.json `specWatch.landChecks` (a list, empty by default) exits 0 on
#     it; because base is an ancestor the tip is the merged result
#   - immediately before the merge the tip is the one that was checked, the
#     worktree is clean, and base has not moved
# and then it lands the way the person's /land does: fast-forward merge of that
# exact commit in the primary checkout, the tag, `yarn install` when the merge
# changed yarn.lock or any package.json, worktree removal, branch deletion, this
# track's line dropped from the roster, and finally `scripts/push-main.sh --yes`
# from the primary checkout to publish base.
#
# Where the gate runs: `verify` and each `landChecks` command run with bash -lc in
# the track's worktree, with tracks.json `namespace` applied ({track} and
# {worktree} filled in). `verify`, `landChecks` and `namespace` are read from the
# primary checkout's tracks.json; a config that cannot be read, or a `landChecks`
# or `namespace` of the wrong shape, refuses the landing rather than gating on less.
#
# Why the gate's own files are off limits: they run with the track's copy of the
# repo, so a track that could change them could rewrite the gate it is judged by.
# Such a track lands only by a person's /land.
#
# If base moves while the gate runs, the branch is rebased again and checked
# again, at most three attempts. When base moved only in `handoff.md`, the gate
# is not rerun.
#
# Where /land asks a person, the unattended equivalent is:
#   - no `verify` declared: refuse, rather than land unverified
#   - a spec with no `touches`: refuse, since nothing bounds the diff
#   - a conflict in anything but `handoff.md` while rebasing: abort and exit 2
#     rather than resolving it, since a semantic conflict is the track writer's
#     work. A `handoff.md` conflict resolves to base's side here, because the
#     landing must not carry the track's note onto base.
#   - the branch's own `handoff.md` note is restored to base's roster in a commit
#     on the branch before the gate runs, so the fast-forward cannot carry it
#     onto base (this repository ignores handoff.md, so normally there is none)
#   - the roster is gitignored here: this track's line is dropped by editing the
#     file in place, with nothing to commit. A tracked roster's edit is committed
#     instead, so the primary checkout stays clean for the next landing.
#
# After the merge every step is retryable. The merge is recorded in
# $GIT_COMMON_DIR/land-pending/<name> before it happens, and that record stays
# until the tag, install, worktree removal, branch deletion, roster step and push
# are all done, so if the run is killed or a step does not happen, the next run
# sees a track whose tip is already in base and finishes what is left instead of
# refusing. Each step is skipped on a rerun when already done. The tag is written
# first (retried once). `yarn install` is tried once: a failure is named on the
# line and not retried by a rerun. The push is retried by every rerun until it
# succeeds; a failed push never undoes the landing, it is only named as owed.
#
# Signals and the lock: TERM, INT and HUP kill the gate's process group, put the
# branch back, and end the run with one line: "not landed: interrupted" (exit 1), or,
# if the merge had already happened, the "landed ... owed: ..." line (exit 0). The
# lock is taken on the git directory itself (no file is created) and its descriptor
# is closed for every child, so a daemon a check leaves behind cannot hold it. Only
# runs of this script take the lock: a manual /land does not. A rerun for a track
# that was merged but not finished proceeds even when the primary is dirty or off
# base; the roster step then names itself as owed.
#
# The whole body is inside main(), followed by `exit`, so bash never reads the
# file again after it starts running; a merge that rewrites this file cannot
# change the run in progress.

# shellcheck disable=SC2317  # cleanup and on_signal run from traps
set -eEuo pipefail

# Run in the primary checkout after a merge that changed yarn.lock or a package.json.
INSTALL_ON_LAND="yarn install"
# Run in the primary checkout last: publishes base.
PUSH_ON_LAND="scripts/push-main.sh --yes"
INSTALL_TIMEOUT=1200
MAX_ATTEMPTS=3

main() {
  # fd 3 is the one line the tick reads; everything else goes to stderr.
  exec 3>&1 1>&2
  emit() { echo "$1" >&3; }
  fail() { emit "not landed: $1"; exit 1; }
  # No child inherits the lock (9) or the result pipe (3).
  git() { command git "$@" 3>&- 9>&-; }

  USAGE="usage: scripts/land-spec.sh [--check] <spec-name> <reviewed-spec-sha> <reviewed-branch-tip>"
  CHECK_ONLY=0
  POS=()
  for arg in "$@"; do
    case "$arg" in
      --check) CHECK_ONLY=1 ;;
      -*) emit "not landed: unknown option $arg ($USAGE)"; exit 1 ;;
      *) POS+=("$arg") ;;
    esac
  done
  if [ "${#POS[@]}" = 1 ]; then
    emit "not landed: the spec sha and branch tip the review passed are required arguments now ($USAGE)"
    exit 1
  fi
  [ "${#POS[@]}" = 3 ] || { emit "not landed: $USAGE"; exit 1; }
  NAME="${POS[0]}"; REVIEWED_SPEC="${POS[1]}"; REVIEWED_TIP="${POS[2]}"
  # The name becomes a branch, a worktree directory and land-pending/<name>, so it
  # may not reach outside any of them.
  if ! [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [[ "$NAME" == *..* ]]; then
    emit "not landed: $NAME is not a spec name (letters, digits, '.', '_' and '-', not starting with a symbol, no '..')"
    exit 1
  fi
  for arg in "$REVIEWED_SPEC" "$REVIEWED_TIP"; do
    [[ "$arg" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || { emit "not landed: $arg is not a full commit sha ($USAGE)"; exit 1; }
  done

  LANDED=0
  MERGE_TRIED=0  # set once the merge has started or an earlier run's merge is being finished
  TIP=""; OLD_BASE=""; TAG=""; PENDING=""; ROOT=""; BASE=""
  ORIG=""        # the tip the worktree had on entry
  SET_TIP=""     # the tip this script last put the worktree at
  REBASING=0
  WT=""
  TMP=""
  CHILD=""
  NS=()
  SETSID="$(command -v setsid || true)"
  TIMEOUT="$(command -v timeout || true)"

  cleanup() {
    local code=$?
    # The line has been printed and the exit status decided: a signal from here on
    # must not print a second line or change the status.
    trap '' TERM INT HUP
    trap - EXIT ERR
    set +e
    [ -z "$TMP" ] || rm -rf "$TMP"
    if [ "$LANDED" = 0 ] && [ -n "$ORIG" ] && [ -d "$WT" ]; then
      if [ "$REBASING" = 1 ]; then
        git -C "$WT" rebase --abort >/dev/null 2>&1
        REBASING=0
      fi
      # Put the tip back only if it is still the one this script set: a commit or
      # an edit a writer made since is not this script's to discard.
      if [ "$SET_TIP" != "$ORIG" ] && [ "$(git -C "$WT" rev-parse HEAD 2>/dev/null)" = "$SET_TIP" ]; then
        git -C "$WT" reset --keep -q "$ORIG" >/dev/null 2>&1
      fi
    fi
    exit "$code"
  }
  # A signal ends the run with one line: "not landed: interrupted" (exit 1), or, if
  # the merge had already happened, "landed ... owed: ..." (exit 0). Cleanup runs
  # on the way out either way.
  on_signal() {
    trap - TERM INT HUP
    if [ -n "$CHILD" ]; then
      if [ -n "$SETSID" ]; then kill -TERM -- "-$CHILD" 2>/dev/null || true
      else kill -TERM "$CHILD" 2>/dev/null || true; fi
    fi
    if [ "$MERGE_TRIED" = 1 ] && [ -n "$TIP" ] \
       && git -C "$ROOT" merge-base --is-ancestor "$TIP" "refs/heads/$BASE" 2>/dev/null; then
      LANDED=1
      emit "landed $NAME at $(git -C "$ROOT" rev-parse --short "$TIP" 2>/dev/null); owed: interrupted before the landing finished (rerun scripts/land-spec.sh $NAME ${TAG##*/} $TIP)"
      exit 0
    fi
    emit "not landed: interrupted"
    exit 1
  }
  trap cleanup EXIT
  # The ERR trap also fires inside $(...) subshells (set -E); only the top-level
  # shell may print, so an unexpected failure is exactly one line.
  MAIN_PID=$BASHPID
  trap 'if [ "$BASHPID" = "$MAIN_PID" ]; then emit "not landed: unexpected failure at line $LINENO"; fi; exit 1' ERR
  trap 'on_signal 143' TERM
  trap 'on_signal 130' INT
  trap 'on_signal 129' HUP

  # run_child <dir> <gate|install> <shell command>: runs in its own session so
  # a signal can take the whole tree down, and so this shell can react to the
  # signal instead of waiting for the child. `gate` applies the namespace
  # environment; `install` runs with the caller's environment.
  run_child() {
    local dir="$1" mode="$2" cmd="$3" rc=0
    (
      cd "$dir"
      # shellcheck disable=SC2086  # $SETSID is empty or one word
      case "$mode" in
        gate)    exec $SETSID env "${NS[@]+"${NS[@]}"}" bash -lc "$cmd" ;;
        install) exec $SETSID bash -lc "$cmd" ;;
      esac
    ) 3>&- 9>&- </dev/null &   # stdin: a child that reads it must not eat the caller's here-string
    CHILD=$!
    wait "$CHILD" || rc=$?
    CHILD=""
    return "$rc"
  }

  # JSON, front matter and glob matching, by node, since the repo already needs
  # it. Every command exits nonzero with a reason on stderr when its input is
  # missing or has the wrong shape.
  read -r -d '' JS <<'EOF' || true
import { readFileSync } from "node:fs";
const [cmd, ...a] = process.argv.slice(1);
const die = (m) => { console.error(m); process.exit(1); };
const read = (f) => {
  try { return JSON.parse(readFileSync(f, "utf-8")); } catch (e) { die(`cannot read ${f}: ${e.message}`); }
};
const glob = (g) => {
  if (g.endsWith("/")) g += "**";   // a directory entry covers everything under it, as the tick's scope check reads it
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }   // **/ is zero or more directories
      else { re += ".*"; i += 1; }
    }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};
const touchesOf = (specFile) => {
  const m = readFileSync(specFile, "utf-8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const kv = m[1].split(/\r?\n/).map((l) => l.match(/^touches\s*:\s*(.*)$/)).find(Boolean);
  if (!kv) return [];
  const v = kv[1].trim();
  return v.startsWith("[")
    ? v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    : v ? [v.replace(/^["']|["']$/g, "")] : [];
};
// Paths that define the gate or the landing, whatever a spec's touches says: the
// scripts and config the gate runs with the track's own copy of the repository.
// Compared without case, since on a case-insensitive filesystem `Scripts/x` is
// `scripts/x`.
//   - the landing: this script and scripts/push-main.sh, which publishes base
//   - tracks.json (verify, namespace, landChecks), specs/ (the reviewed specs),
//     .githooks/, .github/, .tangled/ (commit and CI checks)
//   - the build and test tooling `verify` runs: the root package.json and
//     apps/desktop/package.json (the `build` script), yarn.lock, .yarnrc.yml,
//     .yarn/ (the pinned yarn release and plugins), .nvmrc (node version),
//     apps/desktop/tsconfig.json, apps/desktop/scripts/ (native helper builds),
//     scripts/timed.sh, scripts/patch-chrome-extensions.js,
//     scripts/patch-virtual-core.js and packages/schema/codegen.js (all run by
//     the `build` script)
//   - .env*, .gitattributes and .gitmodules in any directory
const DENY_FILES = [
  "scripts/land-spec.sh", "scripts/push-main.sh", "tracks.json", "package.json",
  "yarn.lock", ".yarnrc.yml", ".nvmrc", "apps/desktop/package.json",
  "apps/desktop/tsconfig.json", "scripts/timed.sh", "scripts/patch-chrome-extensions.js",
  "scripts/patch-virtual-core.js", "packages/schema/codegen.js",
];
const DENY_DIRS = [".githooks/", ".github/", ".tangled/", ".yarn/", "apps/desktop/scripts/"];
const isDenied = (path, specsDirs) => {
  const p = path.toLowerCase();
  return DENY_FILES.includes(p) || DENY_DIRS.some((d) => p.startsWith(d)) ||
    specsDirs.some((d) => p.startsWith(`${d.toLowerCase()}/`)) ||
    /(^|\/)\.env[^/]*$/.test(p) ||
    /(^|\/)\.gitattributes$/.test(p) || /(^|\/)\.gitmodules$/.test(p);
};
// Changed-path lists arrive NUL-separated (git diff -z); control characters are
// escaped when a path is shown on the one output line.
const paths = (f) => readFileSync(f, "utf-8").split("\0").filter(Boolean);
const show = (p) => p.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
if (cmd === "cfg") {
  // cfg <tracks.json> <key> [default]: top-level key, or specWatch.<key>
  const [file, key, dflt = ""] = a;
  const j = read(file);
  const v = key.startsWith("specWatch.") ? (j.specWatch ?? {})[key.slice(10)] : j[key];
  console.log(typeof v === "string" ? v : dflt);
} else if (cmd === "checks") {
  const c = (read(a[0]).specWatch ?? {}).landChecks;
  if (c !== undefined) {
    if (!Array.isArray(c) || c.some((x) => typeof x !== "string" || !x.trim())) {
      die("specWatch.landChecks must be a list of non-empty command strings");
    }
    for (const x of c) console.log(x.trim());
  }
} else if (cmd === "ns") {
  // ns <tracks.json> <track> <worktree>: KEY=VALUE lines with placeholders filled
  const [file, track, wt] = a;
  const n = read(file).namespace;
  if (n !== undefined) {
    if (n === null || typeof n !== "object" || Array.isArray(n) ||
        Object.values(n).some((v) => typeof v !== "string" && typeof v !== "number")) {
      die("namespace must be an object of string values");
    }
    for (const [k, v] of Object.entries(n)) {
      console.log(`${k}=${String(v).replaceAll("{track}", track).replaceAll("{worktree}", wt)}`);
    }
  }
} else if (cmd === "touches") {
  // touches <spec file>: the spec's touches globs, one per line
  for (const t of touchesOf(a[0])) console.log(t);
} else if (cmd === "denied") {
  // denied <file listing changed paths> <spec directory>...: the paths that define the gate
  for (const f of paths(a[0])) if (isDenied(f, a.slice(1))) console.log(show(f));
} else if (cmd === "broad") {
  // broad <spec file> <spec directory>...: touches globs that match everything or reach
  // a path that defines the gate
  const reach = [...DENY_FILES, ...DENY_DIRS.map((d) => `${d}x`), ...a.slice(1).map((d) => `${d}/x.md`),
                 ".env", ".gitattributes", ".gitmodules"];
  const every = ["a", "a/b", "src/x.ts", "apps/desktop/main/x.ts", "docs/x.md"];
  for (const g of touchesOf(a[0])) {
    const re = glob(g), reI = new RegExp(re.source, "i");
    if (reach.some((p) => reI.test(p)) || every.every((p) => re.test(p))) console.log(g);
  }
} else if (cmd === "outside") {
  // outside <spec file> <file listing changed paths>: the paths no touches glob matches
  const res = touchesOf(a[0]).map(glob);
  for (const f of paths(a[1])) if (!res.some((r) => r.test(f))) console.log(show(f));
}
EOF
  js() { node --input-type=module -e "$JS" -- "$@"; }

  COMMON="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
  ROOT="$(dirname "$COMMON")"
  CFG="$ROOT/tracks.json"

  # The lock is on the git directory itself, so taking it creates no file.
  command -v flock >/dev/null 2>&1 || fail "flock is not installed, so a second landing could not be kept out"
  exec 9<"$COMMON"
  flock -n 9 || fail "another landing is in progress"

  BASE="$(js cfg "$CFG" base main)" || fail "tracks.json cannot be read"
  WTDIR="$(js cfg "$CFG" worktrees .worktrees)" || fail "tracks.json cannot be read"
  SPECS="$(js cfg "$CFG" specWatch.specs specs)" || fail "tracks.json cannot be read"
  VERIFY="$(js cfg "$CFG" verify)" || fail "tracks.json cannot be read"
  TRACK="spec-$NAME"
  BRANCH="track/$TRACK"
  WT="$ROOT/$WTDIR/$TRACK"
  SPEC="$SPECS/$NAME.md"
  CHECKS="$(js checks "$CFG")" || fail "specWatch.landChecks in tracks.json cannot be read or is not a list of commands"
  NS_OUT="$(js ns "$CFG" "$TRACK" "$WT")" || fail "namespace in tracks.json cannot be read or is not an object of strings"
  while IFS= read -r line; do
    if [ -n "$line" ]; then NS+=("$line"); fi
  done <<<"$NS_OUT"

  [ -n "$VERIFY" ] || fail "no verify command declared, and landing unverified is a person's call"

  TMP="$(mktemp -d)"
  PENDING="$COMMON/land-pending/$NAME"

  # ---- after the merge -------------------------------------------------------
  # Never fails the run: what is left is named on the line. Needs TIP, OLD_BASE and
  # TAG, and the pending marker, which stays until every step a rerun can finish is
  # done, so a run killed anywhere in here leaves a track the next run finishes
  # rather than refuses. Each step checks whether it is already done: the tag,
  # worktree and branch by looking, the roster by its edit being a no-op, the
  # install by a line recorded in the marker once it has been tried (a failed
  # install is named, not retried), the push by a line recorded once it succeeded.
  # The tag is the one step that matters to the coordinator, so it goes first.
  finish_landing() {
    local owed="" again="" changed rc
    trap - ERR
    set +e
    MERGE_TRIED=1
    if ! git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
      git -C "$ROOT" tag "$TAG" "$TIP" || { sleep 1; git -C "$ROOT" tag "$TAG" "$TIP"; }
      if ! git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
        emit "landed $NAME at $(git -C "$ROOT" rev-parse --short "$TIP"); owed: tag $TAG not written (rerun scripts/land-spec.sh $NAME ${TAG##*/} $TIP)"
        exit 0
      fi
    fi

    if ! sed -n '4,$p' "$PENDING" 2>/dev/null | grep -qx 'install tried'; then
      changed="$(git -C "$ROOT" diff --name-only --no-renames "$OLD_BASE" "$TIP")"
      if printf '%s\n' "$changed" | grep -Eq '(^|/)package\.json$|^yarn\.lock$'; then
        run_child "$ROOT" install "${TIMEOUT:+$TIMEOUT $INSTALL_TIMEOUT }$INSTALL_ON_LAND"
        rc=$?
        case "$rc" in
          0) ;;
          124) owed="$owed; install timed out" ;;
          *) owed="$owed; install failed" ;;
        esac
      fi
      { cat "$PENDING"; echo 'install tried'; } >"$PENDING.tmp" && mv "$PENDING.tmp" "$PENDING"
    fi

    if [ -d "$WT" ]; then
      git -C "$ROOT" worktree remove "$WT" || { owed="$owed; worktree not removed"; again=1; }
    fi
    if git -C "$ROOT" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
      git -C "$ROOT" branch -d "$BRANCH" >/dev/null 2>&1 || { owed="$owed; branch not deleted"; again=1; }
    fi

    # Drop this track's entry (its line and indented continuation lines) from the
    # roster's derived "Waiting on a decision" section, matching the track exactly
    # (`spec-x` is not `spec-x-y`). The roster is ignored in this repository, so the
    # edit is the whole step; a tracked one is committed alone. Prose elsewhere is
    # left alone.
    if [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then
      owed="$owed; roster line not dropped: primary checkout is not on $BASE"; again=1
    elif [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
      owed="$owed; roster line not dropped: primary checkout is dirty"; again=1
    elif [ -f "$ROOT/handoff.md" ]; then
      awk -v wt="\`$WTDIR/$TRACK\`" -v nm="**$NAME**" '
        /^## / { in_sec = ($0 == "## Waiting on a decision"); skip = 0 }
        in_sec {
          if (index($0, wt) || index($0, nm)) { skip = 1; next }
          if (skip && $0 ~ /^[ \t]+[^ \t]/) next
          skip = 0
        }
        { print }
      ' "$ROOT/handoff.md" >"$TMP/roster"
      if cmp -s "$TMP/roster" "$ROOT/handoff.md"; then
        :
      elif ! git -C "$ROOT" ls-files --error-unmatch -- handoff.md >/dev/null 2>&1; then
        # Untracked (ignored) roster: lives on disk only, nothing to commit.
        cat "$TMP/roster" >"$ROOT/handoff.md"
      else
        cat "$TMP/roster" >"$ROOT/handoff.md"
        git -C "$ROOT" add handoff.md
        if ! git -C "$ROOT" commit -q -m "Roster: $NAME landed" -- handoff.md; then
          git -C "$ROOT" reset -q -- handoff.md
          git -C "$ROOT" checkout -- handoff.md
          owed="$owed; roster line not dropped"; again=1
        fi
      fi
    fi

    # Publish base. Last, so everything local is settled first. A failure is named
    # and retried by the next run; the landing stands either way.
    if ! sed -n '4,$p' "$PENDING" 2>/dev/null | grep -qx 'pushed'; then
      if run_child "$ROOT" install "$PUSH_ON_LAND"; then
        { cat "$PENDING"; echo 'pushed'; } >"$PENDING.tmp" && mv "$PENDING.tmp" "$PENDING"
      else
        owed="$owed; push"; again=1
      fi
    fi

    if [ -n "$again" ]; then owed="$owed (rerun scripts/land-spec.sh $NAME ${TAG##*/} $TIP)"
    else rm -f "$PENDING"; fi
    emit "landed $NAME at $(git -C "$ROOT" rev-parse --short "$TIP"), tag $TAG${owed:+; owed:${owed#;}}"
    exit 0
  }

  # ---- a merge an earlier run made but did not finish ------------------------
  if [ -f "$PENDING" ]; then
    TIP="$(sed -n 1p "$PENDING")"; OLD_BASE="$(sed -n 2p "$PENDING")"; TAG="$(sed -n 3p "$PENDING")"
    # It is this track's merge only if the branch is gone or still at that tip; a
    # newer track of the same name is not.
    CUR_TIP="$(git -C "$ROOT" rev-parse -q --verify "refs/heads/$BRANCH" || true)"
    if [ -n "$TIP" ] && [ -n "$OLD_BASE" ] && [ -n "$TAG" ] \
       && { [ -z "$CUR_TIP" ] || [ "$CUR_TIP" = "$TIP" ]; } \
       && git -C "$ROOT" merge-base --is-ancestor "$TIP" "refs/heads/$BASE"; then
      if [ "$CHECK_ONLY" = 1 ]; then
        emit "check passed: $NAME is already merged; a real run would finish the landing (nothing changed)"
        exit 0
      fi
      # Finishing needs no clean primary: the tag does not, and the roster step
      # names itself as owed when the primary is dirty or off base.
      finish_landing
    fi
    # Not a merge that happened: forget it (a check changes nothing).
    if [ "$CHECK_ONLY" = 0 ]; then rm -f "$PENDING"; fi
    TIP=""; OLD_BASE=""; TAG=""
  fi

  [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" = "$BASE" ] || fail "primary checkout is not on $BASE"
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || fail "primary checkout is dirty"

  # ---- refuse before touching anything ---------------------------------------
  [ -d "$WT" ] || fail "no worktree at $WTDIR/$TRACK"
  BRANCH_TIP="$(git -C "$ROOT" rev-parse --verify -q "refs/heads/$BRANCH")" || fail "no branch $BRANCH"
  [ "$BRANCH_TIP" = "$REVIEWED_TIP" ] \
    || fail "$BRANCH is at ${BRANCH_TIP:0:12}, not the reviewed ${REVIEWED_TIP:0:12}, so the track needs review again"

  # A killed earlier run can leave the worktree mid-rebase or detached.
  GD="$(git -C "$WT" rev-parse --absolute-git-dir)"
  if [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ]; then
    git -C "$WT" rebase --abort || fail "could not abort a rebase an earlier run left in $WTDIR/$TRACK"
  fi
  if [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "HEAD" ]; then
    git -C "$WT" merge-base --is-ancestor HEAD "$BRANCH" || fail "worktree is on a detached HEAD holding commits not on $BRANCH"
    git -C "$WT" checkout -q "$BRANCH" || fail "could not return the worktree to $BRANCH"
  fi

  [ -z "$(git -C "$WT" status --porcelain)" ] || fail "track worktree is dirty"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || fail "worktree is not on $BRANCH"
  [ "$(git -C "$ROOT" rev-list --count "refs/heads/$BASE..$BRANCH")" -gt 0 ] || fail "no commits beyond $BASE"

  ORIG="$(git -C "$WT" rev-parse HEAD)"
  SET_TIP="$ORIG"

  # check_diff <ref>: the diff from the pinned base to <ref> may not touch what
  # defines the gate, must have something in it, and must stay inside the touches.
  check_diff() {
    local denied="" outside
    # NUL-separated, so a name holding a newline or a quote is checked as itself
    # rather than in git's quoted form.
    git -C "$ROOT" diff -z --name-only --no-renames "$BASE_SHA...$1" >"$TMP/all"
    [ -s "$TMP/all" ] || fail "no changes beyond $BASE"
    grep -zvx 'handoff.md' "$TMP/all" >"$TMP/files" || [ $? -eq 1 ]
    [ -s "$TMP/files" ] || fail "the branch changes nothing but handoff.md"
    denied="$(js denied "$TMP/files" "$SPECS" | paste -sd, -)"
    [ -z "$denied" ] || fail "the diff changes files that define the gate or the landing, which only a person lands: $denied"
    outside="$(js outside "$TMP/spec.md" "$TMP/files")"
    [ -z "$outside" ] || fail "files outside the spec's touches: $(printf '%s\n' "$outside" | paste -sd, -)"
  }

  # ---- the attempts -----------------------------------------------------------
  ATTEMPT=0
  SKIP_GATE=0
  GATED_TIP=""
  FIRST_SPEC_SHA=""
  while :; do
    ATTEMPT=$((ATTEMPT + 1))
    [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ] || fail "$BASE moved during each of $MAX_ATTEMPTS attempts"

    BASE_SHA="$(git -C "$ROOT" rev-parse "refs/heads/$BASE")"
    git -C "$ROOT" cat-file -e "$BASE_SHA:$SPEC" 2>/dev/null || fail "no $SPEC on $BASE, so this is not a spec-driven track"
    SPEC_SHA="$(git -C "$ROOT" log -1 --format=%H "$BASE_SHA" -- "$SPEC")"
    # The spec version that was reviewed is the first one read; the tag certifies
    # that one, so a spec edited on base while the gate ran means a new review.
    if [ -z "$FIRST_SPEC_SHA" ]; then
      [ "$SPEC_SHA" = "$REVIEWED_SPEC" ] \
        || fail "$SPEC on $BASE is at ${SPEC_SHA:0:12}, not the reviewed ${REVIEWED_SPEC:0:12}, so the track needs review again"
      FIRST_SPEC_SHA="$SPEC_SHA"
    elif [ "$SPEC_SHA" != "$FIRST_SPEC_SHA" ]; then fail "$SPEC changed on $BASE while checking, so the track needs review again"; fi
    TAG="spec/$NAME/$SPEC_SHA"
    git -C "$ROOT" rev-parse --verify -q "refs/tags/$TAG" >/dev/null && fail "tag $TAG already exists"
    git -C "$ROOT" show "$BASE_SHA:$SPEC" >"$TMP/spec.md"
    [ -n "$(js touches "$TMP/spec.md")" ] || fail "$SPEC declares no touches, so nothing bounds the diff"
    BROAD="$(js broad "$TMP/spec.md" "$SPECS" | paste -sd, -)"
    [ -z "$BROAD" ] || fail "$SPEC touches has globs that reach the gate's own files or match everything: $BROAD"
    check_diff "$BRANCH"

    # Base must be an ancestor of the branch. A clean rebase is not a passing one,
    # which is what the gate below is for.
    if ! git -C "$ROOT" merge-base --is-ancestor "$BASE_SHA" "$BRANCH"; then
      REBASING=1
      if ! git -C "$WT" rebase "$BASE_SHA" >/dev/null 2>&1; then
        STEPS=0
        while [ -d "$(git -C "$WT" rev-parse --git-path rebase-merge)" ] \
           || [ -d "$(git -C "$WT" rev-parse --git-path rebase-apply)" ]; do
          STEPS=$((STEPS + 1))
          [ "$STEPS" -le 200 ] || fail "rebase onto $BASE did not finish"
          CONFLICTED="$(git -C "$WT" diff --name-only --diff-filter=U)"
          OTHERS="$(printf '%s\n' "$CONFLICTED" | grep -vx 'handoff.md' || true)"
          if [ -n "$OTHERS" ]; then
            git -C "$WT" rebase --abort >/dev/null 2>&1 || true
            REBASING=0
            emit "rebase onto $BASE conflicts: $(printf '%s\n' "$OTHERS" | paste -sd, -)"
            exit 2
          fi
          # During a rebase "ours" is the branch being rebased onto: base's roster.
          if printf '%s\n' "$CONFLICTED" | grep -qx 'handoff.md'; then
            git -C "$WT" checkout --ours handoff.md >/dev/null 2>&1
            git -C "$WT" add handoff.md
          fi
          # Either step exits nonzero when it stops again at the next commit's
          # conflict, so the loop, not the exit status, decides what happens next.
          # Taking base's roster can leave nothing to commit; that commit is dropped.
          if git -C "$WT" diff --cached --quiet; then
            git -C "$WT" rebase --skip >/dev/null 2>&1 || true
          else
            GIT_EDITOR=true git -C "$WT" rebase --continue >/dev/null 2>&1 || true
          fi
        done
      fi
      REBASING=0
      SET_TIP="$(git -C "$WT" rev-parse HEAD)"
      git -C "$ROOT" merge-base --is-ancestor "$BASE_SHA" "$BRANCH" || fail "rebase did not leave $BASE as an ancestor"
    fi

    # Base's roster stays base's: the branch's own note is undone on the branch.
    if ! git -C "$WT" diff --quiet "$BASE_SHA" -- handoff.md; then
      if git -C "$ROOT" cat-file -e "$BASE_SHA:handoff.md" 2>/dev/null; then
        git -C "$WT" checkout "$BASE_SHA" -- handoff.md
      else
        git -C "$WT" rm -q -f handoff.md
      fi
      git -C "$WT" commit -q -m "Restore the roster handoff.md before landing"
      SET_TIP="$(git -C "$WT" rev-parse HEAD)"
    fi

    # The gate and the extra checks run on the tip, which is the merged result.
    if [ "$SKIP_GATE" = 1 ]; then
      # Only base's roster moved: the gated content is unchanged if the branch
      # differs from what was gated in nothing but handoff.md.
      git -C "$WT" diff --name-only --no-renames "$GATED_TIP" HEAD >"$TMP/regate"
      if [ -n "$(grep -vx 'handoff.md' "$TMP/regate" || true)" ]; then SKIP_GATE=0; fi
    fi
    # The tip that is about to be checked is the tip that may land: a commit a
    # writer adds while the gate runs is not covered by it.
    TIP="$(git -C "$WT" rev-parse HEAD)"
    if [ "$SKIP_GATE" = 0 ]; then
      GATE_RC=0
      run_child "$WT" gate "$VERIFY" || GATE_RC=$?
      [ "$GATE_RC" = 0 ] || fail "verify failed on the tip (exit $GATE_RC)"
      while IFS= read -r check; do
        [ -n "$check" ] || continue
        GATE_RC=0
        run_child "$WT" gate "$check" || GATE_RC=$?
        [ "$GATE_RC" = 0 ] || fail "check failed: $check"
      done <<<"$CHECKS"
      GATED_TIP="$TIP"
    fi

    [ "$(git -C "$WT" rev-parse HEAD)" = "$TIP" ] || fail "the track branch moved while checking"
    [ -z "$(git -C "$WT" status --porcelain)" ] || fail "the track worktree changed while checking"
    NEW_BASE_SHA="$(git -C "$ROOT" rev-parse "refs/heads/$BASE")"
    [ "$NEW_BASE_SHA" != "$BASE_SHA" ] || break

    # Base moved while checking: go round again, skipping the gate when only the
    # roster moved.
    git -C "$ROOT" diff --name-only --no-renames "$BASE_SHA" "$NEW_BASE_SHA" >"$TMP/moved"
    if [ -z "$(grep -vx 'handoff.md' "$TMP/moved" || true)" ]; then SKIP_GATE=1; else SKIP_GATE=0; fi
  done

  # ---- immediately before the merge ------------------------------------------
  [ "$(git -C "$WT" rev-parse HEAD)" = "$TIP" ] || fail "the track branch moved while checking"
  [ "$(git -C "$ROOT" rev-parse "refs/heads/$BRANCH")" = "$TIP" ] || fail "the track branch moved while checking"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || fail "worktree is not on $BRANCH"
  [ -z "$(git -C "$WT" status --porcelain)" ] || fail "the track worktree changed while checking"
  git -C "$WT" diff --quiet "$BASE_SHA" "$TIP" -- handoff.md || fail "the tip still carries a handoff.md change"
  check_diff "$TIP"
  git -C "$ROOT" merge-base --is-ancestor "$BASE_SHA" "$TIP" || fail "$BASE is not an ancestor of the checked tip"
  [ "$(git -C "$ROOT" rev-parse "refs/heads/$BASE")" = "$BASE_SHA" ] || fail "$BASE moved while checking"
  [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" = "$BASE" ] || fail "primary checkout is not on $BASE"
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$BASE_SHA" ] || fail "primary checkout is not at $BASE"
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || fail "primary checkout is dirty"

  if [ "$CHECK_ONLY" = 1 ]; then
    emit "check passed: $NAME would land (nothing merged)"
    exit 0
  fi

  # ---- land it ----------------------------------------------------------------
  OLD_BASE="$BASE_SHA"
  mkdir -p "$COMMON/land-pending"
  printf '%s\n%s\n%s\n' "$TIP" "$OLD_BASE" "$TAG" >"$PENDING.tmp"
  mv "$PENDING.tmp" "$PENDING"
  MERGE_TRIED=1
  if ! git -C "$ROOT" merge --ff-only -q "$TIP"; then
    MERGE_TRIED=0
    rm -f "$PENDING"
    fail "fast-forward merge refused"
  fi
  LANDED=1
  finish_landing
}

main "$@"; exit $?
