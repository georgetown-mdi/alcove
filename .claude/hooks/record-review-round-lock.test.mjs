import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./record-review-round-lock.mjs", import.meta.url),
);

// The PostToolUse payload's shape as record-review-round-lock.probe.md recorded
// it for an async Workflow launch.
function runHook(tool_input, cwd, tool_name = "Workflow") {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name,
      tool_input,
      tool_response: { status: "async_launched", taskType: "local_workflow" },
      cwd,
    }),
    encoding: "utf8",
  });
  return { status, stderr };
}

const review = (targetRef) => ({
  scriptPath: ".claude/scripts/review-round-workflow.mjs",
  args: { targetRef, docs: [], role: null, claims: [] },
});

// A primary checkout with one commit and a linked worktree beside it, so a call
// made from the linked tree shows the lock lands under the primary one.
function makeRepo() {
  const main = mkdtempSync(join(tmpdir(), "round-lock-"));
  const git = (...args) => execFileSync("git", ["-C", main, ...args]);
  git("init", "-q", "-b", "primary");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "Base commit");
  git("worktree", "add", "-q", "-b", "feature", `${main}-wt`);
  return { main, linked: `${main}-wt` };
}

const roundsDir = (main) => join(main, "scratch", "review-rounds");
const lockFor = (main, key) => join(roundsDir(main), `${key}.lock`);

describe("record-review-round-lock hook", () => {
  const dirs = [];
  const repo = () => {
    const made = makeRepo();
    dirs.push(made.main, made.linked);
    return made;
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("writes a lock under the primary checkout for each ref a round names", () => {
    const { main, linked } = repo();
    expect(
      runHook(review(["feature", "refs/heads/other"]), linked).status,
    ).toBe(0);
    for (const [key, ref] of [
      ["feature", "feature"],
      ["other", "refs/heads/other"],
    ]) {
      const lock = JSON.parse(readFileSync(lockFor(main, key), "utf8"));
      expect(lock.ref).toBe(ref);
      expect(Date.now() - Date.parse(lock.startedAt)).toBeLessThan(60_000);
    }
  });

  it("writes the lock for a round named by a saved workflow's name", () => {
    const { main } = repo();
    const named = { name: "review-round", args: { targetRef: "feature" } };
    expect(runHook(named, main).status).toBe(0);
    expect(existsSync(lockFor(main, "feature"))).toBe(true);
  });

  it("writes nothing for another tool, another workflow, or a round naming no ref", () => {
    const { main } = repo();
    for (const [tool_input, tool_name] of [
      [review("feature"), "Agent"],
      [{ scriptPath: ".claude/scripts/panel-workflow.mjs" }, "Workflow"],
      [
        {
          scriptPath: ".claude/scripts/panel-workflow.mjs",
          args: { targetRef: "feature" },
        },
        "Workflow",
      ],
      [{ name: "review-round", args: { docs: [] } }, "Workflow"],
      [{ name: "review-round", args: "{not json" }, "Workflow"],
      [review(["feature", 7]), "Workflow"],
    ]) {
      const { status } = runHook(tool_input, main, tool_name);
      expect(status, JSON.stringify(tool_input)).toBe(0);
    }
    expect(existsSync(roundsDir(main))).toBe(false);
  });

  it("allows an unparseable event", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
  });

  it("warns when a lock cannot be written, and still writes the others", () => {
    const { main } = repo();
    mkdirSync(lockFor(main, "two"), { recursive: true });
    const { status, stderr } = runHook(review(["one", "two"]), main);
    expect(status).toBe(2);
    expect(stderr).toContain("could not write the in-flight round lock");
    expect(stderr).toContain(lockFor(main, "two"));
    expect(stderr).toContain("start no other review round");
    expect(existsSync(lockFor(main, "one"))).toBe(true);
  });

  it("warns when no repository can be found to hold the lock", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "round-lock-bare-"));
    dirs.push(notARepo);
    for (const cwd of [notARepo, undefined]) {
      const { status, stderr } = runHook(review("feature"), cwd);
      expect(status, String(cwd)).toBe(2);
      expect(stderr).toContain("could not locate the primary checkout");
    }
    expect(readdirSync(notARepo)).toEqual([]);
  });
});
