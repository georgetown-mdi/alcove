# Host hand-off brief template

A hand-off brief moves steps the dev container cannot take -- ones that need Docker, the open internet, a cloud account, another machine, or the owner's hands -- to a Claude Code session on the host. That session reads `CLAUDE.md` but not `.claude/orchestration/ruleset.md`, so everything it works under travels in the brief.

To write one: copy the Template below into `scratch/handoffs/<YYYY-MM-DD>-<slug>.md`, fill every `<...>`, and keep every section, writing "none" where one does not apply. Copy the Contract and the Host rules unchanged. Give the owner only the file's path. A worktree-isolated agent cannot write `scratch/`: it writes the brief under `/tmp` and its caller copies it in.

Filling it:

- Paths. `<repo>` is the host folder the dev container mounts at `/workspace`. Every path the host session uses is relative to `<repo>` or absolute on the host (`~/...`, `mktemp -d`); never `/workspace/...`, which exists only in the container. The orchestrator reads the same result file at `/workspace/scratch/handoffs/...`.
- Build. A step needing built code or an image runs `.claude/scripts/host-build.sh` (its `--help` lists the options) rather than hand-listed `npm run build` commands: the CLI runs only once every workspace it depends on is built, in order, and the script holds that order. A branch the container has not pushed is fetched from the host checkout with `--from "$PWD"`, run from `<repo>`.
- Credentials. Name each account a step uses and its identity check, run first: `AWS_PROFILE=<profile> aws sts get-caller-identity` for AWS, `gh auth status` for GitHub, the tool's own check otherwise. Session credentials expire, so the check comes before the work rather than at its first failure.
- Platform. Name the `linux/<arch>` every image is built and run for, and put `--platform` on every `docker build` and `docker run`: the owner's shell has exported `DOCKER_DEFAULT_PLATFORM=linux/amd64` on an arm64 Mac.
- Long commands. Write each as the bounded form the Host rules give, with the timeout sized to the step.
- Steps. Each step gives the exact command, then `Expected:` (what output means it worked) and `Record:` (the values the result file needs). A step the owner performs is one action, with the exact names and values and what he sees when it worked.

## Template

````markdown
# Host hand-off: <what this settles, in a few words>

Agent-written, a proposal until the owner ratifies it. Read `CLAUDE.md` first; your rules are in the Contract and Host rules below.

## For the owner

1. On <the Mac | the bench box | ...>, start a Claude Code session in your alcove checkout -- the folder the dev container mounts at `/workspace`<, with web access when a step needs it>.
2. Tell it: `Read scratch/handoffs/<YYYY-MM-DD>-<slug>.md and follow it.`
3. <What it will ask of you, step by step, or "It needs nothing from you.">. It is done when `scratch/handoffs/<YYYY-MM-DD>-<slug>.result.md` exists.

## Contract

- Execute only. Carry out the steps below as written; do not re-plan, review, or widen them. Repair a defect in the brief's own harness -- a script, path, flag, or fixture -- yourself, record what you changed in the result file, and continue. Stop and write back only on a product defect or a result outside the brief's question -- never to ask the owner.
- No report. Do not summarize the work in the conversation.
- Write the result file named below: for each step, what ran and its outcome, and any value the orchestrator needs. The orchestrator reads that file; the owner does not carry context back.
- When the owner must act, give one step per message and wait for him to finish it before the next.
- Never use the question tool (AskUserQuestion). Anything the owner must answer goes in prose, one step at a time.

## Host rules

- Paths. Run from the alcove checkout (`<repo>` below). Every path here is relative to it or absolute on this machine; a `/workspace/...` path is the dev container's view of `<repo>` -- read it as `<repo>/...`.
- Git. Never run `git worktree`, `git checkout`, `git switch` or `git stash` in `<repo>`: it shares `.git` with the dev container, and a host-side worktree command prunes the container's worktree entries. Build from a fresh clone with `.claude/scripts/host-build.sh`.
- Shell. Your Bash tool runs zsh: an unquoted `$var` does not split into words and an unmatched glob is an error. Put any command longer than one line in a file starting `#!/usr/bin/env bash` and run it with `bash <file>`; quote every variable. Shell variables do not survive between tool calls, so each command sets what it uses.
- Long commands. A background command must be exactly `timeout <seconds> <command>`, optionally with redirections, and nothing after it (no `;`, `&&`, `||` or `&`); read its exit and output in the next call. A wait loop sits inside `timeout <seconds> sh -c '...'`. The repository's hook refuses other forms (`.claude/hooks/block-sleep-poll.mjs`). macOS has `timeout` only from Homebrew coreutils, named `gtimeout`; with neither, run the command in the foreground or start a container with `docker run -d` and wait on it with `docker wait`.
- Credentials. Run each identity check in the Brief before the first step that uses that account. When one fails, ask the owner in one message to refresh that profile's credentials, naming it; re-run the check once he says it is done. Select an AWS profile with `AWS_PROFILE=<profile>` on the command, not a `--profile` kept in a variable.
- Docker. Pass `--platform <platform from the Brief>` on every `docker build` and `docker run`, whatever `DOCKER_DEFAULT_PLATFORM` says.

## Brief

- Goal: <one sentence>
- Host: <where the steps run. If that is not the machine holding `<repo>`, where artifacts land there and the step that copies them back>
- Result file: `scratch/handoffs/<YYYY-MM-DD>-<slug>.result.md`; artifacts in `scratch/handoffs/<YYYY-MM-DD>-<slug>-artifacts/`
- Commit: <the ref to build, and the sha expected: "this sha or later" for a moving branch>
- Build: `timeout <seconds> bash .claude/scripts/host-build.sh --ref <ref> --dir ~/alcove-<slug> <--image FILE=TAG ...> > "<artifacts>/build.log" 2>&1`, or "none"
- Credentials: <account, profile and the identity-check command for each, or "none">
- Platform: <`linux/arm64` | `linux/amd64`, or "none" when no image is built or run>
- Context: <facts the steps need, each with the repository file or command that states it>

## Steps

**Step 0. Setup.** `mkdir -p scratch/handoffs/<YYYY-MM-DD>-<slug>-artifacts`. Record `date -u`, `uname -m`, `command -v timeout gtimeout docker`, and `echo "DOCKER_DEFAULT_PLATFORM=$DOCKER_DEFAULT_PLATFORM"`. Run each identity check in Credentials and record the account it names. Run the Build command; the log's last line names the commit built and the clone directory.
Expected: <...>. Record: <...>.

**Step 1. <name>.** <exact command>
Expected: <...>. Record: <...>.

<... one block per step ...>

**Step N. Clean up.** <containers and temporary files to remove, and `rm -rf ~/alcove-<slug>`; what to leave>

**Step N+1. Write the result file** with exactly these sections:

1. `## Run`: date, host and `uname -m`, the commit host-build.sh printed, each credential check's account.
2. <one section per step or question, naming the values it holds>
3. `## Harness repairs`: each change made to a command above, and why; "none" if none.
4. `## Frictions observed`: anything slow, surprising or manual, one line each; "none" if none.

Done when: <the condition the orchestrator checks, for example "every section present and step 3's exit is 0">.
````
