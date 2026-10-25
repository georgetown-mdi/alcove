#!/usr/bin/env bash
# Run a host hand-off brief (.claude/orchestration/host-handoff-brief.md) in a
# new Claude Code session on the host. The owner's whole launch, from the
# checkout the dev container mounts at /workspace, is
#
#   bash .claude/scripts/host-handoff.sh scratch/handoffs/<YYYY-MM-DD>-<slug>.md
#
# It starts `claude` in that checkout on the model the brief's Model line names
# (DEFAULT_MODEL, Sonnet, when it names none) at the effort its Effort line names
# (DEFAULT_EFFORT, high, when it names none), with an opening prompt that points
# the session at the brief. The brief's Contract states the session's rules, its end
# state among them, so the prompt does not restate them. When the session ends,
# the last line says whether the result file the dev container waits on exists.
#
# --check reads the brief and prints what a launch would run, without starting
# a session: the dev container session runs it before handing a brief out.
#
# Written for the bash 3.2 macOS ships. Exit 0 the result file is written (with
# --check, the brief is ready to run); 1 a precondition failed or the session
# ended without writing it; 2 a usage error.

set -euo pipefail

DEFAULT_MODEL="claude-sonnet-5-5"
DEFAULT_EFFORT="high"

usage() {
  cat <<'EOF'
Usage: bash .claude/scripts/host-handoff.sh [--check] <brief>

Starts a Claude Code session in this checkout that runs a host hand-off brief
and ends when the brief's result file is written.

  <brief>      the brief: scratch/handoffs/<YYYY-MM-DD>-<slug>.md
  --check      read the brief and print the model, the effort, the result file
               and the command a launch runs, without starting a session
  -h, --help   print this help

The session runs on the model the brief's Model line names in backticks, or
claude-sonnet-5-5 when the brief has no Model line, at the effort the brief's
Effort line names in backticks (low, medium, high, xhigh or max), or high when
the brief has no Effort line. Run it on the machine with the checkout the dev
container mounts at /workspace.
EOF
}

say() { printf 'host-handoff: %s\n' "$*"; }
fail() {
  printf 'host-handoff: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'host-handoff: %s Run with --help for usage.\n' "$*" >&2
  exit 2
}

check_only=0
brief=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_only=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) usage_error "unknown option '$1'." ;;
    *)
      [ -z "$brief" ] || usage_error "one brief only; got '$brief' and '$1'."
      brief="$1"
      shift
      ;;
  esac
done

[ -n "$brief" ] || usage_error "name the brief to run, for example scratch/handoffs/2026-10-24-relay-check.md."
case "$brief" in
  *.result.md | *.result-*.md) usage_error "'$brief' is a result file; pass the brief it answers." ;;
  *.md) ;;
  *) usage_error "'$brief' is not a brief: a brief is a .md file in scratch/handoffs/." ;;
esac

repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
handoffs="$(cd "$repo/scratch/handoffs" 2>/dev/null && pwd -P)" ||
  fail "$repo has no scratch/handoffs/ directory; run this in the checkout the dev container mounts at /workspace."
[ -f "$brief" ] || fail "there is no brief at '$brief'; run this from $repo, or pass the brief's full path."
brief_dir="$(cd "$(dirname "$brief")" && pwd -P)"
[ "$brief_dir" = "$handoffs" ] ||
  usage_error "'$brief' is not in $repo/scratch/handoffs/, where the dev container reads hand-offs."
brief_rel="scratch/handoffs/$(basename "$brief")"

for heading in "## Contract" "## Host rules" "## Brief" "## Steps"; do
  grep -q "^$heading[[:space:]]*$" "$brief" ||
    fail "$brief_rel has no '$heading' section; a brief needs every section of the template in .claude/orchestration/host-handoff-brief.md."
done

# The first backticked word on a line the brief starts with "- <field>:", or
# nothing when the brief has no such line or the line has no backticked word.
backticked_field() {
  grep -m 1 "^- $1:" "$brief" | sed -n 's/^[^`]*`\([^`]*\)`.*/\1/p' || true
}

result="$(backticked_field "Result file")"
case "$result" in
  scratch/handoffs/*.result.md) ;;
  *) fail "$brief_rel names no result file: its Brief section needs a line '- Result file: \`scratch/handoffs/<YYYY-MM-DD>-<slug>.result.md\`'." ;;
esac
case "${result#scratch/handoffs/}" in
  */*) fail "$brief_rel names the result file '$result', which is not directly in scratch/handoffs/." ;;
esac
case "$result" in
  *"<"* | *">"*) fail "$brief_rel's result file '$result' still has a <...> placeholder; replace it with the brief's own name, '${brief_rel%.md}.result.md'." ;;
esac
[ "$result" = "${brief_rel%.md}.result.md" ] ||
  fail "$brief_rel's result file '$result' does not match the brief's name; write it as '${brief_rel%.md}.result.md'."

model="$DEFAULT_MODEL"
if grep -q '^- Model:' "$brief"; then
  model="$(backticked_field "Model")"
  printf '%s\n' "$model" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$' ||
    fail "$brief_rel's Model line names no model in backticks; write it as '- Model: \`$DEFAULT_MODEL\`'."
fi

effort="$DEFAULT_EFFORT"
if grep -q '^- Effort:' "$brief"; then
  effort="$(backticked_field "Effort")"
  case "$effort" in
    low | medium | high | xhigh | max) ;;
    *) fail "$brief_rel's Effort line names no effort level in backticks; write it as '- Effort: \`$DEFAULT_EFFORT\`', using low, medium, high, xhigh, or max." ;;
  esac
fi

prompt="Read $brief_rel and follow it. Its Contract and Host rules bind this session."

if [ -e "$repo/$result" ]; then
  fail "$result already exists, so the dev container would read an earlier run's result. Move it aside, for example to ${result%.result.md}.earlier.result.md, and rerun."
fi

if [ "$check_only" -eq 1 ]; then
  say "brief: $brief_rel"
  say "model: $model"
  say "effort: $effort"
  say "result file: $result"
  say "a launch runs, in $repo: claude --model $model --effort $effort '$prompt'"
  exit 0
fi

command -v claude >/dev/null 2>&1 ||
  fail "claude is not on PATH; run this on the machine where you run Claude Code."

cd "$repo"
claude --model "$model" --effort "$effort" "$prompt" || true

if [ -s "$result" ]; then
  say "done: $result is written, and the dev container reads it from there."
  exit 0
fi
say "the session ended without writing $result. Run this command again to start the hand-off over."
exit 1
