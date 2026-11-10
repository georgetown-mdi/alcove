import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { answerTrigger, retest, splitCommand } from "./parked-triggers.mjs";

const SCRIPT = fileURLToPath(new URL("./parked-triggers.mjs", import.meta.url));

// Stubbed board and commands: `statuses` maps "board/id" to a Status,
// `outputs` maps a command line to its stdout (absent: the command fails).
function deps({ statuses = {}, outputs = {} } = {}) {
  const ran = [];
  return {
    ran,
    readStatus: async (board, ids) =>
      new Map(ids.map((id) => [id, statuses[`${board}/${id}`] ?? null])),
    run: async (argv) => {
      const line = argv.join(" ");
      ran.push(line);
      return line in outputs
        ? { ok: true, stdout: outputs[line] }
        : { ok: false, stdout: "" };
    },
  };
}

describe("board triggers", () => {
  it("fires when every item named is Done", async () => {
    const d = deps({ statuses: { "10/1": "Done", "10/2": "Done" } });
    expect(await answerTrigger("board 10 items 1 and 2 are Done", d)).toEqual({
      verdict: "fired",
      detail: "Done",
    });
  });

  it("does not fire while an item is not Done", async () => {
    const d = deps({ statuses: { "9/1": "Todo" } });
    expect(await answerTrigger("board 9 item 1 is Done", d)).toEqual({
      verdict: "not fired",
      detail: "not Done: 1",
    });
  });

  it("cannot answer when an item cannot be read", async () => {
    expect(
      (await answerTrigger("board 9 item 1 is Done", deps())).verdict,
    ).toBe("cannot answer");
  });
});

describe("npm view triggers", () => {
  const release =
    "ssh2 publishes a release after 1.17.0 (`npm view ssh2 version`)";
  const admits =
    "typescript-eslint's latest release admits typescript 7 (`npm view typescript-eslint peerDependencies`)";

  it("fires on a version later than the one named, run with --json", async () => {
    const d = deps({
      outputs: { "npm view ssh2 version --json": '"1.18.0"\n' },
    });
    expect(await answerTrigger(release, d)).toEqual({
      verdict: "fired",
      detail: "npm view ssh2 version --json",
    });
    expect(d.ran).toEqual(["npm view ssh2 version --json"]);
  });

  it("does not fire on the version named", async () => {
    const d = deps({
      outputs: { "npm view ssh2 version --json": '"1.17.0"\n' },
    });
    expect((await answerTrigger(release, d)).verdict).toBe("not fired");
  });

  it("fires when the range printed admits the major named, and not otherwise", async () => {
    const line = "npm view typescript-eslint peerDependencies --json";
    const fired = deps({
      outputs: { [line]: '{"eslint":"^9","typescript":">=4.8.4 <7.1.0"}' },
    });
    expect((await answerTrigger(admits, fired)).verdict).toBe("fired");
    const notFired = deps({
      outputs: { [line]: '{"eslint":"^9","typescript":">=4.8.4 <6.1.0"}' },
    });
    expect((await answerTrigger(admits, notFired)).verdict).toBe("not fired");
  });

  it("cannot answer when the command fails", async () => {
    expect((await answerTrigger(release, deps())).verdict).toBe(
      "cannot answer",
    );
  });
});

describe("gh release list triggers", () => {
  const names = "`gh release list` names v1.0.0";
  const form =
    "`gh release list --exclude-drafts --json tagName --jq '.[].tagName'` prints a tag of the form `vX.Y.Z`";
  const formLine =
    "gh release list --exclude-drafts --json tagName --jq .[].tagName";

  it("fires when the output names the tag", async () => {
    const d = deps({
      outputs: {
        "gh release list": "Alcove 1.0.0\tLatest\tv1.0.0\t2026-12-01\n",
      },
    });
    expect((await answerTrigger(names, d)).verdict).toBe("fired");
  });

  it("does not fire when it does not", async () => {
    const d = deps({
      outputs: {
        "gh release list":
          "Alcove 1.0.0-rc.1\tPre-release\tv1.0.0-rc.1\t2026-11-20\n",
      },
    });
    expect((await answerTrigger(names, d)).verdict).toBe("not fired");
  });

  it("fires on a vX.Y.Z tag and not on a pre-release tag", async () => {
    expect(
      (
        await answerTrigger(
          form,
          deps({ outputs: { [formLine]: "v1.0.0-rc.1\nv1.0.0\n" } }),
        )
      ).verdict,
    ).toBe("fired");
    expect(
      (
        await answerTrigger(
          form,
          deps({ outputs: { [formLine]: "v1.0.0-rc.1\n" } }),
        )
      ).verdict,
    ).toBe("not fired");
  });
});

describe("unanswerable triggers", () => {
  it("cannot answer a trigger no board read or command answers, and runs nothing", async () => {
    const d = deps();
    for (const trigger of [
      "a migration table at origin/staging holds a step",
      "`git ls-remote --heads origin release/v1.0.0` prints a ref",
      "`npm view ssh2 version; rm -rf x` prints a version",
      "`gh release list` lists something new",
    ]) {
      expect((await answerTrigger(trigger, d)).verdict).toBe("cannot answer");
    }
    expect(d.ran).toEqual(["gh release list"]);
  });

  it("refuses shell syntax in a command", () => {
    expect(splitCommand("gh release list --jq '.[].tagName'")).toEqual([
      "gh",
      "release",
      "list",
      "--jq",
      ".[].tagName",
    ]);
    expect(splitCommand("npm view x | head")).toBeNull();
    expect(splitCommand("npm view $(x)")).toBeNull();
  });
});

describe("retest", () => {
  it("answers each parked item on each board, its date removed", async () => {
    const d = deps({ statuses: { "9/5": "Done" } });
    d.listParked = async (board) =>
      board === 9
        ? [
            {
              id: 1,
              title: "Wait on item 5",
              parkedUntil: "board 9 item 5 is Done (2026-10-24)",
            },
          ]
        : [
            {
              id: 2,
              title: "Wait on a host",
              parkedUntil: "the host is rebuilt (2026-10-24)",
            },
          ];
    expect(await retest([9, 10], d)).toEqual([
      {
        board: 9,
        id: 1,
        title: "Wait on item 5",
        trigger: "board 9 item 5 is Done",
        verdict: "fired",
        detail: "Done",
      },
      {
        board: 10,
        id: 2,
        title: "Wait on a host",
        trigger: "the host is rebuilt",
        verdict: "cannot answer",
        detail: "no board read or command answers it",
      },
    ]);
  });

  it("answers the other items when one board read throws", async () => {
    const d = deps({ statuses: { "9/5": "Done" } });
    const read = d.readStatus;
    d.readStatus = async (board, ids) => {
      if (board === 7) throw new Error("no such board");
      return read(board, ids);
    };
    d.listParked = async () => [
      {
        id: 1,
        title: "Bad",
        parkedUntil: "board 7 item 1 is Done (2026-10-24)",
      },
      {
        id: 2,
        title: "Good",
        parkedUntil: "board 9 item 5 is Done (2026-10-24)",
      },
    ];
    const rows = await retest([9], d);
    expect(rows.map((r) => [r.id, r.verdict])).toEqual([
      [1, "cannot answer"],
      [2, "fired"],
    ]);
    expect(rows[0].detail).toContain("no such board");
  });

  it("prints its usage when run with no args", () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "Usage: node parked-triggers.mjs <project-number>...",
    );
  });
});
