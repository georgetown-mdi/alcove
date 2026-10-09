#!/usr/bin/env bash
# Build what a host hand-off needs, on the host, from a fresh clone: the npm
# workspaces the CLI runs from (core, cli-contract, cli, in that order) and, on
# request, Docker images. A host session runs it as a hand-off brief's build
# step (.claude/orchestration/host-handoff-brief.md):
#
#   bash .claude/scripts/host-build.sh --ref staging --dir "$B" > "$A/build.log" 2>&1
#
# Why a fresh clone rather than the host's checkout: the host checkout shares
# .git with the dev container, so a host-side `git worktree` operation prunes
# the container's worktree entries, and a checkout there moves the container's
# branch. A fresh clone also carries no dist/ or .rollup.cache left by a build
# of another revision, which can fail a rollup build.
#
# Written for the bash 3.2 macOS ships: no associative arrays, no mapfile, and
# no array expansion that `set -u` refuses when empty.
#
# Exit 0 built; 1 a precondition or a build step failed; 2 a usage error.

set -euo pipefail

DEFAULT_FROM="https://github.com/georgetown-mdi/alcove"

# The workspaces `node apps/cli/dist/index.js` needs built, dependencies
# first. host-build.test.mjs fails when apps/cli gains a workspace dependency
# this list does not build ahead of it.
WORKSPACES="packages/core packages/cli-contract apps/cli"

usage() {
  cat <<'EOF'
Usage: bash .claude/scripts/host-build.sh [options]

Clones a commit into a new directory and builds it there, never touching the
checkout this script was run from.

  --ref REF          branch, tag or full commit sha to build (default: staging)
  --from SOURCE      repository to fetch REF from: a URL, or the path of the
                     host checkout for a branch that was never pushed
                     (default: https://github.com/georgetown-mdi/alcove)
  --dir DIR          directory to clone into; must not exist or be empty
                     (default: a new directory under mktemp -d)
  --image FILE=TAG   also build an image from Dockerfile FILE, tagged TAG, with
                     docker buildx build --load; repeatable. Needs Docker
  --platform OS/ARCH platform for every image (default: this machine's, so an
                     exported DOCKER_DEFAULT_PLATFORM does not decide it)
  --skip-npm         build only the images, not the npm workspaces
  -h, --help         print this help

The last line names the commit built and the directory it was built in.
EOF
}

say() { printf 'host-build: %s\n' "$*"; }
fail() {
  printf 'host-build: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'host-build: %s Run with --help for usage.\n' "$*" >&2
  exit 2
}

ref="staging"
from="$DEFAULT_FROM"
dir=""
images=""
platform=""
skip_npm=0

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
    --from)
      need_value "$1" "$#"
      from="$2"
      shift 2
      ;;
    --dir)
      need_value "$1" "$#"
      dir="$2"
      shift 2
      ;;
    --image)
      need_value "$1" "$#"
      case "$2" in
        ?*=?*) ;;
        *) usage_error "--image takes FILE=TAG, for example Dockerfile=alcove:probe; got '$2'." ;;
      esac
      images="$images$2
"
      shift 2
      ;;
    --platform)
      need_value "$1" "$#"
      case "$2" in
        linux/?*) platform="$2" ;;
        *) usage_error "--platform takes linux/ARCH, for example linux/arm64; got '$2'." ;;
      esac
      shift 2
      ;;
    --skip-npm)
      skip_npm=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument '$1'." ;;
  esac
done

case "$ref" in
  "" | -*) usage_error "--ref takes a branch, tag or commit sha; got '$ref'." ;;
esac
if [ "$skip_npm" -eq 1 ] && [ -z "$images" ]; then
  usage_error "--skip-npm with no --image leaves nothing to build."
fi

# Every precondition is checked before the clone, so a host missing a tool
# fails in one line rather than after minutes of fetching and installing.
command -v git >/dev/null 2>&1 || fail "git is not on PATH; install git and rerun."
if [ "$skip_npm" -eq 0 ]; then
  command -v node >/dev/null 2>&1 || fail "node is not on PATH; install Node.js and rerun."
  command -v npm >/dev/null 2>&1 || fail "npm is not on PATH; install Node.js and rerun."
fi
if [ -n "$images" ]; then
  command -v docker >/dev/null 2>&1 ||
    fail "docker is not on PATH; --image needs a host with Docker (drop --image to build the npm workspaces only)."
  docker info >/dev/null 2>&1 ||
    fail "the Docker daemon is not answering (docker info failed); start Docker and rerun."
  if [ -z "$platform" ]; then
    case "$(uname -m)" in
      arm64 | aarch64) platform="linux/arm64" ;;
      x86_64 | amd64) platform="linux/amd64" ;;
      *) fail "cannot tell this machine's platform from uname -m '$(uname -m)'; pass --platform." ;;
    esac
  fi
  if [ -n "${DOCKER_DEFAULT_PLATFORM:-}" ] && [ "$DOCKER_DEFAULT_PLATFORM" != "$platform" ]; then
    say "DOCKER_DEFAULT_PLATFORM=$DOCKER_DEFAULT_PLATFORM is set in this shell; images build for $platform. Pass --platform $platform to every docker run of them too."
  fi
fi

if [ -z "$dir" ]; then
  dir="$(mktemp -d)/alcove"
elif [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
  fail "$dir already exists and is not empty; pass a new --dir."
fi

say "cloning $ref from $from into $dir"
git init -q "$dir"
git -C "$dir" fetch -q --depth 1 "$from" "$ref" ||
  fail "could not fetch $ref from $from; a branch only the dev container holds needs --from <host checkout path>."
git -C "$dir" checkout -q --detach FETCH_HEAD
sha="$(git -C "$dir" rev-parse HEAD)"
say "commit $sha"

if [ "$skip_npm" -eq 0 ]; then
  floor="$(node -e '
    const range = require(process.argv[1]).engines?.node ?? "";
    const match = /^>=\s*(\d+)/.exec(range);
    process.stdout.write(match ? match[1] : "");
  ' "$dir/package.json")"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ -n "$floor" ] && [ "$major" -lt "$floor" ]; then
    fail "node $(node --version) is older than the Node $floor this commit's package.json requires; install Node $floor or later and rerun."
  fi
  say "npm ci"
  (cd "$dir" && npm ci --no-audit --no-fund) || fail "npm ci failed in $dir."
  for workspace in $WORKSPACES; do
    say "building $workspace"
    (cd "$dir" && npm run build -w "$workspace") || fail "building $workspace failed in $dir."
  done
fi

if [ -n "$images" ]; then
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    file="${spec%%=*}"
    tag="${spec#*=}"
    [ -f "$dir/$file" ] || fail "commit $sha has no $file."
    say "building image $tag from $file for $platform"
    (cd "$dir" && docker buildx build -f "$file" --platform "$platform" --progress=plain -t "$tag" --load .) ||
      fail "building image $tag from $file failed."
  done <<EOF
$images
EOF
fi

say "done: commit $sha built in $dir"
