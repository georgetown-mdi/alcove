import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "verify-fix-shape.mjs",
);
const TARGET = "feature-branch";

const { makeFixture, makeTempDir, cleanup } = createGitFixtures();
let tree;
let resultDir;
beforeAll(() => {
  const fixture = makeFixture("verify-fix-shape-");
  fixture.write("a.ts", "let x = 1;\nlet y = 2;\nlet y = 3;\n");
  fixture.commit("fixture");
  fixture.git(["branch", "-m", TARGET]);
  // Moving the working tree off the target ref shows the script reads the ref,
  // not the files on disk.
  fixture.git(["checkout", "-q", "-b", "elsewhere"]);
  fixture.write("a.ts", "let z = 1;\n");
  fixture.commit("elsewhere");
  tree = fixture.dir;
  resultDir = makeTempDir("verify-fix-shape-result-");
});
afterAll(cleanup);

const edit = (oldText, file = "a.ts") => ({ file, oldText, newText: "const" });
const cluster = (name, edits) => ({
  name,
  verification: "confirmed",
  edits,
  verifyCommand: "true",
});

function verify(saved, extra = ["--worktree", tree]) {
  const file = join(resultDir, "result.json");
  writeFileSync(file, JSON.stringify(saved));
  const run = spawnSync(process.execPath, [SCRIPT, TARGET, file, ...extra], {
    encoding: "utf8",
  });
  return { status: run.status, lines: run.stdout.trim().split("\n") };
}

describe("verify-fix-shape", () => {
  it("calls a cluster mechanical when its old text occurs exactly once at the target ref", () => {
    expect(
      verify({
        result: { clusters: [cluster("unique", [edit("let y = 2;")])] },
      }),
    ).toEqual({ status: 0, lines: ["mechanical unique"] });
  });

  it("calls a cluster judgment when an edit's old text is absent", () => {
    expect(
      verify({
        clusters: [cluster("absent", [edit("let x"), edit("let z")])],
      }),
    ).toEqual({
      status: 1,
      lines: ["judgment absent -- the old text is not in a.ts"],
    });
  });

  it("calls a cluster judgment when an edit's old text occurs more than once", () => {
    expect(
      verify({ clusters: [cluster("repeated", [edit("let y")])] }),
    ).toEqual({
      status: 1,
      lines: [
        "judgment repeated -- the old text occurs more than once in a.ts",
      ],
    });
  });

  it("calls a cluster judgment when its file is not at the target ref", () => {
    const { status, lines } = verify({
      clusters: [cluster("missing", [edit("let x", "missing.ts")])],
    });
    expect(status).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^judgment missing -- git cannot show missing\.ts: .*missing\.ts/,
    );
  });

  it("reports only the clusters carrying edits, and fails when any is judgment", () => {
    expect(
      verify({
        result: {
          clusters: [
            cluster("unique", [edit("let x")]),
            { name: "no edits", verification: "confirmed" },
            cluster("repeated", [edit("let y")]),
          ],
        },
      }),
    ).toEqual({
      status: 1,
      lines: [
        "mechanical unique",
        "judgment repeated -- the old text occurs more than once in a.ts",
      ],
    });
  });

  it("refuses a result file with no clusters list", () => {
    expect(verify({ result: { claims: [] } }).status).toBe(2);
  });
});
