// Reading the agent definitions under .claude/agents/, shared by the hooks that
// decide a spawn by the tier its definition pins.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The body between the leading `---` fence and the next `---`, or null when the
// file does not open with a closed frontmatter block.
function leadingFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(1, i).join("\n");
  }
  return null;
}

/**
 * Every agent definition in `agentsDir` whose leading frontmatter is closed, as
 * `{file, name, model}`, where `name` and `model` are the last value of each key
 * in that block, or null when it states none. Throws when the directory or a
 * file cannot be read; each caller decides how that fails.
 */
export function agentDefinitions(agentsDir) {
  const definitions = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const frontmatter = leadingFrontmatter(
      readFileSync(join(agentsDir, file), "utf8"),
    );
    if (frontmatter === null) continue;
    let name = null;
    let model = null;
    for (const line of frontmatter.split("\n")) {
      const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) name = nameMatch[1];
      const modelMatch = line.match(/^model:\s*(.+?)\s*$/);
      if (modelMatch) model = modelMatch[1];
    }
    definitions.push({ file, name, model });
  }
  return definitions;
}
