# Host hand-off brief template

A hand-off brief moves steps the dev container cannot take -- ones that need Docker, the open internet, a cloud account, another machine, or the owner's hands -- to a Claude Code session on the host. That session reads `CLAUDE.md` but not `.claude/orchestration/ruleset.md`, so everything it works under travels in the brief.

To write one: copy the Template below into `scratch/handoffs/<YYYY-MM-DD>-<slug>.md`, fill every `<...>`, and keep every section, writing "none" where one does not apply. Copy the Contract and the Host rules unchanged. Check it with `bash .claude/scripts/host-handoff.sh --check scratch/handoffs/<YYYY-MM-DD>-<slug>.md`, then give the owner only the launch line in its For the owner section. A worktree-isolated agent cannot write `scratch/`: it writes the brief under `/tmp` and its caller copies it in.

Filling it:

- Paths. `<repo>` is the host folder the dev container mounts at `/workspace`. Every path the host session uses is relative to `<repo>` or absolute on the host (`~/...`, `mktemp -d`); never `/workspace/...`, which exists only in the container. The orchestrator reads the same result file at `/workspace/scratch/handoffs/...`.
- Model. The host command, `.claude/scripts/host-handoff.sh`, starts the session on the model the Brief's Model line names in backticks. Keep `claude-opus-5-5` unless the run needs another, and say why.
- Build. A step needing built code or an image runs `.claude/scripts/host-build.sh` (its `--help` lists the options) rather than hand-listed `npm run build` commands: the CLI runs only once every workspace it depends on is built, in order, and the script holds that order. A branch the container has not pushed is fetched from the host checkout with `--from "$PWD"`, run from `<repo>`.
- Credentials. Name each account a step uses and its identity check, run first: `AWS_PROFILE=<profile> aws sts get-caller-identity` for AWS, `gh auth status` for GitHub, the tool's own check otherwise. Session credentials expire, so the check comes before the work rather than at its first failure.
- Live values. The brief asserts no state that can change before the run -- a token's permissions, a deploy run in flight, a branch's distance from `main`, a unit's state on the relay host. Step 0 reads each with a command and records it, the value the steps assume being that line's Expected, so a difference stops the run before its first change. A GitHub token's scopes are in `gh auth status`; runs in flight in `gh run list --workflow <file> --branch <branch> --limit 3 --json databaseId,status,headSha`; a branch's distance under Branch installs. A permission no read shows -- a Cloudflare token's, for which `/user/tokens/verify` says only `active` -- is written as the refusal the step would get and how the step resumes once the owner fixes it.
- Reused steps. A brief that copies steps from an earlier brief first reads that run's result file: its Harness repairs and Frictions observed name the commands it corrected and the assumptions it found wrong, and the copy takes the corrected form. The 2026-10-15 TURN client-address run reused a Firefox step whose earlier result had already recorded that the page it described has no such section.
- Platform. Name the `linux/<arch>` every image is built and run for, and put `--platform` on every `docker build` and `docker run`: the owner's shell has exported `DOCKER_DEFAULT_PLATFORM=linux/amd64` on an arm64 Mac.
- Long commands. Write each as the bounded form the Host rules give, with the timeout sized to the step.
- Times. Every time the brief shows the owner -- its "For the owner" section and any message the host session sends him -- is in US Eastern time, never UTC. UTC stays only in commands and machine settings.
- Relay host. A brief that acts on the relay host holds its maintenance lock for the whole run, so no daily job runs beside it (`infra/relay/README.md`, The daily schedule). Its first host step takes the lock through SSM in a transient unit bounded by the run's total timeout in seconds, waiting up to 10 minutes for a running job, and checks it is held (`sleep` starts only once `flock` has the lock). The lock lives in `/run/alcove-maintenance`, a root-only directory the install scripts create from `infra/tmpfiles.d/alcove-maintenance.conf`; on a host the install has not reached, the step first runs `install -d -m 700 -o root -g root /run/alcove-maintenance`:
  `systemd-run --unit=alcove-handoff-lock --collect -p RuntimeMaxSec=<seconds> /usr/bin/flock -w 600 /run/alcove-maintenance/lock /usr/bin/sleep infinity`
  `timeout 610 sh -c 'until pgrep -x -P "$(systemctl show -p MainPID --value alcove-handoff-lock.service)" sleep; do sleep 5; done' >/dev/null; echo held=$?`
  Expected: `held=0`. Anything else: release it, write the result file (nothing changed) and stop. The last host step, and the Recovery, release it: `systemctl stop alcove-handoff-lock.service`. While it is held, a daily job's unit started by hand waits on it and then fails, so run that job's command directly instead.
