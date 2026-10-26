#!/usr/bin/env bash
# Check, on the host, that the branch a hand-off brief names still carries the
# commit the brief was written for, before a step builds or installs it. A host
# session runs it in Step 0 of a hand-off brief
# (.claude/orchestration/host-handoff-brief.md), from the checkout the dev
# container mounts at /workspace:
#
#   bash .claude/scripts/host-commit-check.sh --ref <branch> --commit <sha>
#
# It accepts the branch's tip when it is the briefed commit, a descendant of
# it, or a rebase of the same change: the commits the briefed commit adds over
# its fork point and the same number of commits at the tip have one
# `git patch-id --verbatim`, which counts whitespace. Where git has no
# `--verbatim`, only the briefed commit or a descendant is accepted. When the
# branch is gone from the source, merged and deleted, it reads the merged ref
# (main by default) instead and accepts it when it holds the briefed commit, or
# when every line the briefed change made is at its tip: the change applies in
# reverse to its tree. A --ref naming the merged ref gets the branch check
# alone. Anything else is refused.
#
# The briefed commit is read from this checkout, which shares its object
# database with the dev container; the refs are fetched into a temporary
# repository, so the checkout is only read.
#
# Written for the bash 3.2 macOS ships. Exit 0 accepted, the line before the
# last naming REF and TIP; 1 refused or a precondition failed; 2 a usage error.

set -euo pipefail

DEFAULT_FROM="https://github.com/georgetown-mdi/alcove"
DEFAULT_MERGED_REF="main"

usage() {
  cat <<'EOF'
Usage: bash .claude/scripts/host-commit-check.sh --ref BRANCH --commit SHA [options]

Checks that BRANCH still carries the commit a hand-off brief names, and prints
the ref and commit to build. Changes nothing in this checkout.

  --ref BRANCH        the branch the brief names
  --commit SHA        the full sha the brief was written for
  --from SOURCE       repository to read the branch from: a URL, or the path of
                      the host checkout for a branch that was never pushed
                      (default: https://github.com/georgetown-mdi/alcove)
  --merged-ref REF    branch to read, from the same source, once BRANCH is gone
                      from it (default: main)
  -h, --help          print this help

BRANCH is accepted when its tip is SHA, a descendant of SHA, or a rebase of
the same change (equal git patch-id --verbatim, where this git has it). When
BRANCH is not on the source, the merged ref is accepted when it holds SHA or
every line SHA's change made. The second-to-last line is REF=<ref> TIP=<sha>;
build TIP.
EOF
}

say() { printf 'host-commit-check: %s\n' "$*"; }
fail() {
  printf 'host-commit-check: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'host-commit-check: %s Run with --help for usage.\n' "$*" >&2
  exit 2
}

ref=""
commit=""
from="$DEFAULT_FROM"
merged_ref="$DEFAULT_MERGED_REF"

need_value() {
  if [ "$2" -lt 2 ]; then usage_error "$1 needs a value."; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      need_value "$1" "$#"
      ref="$2"
      shift 2
      ;;
    --commit)
      need_value "$1" "$#"
      commit="$2"
      shift 2
      ;;
    --from)
      need_value "$1" "$#"
      from="$2"
      shift 2
      ;;
    --merged-ref)
      need_value "$1" "$#"
      merged_ref="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument '$1'." ;;
  esac
done

