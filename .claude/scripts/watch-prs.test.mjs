import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE, ciResult, parseArgs, poll, watch } from "./watch-prs.mjs";

const SCRIPT = fileURLToPath(new URL("./watch-prs.mjs", import.meta.url));
const SLEEP_POLL_HOOK = fileURLToPath(
  new URL("../hooks/block-sleep-poll.mjs", import.meta.url),
);

const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function statePath() {
  const directory = mkdtempSync(join(tmpdir(), "watch-prs-"));
  directories.push(directory);
  return join(directory, "watch-prs.reported");
}

const pr = (label) => parseArgs([label]).prs[0];

function checkRun(name, status, conclusion = null) {
  return { __typename: "CheckRun", name, status, conclusion };
}

function view(overrides = {}) {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    headRefOid: HEAD,
    mergeCommit: null,
    statusCheckRollup: [checkRun("lint", "IN_PROGRESS")],
    url: "https://github.com/georgetown-mdi/alcove/pull/12",
    ...overrides,
  };
}

// Polls once with each PR label shown as the fixture names it.
function pollWith(path, fixtures) {
  const warnings = [];
  const lines = poll({
    prs: Object.keys(fixtures).map(pr),
    statePath: path,
    view: ({ number, repo }) => {
      const fixture = fixtures[repo ? `${repo}#${number}` : String(number)];
      if (fixture instanceof Error) throw fixture;
      return fixture;
    },
    warn: (text) => warnings.push(text),
  });
  return { lines, warnings };
}

describe("events", () => {
  it("reports ci-green when every check on the head completed and none failed", () => {
    const { lines } = pollWith(statePath(), {
      12: view({
        statusCheckRollup: [
          checkRun("lint", "COMPLETED", "SUCCESS"),
          checkRun("docs", "COMPLETED", "SKIPPED"),
          checkRun("notes", "COMPLETED", "NEUTRAL"),
          { __typename: "StatusContext", context: "ext", state: "SUCCESS" },
        ],
      }),
    });
    expect(lines).toEqual([`ci-green 12 ${HEAD}`]);
  });

  it("reports ci-red with each failed check name once", () => {
    const { lines } = pollWith(statePath(), {
      12: view({
        statusCheckRollup: [
          checkRun("unit", "COMPLETED", "FAILURE"),
          checkRun("lint", "COMPLETED", "SUCCESS"),
          checkRun("e2e", "COMPLETED", "CANCELLED"),
          checkRun("unit", "COMPLETED", "TIMED_OUT"),
          { __typename: "StatusContext", context: "ext", state: "ERROR" },
        ],
      }),
    });
    expect(lines).toEqual([`ci-red 12 ${HEAD} e2e, ext, unit`]);
  });

  it("reports a conflict, a merge, and a close", () => {
    const { lines } = pollWith(statePath(), {
      12: view({ mergeable: "CONFLICTING" }),
      13: view({ state: "MERGED", mergeCommit: { oid: MERGE } }),
      14: view({ state: "CLOSED" }),
    });
    expect(lines).toEqual(["conflict 12", `merged 13 ${MERGE}`, "closed 14"]);
  });

  it("names a fork PR as given and reads it from its own repository", () => {
    const seen = [];
    const lines = poll({
      prs: [pr("some-org/some-fork#7")],
      statePath: statePath(),
      view: (target) => {
        seen.push(target);
        return view({
          state: "MERGED",
          mergeCommit: { oid: MERGE },
          url: "https://github.com/some-org/some-fork/pull/7",
        });
      },
      warn: () => {},
    });
    expect(seen).toEqual([
      { label: "some-org/some-fork#7", repo: "some-org/some-fork", number: 7 },
    ]);
    expect(lines).toEqual([`merged some-org/some-fork#7 ${MERGE}`]);
  });

  it("reports nothing while no check is registered", () => {
    expect(ciResult([])).toEqual({ result: "pending" });
    expect(ciResult(null)).toEqual({ result: "pending" });
  });
});

