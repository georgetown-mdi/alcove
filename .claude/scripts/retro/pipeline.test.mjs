import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  assistant,
  sessionId,
  tempDir,
  usage,
  user,
  writeProject,
} from "./transcriptFixtures.mjs";

const step = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function run(name, args) {
  const result = spawnSync(process.execPath, [step(name), ...args], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("the four steps from the command line", () => {
  it("aggregate, cost, map and analyze write their files to the directories they are given", () => {
    const root = tempDir();
    dirs.push(root);
    const at = "2026-01-11T10:00:00Z";
    writeProject(
      path.join(root, "projects"),
      "-workspace",
      {
        [sessionId(1)]: {
          main: [
            user(at, "Please fix the parser.", { gitBranch: "fix-parser" }),
            assistant(at, {
              id: "msg_fixture_pipeline",
              u: usage({ input: 1e6 }),
              gitBranch: "fix-parser",
            }),
          ],
        },
      },
      new Date("2026-01-11T12:00:00Z"),
    );
    const prs = path.join(root, "prs.json");
    fs.writeFileSync(
      prs,
      JSON.stringify([
        {
          number: 2101,
          title: "Fix the parser",
          state: "MERGED",
          mergedAt: at,
          headRefName: "fix-parser",
          author: { login: "maintainer" },
          additions: 5,
          deletions: 1,
          changedFiles: 1,
        },
      ]),
    );
    const agg = path.join(root, "store.json");
    const out = path.join(root, "out");
    run("aggregate", [
      "--store",
      "fixture",
      "--cut",
      "2026-01-10T00:00:00Z",
      "--end",
      "2026-01-12T00:00:00Z",
      "--pr-range",
      "2100-2199",
      "--out",
      agg,
      "--root",
      path.join(root, "projects"),
    ]);
    run("cost", ["--out-dir", out, agg]);
    run("map", ["--dir", out, "--prs", prs, "--pr-range", "2100-2199"]);
    run("analyze", ["--dir", out]);
    expect(fs.readdirSync(out).sort()).toEqual([
      "agents.json",
      "analysis.json",
      "map-summary.json",
      "pr-cost.json",
      "rollups.json",
      "sessions-enriched.json",
    ]);
    const read = (f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8"));
    expect(read("rollups.json").grandTotalUSD).toBe(4);
    expect(read("map-summary.json")).toMatchObject({
      mergedPrs: 1,
      meanPerMergedPr: 4,
    });
    expect(read("pr-cost.json")[0]).toMatchObject({ number: 2101, costD: 4 });
  });
});
