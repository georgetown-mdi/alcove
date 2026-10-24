import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  aggregate,
  classifyDenial,
  ownerKind,
  parseArgs,
} from "./aggregate.mjs";
import {
  assistant,
  sessionId,
  tempDir,
  toolResult,
  toolUse,
  usage,
  user,
  writeProject,
} from "./transcriptFixtures.mjs";

const SCRIPT = fileURLToPath(new URL("./aggregate.mjs", import.meta.url));
const CUT = "2026-01-10T00:00:00Z";
const END = "2026-01-12T00:00:00Z";
const WRITTEN = new Date("2026-01-11T12:00:00Z");
const BEFORE_CUT = new Date("2026-01-09T12:00:00Z");
const MODEL = "claude-opus-5-5";
const S1 = sessionId(1);
const S2 = sessionId(2);
const S3 = sessionId(3);

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function storeWith(sessions) {
  const root = tempDir();
  dirs.push(root);
  const projects = path.join(root, "projects");
  writeProject(projects, "-workspace", sessions, WRITTEN);
  return projects;
}

async function aggregateSessions(sessions, options = {}) {
  return aggregate({
    store: "fixture",
    cut: CUT,
    end: END,
    prRange: { lo: 2000, hi: 2999 },
    exclude: [],
    only: [],
    roots: [storeWith(sessions)],
    projectDirs: [],
    ...options,
  });
}

const sessionOf = (result, id) => result.sessions.find((s) => s.id === id);
const agentOf = (session, id) => session.subagents.find((a) => a.id === id);

function counted({
  calls = 1,
  input = 0,
  output = 0,
  outFirst = output,
  cacheRead = 0,
  cache5m = 0,
  cache1h = 0,
}) {
  return {
    calls,
    in: input,
    out: output,
    outFirst,
    cacheRead,
    cache1h,
    cache5m,
    ctxMax: input + cacheRead + cache5m + cache1h,
  };
}

describe("streamed usage", () => {
  it("counts a message logged in several entries once, at its first entry's time, with its last entry's usage", async () => {
    const id = "msg_fixture_streamed";
    const shared = { input: 3, cacheRead: 12000, cache5m: 400 };
    const result = await aggregateSessions({
      [S1]: {
        main: [user("2026-01-11T23:58:00Z", "Start the work.")],
        subagents: {
          "agent-afixture01": {
            entries: [
              user("2026-01-11T23:59:00Z", "Implement the parser."),
              assistant("2026-01-11T23:59:58Z", {
                id,
                u: usage({ ...shared, output: 8 }),
                content: [{ type: "thinking", thinking: "", signature: "" }],
              }),
              assistant("2026-01-12T00:00:04Z", {
                id,
                u: usage({ ...shared, output: 517 }),
                content: [{ type: "text", text: "Implemented." }],
              }),
            ],
          },
        },
      },
    });
    const agent = agentOf(sessionOf(result, S1), "agent-afixture01");
    const expected = counted({ ...shared, output: 517, outFirst: 8 });
    expect(agent.usageWin).toEqual({ [MODEL]: expected });
    expect(agent.byDay).toEqual({ "2026-01-11": { [MODEL]: expected } });
    expect(agent.streamRepeatsChanged).toBe(1);
  });

  it("takes output_tokens as the maximum over the entries and every other field from the last", async () => {
    const id = "msg_fixture_nonmonotone";
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id,
            u: usage({ input: 2, cacheRead: 900, cache5m: 6816, output: 8 }),
          }),
          assistant("2026-01-11T10:00:01Z", {
            id,
            u: usage({ input: 2, cacheRead: 900, cache5m: 6816, output: 700 }),
          }),
          assistant("2026-01-11T10:00:02Z", {
            id,
            u: usage({ input: 2, cacheRead: 900, cache5m: 6776, output: 650 }),
          }),
        ],
      },
    });
    const { calls, out, outFirst, cache5m } = sessionOf(result, S1).usageWin[
      MODEL
    ];
    expect({ calls, out, outFirst, cache5m }).toEqual({
      calls: 1,
      out: 700,
      outFirst: 8,
      cache5m: 6776,
    });
  });

  it("counts a message whose entries have equal usage unchanged", async () => {
    const id = "msg_fixture_equal";
    const u = usage({ input: 5, cacheRead: 30000, cache1h: 1200, output: 412 });
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", { id, u }),
          assistant("2026-01-11T10:00:01Z", { id, u }),
          assistant("2026-01-11T10:00:02Z", { id, u }),
        ],
      },
    });
    const session = sessionOf(result, S1);
    expect(session.usageWin).toEqual({
      [MODEL]: counted({
        input: 5,
        cacheRead: 30000,
        cache1h: 1200,
        output: 412,
      }),
    });
    expect(session.streamRepeatsChanged).toBe(0);
  });

  it("leaves a message out of the window when its first entry precedes the cut", async () => {
    const id = "msg_fixture_straddles_cut";
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-09T23:59:59Z", { id, u: usage({ output: 8 }) }),
          assistant("2026-01-10T00:00:03Z", { id, u: usage({ output: 300 }) }),
        ],
      },
    });
    expect(sessionOf(result, S1).usageWin).toEqual({});
  });
});

