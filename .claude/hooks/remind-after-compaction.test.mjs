import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./remind-after-compaction.mjs", import.meta.url),
);
const RULESET = fileURLToPath(
  new URL("../orchestration/ruleset.md", import.meta.url),
);

const MARKER_SUBDIR = "alcove-orchestration-reads";
const SESSION = "8f2b1c66-0000-4000-8000-0123456789ab";
const BRIEF_TEXT = "Branches in flight: feature-x, round 2 open.";

const dirs = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function makeDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

// Each run gets its own TMPDIR, where the hook derives the marker directory
// from, and its own checkout directory holding `scratch/`.
function setup({ orchestrating = true } = {}) {
  const markerRoot = makeDir("compact-markers-");
  const checkout = makeDir("compact-checkout-");
  const marker = join(markerRoot, MARKER_SUBDIR, SESSION);
  if (orchestrating) {
    mkdirSync(join(markerRoot, MARKER_SUBDIR), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
  return { markerRoot, checkout, marker, scratch: join(checkout, "scratch") };
}

function writeBrief(scratch, name, ageMinutes, text = BRIEF_TEXT) {
  mkdirSync(scratch, { recursive: true });
  const path = join(scratch, name);
  writeFileSync(path, `${text}\n`);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, when, when);
  return path;
}

const compacted = (cwd, extra = {}) => ({
  session_id: SESSION,
  transcript_path: `/home/node/.claude/projects/-workspace/${SESSION}.jsonl`,
  cwd,
  hook_event_name: "SessionStart",
  source: "compact",
  model: "claude-opus-5-5",
  ...extra,
});

function runHook(payload, markerRoot) {
  const { status, stdout } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: markerRoot },
  });
  return { status, stdout };
}

/** The context the hook added, or null when it printed nothing. */
function context(payload, markerRoot) {
  const { status, stdout } = runHook(payload, markerRoot);
  expect(status).toBe(0);
  if (stdout === "") return null;
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("remind-after-compaction hook", () => {
  it("names the ruleset and the newest continuation brief by path", () => {
    const { markerRoot, checkout, scratch } = setup();
    writeBrief(scratch, "continuation-2026-11-05.md", 600);
    writeBrief(scratch, "continuation-2026-11-06.md", 120);
    const newest = writeBrief(scratch, "continuation-2026-11-06b.md", 5);
    writeBrief(scratch, "brief-feature-x.md", 1);
    writeBrief(scratch, "continuation-notes.txt", 1);
    const added = context(compacted(checkout), markerRoot);
    expect(added).toContain(RULESET);
    expect(added).toContain(newest);
    expect(added).not.toContain("continuation-2026-11-06.md");
    expect(added).not.toContain("brief-feature-x.md");
  });

  it("picks the brief by modification time, not by name", () => {
    const { markerRoot, checkout, scratch } = setup();
    const touched = writeBrief(scratch, "continuation-2026-11-01.md", 1);
    writeBrief(scratch, "continuation-2026-11-06.md", 60);
    expect(context(compacted(checkout), markerRoot)).toContain(touched);
  });

  it("quotes neither file's content", () => {
    const { markerRoot, checkout, scratch } = setup();
    writeBrief(scratch, "continuation-2026-11-06.md", 5);
    const added = context(compacted(checkout), markerRoot);
    expect(added).not.toContain(BRIEF_TEXT);
    expect(added).not.toContain("# Alcove orchestration ruleset");
    expect(added.length).toBeLessThan(800);
  });

  it("names the ruleset and no brief when scratch holds none", () => {
    for (const withScratch of [false, true]) {
      const { markerRoot, checkout, scratch } = setup();
      if (withScratch) writeBrief(scratch, "brief-feature-x.md", 1);
      const added = context(compacted(checkout), markerRoot);
      expect(added, String(withScratch)).toContain(RULESET);
      expect(added, String(withScratch)).toContain(
        `No open continuation brief is in ${scratch}`,
      );
    }
  });

  it("names no brief when the newest one is closed", () => {
    const { markerRoot, checkout, scratch } = setup();
    writeBrief(scratch, "continuation-2026-11-05.md", 600);
    writeBrief(
      scratch,
      "continuation-2026-11-06.md",
      5,
      "Closed out 2026-11-06 after the follow-ups pass.",
    );
    const added = context(compacted(checkout), markerRoot);
    expect(added).toContain("No open continuation brief");
    expect(added).not.toContain("continuation-2026-11-05.md");
  });

  it("reads the briefs from the primary checkout of a linked worktree", () => {
    const { markerRoot, checkout, scratch } = setup();
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "-q", "--allow-empty", "-m", "Base commit");
    const linked = join(checkout, ".claude", "worktrees", "agent-1");
    git("worktree", "add", "-q", "--detach", linked);
    const brief = writeBrief(scratch, "continuation-2026-11-06.md", 5);
    writeBrief(join(linked, "scratch"), "continuation-2026-11-07.md", 1);
    expect(context(compacted(linked), markerRoot)).toContain(brief);
  });

  it("removes the session's ruleset-read record", () => {
    const { markerRoot, checkout, marker } = setup();
    expect(existsSync(marker)).toBe(true);
    context(compacted(checkout), markerRoot);
    expect(existsSync(marker)).toBe(false);
  });

  it("adds nothing for a session that never read the ruleset", () => {
    const { markerRoot, checkout, scratch } = setup({ orchestrating: false });
    writeBrief(scratch, "continuation-2026-11-06.md", 5);
    expect(context(compacted(checkout), markerRoot)).toBeNull();
  });

  it("adds nothing and keeps the record for any other session start", () => {
    const { markerRoot, checkout, marker } = setup();
    for (const source of ["startup", "resume", "clear", undefined]) {
      expect(
        context(compacted(checkout, { source }), markerRoot),
        String(source),
      ).toBeNull();
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("adds nothing for an event it cannot read or key", () => {
    const { markerRoot, checkout } = setup();
    for (const payload of ["", "not json", "null", "[]", "7"]) {
      expect(context(payload, markerRoot), payload).toBeNull();
    }
    for (const session_id of [undefined, "", 7, ".."]) {
      expect(
        context(compacted(checkout, { session_id }), markerRoot),
        String(session_id),
      ).toBeNull();
    }
  });
});