valid_branch() {
  case "$1" in
    "" | -* | refs/* | *" "*) return 1 ;;
  esac
  git check-ref-format --branch "$1" >/dev/null 2>&1
}

[ -n "$ref" ] || usage_error "name the branch the brief names with --ref."
valid_branch "$ref" || usage_error "--ref takes a branch name, for example filedrop-poll-pace; got '$ref'."
[ -n "$commit" ] || usage_error "name the commit the brief was written for with --commit."
printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$' ||
  usage_error "--commit takes a full 40-character sha; got '$commit'."
valid_branch "$merged_ref" || usage_error "--merged-ref takes a branch name, for example main; got '$merged_ref'."

# Resolved before any cd, which would read a relative path against another
# directory.
if [ -d "$from" ]; then
  from="$(cd "$from" && pwd -P)"
fi

command -v git >/dev/null 2>&1 || fail "git is not on PATH; install git and rerun."

repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
common="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)" ||
  fail "$repo is not a git checkout; run the copy of this script in the checkout the dev container mounts at /workspace."
objects="$(cd "$repo" && cd "$common" && pwd -P)/objects"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git init -q --bare "$scratch/git"
printf '%s\n' "$objects" >"$scratch/git/objects/info/alternates"
g() { git --git-dir="$scratch/git" "$@"; }

g cat-file -e "$commit^{commit}" 2>/dev/null ||
  fail "the briefed commit $commit is not in $repo. Run this in the checkout the dev container mounts at /workspace, which holds every commit the dev container made."

# The tip of a branch at the source, or nothing when the source has no such
# branch. Fails when the source cannot be read at all.
remote_tip() {
  local heads
  heads="$(git ls-remote "$from" "refs/heads/$1")" ||
    fail "could not read the branches of $from; check the network, or the path given to --from."
  printf '%s\n' "$heads" | awk -v want="refs/heads/$1" '$2 == want { print $1 }'
}

fetch_ref() {
  g fetch -q "$from" "+refs/heads/$1:refs/check/$1" ||
    fail "could not fetch $1 from $from."
  g rev-parse "refs/check/$1"
}

# The patch id of the change from one commit to another, or nothing for an
# empty change.
patch_id() {
  g diff-tree -p "$1" "$2" | g patch-id --verbatim | cut -d' ' -f1
}

accept() {
  echo "REF=$1 TIP=$2"
  say "accepted $1 at $2: $3."
  exit 0
}

tip="$(remote_tip "$ref")"
if [ -n "$tip" ]; then
  tip="$(fetch_ref "$ref")"
  say "$ref is at $tip on $from"
  if [ "$tip" = "$commit" ]; then
    accept "$ref" "$tip" "the briefed commit"
  fi
  if g merge-base --is-ancestor "$commit" "$tip"; then
    accept "$ref" "$tip" "a descendant of the briefed commit $commit"
  fi
  fork="$(g merge-base "$commit" "$tip")" ||
    fail "$ref at $tip shares no history with the briefed commit $commit; refusing it."
  printf '' | g patch-id --verbatim >/dev/null 2>&1 ||
    fail "$ref at $tip is not the briefed commit $commit or a descendant of it, and this git has no 'git patch-id --verbatim' to tell whether it is a rebase of the same change, whitespace included. Refusing it; update git and rerun, or the brief needs the new commit."
  count="$(g rev-list --count "$tip..$commit")"
  briefed_id="$(patch_id "$fork" "$commit")"
  tip_id=""
  if g rev-parse -q --verify "$tip~$count^{commit}" >/dev/null; then
    tip_id="$(patch_id "$tip~$count" "$tip")"
  fi
  if [ -n "$briefed_id" ] && [ "$briefed_id" = "$tip_id" ]; then
    accept "$ref" "$tip" "a rebase of the briefed commit $commit, the same change (patch id $briefed_id)"
  fi
  fail "$ref at $tip is not the briefed commit $commit, a descendant of it, or a rebase of the same change: the briefed commit's $count commit(s) over $fork have patch id ${briefed_id:-none}, and the branch's last $count have ${tip_id:-none}. Refusing it; the brief needs the new commit."
fi

[ "$ref" != "$merged_ref" ] || fail "$ref is not on $from; refusing to guess a ref."
say "$ref is not on $from, so it has merged or been deleted; reading $merged_ref instead"
merged_tip="$(remote_tip "$merged_ref")"
[ -n "$merged_tip" ] || fail "neither $ref nor $merged_ref is on $from; refusing to guess a ref."
merged_tip="$(fetch_ref "$merged_ref")"
say "$merged_ref is at $merged_tip on $from"
if g merge-base --is-ancestor "$commit" "$merged_tip"; then
  accept "$merged_ref" "$merged_tip" "it holds the briefed commit $commit"
fi
fork="$(g merge-base "$commit" "$merged_tip")" ||
  fail "$merged_ref at $merged_tip shares no history with the briefed commit $commit; refusing it."
if g diff-tree --quiet "$fork" "$commit"; then
  fail "the briefed commit $commit changes nothing over $fork; refusing it."
fi
# A squash merge also holds the branch's later commits, so no commit on the
# merged ref need match the briefed change; its lines at the tip are checked
# instead, against an index read from the tip.
g diff-tree -p --binary "$fork" "$commit" >"$scratch/change.patch"
GIT_INDEX_FILE="$scratch/index" git --git-dir="$scratch/git" read-tree "$merged_tip"
change_applies() {
  GIT_INDEX_FILE="$scratch/index" git --git-dir="$scratch/git" apply --check --cached "$@" \
    "$scratch/change.patch" >/dev/null 2>&1
}
if change_applies -R; then
  accept "$merged_ref" "$merged_tip" "it holds every line the briefed change $fork..$commit made"
fi
if change_applies; then
  fail "$merged_ref at $merged_tip holds none of the lines the briefed change $fork..$commit made. If $ref has not reached $merged_ref yet, a hand-off that needs it on $merged_ref waits for a session after it does."
fi
fail "$merged_ref at $merged_tip holds neither the briefed change $fork..$commit as briefed nor the lines it replaced: later commits changed some of the same lines or the lines around them. Refusing it; re-brief the hand-off at a $merged_ref commit."