describe("reported events", () => {
  it("does not report an event again after a re-arm", () => {
    const path = statePath();
    const merged = {
      13: view({ state: "MERGED", mergeCommit: { oid: MERGE } }),
    };
    expect(pollWith(path, merged).lines).toEqual([`merged 13 ${MERGE}`]);
    expect(pollWith(path, merged).lines).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(
      `georgetown-mdi/alcove#13 merged ${MERGE}\n`,
    );
  });

  it("reports CI again for a new head", () => {
    const path = statePath();
    const red = [checkRun("unit", "COMPLETED", "FAILURE")];
    const green = [checkRun("unit", "COMPLETED", "SUCCESS")];
    expect(
      pollWith(path, { 12: view({ statusCheckRollup: red }) }).lines,
    ).toEqual([`ci-red 12 ${HEAD} unit`]);
    expect(
      pollWith(path, { 12: view({ statusCheckRollup: red }) }).lines,
    ).toEqual([]);
    expect(
      pollWith(path, {
        12: view({ headRefOid: NEW_HEAD, statusCheckRollup: green }),
      }).lines,
    ).toEqual([`ci-green 12 ${NEW_HEAD}`]);
  });

  it("reports ci-red again on the same head after a rerun", () => {
    const path = statePath();
    const red = view({
      statusCheckRollup: [checkRun("unit", "COMPLETED", "FAILURE")],
    });
    expect(pollWith(path, { 12: red }).lines).toEqual([
      `ci-red 12 ${HEAD} unit`,
    ]);
    expect(pollWith(path, { 12: red }).lines).toEqual([]);
    expect(
      pollWith(path, {
        12: view({ statusCheckRollup: [checkRun("unit", "IN_PROGRESS")] }),
      }).lines,
    ).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(pollWith(path, { 12: red }).lines).toEqual([
      `ci-red 12 ${HEAD} unit`,
    ]);
  });

  it("keeps the keys of a watch that wrote while another poll ran", () => {
    const path = statePath();
    writeFileSync(path, `georgetown-mdi/alcove#12 conflict ${HEAD}\n`);
    let inner;
    const outer = poll({
      prs: [pr("12")],
      statePath: path,
      view: () => {
        inner = pollWith(path, {
          13: view({ state: "MERGED", mergeCommit: { oid: MERGE } }),
        });
        return view({ state: "CLOSED" });
      },
      warn: () => {},
    });
    expect(inner.lines).toEqual([`merged 13 ${MERGE}`]);
    expect(outer).toEqual(["closed 12"]);
    expect(readFileSync(path, "utf8")).toBe(
      [
        `georgetown-mdi/alcove#12 conflict ${HEAD}`,
        `georgetown-mdi/alcove#13 merged ${MERGE}`,
        `georgetown-mdi/alcove#12 closed ${HEAD}`,
        "",
      ].join("\n"),
    );
  });

  it("deletes only its own removals when another watch wrote meanwhile", () => {
    const path = statePath();
    writeFileSync(path, `georgetown-mdi/alcove#12 conflict ${HEAD}\n`);
    const outer = poll({
      prs: [pr("12")],
      statePath: path,
      view: () => {
        pollWith(path, {
          13: view({ state: "MERGED", mergeCommit: { oid: MERGE } }),
        });
        return view();
      },
      warn: () => {},
    });
    expect(outer).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(
      `georgetown-mdi/alcove#13 merged ${MERGE}\n`,
    );
  });

  it("reports a conflict again only after the PR was seen mergeable", () => {
    const path = statePath();
    const conflicting = view({ mergeable: "CONFLICTING" });
    expect(pollWith(path, { 12: conflicting }).lines).toEqual(["conflict 12"]);
    expect(
      pollWith(path, { 12: { ...conflicting, headRefOid: NEW_HEAD } }).lines,
    ).toEqual([]);
    expect(
      pollWith(path, { 12: view({ mergeable: "UNKNOWN" }) }).lines,
    ).toEqual([]);
    expect(pollWith(path, { 12: conflicting }).lines).toEqual([]);
    expect(pollWith(path, { 12: view() }).lines).toEqual([]);
    expect(pollWith(path, { 12: conflicting }).lines).toEqual(["conflict 12"]);
  });
});

