import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentDefinitions } from "./agentDefinitions.mjs";

describe("lib/agentDefinitions", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });
  const agentsDir = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "hook-agents-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it("reads the name and model of each definition's leading frontmatter", () => {
    const dir = agentsDir({
      "pinned.md": "---\nname: pinned\nmodel: opus\n---\nmodel: haiku\n",
      "unpinned.md": "---\nname: unpinned\n---\nBody.\n",
      "notes.txt": "---\nname: ignored\nmodel: opus\n---\n",
    });
    const read = agentDefinitions(dir).sort((a, b) =>
      a.file.localeCompare(b.file),
    );
    expect(read).toEqual([
      { file: "pinned.md", name: "pinned", model: "opus" },
      { file: "unpinned.md", name: "unpinned", model: null },
    ]);
  });

  it("skips a file whose frontmatter is missing or never closes", () => {
    const dir = agentsDir({
      "bare.md": "name: bare\nmodel: opus\n",
      "open.md": "---\nname: open\nmodel: fable\n",
    });
    expect(agentDefinitions(dir)).toEqual([]);
  });

  it("throws when the directory cannot be read", () => {
    expect(() =>
      agentDefinitions(join(tmpdir(), "no-such-agents-dir")),
    ).toThrow();
  });
});