- Serving units. A step that stops or restarts a serving unit on the relay host -- the relay, its 443 front, the broker, the broker's TLS front, coturn -- names the units that stop with it and starts each again (`infra/relay/README.md`, OS updates, and `infra/broker/README.md`, How a change reaches the units, name them), then ends with a health gate: `systemctl is-active --quiet <unit>` for each named unit, one unit per check, and each public port they serve answering, as `infra/broker/install.sh` checks the broker and its front. A failed gate runs the Recovery before anything else. A broker stop and start on 2026-10-19 left the broker's TLS front stopped, and port 8443 down for up to about 80 s.
- Branch installs. A step that installs a branch on the relay host states the branch's distance from `main`, read in Step 0: `gh api repos/georgetown-mdi/alcove/compare/main...<sha> --jq '[.status, .ahead_by, .behind_by] | @tsv'`, or, for a branch only the host checkout has, `git rev-list --left-right --count origin/main...<sha>` there, which prints the behind count first. An install from a branch behind `main` undoes on that host every `main` commit the branch lacks: the brief names those commits and why the install is still wanted, or the step stops when the branch is behind.
- Workflow runs. A step that dispatches a workflow waits on a run id that did not exist before the dispatch: right after `gh workflow run`, `gh run list --limit 1` still returns the previous, completed run, the likely cause of the demo-site hand-off's early wait exit. Record the newest run's id first (`gh run list --workflow <file> --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId'`), dispatch, then wait for another id: `timeout 300 sh -c 'until gh run list --workflow <file> --branch <branch> --limit 1 --json databaseId --jq ".[0].databaseId" | grep -vxq <earlier id>; do sleep 5; done'`. Wait on the new id with `timeout <seconds> gh run watch <id> --exit-status > <log> 2>&1; echo exit=$?`, which returns once its `status` is `completed`, and only then read its `conclusion`: before that it is empty, or `null` from a jq path that finds no run, and neither is a result -- the 2026-10-22 rename hand-off's wait took a `null` for one. A re-run keeps its run id, so the wait on it first waits for the run's `attempt` (`gh run view <id> --json attempt --jq .attempt`) to go up.
- Build variables. A step that sets a repository variable a build reads, right after a merge, first waits for the deploy run that merge started to finish -- it built before the variable existed, and a run in progress cannot be re-run -- then re-runs it with `gh run rerun <id>` and waits on the re-run as Workflow runs says. The 2026-10-22 WebSocket relay variable hand-off had to repair its brief this way.
- WebSocket probes. A probe of a WebSocket upgrade is `curl -sS -m 5 -D - -o /dev/null --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' <url>; echo exit=$?`, read from the status line it dumps (`HTTP/1.1 101 Switching Protocols`), exit 28 expected: after the `101` the relay keeps the socket open and curl never returns, so a `-w '%{http_code}'` form prints nothing before its timeout.
- Clone edits. A step that changes a file in a clone (`~/alcove-<slug>`) gives the change as a command -- `perl -pi -e 's/<old>/<new>/' <file>`, the same on macOS and Linux, where `sed -i` differs -- followed by `git -C <clone> diff` to record it. The host session's `block-primary-checkout-writes` hook refuses the Edit and Write tools in any checkout but the one it started in, which stopped the demo-site hand-off's `prevent_destroy` edit.
- Browser capture. A step that reads a browser's WebRTC connections uses `.claude/scripts/webrtc-capture.mjs` (its `--help` gives the owner's steps) and describes no browser screen: `chrome://webrtc-internals` keeps no closed connection, and three 2026-10 runs found a page's screens other than their brief described. The owner pastes the code `snippet` prints into the page's console before starting the exchange; the page downloads a capture file when its connections end, and `read-capture` summarizes it -- servers, a timeline of states, candidates and errors, and the selected pair. For Firefox's own connection log, the owner saves about:webrtc with its sections expanded and `read-about-webrtc` reads the saved page.
- Browser UDP block. Chrome 155's UDP-block flag did not block UDP in the 2026-10-15 run, so a step that needs a browser without UDP applies a firewall rule or a container block, or gathers relay-only on one browser (`snippet --relay-only`). A step that applies a real block also records where the relay-only connection's time goes (allocation, DTLS, data channel), which the capture's timeline shows: the run measured 12 s relay-only against 1.7 s direct.
- SSM waits. A wait loop that polls a host over SSM bounds each call (`timeout <seconds>` on the `aws ssm` command): the 2026-10-15 reboot script's SSM check blocked for the whole outage, so it measured no outage and ran to its 840 s cap.
- Relay test key. A brief that needs a relay test key enrolls it at the project registrar over HTTPS without a token (`POST /exchanges/<id>` with `"maxAgeDays": null`; the row lapses after 70 minutes) and stays under the limits for one client address: 20 enrollments per 600 s and 10 unlapsed rows (`infra/relay/README.md`, The registrar, Enrollment without a token). The test id does not start with `alcove-verify-`: that prefix is reserved and a token-free enrollment of it is refused 400. It never registers a test key through SSM: piping the key into an interactive SSM session fails with EOF.
- Steps. Each step gives the exact command, then `Expected:` (what output means it worked) and `Record:` (the values the result file needs). A step the owner performs is one action, with the exact names and values and what he sees when it worked.

## Template

````markdown
# Host hand-off: <what this settles, in a few words>

Agent-written, a proposal until the owner ratifies it. Read `CLAUDE.md` first; your rules are in the Contract and Host rules below.

## For the owner