describe("line splitting", () => {
  it("keeps an entry whose text contains a raw U+2028 or U+2029 whole", async () => {
    const text = `first${String.fromCharCode(0x2028)}second${String.fromCharCode(0x2029)}third`;
    const projects = storeWith({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_separator",
            u: usage({ output: 40 }),
            content: [{ type: "text", text }],
          }),
        ],
      },
    });
    const raw = fs.readFileSync(
      path.join(projects, "-workspace", `${S1}.jsonl`),
      "utf8",
    );
    expect(raw).toContain(String.fromCharCode(0x2028));
    expect(raw).toContain(String.fromCharCode(0x2029));
    const result = await aggregate({
      store: "fixture",
      cut: CUT,
      end: END,
      prRange: { lo: 2000, hi: 2999 },
      exclude: [],
      only: [],
      roots: [projects],
      projectDirs: [],
    });
    const session = sessionOf(result, S1);
    expect(session.parseErrors).toBe(0);
    expect(session.usageWin[MODEL].calls).toBe(1);
  });

  it("counts a malformed line as a parse error and reads the lines after it", async () => {
    const result = await aggregateSessions({
      [S1]: {
        main: [
          '{"type":"assistant","message":',
          "",
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_after_bad_line",
            u: usage({ output: 9 }),
          }),
        ],
      },
    });
    const session = sessionOf(result, S1);
    expect(session.parseErrors).toBe(1);
    expect(session.usageWin[MODEL].calls).toBe(1);
  });
});

describe("window", () => {
  it("counts an entry at the cut and none at the end or before the cut", async () => {
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-09T23:59:59.999Z", { id: "msg_fixture_before" }),
          assistant(CUT, { id: "msg_fixture_at_cut" }),
          assistant(END, { id: "msg_fixture_at_end" }),
        ],
      },
    });
    const session = sessionOf(result, S1);
    expect(session.usageWin[MODEL].calls).toBe(1);
    expect(session.winFirstTs).toBe(CUT);
    expect(session.winLastTs).toBe(CUT);
  });

  it("skips a session whose files were all last written before the cut, and an agent file written before it", async () => {
    const entry = () => [
      assistant("2026-01-11T10:00:00Z", { id: "msg_fixture_window" }),
    ];
    const result = await aggregateSessions({
      [S1]: { main: entry(), mtime: BEFORE_CUT },
      [S2]: {
        main: entry(),
        mtime: BEFORE_CUT,
        subagents: { "agent-afixture02": { entries: entry() } },
      },
      [S3]: {
        main: entry(),
        subagents: {
          "agent-afixture03": { entries: entry(), mtime: BEFORE_CUT },
        },
      },
    });
    expect(result.sessions.map((s) => s.id).sort()).toEqual([S2, S3]);
    expect(sessionOf(result, S2).subagents.map((a) => a.id)).toEqual([
      "agent-afixture02",
    ]);
    expect(sessionOf(result, S3).subagents).toEqual([]);
  });
});

describe("calls", () => {
  it("does not count an entry with no usage or a synthetic model, and keys an entry with no message.id by its uuid", async () => {
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_no_usage",
            u: null,
          }),
          assistant("2026-01-11T10:00:01Z", {
            id: "msg_fixture_synthetic",
            model: "<synthetic>",
          }),
          assistant("2026-01-11T10:00:02Z", { u: usage({ output: 3 }) }),
          assistant("2026-01-11T10:00:03Z", { u: usage({ output: 4 }) }),
        ],
      },
    });
    expect(sessionOf(result, S1).usageWin).toEqual({
      [MODEL]: counted({ calls: 2, output: 7, outFirst: 7 }),
    });
  });
});

