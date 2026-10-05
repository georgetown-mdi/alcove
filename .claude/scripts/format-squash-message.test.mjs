import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BODY_WRAP_COLUMNS,
  bodyLinesOf,
  fenced,
  formatDraft,
  normalizeDraft,
  parseArgs,
  refusals,
  violations,
  wrapParagraph,
} from "./format-squash-message.mjs";

const SCRIPT = fileURLToPath(
  new URL("./format-squash-message.mjs", import.meta.url),
);
const REPO_ROOT = join(dirname(SCRIPT), "..", "..");

const directories = [];
afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "format-squash-"));
  directories.push(directory);
  return directory;
}

/** Run the script the way a session does, returning its streams and status. */
function run(args, input = "") {
  return spawnSync("node", [SCRIPT, ...args], { input, encoding: "utf8" });
}

const draft = (body) => `${body}\n`;
const bodyLines = (text) => bodyLinesOf(text).filter((l) => l !== "");

describe("format-squash-message wrapping", () => {
  it("rewraps a paragraph written at 120 columns", () => {
    const paragraph = Array.from({ length: 24 }, (_, i) => `word${i}`).join(
      " ",
    );
    const wide = `${paragraph} ${paragraph}`;
    expect(wide.length).toBeGreaterThan(120);

    const normalized = normalizeDraft(draft(wide));
    for (const line of bodyLines(normalized)) {
      expect(line.length).toBeLessThanOrEqual(BODY_WRAP_COLUMNS);
    }
    expect(bodyLines(normalized).join(" ")).toBe(wide);
  });

  it("keeps paragraphs apart and collapses repeated blank lines", () => {
    const normalized = normalizeDraft("\n\nFirst.\n\n\n\nSecond.\n\n");
    expect(normalized).toBe("First.\n\nSecond.\n");
  });

  it("leaves an indented block exactly as it was written", () => {
    const block = "  alcove exchange --config a.yaml\n  alcove doctor";
    expect(normalizeDraft(draft(block))).toBe(`${block}\n`);
  });

  it("gives a word longer than the budget a line of its own", () => {
    const word = "x".repeat(BODY_WRAP_COLUMNS + 20);
    const lines = wrapParagraph(`start ${word} end`);
    expect(lines).toEqual(["start", word, "end"]);
  });
});

// One case per marker the normalizer takes out. Each body normalizes to the
// text beside it.
const NORMALIZED = [
  {
    name: "a heading marker, whose line becomes a paragraph",
    body: "## Motivation\nThe rules had two copies.",
    want: "Motivation\n\nThe rules had two copies.",
  },
  {
    name: "asterisk emphasis",
    body: "This is **strong** and *slanted* text.",
    want: "This is strong and slanted text.",
  },
  {
    name: "underscore emphasis, leaving an identifier alone",
    body: "This is __strong__ and _slanted_, unlike snake_case_name.",
    want: "This is strong and slanted, unlike snake_case_name.",
  },
  {
    name: "an inline code span",
    body: "This names `a code span` in a body.",
    want: "This names a code span in a body.",
  },
  {
    name: "a link, whose url follows the text",
    body: "See [the design](docs/DESIGN.md) for context.",
    want: "See the design (docs/DESIGN.md) for context.",
  },
  {
    name: "a link whose text already holds the url",
    body: "See [docs/DESIGN.md](docs/DESIGN.md) for context.",
    want: "See docs/DESIGN.md for context.",
  },
  {
    name: "a code fence, whose line is dropped whole",
    body: "```\nA sentence the run wrapped in a fence.\n```",
    want: "A sentence the run wrapped in a fence.",
  },
  {
    name: "a blockquote marker",
    body: "> A quoted line.",
    want: "A quoted line.",
  },
  {
    name: "a bullet item, which becomes its own paragraph",
    body: "- first point\n* second point\n+ third point",
    want: "first point\n\nsecond point\n\nthird point",
  },
  {
    name: "a numbered item in either spelling",
    body: "1. first point\n2) second point",
    want: "first point\n\nsecond point",
  },
  {
    name: "an item's continuation lines, joined into it",
    body: "- first point\n  continued on the next line",
    want: "first point continued on the next line",
  },
  {
    name: "a nested item, which rides with its parent paragraph",
    body: "- first point\n  - a point under it",
    want: "first point a point under it",
  },
  {
    name: "a list under a lead-in line, which stays a paragraph",
    body: "The points:\n- one\n- two",
    want: "The points:\n\none\n\ntwo",
  },
  {
    name: "a list under a heading, with no blank line between them",
    body: "## Steps\n- one\n- two",
    want: "Steps\n\none\n\ntwo",
  },
  {
    name: "a numbered list under a heading",
    body: "## Steps\n1. one\n2. two",
    want: "Steps\n\none\n\ntwo",
  },
  {
    name: "a list under a lead-in whose colon is inside emphasis",
    body: "**The points:**\n- one\n- two",
    want: "The points:\n\none\n\ntwo",
  },
  {
    name: "prose whose wrapped line opens on a year",
    body: "The release landed and\n2026. The next one is in May.",
    want: "The release landed and 2026. The next one is in May.",
  },
];

