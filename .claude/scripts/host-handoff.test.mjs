import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// host-handoff.sh runs on the host, where `claude` is logged in; here `claude`
// is a stub on PATH that logs its working directory and each argument, and
// writes the result file when the case asks it to. The script finds the
// checkout from its own path, so each case copies it into a fixture checkout.

const SCRIPT = fileURLToPath(new URL("./host-handoff.sh", import.meta.url));
const TEMPLATE_DOCUMENT = fileURLToPath(
  new URL("../orchestration/host-handoff-brief.md", import.meta.url),
);

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

// A directory with a real claude (the dev container has one) is swapped for
// a copy made of symlinks to everything else in it.
const shadowRoot = mkdtempSync(join(tmpdir(), "host-handoff-path-"));
afterAll(() => rmSync(shadowRoot, { recursive: true, force: true }));

const PATH_WITHOUT_CLAUDE = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir !== "")
  .map((dir, index) => {
    if (!existsSync(join(dir, "claude"))) return dir;
    const shadow = join(shadowRoot, String(index));
    mkdirSync(shadow);
    for (const name of readdirSync(dir)) {
      if (name !== "claude") symlinkSync(join(dir, name), join(shadow, name));
    }
    return shadow;
  })
  .join(delimiter);

const SLUG = "2026-10-24-relay-check";

function briefText({
  sections = ["## Contract", "## Host rules", "## Brief", "## Steps"],
  result = `\`scratch/handoffs/${SLUG}.result.md\`; artifacts in \`scratch/handoffs/${SLUG}-artifacts/\``,
  model,
  effort,
} = {}) {
  const lines = ["# Host hand-off: relay check", ""];
  for (const section of sections) {
    lines.push(section, "");
    if (section === "## Brief") {
      lines.push("- Goal: check the relay.");
      if (result !== null) lines.push(`- Result file: ${result}`);
      if (model !== undefined) lines.push(`- Model: ${model}`);
      if (effort !== undefined) lines.push(`- Effort: ${effort}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function checkout({ brief = briefText(), resultExists = false } = {}) {
  const root = tempDirectory("host-handoff-repo-");
  mkdirSync(join(root, ".claude", "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(root, ".claude", "scripts", "host-handoff.sh"));
  const handoffs = join(root, "scratch", "handoffs");
  mkdirSync(handoffs, { recursive: true });
  writeFileSync(join(handoffs, `${SLUG}.md`), brief);
  if (resultExists) {
    writeFileSync(join(handoffs, `${SLUG}.result.md`), "## Run\n");
  }
  const bin = tempDirectory("host-handoff-bin-");
  const log = join(bin, "claude.log");
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `pwd > "${log}"`,
      `for argument in "$@"; do printf '%s\\n' "$argument" >> "${log}"; done`,
      'if [ -n "${STUB_RESULT:-}" ]; then printf "## Run\\n" > "$STUB_RESULT"; fi',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const claudeCall = () =>
    existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : null;
  return { root, handoffs, bin, claudeCall };
}

function run(fixture, args, { cwd = fixture.root, env = {}, path } = {}) {
  return spawnSync(
    "bash",
    [join(fixture.root, ".claude", "scripts", "host-handoff.sh"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path ?? `${fixture.bin}${delimiter}${PATH_WITHOUT_CLAUDE}`,
        ...env,
      },
    },
  );
}

const PROMPT = `Read scratch/handoffs/${SLUG}.md and follow it. Its Contract and Host rules bind this session.`;

describe("host-handoff.sh launch", () => {
  it("starts claude in the checkout on claude-sonnet-5-5 at high effort with the brief's prompt, and exits 0 once the result is written", () => {
    const fixture = checkout();
    const { status, stdout, stderr } = run(
      fixture,
      [`scratch/handoffs/${SLUG}.md`],
      {
        env: { STUB_RESULT: `scratch/handoffs/${SLUG}.result.md` },
      },
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(fixture.claudeCall()).toEqual([
      fixture.root,
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
      PROMPT,
    ]);
    expect(stdout.trim().split("\n")).toEqual([
      `host-handoff: done: scratch/handoffs/${SLUG}.result.md is written, and the dev container reads it from there.`,
    ]);
  });

  it("takes the model the brief's Model line names", () => {
    const fixture = checkout({
      brief: briefText({
        model: "`claude-opus-5-5`, since the run needs a long plan",
      }),
    });
    run(fixture, [`scratch/handoffs/${SLUG}.md`]);
    expect(fixture.claudeCall().slice(1, 5)).toEqual([
      "--model",
      "claude-opus-5-5",
      "--effort",
      "high",
    ]);
  });

  it("takes the effort the brief's Effort line names", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const fixture = checkout({
        brief: briefText({ effort: `\`${level}\`, since the run needs it` }),
      });
      run(fixture, [`scratch/handoffs/${SLUG}.md`]);
      expect(fixture.claudeCall().slice(1, 5), level).toEqual([
        "--model",
        "claude-sonnet-5-5",
        "--effort",
        level,
      ]);
    }
  });

  it("finds the checkout from its own path when run elsewhere with the brief's full path", () => {
    const fixture = checkout();
    const elsewhere = tempDirectory("host-handoff-cwd-");
    run(fixture, [join(fixture.handoffs, `${SLUG}.md`)], { cwd: elsewhere });
    expect(fixture.claudeCall()).toEqual([
      fixture.root,
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
      PROMPT,
    ]);
  });

  it("exits 1 naming the result file when the session ends without writing it", () => {
    const fixture = checkout();
    const { status, stdout } = run(fixture, [`scratch/handoffs/${SLUG}.md`]);
    expect(status).toBe(1);
    expect(stdout).toContain(
      `the session ended without writing scratch/handoffs/${SLUG}.result.md`,
    );
  });

  it("refuses when claude is not on PATH", () => {
    const fixture = checkout();
    const { status, stderr } = run(fixture, [`scratch/handoffs/${SLUG}.md`], {
      path: PATH_WITHOUT_CLAUDE,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("claude is not on PATH");
  });
});

