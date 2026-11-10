import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import {
  SliceOverSizeError,
  WORKING_VALUES,
  assertSliceBound,
  boundaryOf,
  cutByDirectory,
  fitHotThreshold,
  owedFiles,
  parseOwed,
  planDay,
  renderSlices,
  selectedLineCount,
  selectedRanges,
} from "./review-day-slices.mjs";

// The selectors run real git over repositories built here; the board read
// behind an owed pass's `Delivered by:` check is a stub, so no case touches the
// network.

const SCRIPT = fileURLToPath(
  new URL("./review-day-slices.mjs", import.meta.url),
);
const { makeFixture, makeTempDir, cleanup } = createGitFixtures();

afterEach(cleanup);

const textOfLines = (count, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

const noBoardRead = () => {
  throw new Error("the board was read");
};

/** A fixture repository holding one base commit. */
function baseRepo() {
  const fixture = makeFixture("review-day-slices-");
  fixture.write("README.md", "# Fixture\n");
  return { fixture, base: fixture.commit("Base") };
}

/** A days directory and the path of its day `name`, not yet created. */
function daysRoot() {
  const root = makeTempDir("review-days-");
  return { root, dayDir: join(root, "2026-11-20") };
}

/** Write the previous day's FINAL files under `root`. */
function previousDay(root, { owed, record } = {}) {
  const final = join(root, "2026-11-06", "FINAL");
  mkdirSync(final, { recursive: true });
  if (owed !== undefined) writeFileSync(join(final, "owed.md"), owed);
  if (record !== undefined)
    writeFileSync(join(final, "record.json"), JSON.stringify(record));
  writeFileSync(join(final, "ledger.jsonl"), "");
}

const runScript = (cwd, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

describe("usage", () => {
  it("prints its usage and exits 2 with no arguments", () => {
    const result = runScript(process.cwd(), []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Usage: node .claude/scripts/review-day-slices.mjs",
    );
  });
});

describe("the slice size bound", () => {
  it("refuses an over-size slice and writes nothing", () => {
    const { fixture, base } = baseRepo();
    fixture.write("src/big.ts", textOfLines(WORKING_VALUES.maxSliceLines + 1));
    const head = fixture.commit("Add a large file");
    const { dayDir } = daysRoot();

    const result = runScript(fixture.dir, [head, dayDir, "--prev", base]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `is ${WORKING_VALUES.maxSliceLines + 1} lines, over the ${WORKING_VALUES.maxSliceLines}-line bound: src/big.ts`,
    );
    expect(existsSync(join(dayDir, "SLICES.md"))).toBe(false);
    expect(existsSync(join(dayDir, "plan.json"))).toBe(false);
  });

  it("splits a large directory and joins a small one to its neighbour", () => {
    const lines = { "a/x.ts": 6, "a/y.ts": 6, "b/z.ts": 3 };
    const pieces = cutByDirectory(Object.keys(lines), (p) => lines[p], 10);
    expect(pieces).toEqual([
      { files: ["a/x.ts"], lines: 6 },
      { files: ["a/y.ts", "b/z.ts"], lines: 9 },
    ]);
  });

  it("keeps a single over-size file alone for the bound check to refuse", () => {
    const lines = { "a/x.ts": 12, "a/y.ts": 2 };
    const pieces = cutByDirectory(Object.keys(lines), (p) => lines[p], 10);
    expect(pieces[0]).toEqual({ files: ["a/x.ts"], lines: 12 });
    const slices = pieces.map((piece, i) => ({
      id: `hot-${i + 1}`,
      selector: "hot",
      lens: 4,
      ...piece,
    }));
    expect(() => assertSliceBound(slices, 10)).toThrow(SliceOverSizeError);
  });
});

describe("hot-file threshold fitting", () => {
  it("picks the N whose set comes closest to the line target", () => {
    const counts = new Map([
      ["a.ts", 3],
      ["b.ts", 2],
      ["c.ts", 1],
    ]);
    const lines = { "a.ts": 100, "b.ts": 100, "c.ts": 1000 };
    const lineOf = (path) => lines[path];
    expect(fitHotThreshold(counts, lineOf, 210)).toEqual({
      threshold: 2,
      files: ["a.ts", "b.ts"],
      lines: 200,
    });
    expect(fitHotThreshold(counts, lineOf, 1000).threshold).toBe(1);
    expect(fitHotThreshold(counts, lineOf, 0).threshold).toBe(3);
  });

  it("fits N over the window's pull-request counts to reach the target", () => {
    const { fixture, base } = baseRepo();
    fixture.write("src/a.ts", textOfLines(100, "a1"));
    fixture.write("src/b.ts", textOfLines(100, "b1"));
    fixture.write("src/c.ts", textOfLines(1000, "c1"));
    fixture.commit("One");
    fixture.write("src/a.ts", textOfLines(100, "a2"));
    fixture.write("src/b.ts", textOfLines(100, "b2"));
    fixture.commit("Two");
    fixture.write("src/a.ts", textOfLines(100, "a3"));
    const head = fixture.commit("Three");
    const { dayDir } = daysRoot();

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: base,
      deliveredBy: noBoardRead,
      workingValues: { ...WORKING_VALUES, hotLineTarget: 210 },
    });

    expect(plan.hotThreshold).toBe(2);
    expect(plan.hotLines).toBe(200);
    const hot = plan.slices.filter((slice) => slice.selector === "hot");
    expect(hot.flatMap((slice) => slice.files)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

describe("hot files the previous day read whole", () => {
  it("skips one unchanged since and keeps one changed since", () => {
    const { fixture, base } = baseRepo();
    fixture.write("src/a.ts", textOfLines(10, "a"));
    fixture.write("src/b.ts", textOfLines(10, "b1"));
    const readAt = fixture.commit("Both");
    fixture.write("src/b.ts", textOfLines(10, "b2"));
    const head = fixture.commit("Only b");
    const { root, dayDir } = daysRoot();
    previousDay(root, {
      record: {
        sha: readAt,
        slices: [{ filesReadWhole: ["src/a.ts", "src/b.ts"] }],
      },
    });

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: base,
      deliveredBy: noBoardRead,
    });

    expect(plan.skippedHotFiles).toEqual(["src/a.ts"]);
    const hotFiles = plan.slices
      .filter((slice) => slice.selector === "hot")
      .flatMap((slice) => slice.files);
    expect(hotFiles).toEqual(["src/b.ts"]);
  });

  it("starts the window at the previous day's record sha without --prev", () => {
    const { fixture } = baseRepo();
    fixture.write("src/a.ts", textOfLines(10, "a"));
    const readAt = fixture.commit("One");
    fixture.write("src/a.ts", textOfLines(10, "a2"));
    const head = fixture.commit("Two");
    const { root, dayDir } = daysRoot();
    previousDay(root, { record: { sha: readAt, slices: [] } });

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      deliveredBy: noBoardRead,
    });

    expect(plan.prevSha).toBe(readAt);
    expect(plan.window.commits).toBe(1);
  });
});

describe("owed passes", () => {
  const OWED = [
    "# Owed passes",
    "",
    "One owed pass per line: `lens | files or slice | reason | blocked by`.",
    "",
    "- 2 | `src/a.ts` | fix not merged | 9/111",
    "- 2 | `b.ts` | fix merged | 9/222",
    "- 1 | `src/c.ts:10-12` | nothing blocks it | -",
    "- 4 | `src/a.ts` | item gone | 10/333",
    "- 4 | S7 split | waits on another line | S2",
    "",
  ].join("\n");

  it("carries a pass over until its fix item has a Delivered by: line", () => {
    const { fixture, base } = baseRepo();
    for (const name of ["a", "b", "c"])
      fixture.write(`src/${name}.ts`, textOfLines(5, name));
    const head = fixture.commit("Sources");
    const { root, dayDir } = daysRoot();
    previousDay(root, { owed: OWED });
    const reads = [];
    const deliveredBy = (refs) => {
      reads.push(refs);
      return new Map([
        ["9/111", false],
        ["9/222", true],
        ["10/333", undefined],
      ]);
    };

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: base,
      deliveredBy,
    });

    expect(reads).toEqual([["9/111", "9/222", "10/333"]]);
    const owed = plan.slices.filter((slice) => slice.selector === "owed");
    expect(
      owed.map(({ files, lens, reason }) => ({ files, lens, reason })),
    ).toEqual([
      { files: ["src/b.ts"], lens: 2, reason: "fix merged" },
      { files: ["src/c.ts"], lens: 1, reason: "nothing blocks it" },
    ]);
    expect(plan.carried.map(({ target, why }) => ({ target, why }))).toEqual([
      { target: "`src/a.ts`", why: "9/111 has no Delivered by: line" },
      { target: "`src/a.ts`", why: "10/333 was not found on its board" },
      { target: "S7 split", why: "S2 is not a board item" },
    ]);
  });

  it("refuses an owed line whose lens is not 1-4", () => {
    expect(() => parseOwed("- 5 | `a.ts` | why | -\n")).toThrow(
      'owed.md line 1: the lens field is "5", not 1-4',
    );
  });

  it("stops the run on an owed list line with three fields", () => {
    const { fixture, base } = baseRepo();
    const { root, dayDir } = daysRoot();
    previousDay(root, {
      owed: "# Owed\n\n- 2 | `a.ts` | no blocked-by field\n",
    });

    const result = runScript(fixture.dir, [base, dayDir, "--prev", base]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'owed.md line 3: a list line has 3 of the 4 fields "lens | files | reason | blocked by"',
    );
  });

  it("takes the owed list and sha from the newest day with FINAL/, past an aborted one", () => {
    const { fixture } = baseRepo();
    fixture.write("src/a.ts", textOfLines(5, "a"));
    const readAt = fixture.commit("One");
    fixture.write("src/a.ts", textOfLines(5, "a2"));
    const head = fixture.commit("Two");
    const { root, dayDir } = daysRoot();
    previousDay(root, {
      owed: "- 1 | `src/a.ts` | a spec range left unread | -\n",
      record: { sha: readAt, slices: [] },
    });
    const aborted = join(root, "2026-11-13");
    mkdirSync(aborted);
    writeFileSync(join(aborted, "summary.md"), "Stopped at Step 1.\n");

    const result = runScript(fixture.dir, [head, dayDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `not the previous day: ${aborted}, which has no FINAL/ directory`,
    );
    const plan = JSON.parse(readFileSync(join(dayDir, "plan.json"), "utf8"));
    expect(plan.previousDay).toBe(join(root, "2026-11-06"));
    expect(plan.skippedDays).toEqual([aborted]);
    expect(plan.prevSha).toBe(readAt);
    const owed = plan.slices.filter((slice) => slice.selector === "owed");
    expect(owed.map(({ files, reason }) => ({ files, reason }))).toEqual([
      { files: ["src/a.ts"], reason: "a spec range left unread" },
    ]);
  });

  it("says so and runs with no owed passes when the previous FINAL/ has no owed.md", () => {
    const { fixture, base } = baseRepo();
    fixture.write("src/a.ts", textOfLines(5, "a"));
    const head = fixture.commit("One");
    const { root, dayDir } = daysRoot();
    previousDay(root, { record: { sha: base, slices: [] } });
    const day = join(root, "2026-11-06");
    const note = `Owed passes: ${day} has a FINAL/ directory but no owed.md, so no owed passes were read from it.`;

    const result = runScript(fixture.dir, [head, dayDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${note}\n`);
    const plan = JSON.parse(readFileSync(join(dayDir, "plan.json"), "utf8"));
    expect(plan.owedNote).toBe(note);
    expect(plan.slices.some((slice) => slice.selector === "owed")).toBe(false);
    expect(readFileSync(join(dayDir, "SLICES.md"), "utf8")).toContain(
      `${note}\n`,
    );
  });

  it("resolves backticked paths, stems and directories to tracked files", () => {
    const tracked = ["apps/x/run/prepare.ts", "apps/x/authoring/a.ts", "b.ts"];
    expect(
      owedFiles(
        "`run/prepare.ts` and `apps/x/authoring/` beside `scanFrame`",
        tracked,
      ),
    ).toEqual(["apps/x/authoring/a.ts", "apps/x/run/prepare.ts"]);
  });
});

describe("plan.json", () => {
  /** A repository whose window adds a protocol deserializer, a doc and a spec line. */
  function windowWithEverySelector() {
    const { fixture, base } = baseRepo();
    fixture.write(
      "packages/core/src/psi/frameReader.ts",
      "export function parseReaderFrame(text) {\n  return JSON.parse(text);\n}\n",
    );
    fixture.write("docs/GUIDE.md", "# Guide\n\nRun it.\n");
    fixture.write(
      "docs/spec/FRAMES.md",
      "# Frames\n\nparseReaderFrame refuses a frame over the cap.\n",
    );
    fixture.write("tools/idle.mjs", "export const idle = 1;\n");
    const head = fixture.commit("Add a frame reader");
    return { fixture, base, head };
  }

  it("records id, lens, files, lines, selector and estimated cost per slice", () => {
    const { fixture, base, head } = windowWithEverySelector();
    const { root, dayDir } = daysRoot();
    previousDay(root, {
      owed: "- 2 | `frameReader.ts` | an unread residue | -\n",
    });

    const result = runScript(fixture.dir, [head, dayDir, "--prev", base]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(readFileSync(join(dayDir, "plan.json"), "utf8"));
    expect(plan.sha).toBe(head);
    expect(plan.prevSha).toBe(base);
    for (const slice of plan.slices) {
      expect(Object.keys(slice)).toEqual(
        expect.arrayContaining([
          "id",
          "lens",
          "files",
          "lines",
          "selector",
          "estimatedCost",
        ]),
      );
      const counted = slice.files.reduce(
        (sum, path) =>
          sum + fixture.git(["show", `${head}:${path}`]).split("\n").length - 1,
        0,
      );
      expect(slice.lines).toBe(counted);
      expect(slice.estimatedCost).toBe(WORKING_VALUES.unitCosts[slice.lens]);
    }
    expect(
      plan.slices.map(({ id, selector, lens, files }) => ({
        id,
        selector,
        lens,
        files,
      })),
    ).toEqual([
      {
        id: "owed-1",
        selector: "owed",
        lens: 2,
        files: ["packages/core/src/psi/frameReader.ts"],
      },
      {
        id: "census-1",
        selector: "census",
        lens: 2,
        files: ["packages/core/src/psi/frameReader.ts"],
      },
      {
        id: "hot-1",
        selector: "hot",
        lens: 4,
        files: ["packages/core/src/psi/frameReader.ts", "tools/idle.mjs"],
      },
      {
        id: "outward-1",
        selector: "outward",
        lens: 3,
        files: ["docs/GUIDE.md"],
      },
      {
        id: "stale-spec-1",
        selector: "stale-spec",
        lens: 1,
        files: ["docs/spec/FRAMES.md", "packages/core/src/psi/frameReader.ts"],
      },
    ]);
    const census = plan.slices.find((slice) => slice.id === "census-1");
    expect(census.boundary).toBe("L2-protocol");
    expect(census.kinds).toEqual({
      "packages/core/src/psi/frameReader.ts": ["deserializer"],
    });
    const spec = plan.slices.find((slice) => slice.id === "stale-spec-1");
    expect(spec.statements).toEqual([
      {
        path: "docs/spec/FRAMES.md",
        line: 3,
        names: ["parseReaderFrame"],
        code: { "packages/core/src/psi/frameReader.ts": ["parseReaderFrame"] },
      },
    ]);
    expect(spec.regions).toEqual({
      "packages/core/src/psi/frameReader.ts": [[1, 3]],
    });
    const total =
      Math.round(
        plan.slices.reduce((sum, slice) => sum + slice.estimatedCost, 0) * 100,
      ) / 100;
    expect(plan.totalEstimate).toBe(total);
    expect(result.stdout).toContain(`estimated total: $${total.toFixed(2)}`);
    expect(readFileSync(join(dayDir, "SLICES.md"), "utf8")).toContain(
      "## census-1: census, lens 2",
    );
  });

  it("runs the first day, with no previous day, without owed passes", () => {
    const { fixture, base, head } = windowWithEverySelector();
    const { dayDir } = daysRoot();

    const result = runScript(fixture.dir, [head, dayDir, "--prev", base]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(readFileSync(join(dayDir, "plan.json"), "utf8"));
    expect(plan.previousDay).toBeNull();
    expect(plan.slices.some((slice) => slice.selector === "owed")).toBe(false);
  });

  it("asks for --prev when no previous day names the window's start", () => {
    const { fixture, head } = windowWithEverySelector();
    const { dayDir } = daysRoot();

    const result = runScript(fixture.dir, [head, dayDir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--prev <sha>");
  });
});

describe("slices sized by the lines they match", () => {
  it("counts each match with its context, overlaps once, inside the file", () => {
    expect(selectedLineCount([10], 100, 5)).toBe(11);
    expect(selectedLineCount([10, 12, 10], 100, 5)).toBe(13);
    expect(selectedLineCount([2, 99], 100, 5)).toBe(7 + 7);
    expect(selectedLineCount([], 100, 5)).toBe(0);
    expect(selectedRanges([10, 12, 30, 41], 100, 5)).toEqual([
      [5, 17],
      [25, 46],
    ]);
    expect(selectedRanges([2, 99], 100, 5)).toEqual([
      [1, 7],
      [94, 100],
    ]);
  });

  it("sizes user-string and stale-spec slices by their matches and lists each string", () => {
    const { fixture } = baseRepo();
    const source = (message) =>
      [
        "export function refuseLongFrame(frame) {",
        ...Array.from({ length: 98 }, (_, i) =>
          i === 48 ? "  refuseLongFrame(frame);" : `  const step${i} = frame;`,
        ),
        `  throw new Error("${message}");`,
        ...Array.from({ length: 100 }, (_, i) => `  const tail${i} = frame;`),
        "}",
        "",
      ].join("\n");
    fixture.write("apps/cli/src/frames.ts", source("Frame too long"));
    fixture.write(
      "docs/spec/LONG.md",
      Array.from({ length: 300 }, (_, i) =>
        i === 149 || i === 152 ? "refuseLongFrame refuses it." : `Prose ${i}.`,
      ).join("\n") + "\n",
    );
    const from = fixture.commit("Base sources");
    fixture.write(
      "apps/cli/src/frames.ts",
      source("The frame is over the limit. Send a shorter one."),
    );
    const head = fixture.commit("Reword the refusal");
    const { dayDir } = daysRoot();
    const context = WORKING_VALUES.matchContextLines;

    const result = runScript(fixture.dir, [head, dayDir, "--prev", from]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(readFileSync(join(dayDir, "plan.json"), "utf8"));
    const strings = plan.slices.find(
      (slice) => slice.kind === "user-visible strings",
    );
    expect(strings.files).toEqual(["apps/cli/src/frames.ts"]);
    expect(strings.strings).toEqual([
      {
        path: "apps/cli/src/frames.ts",
        line: 100,
        text: 'throw new Error("The frame is over the limit. Send a shorter one.");',
      },
    ]);
    expect(strings.lines).toBe(2 * context + 1);
    const spec = plan.slices.find((slice) => slice.selector === "stale-spec");
    expect(spec.statements.map(({ line }) => line)).toEqual([150, 153]);
    const codeLines =
      fixture.git(["show", `${head}:apps/cli/src/frames.ts`]).split("\n")
        .length - 1;
    const codeRegions = selectedLineCount([1, 50], codeLines, context);
    expect(codeRegions).toBeLessThan(codeLines);
    expect(spec.files).toEqual(["docs/spec/LONG.md", "apps/cli/src/frames.ts"]);
    expect(spec.lines).toBe(2 * context + 1 + 3 + codeRegions);
    expect(spec.regions).toEqual({
      "apps/cli/src/frames.ts": [
        [1, 1 + context],
        [50 - context, 50 + context],
      ],
    });
    const slicesText = readFileSync(join(dayDir, "SLICES.md"), "utf8");
    expect(slicesText).toContain(
      `  - apps/cli/src/frames.ts: lines 1-${1 + context}, ${50 - context}-${50 + context}\n`,
    );
    expect(slicesText).toContain("  - docs/spec/LONG.md\n");
    expect(slicesText).toContain(
      '  - apps/cli/src/frames.ts:100: throw new Error("The frame is over the limit. Send a shorter one.");',
    );
  });

  /** A 40-line reader file whose line `changed` reads differently in `variant`. */
  const readerSource = (variant, changed = 0) =>
    [
      "export function readOne() {",
      ...Array.from({ length: 38 }, (_, i) =>
        i + 2 === changed
          ? `  const changed = "${variant}";`
          : `  const step${i} = 1;`,
      ),
      "}",
      "",
    ].join("\n");
  const READER_SPEC = "# Reader\n\nframeReader is described here.\n";
  const READER_PATH = "apps/cli/src/frameReader.ts";

  it("charges the lines the window changed in a file a statement names only by its stem", () => {
    const { fixture } = baseRepo();
    fixture.write(READER_PATH, readerSource("a"));
    fixture.write("docs/spec/READER.md", READER_SPEC);
    const from = fixture.commit("Add a reader");
    fixture.write(READER_PATH, readerSource("b", 20));
    const head = fixture.commit("Change one line");
    const { dayDir } = daysRoot();
    const context = WORKING_VALUES.matchContextLines;

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: from,
      deliveredBy: noBoardRead,
    });

    const spec = plan.slices.find((slice) => slice.selector === "stale-spec");
    expect(spec.statements).toEqual([
      {
        path: "docs/spec/READER.md",
        line: 3,
        names: ["frameReader"],
        code: { [READER_PATH]: ["frameReader"] },
      },
    ]);
    expect(spec.regions).toEqual({
      [READER_PATH]: [[20 - context, 20 + context]],
    });
    expect(spec.files).toEqual(["docs/spec/READER.md", READER_PATH]);
    expect(spec.lines).toBe(3 + 2 * context + 1);
    expect(renderSlices(plan)).toContain(
      `  - ${READER_PATH}: lines ${20 - context}-${20 + context}\n`,
    );
  });

  it("charges the whole file when the window has no hunk for a file named only by its stem", () => {
    const { fixture } = baseRepo();
    fixture.write(READER_PATH, readerSource("a"));
    fixture.write("docs/spec/READER.md", READER_SPEC);
    const from = fixture.commit("Add a reader");
    fixture.write(READER_PATH, readerSource("b", 20));
    fixture.commit("Change one line");
    fixture.write(READER_PATH, readerSource("a"));
    const head = fixture.commit("Revert it");
    const { dayDir } = daysRoot();

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: from,
      deliveredBy: noBoardRead,
    });

    const spec = plan.slices.find((slice) => slice.selector === "stale-spec");
    expect(spec.regions).toEqual({ [READER_PATH]: [[1, 40]] });
    expect(spec.files).toEqual(["docs/spec/READER.md", READER_PATH]);
    expect(spec.lines).toBe(3 + 40);
  });

  it("leaves a file only its strings were read from open to rotation", () => {
    const { fixture, base } = baseRepo();
    fixture.write("apps/cli/src/hot.ts", textOfLines(10, "h1"));
    fixture.write(
      "apps/cli/src/strings.ts",
      'throw new Error("The key file is missing. Run init first.");\n',
    );
    fixture.commit("One");
    fixture.write("apps/cli/src/hot.ts", textOfLines(10, "h2"));
    const head = fixture.commit("Two");
    const { dayDir } = daysRoot();

    const plan = planDay({
      cwd: fixture.dir,
      sha: head,
      dayDir,
      prevSha: base,
      deliveredBy: noBoardRead,
      workingValues: { ...WORKING_VALUES, hotLineTarget: 10 },
    });

    expect(plan.hotThreshold).toBe(2);
    const strings = plan.slices.find(
      (slice) => slice.kind === "user-visible strings",
    );
    expect(strings.files).toEqual(["apps/cli/src/strings.ts"]);
    const rotation = plan.slices.find((slice) => slice.selector === "rotation");
    expect(rotation.files).toEqual(["apps/cli/src/strings.ts"]);
  });
});

describe("the boundary table", () => {
  it("routes the file-sync files to SFTP and the rest of connection to WebRTC", () => {
    expect(
      boundaryOf("packages/core/src/connection/fileSyncWrite.ts")?.id,
    ).toBe("L2-sftp");
    expect(boundaryOf("packages/core/src/connection/chunkedAead.ts")?.id).toBe(
      "L2-webrtc",
    );
    expect(boundaryOf("apps/cli/src/connection/webrtc/weriftPeer.ts")?.id).toBe(
      "L2-webrtc",
    );
    expect(boundaryOf("apps/cli/src/connection/ssh2SftpAdapter.ts")?.id).toBe(
      "L2-sftp",
    );
    expect(boundaryOf("Dockerfile.fips")?.id).toBe("L2-delivery");
    expect(boundaryOf("docs/README.md")).toBeNull();
  });
});