describe("cache writes", () => {
  it("splits writes by cache_creation, and counts a bare cache_creation_input_tokens as 5m", async () => {
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_split",
            u: usage({ cache5m: 100, cache1h: 50 }),
          }),
          assistant("2026-01-11T10:00:01Z", {
            id: "msg_fixture_flat",
            u: usage({ cache5m: 30, flat: true }),
          }),
        ],
      },
    });
    const { cache5m, cache1h } = sessionOf(result, S1).usageWin[MODEL];
    expect({ cache5m, cache1h }).toEqual({ cache5m: 130, cache1h: 50 });
  });
});

describe("components", () => {
  it("files main, sidechain, subagent, workflow-agent and worktree-agent usage apart", async () => {
    const at = "2026-01-11T10:00:00Z";
    const projects = storeWith({
      [S1]: {
        main: [
          assistant(at, { id: "msg_fixture_main", u: usage({ output: 1 }) }),
          assistant(at, {
            id: "msg_fixture_side",
            u: usage({ output: 2 }),
            isSidechain: true,
          }),
        ],
        subagents: {
          "agent-afixture04": {
            entries: [
              user(at, "Fix the parser."),
              assistant(at, { id: "msg_fixture_sub", u: usage({ output: 3 }) }),
            ],
            meta: {
              agentType: "implementer",
              model: "opus",
              description: "Fix the parser",
              spawnDepth: 1,
            },
          },
        },
        workflows: {
          wf_fixture01: {
            record: {
              script: 'export const meta = { name: "light-review" };',
              timestamp: at,
            },
            agents: {
              "agent-afixture05": [
                user(
                  at,
                  "You are reviewing the ref fix-parser. Read the diff.",
                ),
                assistant(at, {
                  id: "msg_fixture_wf",
                  u: usage({ output: 4 }),
                }),
              ],
            },
          },
        },
      },
      "agent-afixture06": {
        main: [
          assistant(at, {
            id: "msg_fixture_worktree",
            u: usage({ output: 5 }),
          }),
        ],
      },
    });
    const result = await aggregate({
      store: "fixture",
      cut: CUT,
      end: END,
      prRange: { lo: 2000, hi: 2999 },
      exclude: [],
      only: [],
      roots: [],
      projectDirs: [path.join(projects, "-workspace")],
    });
    const session = sessionOf(result, S1);
    expect(session.kind).toBe("session");
    expect(session.usageWin[MODEL].out).toBe(1);
    expect(session.usageSidechainWin[MODEL].out).toBe(2);
    expect(session.workflowRuns).toEqual({
      wf_fixture01: { name: "light-review", ts: at },
    });
    expect(agentOf(session, "agent-afixture04")).toMatchObject({
      kind: "subagent",
      agentType: "implementer",
      metaModel: "opus",
      desc: "Fix the parser",
      spawnDepth: 1,
      wf: null,
      wfName: null,
      targetRef: null,
      usageWin: { [MODEL]: { out: 3 } },
    });
    expect(agentOf(session, "agent-afixture05")).toMatchObject({
      kind: "workflow-agent",
      wf: "wf_fixture01",
      wfName: "light-review",
      targetRef: "fix-parser",
      usageWin: { [MODEL]: { out: 4 } },
    });
    expect(sessionOf(result, "agent-afixture06")).toMatchObject({
      kind: "worktree-agent",
      usageWin: { [MODEL]: { out: 5 } },
    });
  });
});

describe("cross-file duplicates", () => {
  it("adds a message.id and requestId seen in an earlier file to the duplicates bucket", async () => {
    const at = "2026-01-11T10:00:00Z";
    const repeated = {
      id: "msg_fixture_dup",
      requestId: "req_fixture_dup",
      u: usage({ output: 6 }),
    };
    const result = await aggregateSessions({
      [S1]: {
        main: [assistant(at, repeated)],
        subagents: {
          "agent-afixture07": {
            entries: [
              assistant(at, repeated),
              assistant(at, {
                ...repeated,
                id: "msg_fixture_dup",
                requestId: "req_fixture_other",
              }),
            ],
          },
        },
      },
    });
    const session = sessionOf(result, S1);
    expect(session.dupWin).toEqual({});
    const agent = agentOf(session, "agent-afixture07");
    expect(agent.dupWin).toEqual({ [MODEL]: counted({ output: 6 }) });
    expect(agent.usageWin[MODEL].calls).toBe(1);
  });
});