1. On <the Mac | ...>, in your alcove checkout -- the folder the dev container mounts at `/workspace` -- run `bash .claude/scripts/host-handoff.sh scratch/handoffs/<YYYY-MM-DD>-<slug>.md`.
2. <What it will ask of you, step by step, or "It needs nothing from you.">
3. It is done when it says `Hand-off done`; close it with /exit. The dev container session reads the result itself.

## Contract

- Execute only. Carry out the steps below as written; do not re-plan, review, or widen them. Repair a defect in the brief's own harness -- a script, path, flag, or fixture -- yourself, record what you changed in the result file, and continue. Stop and write back only on a product defect or a result outside the brief's question -- never to ask the owner.
- No report. Do not summarize the work in the conversation.
- Write the result file named below: for each step, what ran and its outcome, and any value the orchestrator needs. The orchestrator reads that file; the owner does not carry context back.
- End state. However the run ends -- its last step, a stop on a product defect, a failed check -- run the Clean up step, then write the result file in one write, as the last action: the orchestrator is waiting on that file and reads it as soon as it appears. Then send the one line `Hand-off done: <result file path>` and nothing more.
- When the owner must act, give one step per message and wait for him to finish it before the next.
- Never use the question tool (AskUserQuestion). Anything the owner must answer goes in prose, one step at a time.

## Host rules

- Paths. Run from the alcove checkout (`<repo>` below). Every path here is relative to it or absolute on this machine; a `/workspace/...` path is the dev container's view of `<repo>` -- read it as `<repo>/...`.
- Git. Never run `git worktree`, `git checkout`, `git switch` or `git stash` in `<repo>`: it shares `.git` with the dev container, and a host-side worktree command prunes the container's worktree entries. Build from a fresh clone with `.claude/scripts/host-build.sh`.
- Shell. Your Bash tool runs zsh: an unquoted `$var` does not split into words and an unmatched glob is an error. Put any command longer than one line in a file starting `#!/usr/bin/env bash` and run it with `bash <file>`; quote every variable. Shell variables do not survive between tool calls, so each command sets what it uses.
- Deletions. Name each path you delete literally, never as a command's result: no variable, `$(...)`, or path read from a file, so the owner can read what he approves: `rm -rf ~/alcove-<slug>`, not `rm -rf "$DIR"`. A git worktree in a clone of your own goes by `git worktree remove <literal path>`; in `<repo>`, see Git.
- Clones. Change a file in a clone with a command, never the Edit or Write tool, which the repository's checkout-write hook refuses outside `<repo>`; record the change with `git -C <clone> diff`.
- Long commands. In a background command every command that runs opens with `timeout <seconds>`, apart from a leading `cd <dir>` and a trailing or piped `echo` or read-only `tail`/`grep` that does not follow a file, with no lone `&`, heredoc, `$(...)` or backtick outside single quotes: `timeout 900 <command> > <log> 2>&1; echo exit=$?`. A wait loop sits inside `timeout <seconds> sh -c '...'`. The repository's hook refuses other forms (`.claude/hooks/block-sleep-poll.mjs`). macOS has `timeout` only from Homebrew coreutils, named `gtimeout`; with neither, run the command in the foreground or start a container with `docker run -d` and wait on it with `docker wait`.
- Credentials. Run each identity check in the Brief before the first step that uses that account. When one fails, ask the owner in one message to refresh that profile's credentials, naming it; re-run the check once he says it is done. Select an AWS profile with `AWS_PROFILE=<profile>` on the command, not a `--profile` kept in a variable.
- Docker. Pass `--platform <platform from the Brief>` on every `docker build` and `docker run`, whatever `DOCKER_DEFAULT_PLATFORM` says.

## Brief

- Goal: <one sentence>
- Host: <where the steps run. If that is not the machine holding `<repo>`, where artifacts land there and the step that copies them back>
- Result file: `scratch/handoffs/<YYYY-MM-DD>-<slug>.result.md`; artifacts in `scratch/handoffs/<YYYY-MM-DD>-<slug>-artifacts/`
- Model: `claude-opus-5-5`<, or the model the run needs, and why>
- Commit: <the ref to build, and the sha expected: "this sha or later" for a moving branch>
- Build: `timeout <seconds> bash .claude/scripts/host-build.sh --ref <ref> --dir ~/alcove-<slug> <--image FILE=TAG ...> > "<artifacts>/build.log" 2>&1`, or "none"
- Credentials: <account, profile and the identity-check command for each, or "none">
- Platform: <`linux/arm64` | `linux/amd64`, or "none" when no image is built or run>
- Context: <facts the steps need, each with the repository file or command that states it>

## Steps

**Step 0. Setup.** `mkdir -p scratch/handoffs/<YYYY-MM-DD>-<slug>-artifacts`. Record `date -u`, `uname -m`, `command -v timeout gtimeout docker`, and `echo "DOCKER_DEFAULT_PLATFORM=$DOCKER_DEFAULT_PLATFORM"`. Run each identity check in Credentials and record the account it names. <Read and record each live value the steps rely on (Filling it, Live values), each with the value expected, or "No live values">. Run the Build command; the log's last line names the commit built and the clone directory.
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