describe("host-handoff.sh --check", () => {
  it("prints the model, the effort, the result file and the launch command without starting claude", () => {
    const fixture = checkout();
    const { status, stdout } = run(fixture, [
      "--check",
      `scratch/handoffs/${SLUG}.md`,
    ]);
    expect(status).toBe(0);
    expect(fixture.claudeCall()).toBeNull();
    expect(stdout).toContain("host-handoff: model: claude-sonnet-5-5");
    expect(stdout).toContain("host-handoff: effort: high");
    expect(stdout).toContain(
      `host-handoff: result file: scratch/handoffs/${SLUG}.result.md`,
    );
    expect(stdout).toContain(
      `claude --model claude-sonnet-5-5 --effort high '${PROMPT}'`,
    );
  });

  it("prints the effort the brief's Effort line names", () => {
    const fixture = checkout({ brief: briefText({ effort: "`xhigh`" }) });
    const { status, stdout } = run(fixture, [
      "--check",
      `scratch/handoffs/${SLUG}.md`,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("host-handoff: effort: xhigh");
    expect(stdout).toContain(
      `claude --model claude-sonnet-5-5 --effort xhigh '${PROMPT}'`,
    );
  });
});

describe("host-handoff.sh refusals", () => {
  it("refuses a run whose result file already exists", () => {
    const fixture = checkout({ resultExists: true });
    for (const args of [["--check"], []]) {
      const { status, stderr } = run(fixture, [
        ...args,
        `scratch/handoffs/${SLUG}.md`,
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain("already exists");
    }
    expect(fixture.claudeCall()).toBeNull();
  });

  it("refuses a brief missing a template section", () => {
    const fixture = checkout({
      brief: briefText({ sections: ["## Host rules", "## Brief", "## Steps"] }),
    });
    const { status, stderr } = run(fixture, [`scratch/handoffs/${SLUG}.md`]);
    expect(status).toBe(1);
    expect(stderr).toContain("has no '## Contract' section");
    expect(fixture.claudeCall()).toBeNull();
  });

  it("refuses a brief with no result file, or one outside scratch/handoffs/", () => {
    for (const result of [
      null,
      "none",
      "`scratch/handoffs/other/x.result.md`",
      "`scratch/x.result.md`",
    ]) {
      const fixture = checkout({ brief: briefText({ result }) });
      const { status, stderr } = run(fixture, [
        "--check",
        `scratch/handoffs/${SLUG}.md`,
      ]);
      expect(status, String(result)).toBe(1);
      expect(stderr, String(result)).toMatch(/result file/);
    }
  });

  it("refuses a Model line with no model in backticks", () => {
    for (const model of ["claude-sonnet-5-5", "`two words`", "`$(id)`"]) {
      const fixture = checkout({ brief: briefText({ model }) });
      const { status, stderr } = run(fixture, [
        "--check",
        `scratch/handoffs/${SLUG}.md`,
      ]);
      expect(status, model).toBe(1);
      expect(stderr, model).toContain("Model line names no model");
    }
  });

  it("refuses an Effort line with no accepted level in backticks", () => {
    for (const effort of ["high", "`extreme`", "`High`", "`two words`", "``"]) {
      const fixture = checkout({ brief: briefText({ effort }) });
      for (const args of [["--check"], []]) {
        const { status, stderr } = run(fixture, [
          ...args,
          `scratch/handoffs/${SLUG}.md`,
        ]);
        expect(status, effort).toBe(1);
        expect(stderr, effort).toContain("Effort line names no effort level");
        expect(stderr, effort).toContain("low, medium, high, xhigh, or max");
      }
      expect(fixture.claudeCall(), effort).toBeNull();
    }
  });

  it("refuses usage errors with exit 2", () => {
    const fixture = checkout();
    const outside = join(tempDirectory("host-handoff-outside-"), "brief.md");
    writeFileSync(outside, briefText());
    for (const args of [
      [],
      ["--launch", `scratch/handoffs/${SLUG}.md`],
      [`scratch/handoffs/${SLUG}.md`, `scratch/handoffs/${SLUG}.md`],
      [`scratch/handoffs/${SLUG}.result.md`],
      [`scratch/handoffs/${SLUG}`],
      [outside],
    ]) {
      const { status, stderr } = run(fixture, args);
      expect(status, args.join(" ")).toBe(2);
      expect(stderr, args.join(" ")).toContain("Run with --help for usage.");
    }
    expect(fixture.claudeCall()).toBeNull();
  });

  it("refuses a brief path with no file behind it", () => {
    const fixture = checkout();
    const { status, stderr } = run(fixture, ["scratch/handoffs/missing.md"]);
    expect(status).toBe(1);
    expect(stderr).toContain("there is no brief at");
  });
});

describe("host-handoff.sh and the brief template", () => {
  const template = () => {
    const document = readFileSync(TEMPLATE_DOCUMENT, "utf8");
    const text = /````markdown\n([\s\S]*?)\n````/.exec(document)?.[1];
    expect(text).toBeDefined();
    expect(text).toContain(
      "`bash .claude/scripts/host-handoff.sh scratch/handoffs/<YYYY-MM-DD>-<slug>.md`",
    );
    expect(text).toContain("`Hand-off done: <result file path>`");
    return text;
  };

  it("refuses the template as written, whose result file path is still a placeholder", () => {
    const fixture = checkout({ brief: template() });
    const { status, stderr } = run(fixture, [
      "--check",
      `scratch/handoffs/${SLUG}.md`,
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("still has a <...> placeholder");
    expect(fixture.claudeCall()).toBeNull();
  });

  it("accepts the template once its placeholders are filled in", () => {
    const filled = template().replaceAll("<YYYY-MM-DD>-<slug>", SLUG);
    const fixture = checkout({ brief: filled });
    const { status, stdout, stderr } = run(fixture, [
      "--check",
      `scratch/handoffs/${SLUG}.md`,
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("host-handoff: model: claude-sonnet-5-5");
    expect(stdout).toContain("host-handoff: effort: high");
  });

  it("refuses a result file whose name is not the brief's own", () => {
    const fixture = checkout({
      brief: briefText({ result: "`scratch/handoffs/other-name.result.md`" }),
    });
    for (const args of [["--check"], []]) {
      const { status, stderr } = run(fixture, [
        ...args,
        `scratch/handoffs/${SLUG}.md`,
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain(
        `write it as 'scratch/handoffs/${SLUG}.result.md'`,
      );
    }
    expect(fixture.claudeCall()).toBeNull();
  });
});

describe("host-handoff.sh --help", () => {
  it("prints the usage and exits 0", () => {
    const fixture = checkout();
    const { status, stdout } = run(fixture, ["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: bash .claude/scripts/host-handoff.sh");
    expect(stdout).toContain("claude-sonnet-5-5");
    expect(stdout).toContain("or high when");
  });
});