describe("owner turns", () => {
  it("classifies each kind of owner-side user entry", () => {
    const kind = (txt, e = {}) => ownerKind(txt, e);
    expect(kind("Please fix the parser.")).toBe("typed");
    expect(kind("<command-name>/pm</command-name>")).toBe("command");
    expect(kind("[Request interrupted by user]")).toBe("interrupt");
    expect(kind("<task-notification>done</task-notification>")).toBe(
      "notification",
    );
    expect(kind("<local-command-stdout>ok</local-command-stdout>")).toBe(
      "local-output",
    );
    expect(kind("Caveat: the messages below")).toBe("local-output");
    expect(kind("<system-reminder>note</system-reminder>")).toBe("reminder");
    expect(kind("<system-reminder>note</system-reminder> and a question")).toBe(
      "typed",
    );
    expect(kind("<bash-input>ls</bash-input>")).toBe("other-system");
    expect(kind("[Artifact comment] looks good")).toBe("other-system");
    expect(kind("summary text", { isCompactSummary: true })).toBe("compact");
    expect(
      kind("This session is being continued from a previous conversation."),
    ).toBe("compact");
  });

  it("counts main-session owner turns per day and leaves out tool results, sidechain, meta and subagent entries", async () => {
    const at = "2026-01-11T10:00:00Z";
    const result = await aggregateSessions({
      [S1]: {
        main: [
          user(at, "Please fix the parser."),
          user(at, [
            { type: "text", text: "<command-name>/pm</command-name>" },
          ]),
          user(at, "[Request interrupted by user]"),
          user(at, "<task-notification>done</task-notification>"),
          toolResult(at, "ok"),
          user(at, "A sidechain prompt.", { isSidechain: true }),
          user(at, "Meta text.", { isMeta: true }),
          user("2026-01-12T00:00:00Z", "Past the end."),
        ],
        subagents: {
          "agent-afixture08": { entries: [user(at, "A subagent prompt.")] },
        },
      },
    });
    const session = sessionOf(result, S1);
    expect(session.ownerByDay).toEqual({
      "2026-01-11": { typed: 1, command: 1, interrupt: 1, notification: 1 },
    });
    expect(session.userTurns).toBe(3);
    expect(session.interrupts).toBe(1);
    expect(session.commands).toEqual({ "/pm": 1 });
    expect(agentOf(session, "agent-afixture08").ownerByDay).toBeUndefined();
  });
});

describe("denials", () => {
  it("classifies a tool result's text by its source", () => {
    expect(
      classifyDenial(
        "PreToolUse:Bash hook error: [node /workspace/.claude/hooks/block-sleep-poll.mjs]: refused",
        false,
      ),
    ).toBe("hook:block-sleep-poll");
    expect(
      classifyDenial("PreToolUse:Edit hook blocking error from command", true),
    ).toBe("hook:unknown");
    expect(
      classifyDenial(
        "This agent is isolated in the worktree /tmp/w, but",
        true,
      ),
    ).toBe("isolation");
    expect(classifyDenial("Blocked: a write outside the repo", true)).toBe(
      "global-guard",
    );
    expect(classifyDenial("Blocked: not allowed here", true)).toBe(
      "blocked-other",
    );
    expect(
      classifyDenial("Permission to use Bash has been denied.", true),
    ).toBe("permission-deny");
    expect(classifyDenial("The command was blocked by a deny rule", true)).toBe(
      "deny-rule",
    );
    expect(classifyDenial("Blocked: not allowed here", false)).toBeNull();
    expect(classifyDenial("exit code 1", true)).toBeNull();
  });

  it("counts window tool results' denials and errors, and tallies unclassified error prefixes", async () => {
    const at = "2026-01-11T10:00:00Z";
    const result = await aggregateSessions({
      [S1]: {
        main: [
          toolResult(at, "Permission to use Bash has been denied.", {
            isError: true,
          }),
          toolResult(at, "exit code 12 at deadbeef01", { isError: true }),
          toolResult("2026-01-09T10:00:00Z", "Blocked: before the cut", {
            isError: true,
          }),
        ],
      },
    });
    const session = sessionOf(result, S1);
    expect(session.denials).toEqual({ "permission-deny": 1 });
    expect(session.toolErrors).toBe(2);
    expect(result.topUnclassifiedErrors).toEqual({ "exit code N at H": 1 });
  });
});

describe("PR mentions", () => {
  it("records four-digit PR, pull/ and # mentions in the range from user text, not tool results", async () => {
    const at = "2026-01-11T10:00:00Z";
    const result = await aggregateSessions({
      [S1]: {
        main: [
          user(
            at,
            "See PR 2101, pull/2102 and #2103; not #1999, #3001 or #21045.",
          ),
          user(at, "And #2101 again."),
          toolResult(at, "#2104 from a command"),
        ],
      },
    });
    expect(sessionOf(result, S1).prMentions).toEqual({
      2101: 2,
      2102: 1,
      2103: 1,
    });
  });
});