describe("watch", () => {
  it("holds ci-green back while a late-registered check is pending", async () => {
    const rollups = [
      [
        checkRun("lint", "COMPLETED", "SUCCESS"),
        checkRun("unit", "IN_PROGRESS"),
      ],
      [
        checkRun("lint", "COMPLETED", "SUCCESS"),
        checkRun("unit", "COMPLETED", "SUCCESS"),
        checkRun("docs", "QUEUED"),
      ],
      [
        checkRun("lint", "COMPLETED", "SUCCESS"),
        checkRun("unit", "COMPLETED", "SUCCESS"),
        { __typename: "StatusContext", context: "ext", state: "PENDING" },
      ],
      [
        checkRun("lint", "COMPLETED", "SUCCESS"),
        checkRun("unit", "COMPLETED", "SUCCESS"),
        checkRun("docs", "COMPLETED", "SUCCESS"),
        { __typename: "StatusContext", context: "ext", state: "SUCCESS" },
      ],
    ];
    let polls = 0;
    const sleeps = [];
    const lines = await watch({
      prs: [pr("12")],
      statePath: statePath(),
      intervalSeconds: 5,
      view: () => view({ statusCheckRollup: rollups[polls++] }),
      sleep: async (ms) => sleeps.push(ms),
    });
    expect(lines).toEqual([`ci-green 12 ${HEAD}`]);
    expect(polls).toBe(4);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it("goes on past a gh failure for one PR", async () => {
    const warnings = [];
    let polls = 0;
    const lines = await watch({
      prs: [pr("12"), pr("13")],
      statePath: statePath(),
      view: ({ number }) => {
        if (number === 12) throw new Error("HTTP 502\nmore detail");
        polls += 1;
        return polls < 2
          ? view()
          : view({ state: "MERGED", mergeCommit: { oid: MERGE } });
      },
      warn: (text) => warnings.push(text),
      sleep: async () => {},
    });
    expect(lines).toEqual([`merged 13 ${MERGE}`]);
    expect(warnings).toEqual([
      "watch-prs: could not read 12 (HTTP 502); trying again next poll.\n",
      "watch-prs: could not read 12 (HTTP 502); trying again next poll.\n",
    ]);
  });

  it("keeps polling while nothing new happens", async () => {
    const path = statePath();
    writeFileSync(path, `georgetown-mdi/alcove#13 merged ${MERGE}\n`);
    const lines = await watch({
      prs: [pr("13")],
      statePath: path,
      view: () => view({ state: "MERGED", mergeCommit: { oid: MERGE } }),
      sleep: async () => {},
      polls: 3,
    });
    expect(lines).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads PRs, the interval, and the state file", () => {
    expect(
      parseArgs(["12", "o/r#7", "12", "--interval", "30", "--state", "s"]),
    ).toEqual({
      prs: [
        { label: "12", repo: undefined, number: 12 },
        { label: "o/r#7", repo: "o/r", number: 7 },
      ],
      intervalSeconds: 30,
      statePath: "s",
    });
  });

  it("refuses an argument that is not a pull request", () => {
    expect(parseArgs(["#12"]).error).toContain("not a pull request");
    expect(parseArgs(["o/r#"]).error).toContain("not a pull request");
  });

  it("refuses an interval out of range and a bare --state", () => {
    expect(parseArgs(["12", "--interval", "0"]).error).toContain("--interval");
    expect(parseArgs(["12", "--state"]).error).toContain("--state");
  });
});

describe("watch-prs.mjs", () => {
  it("exits 2 naming the file and --state when the state file cannot be written", () => {
    const directory = mkdtempSync(join(tmpdir(), "watch-prs-cli-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const stateDirectory = join(directory, "state");
    mkdirSync(bin);
    mkdirSync(stateDirectory);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho '${JSON.stringify(view({ state: "MERGED", mergeCommit: { oid: MERGE } }))}'\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(stateDirectory, 0o555);
    try {
      const state = join(stateDirectory, "watch-prs.reported");
      const { status, stdout, stderr } = spawnSync(
        "node",
        [SCRIPT, "12", "--state", state],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(status).toBe(2);
      expect(stdout).toBe("");
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(stderr).toContain(`cannot use the state file ${state}`);
      expect(stderr).toContain("--state");
    } finally {
      chmodSync(stateDirectory, 0o755);
    }
  });

  it("prints its usage and exits 2 with no arguments", () => {
    const { status, stderr } = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
    });
    expect(status).toBe(2);
    expect(stderr).toBe(USAGE);
  });

  it("gives a background line block-sleep-poll.mjs admits", () => {
    const line = USAGE.split("\n").find((text) =>
      text.trim().startsWith("timeout "),
    );
    expect(line).toBeDefined();
    const { status, stderr } = spawnSync("node", [SLEEP_POLL_HOOK], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: line.trim(), run_in_background: true },
      }),
      encoding: "utf8",
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});
