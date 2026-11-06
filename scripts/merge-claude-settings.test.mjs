import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPLIED_TEMPLATE_FILE,
  SETTINGS_FILE,
  applyTemplate,
  deepEqual,
  differingPaths,
  mergeSettings,
} from "./merge-claude-settings.mjs";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "merge-claude-settings.mjs",
);

let directory;
let configDir;
let templatePath;
let warnings;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "merge-claude-settings-"));
  configDir = join(directory, "config");
  templatePath = join(directory, "template.json");
  warnings = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

function readJson(name) {
  return JSON.parse(readFileSync(join(configDir, name), "utf8"));
}

function setTemplate(value) {
  writeJson(templatePath, value);
}

function apply() {
  return applyTemplate({
    templatePath,
    configDir,
    warn: (line) => warnings.push(line),
  });
}

/** Creates the config dir by applying `first`, then lets the operator edit settings.json. */
function appliedThenEdited(first, edit) {
  setTemplate(first);
  apply();
  writeJson(join(configDir, SETTINGS_FILE), edit(readJson(SETTINGS_FILE)));
}

describe("applyTemplate", () => {
  it("writes the template as settings and as the base on a fresh volume", () => {
    const template = { model: "opus", nested: { a: 1 } };
    setTemplate(template);
    expect(apply()).toEqual([]);
    expect(readJson(SETTINGS_FILE)).toEqual(template);
    expect(readJson(APPLIED_TEMPLATE_FILE)).toEqual(template);
  });

  it("writes the template wholesale over settings that have no base", () => {
    setTemplate({ model: "opus", effortLevel: "xhigh" });
    apply();
    rmSync(join(configDir, APPLIED_TEMPLATE_FILE));
    writeJson(join(configDir, SETTINGS_FILE), {
      model: "sonnet",
      extra: true,
    });
    expect(apply()).toEqual([]);
    expect(readJson(SETTINGS_FILE)).toEqual({
      model: "opus",
      effortLevel: "xhigh",
    });
    expect(readJson(APPLIED_TEMPLATE_FILE)).toEqual(readJson(SETTINGS_FILE));
  });

  it("keeps an operator change when the template changes the same key", () => {
    appliedThenEdited({ model: "opus", tui: "fullscreen" }, (s) => ({
      ...s,
      model: "sonnet",
    }));
    setTemplate({ model: "haiku", tui: "fullscreen" });
    expect(apply()).toEqual(["model"]);
    expect(readJson(SETTINGS_FILE).model).toBe("sonnet");
    expect(readJson(APPLIED_TEMPLATE_FILE).model).toBe("haiku");
  });

  it("follows a template change to a key the operator left alone", () => {
    appliedThenEdited({ model: "opus", tui: "fullscreen" }, (s) => s);
    setTemplate({ model: "haiku", tui: "fullscreen" });
    expect(apply()).toEqual([]);
    expect(readJson(SETTINGS_FILE)).toEqual({
      model: "haiku",
      tui: "fullscreen",
    });
  });

  it("keeps a key the operator added and reports it", () => {
    appliedThenEdited({ model: "opus" }, (s) => ({ ...s, theme: "dark" }));
    setTemplate({ model: "haiku" });
    expect(apply()).toEqual(["theme"]);
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "haiku", theme: "dark" });
  });

  it("drops an untouched key the template removed", () => {
    appliedThenEdited({ model: "opus", tui: "fullscreen" }, (s) => s);
    setTemplate({ model: "opus" });
    expect(apply()).toEqual([]);
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "opus" });
  });

  it("keeps a key the operator deleted deleted and reports it", () => {
    appliedThenEdited(
      { model: "opus", tui: "fullscreen" },
      ({ tui, ...rest }) => rest,
    );
    setTemplate({ model: "opus", tui: "fullscreen" });
    expect(apply()).toEqual(["tui"]);
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "opus" });
  });

  it("merges nested objects per leaf and reports dotted paths", () => {
    const first = {
      model: "opus",
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "xhigh", autoCompactWindow: 400000 },
      },
    };
    appliedThenEdited(first, (s) => ({
      ...s,
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "xhigh", autoCompactWindow: 200000 },
      },
    }));
    setTemplate({
      model: "opus",
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 400000 },
        "claude-sonnet-5-5": { effortLevel: "low" },
      },
    });
    expect(apply()).toEqual([
      "modelSettings.claude-opus-5-5.autoCompactWindow",
    ]);
    expect(readJson(SETTINGS_FILE).modelSettings).toEqual({
      "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 200000 },
      "claude-sonnet-5-5": { effortLevel: "low" },
    });
  });

  it("treats a rewritten key order as no change", () => {
    appliedThenEdited({ nested: { a: 1, b: [1, 2] }, model: "opus" }, () => ({
      model: "opus",
      nested: { b: [1, 2], a: 1 },
    }));
    setTemplate({ nested: { a: 2, b: [1, 2] }, model: "haiku" });
    expect(apply()).toEqual([]);
    expect(readJson(SETTINGS_FILE)).toEqual({
      nested: { a: 2, b: [1, 2] },
      model: "haiku",
    });
  });

  it("sets an unparsable settings.json aside and writes the template", () => {
    setTemplate({ model: "opus" });
    apply();
    writeFileSync(join(configDir, SETTINGS_FILE), "{ not json");
    expect(() => apply()).not.toThrow();
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "opus" });
    expect(
      readFileSync(join(configDir, `${SETTINGS_FILE}.unreadable`), "utf8"),
    ).toBe("{ not json");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SETTINGS_FILE);
  });

  it("sets an unparsable base aside and writes the template wholesale", () => {
    setTemplate({ model: "opus" });
    apply();
    writeJson(join(configDir, SETTINGS_FILE), { model: "sonnet" });
    writeFileSync(join(configDir, APPLIED_TEMPLATE_FILE), "[1, 2");
    expect(() => apply()).not.toThrow();
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "opus" });
    expect(readJson(APPLIED_TEMPLATE_FILE)).toEqual({ model: "opus" });
    expect(
      existsSync(join(configDir, `${APPLIED_TEMPLATE_FILE}.unreadable`)),
    ).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(APPLIED_TEMPLATE_FILE);
  });

  it("sets aside a settings.json that is not an object", () => {
    setTemplate({ model: "opus" });
    apply();
    writeFileSync(join(configDir, SETTINGS_FILE), "[]");
    apply();
    expect(readJson(SETTINGS_FILE)).toEqual({ model: "opus" });
    expect(warnings).toHaveLength(1);
  });

  it("throws on an unparsable template", () => {
    writeFileSync(templatePath, "{");
    expect(() => apply()).toThrow();
  });

  it("leaves no temporary file behind", () => {
    setTemplate({ model: "opus" });
    apply();
    apply();
    const leftovers = execFileSync("ls", ["-A", configDir], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("mergeSettings", () => {
  it("treats a non-object base as empty when current and template are objects", () => {
    expect(
      mergeSettings({ a: 1 }, { a: { x: 1 } }, { a: { x: 2, y: 3 } }),
    ).toEqual({ a: { x: 1, y: 3 } });
  });

  it("compares arrays element-wise in order", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
    expect(mergeSettings({ l: [1, 2] }, { l: [2, 1] }, { l: [3] })).toEqual({
      l: [2, 1],
    });
  });
});

describe("differingPaths", () => {
  it("lists dotted paths where merged differs from the template", () => {
    expect(
      differingPaths(
        { a: { b: 1, c: 2 }, d: 3 },
        { a: { b: 1, c: 9 }, e: 4 },
      ).sort(),
    ).toEqual(["a.c", "d", "e"]);
  });
});

describe("command line", () => {
  it("prints the kept paths in one line and nothing when none", () => {
    setTemplate({ model: "opus", tui: "fullscreen" });
    const run = () =>
      execFileSync("node", [script, templatePath, configDir], {
        encoding: "utf8",
      });
    expect(run()).toBe("");
    writeJson(join(configDir, SETTINGS_FILE), {
      model: "sonnet",
      tui: "fullscreen",
    });
    expect(run()).toBe("post-create: kept container settings: model\n");
  });
});