describe("tool use", () => {
  it("tallies window tool calls, spawns, skills and workflow calls", async () => {
    const result = await aggregateSessions({
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_tools",
            content: [
              toolUse("Agent", {
                subagent_type: "implementer",
                model: "opus",
                description: "Fix the parser",
              }),
              toolUse("Task", { description: "Survey" }),
              toolUse("Skill", { skill: "pm" }),
              toolUse("Workflow", {}),
              toolUse("Bash", { command: "ls" }),
            ],
          }),
          assistant("2026-01-09T10:00:00Z", {
            id: "msg_fixture_early",
            content: [toolUse("Bash", {})],
          }),
        ],
      },
    });
    const session = sessionOf(result, S1);
    expect(session.toolUse).toEqual({
      Agent: 1,
      Task: 1,
      Skill: 1,
      Workflow: 1,
      Bash: 1,
    });
    expect(session.spawns).toEqual([
      { type: "implementer", model: "opus", desc: "Fix the parser" },
      { type: null, model: null, desc: "Survey" },
    ]);
    expect(session.skills).toEqual({ pm: 1 });
    expect(session.workflowCalls).toBe(1);
  });
});

describe("session selection", () => {
  it("leaves out --exclude sessions and keeps only --only sessions", async () => {
    const sessions = {
      [S1]: {
        main: [assistant("2026-01-11T10:00:00Z", { id: "msg_fixture_s1" })],
      },
      [S2]: {
        main: [assistant("2026-01-11T10:00:00Z", { id: "msg_fixture_s2" })],
      },
    };
    const excluded = await aggregateSessions(sessions, { exclude: [S1] });
    expect(excluded.sessions.map((s) => s.id)).toEqual([S2]);
    expect(excluded.excluded).toEqual([S1]);
    const only = await aggregateSessions(sessions, { only: [S1] });
    expect(only.sessions.map((s) => s.id)).toEqual([S1]);
  });
});

describe("parseArgs", () => {
  const ok = [
    "--store",
    "vm",
    "--cut",
    CUT,
    "--end",
    END,
    "--pr-range",
    "2000-2999",
    "--out",
    "/tmp/x.json",
    "--root",
    "/tmp/p",
  ];

  it("reads every option", () => {
    const parsed = parseArgs([
      ...ok,
      "--exclude",
      S1,
      "--only",
      S2,
      "/tmp/project",
    ]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        store: "vm",
        cut: CUT,
        end: END,
        prRange: { lo: 2000, hi: 2999 },
        out: "/tmp/x.json",
        exclude: [S1],
        only: [S2],
        roots: ["/tmp/p"],
        projectDirs: ["/tmp/project"],
      },
    });
  });

  it("requires the store name, both window bounds, the PR range, the output and a store path", () => {
    for (const flag of ["--store", "--cut", "--end", "--pr-range", "--out"]) {
      const i = ok.indexOf(flag);
      const without = [...ok.slice(0, i), ...ok.slice(i + 2)];
      expect(parseArgs(without)).toEqual({
        ok: false,
        message: `${flag} is required`,
      });
    }
    expect(parseArgs(ok.slice(0, -2))).toMatchObject({ ok: false });
  });

  it("refuses a time with no zone, an end not after the cut, and a malformed range", () => {
    const withValue = (flag, value) =>
      ok.map((a, i) => (ok[i - 1] === flag ? value : a));
    expect(parseArgs(withValue("--cut", "2026-01-10T00:00"))).toMatchObject({
      ok: false,
    });
    expect(parseArgs(withValue("--end", CUT))).toMatchObject({ ok: false });
    expect(parseArgs(withValue("--pr-range", "2999-2000"))).toMatchObject({
      ok: false,
    });
    expect(parseArgs(withValue("--cut", "2026-01-10"))).toMatchObject({
      ok: true,
    });
  });
});

describe("command line", () => {
  it("writes the aggregate to --out", () => {
    const projects = storeWith({
      [S1]: {
        main: [assistant("2026-01-11T10:00:00Z", { id: "msg_fixture_cli" })],
      },
    });
    const out = path.join(path.dirname(projects), "agg.json");
    const run = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--store",
        "fixture",
        "--cut",
        CUT,
        "--end",
        END,
        "--pr-range",
        "2000-2999",
        "--out",
        out,
        "--root",
        projects,
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(written).toMatchObject({ store: "fixture", cut: CUT, end: END });
    expect(written.sessions.map((s) => s.id)).toEqual([S1]);
  });

  it("exits 2 with the usage on an argument error", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--store", "fixture"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--cut is required");
    expect(run.stderr).toContain("Usage: node aggregate.mjs");
  });
});