describe("format-squash-message normalizing", () => {
  for (const { name, body, want } of NORMALIZED) {
    it(`takes out ${name}`, () => {
      expect(normalizeDraft(draft(body))).toBe(`${want}\n`);
      expect(refusals(draft(body))).toEqual([]);
    });
  }

  it("is a fixed point: normalizing its own output changes nothing", () => {
    const drafts = [
      draft(`${"word ".repeat(40)}end`),
      "\r\nBody sentence.   \r\n\r\n",
      ...NORMALIZED.map(({ body }) => draft(body)),
    ];
    for (const source of drafts) {
      const once = normalizeDraft(source);
      expect(normalizeDraft(once), source).toBe(once);
      expect(violations(once), source).toEqual([]);
    }
  });
});

// Draft shapes the normalizer must leave nothing in for its own check to
// report: every marker kind above, plus the combinations a `claude -p` answer
// arrives in -- a list under a heading, a nested item, a fence around prose, an
// indented block, a paragraph written at some other width.
const CORPUS = [
  ...NORMALIZED.map(({ body }) => body),
  "## Steps\n- one\n  - nested under one\n- two\n\nClosing prose.",
  "Intro line.\n## A heading mid-block\n- one\n- two",
  "The points:\n1. one\n2) two\n\n> a quoted line\n\n```\na fenced line\n```",
  "See [the design](docs/DESIGN.md):\n- **first** point\n- `second` point",
  "  alcove exchange --config a.yaml\n  alcove doctor",
  "## Heading\n\n    an indented block under it",
  "## Heading\n- item\n\n    an indented block after the list",
  `${"word ".repeat(40)}end`,
  `Lead-in:\n- ${"word ".repeat(30)}end\n- second`,
  "A paragraph.\n\n## Another heading\n+ plus item\n+ another",
];

describe("format-squash-message normalized output", () => {
  it("leaves nothing for the check to report, whatever the shape", () => {
    for (const body of CORPUS) {
      const once = normalizeDraft(draft(body));
      expect(violations(once), body).toEqual([]);
      expect(normalizeDraft(once), body).toBe(once);
    }
  });
});

