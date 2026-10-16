# Background-resume probe

The rule in `block-sleep-poll.mjs` and the one-shot wait bullet in `CLAUDE.md`, Spawns and reports, rests on one harness behavior: a subagent that starts a background command and ends its turn is resumed with the command's result. Re-run this probe after a Claude Code upgrade, and record the date and build in the hook's header.

Run it from a session on a host with `timeout` on PATH (the dev container has it). Spawn it with the Agent tool, `subagent_type: general-purpose`, `model: sonnet`, and this prompt:

```text
You are a probe of the Claude Code harness, not a task. Do exactly this and nothing else:

1. Call the Bash tool once with run_in_background set to true and this command: timeout 700 sh -c 'sleep 20; echo PROBE-DONE'
2. Immediately end your turn. Your whole message is the single line: WAITING
3. If you are later handed that background command's result, reply with the single line: RESUMED <the command's output>, and end.

Do not wait, poll, sleep, or read any file.
```

The behavior holds when the spawning session receives two notifications under one task id: the first with the result `WAITING` and a note that the agent stopped with background work of its own still running and the result may be interim, the second, about 20 seconds later, with `RESUMED PROBE-DONE`. A single `WAITING` notification and nothing after it means the harness no longer resumes the agent, and the one-shot wait bullet goes back to foreground-only.

To probe a `Workflow` `agent()` call, give its agent the same prompt.

# Background-stdin probe

The read-only allowance in `block-sleep-poll.mjs` lets a `cat`, `grep` or `tail` given no file follow a bounded command in a background run, which ends only because the run's stdin is empty. Re-run this probe after a Claude Code upgrade, and record the date and build here and in the hook's header.

From any session, call the Bash tool once with `run_in_background` set to true and this command:

```sh
timeout 10 sh -c 'ls -l /proc/self/fd/0; readlink /proc/$$/fd/0; [ -t 0 ] && echo tty || echo not-a-tty; wc -c'
```

The behavior holds when the output names `/dev/null` for fd 0 on both lines, prints `not-a-tty`, and `wc -c` prints `0` and the command exits 0 well inside its timeout. A pipe, a terminal, or a `wc -c` that runs until the timeout means a read-only command given no file can wait forever, and the allowance must require a file argument.

Last run 2026-10-12, Claude Code 2.1.296, Linux dev container: fd 0 was `/dev/null` on both lines, `not-a-tty`, `wc -c` printed `0`, exit 0.
