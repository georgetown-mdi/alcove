# PostToolUse-on-Workflow probe

`record-review-round-lock.mjs` writes the in-flight round lock from a PostToolUse hook on the `Workflow` tool, which rests on one harness behavior: PostToolUse fires for a `Workflow` call once the harness has run it, including an async launch that returns before the workflow finishes, and hands the hook the call's own `tool_input`. Re-run this probe after a Claude Code upgrade, and record the date and build here and in the hook's header.

Run it from an orchestrating session in the dev container.

1. Add a user-level hook to `~/.claude/settings.json`, outside the repository so no branch carries it: under `hooks.PostToolUse`, an entry with `"matcher": "Workflow"` whose command copies its stdin to a file, `cat > /tmp/posttooluse-workflow.json`.
2. Start a new session so the setting loads, and call the `Workflow` tool once with this inline script, which spawns no agent:

   ```js
   export const meta = { name: 'posttooluse-probe', description: 'Zero-agent probe: does a PostToolUse hook fire for a Workflow call', phases: [] }
   return { ok: true }
   ```

3. Read `/tmp/posttooluse-workflow.json`, then remove the user-level hook.

The behavior holds when the file exists after the call returns and holds `"hook_event_name": "PostToolUse"`, `"tool_name": "Workflow"`, a `tool_input` equal to the call's input, and a `tool_response`. No file means PostToolUse does not fire for `Workflow`, and nothing writes the lock: the gate then refuses no concurrent round.

Last run 2026-10-12, Claude Code 2.1.296, Linux dev container: the hook fired at launch. The payload's fields, with session ids and paths cut:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Workflow",
  "tool_input": { "script": "export const meta = { name: 'posttooluse-probe', ... }\nreturn { ok: true }" },
  "tool_response": {
    "status": "async_launched",
    "taskType": "local_workflow",
    "workflowName": "posttooluse-probe",
    "scriptPath": "<session dir>/workflows/scripts/posttooluse-probe-<run id>.js"
  },
  "cwd": "/workspace"
}
```

A second run, 2026-10-12 on Claude Code 2.1.296, called `Workflow` with a `scriptPath` and `args` (`targetRef` and the other review fields): the hook fired at launch, `tool_input` held `scriptPath`, `args` and the resolved `script`, and `tool_response.status` was `async_launched`.

Not probed: whether PostToolUse fires for a `Workflow` call that fails to launch.