describe("format-squash-message refusals", () => {
  const refusedFor = (body) => refusals(draft(body));

  it("refuses an over-wide line inside an indented block", () => {
    const found = refusedFor(`  ${"x".repeat(BODY_WRAP_COLUMNS)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Indented");
  });

  it("refuses an empty draft", () => {
    expect(refusals("   \n\n")).toHaveLength(1);
  });

  it("refuses nothing normalizing can fix without losing a word", () => {
    for (const { body } of NORMALIZED) {
      expect(refusedFor(body), body).toEqual([]);
    }
    expect(refusedFor(`${"word ".repeat(30)}end`)).toEqual([]);
  });

  it("passes a message shaped the way this repository writes them", () => {
    const body =
      "Squash drafts reached the maintainer with unwrapped body lines,\n" +
      "because both producers stated the rule in prose and nothing\n" +
      "checked the result.";
    expect(refusedFor(body)).toEqual([]);
    expect(violations(normalizeDraft(draft(body)))).toEqual([]);
  });
});

describe("format-squash-message violations", () => {
  it("reports the wrap a producer that cannot rewrite must refuse", () => {
    const wide = `${"word ".repeat(30)}end`;
    expect(refusals(draft(wide))).toEqual([]);
    expect(violations(draft(wide))).toHaveLength(1);
    expect(violations(draft(wide))[0]).toContain(String(BODY_WRAP_COLUMNS));
  });

  it("names the markdown and the list", () => {
    expect(violations(draft("## Motivation"))[0]).toContain("no markdown");
    expect(violations(draft("- first point"))[0]).toContain(
      "prose, not a list",
    );
  });

  it("reports a draft no rule names but the normalizer still changes", () => {
    const found = violations("Body sentence.\n\n\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("normalizer produces");
  });

  // A body wrapped by hand at some narrower column is not what the normalizer
  // produces, so the gate is byte identity with its output rather than "every
  // line fits": an edit that leaves the paragraph short is one command away
  // from normalized again.
  it("reports a paragraph hand-wrapped narrower than the column", () => {
    const body = "A body sentence broken\nearly, well under the column.";
    expect(violations(draft(body))).toHaveLength(1);
    expect(violations(normalizeDraft(draft(body)))).toEqual([]);
  });

  it("exempts a single unbreakable word, which no wrap can shorten", () => {
    const word = "x".repeat(BODY_WRAP_COLUMNS + 20);
    expect(violations(draft(word))).toEqual([]);
  });
});

describe("format-squash-message fence", () => {
  it("wraps the body in a three-backtick fence", () => {
    expect(fenced("Body sentence.\n")).toBe("```\nBody sentence.\n```\n");
  });

  it("outruns any backtick run the body holds", () => {
    expect(fenced("A ```` run.\n")).toBe("`````\nA ```` run.\n`````\n");
  });
});

describe("format-squash-message arguments", () => {
  it("takes no argument, a draft path, stdin's dash, and --fenced", () => {
    expect(parseArgs([])).toEqual({ input: null, fenced: false });
    expect(parseArgs(["/tmp/a.txt"])).toEqual({
      input: "/tmp/a.txt",
      fenced: false,
    });
    expect(parseArgs(["-", "--fenced"])).toEqual({ input: null, fenced: true });
    expect(parseArgs(["--fenced", "/tmp/a.txt"])).toEqual({
      input: "/tmp/a.txt",
      fenced: true,
    });
  });

  it("refuses an argument list it cannot read", () => {
    for (const argv of [
      ["a.txt", "b.txt"],
      ["--fenced", "--fenced"],
      ["--out", "b.txt"],
      ["--verbose"],
    ]) {
      expect(parseArgs(argv), JSON.stringify(argv)).toBeNull();
    }
  });
});

describe("format-squash-message as a command", () => {
  it("normalizes a draft read from stdin onto stdout", () => {
    const wide = `${"word ".repeat(30)}end`;
    const result = run([], draft(wide));
    expect(result.status).toBe(0);
    for (const line of bodyLines(result.stdout)) {
      expect(line.length).toBeLessThanOrEqual(BODY_WRAP_COLUMNS);
    }
  });

  it("takes the markers out rather than refusing over them", () => {
    const result = run([], draft("- a list item with `a code span`"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("a list item with a code span\n");
  });

  it("reads a draft path and prints the fenced body for a comment", () => {
    const source = join(tempDirectory(), "draft.txt");
    writeFileSync(source, draft(`${"word ".repeat(30)}end`));
    const result = run([source, "--fenced"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      fenced(normalizeDraft(draft(`${"word ".repeat(30)}end`))),
    );
  });

  it("prints nothing when the draft is refused", () => {
    const result = run(["--fenced"], "   \n\n");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("needs a body");
    expect(result.stderr).toContain("Nothing was printed");
    expect(result.stdout).toBe("");
  });

  // The check over its own output has one shape that reaches it: the wrap put a
  // marker at the front of a line whose line above ends in a colon, which the
  // next pass reads as a list. The run fails there rather than print a message
  // its own check refuses.
  it("prints nothing when its own check rejects what it produced", () => {
    const body = `${"word ".repeat(12)}budget: 12. A sentence the wrap pushes onto the next line.`;
    const result = run(["--fenced"], draft(body));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bug in the script");
    expect(result.stderr).toContain("prose, not a list");
    expect(result.stderr).toContain("Nothing was printed");
    expect(result.stdout).toBe("");
  });

  it("prints its usage rather than guessing at a bad argument list", () => {
    const result = run(["a.txt", "b.txt"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});

/**
 * The bodies of recent commits that landed through a squash merge, the subject
 * left off since GitHub fills it from the title. `git log` ends each record
 * with the NUL and then a newline, so the newline opening every record after
 * the first is dropped. A commit with no body is left out: there is nothing of
 * it a comment would carry.
 */
function landedBodies(count) {
  const log = execFileSync(
    "git",
    ["-C", REPO_ROOT, "log", `-${count}`, "--format=%s%x01%b%x00"],
    { encoding: "utf8" },
  );
  return log
    .split("\0")
    .map((record) => record.replace(/^\n/, ""))
    .flatMap((record) => {
      const [subject, body = ""] = record.split("\x01");
      if (!/ \(#\d+\)$/.test(subject) || body.trim() === "") return [];
      return [{ subject, body }];
    });
}

describe("format-squash-message against real commit messages", () => {
  // The repository's own recent history is the only corpus that proves the
  // rules do not fire on messages written under them.
  const landed = landedBodies(50);

  it("reads a corpus of messages rather than an empty list", () => {
    expect(landed.length).toBeGreaterThan(10);
  });

  it("refuses no body among the last fifty commits", () => {
    for (const { subject, body } of landed) {
      expect(formatDraft(body).refusals, subject).toEqual([]);
    }
  });

  it("leaves nothing for the check to report on what it normalizes", () => {
    for (const { subject, body } of landed) {
      const once = normalizeDraft(body);
      expect(violations(once), subject).toEqual([]);
      expect(normalizeDraft(once), subject).toBe(once);
    }
  });
});
