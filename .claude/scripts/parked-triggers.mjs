#!/usr/bin/env node
//
// Re-test the triggers of the parked items on the boards named: for each item
// `list-issues.mjs --parked --json <N>` lists, print fired, not fired or
// cannot answer, with its trigger (.claude/pm/ruleset.md, Task template).
//
// Usage:
//   node parked-triggers.mjs <project-number>...
//
// The trigger forms answered:
//   - "board N item M is Done", or "board N items M and K are Done": by a
//     board read of each item's Status.
//   - A backticked `npm view ...` command, run with --json added, and the
//     condition "publishes a release after X.Y.Z" (the version printed is
//     later) or "admits <package> <major>" (the range printed for that
//     package admits a version of that major).
//   - A backticked `gh release list ...` command, and the condition "names
//     <tag>" or "prints a tag of the form `vX.Y.Z`", read against the words
//     of its output.
// Any other trigger, a command holding shell syntax, and a command that
// fails are cannot answer. A command is run without a shell.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { fetchItems } from "./lib/projectItems.mjs";

const USAGE = "Usage: node parked-triggers.mjs <project-number>...\n";
const LIST_ISSUES = fileURLToPath(new URL("list-issues.mjs", import.meta.url));

const BOARD_TRIGGER =
  /^board (\d+) items? (\d+(?:(?:,? and |, )\d+)*) (?:is|are) Done$/i;

/**
 * Split a command into words, honouring single and double quotes. Returns
 * null when it holds shell syntax a plain argv cannot express.
 */
export function splitCommand(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[|;&$`<>()\\*?]/.test(ch)) {
      return null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

const words = (text) => text.split(/\s+/).filter(Boolean);

function commandCondition(argv, condition, stdout) {
  if (argv[0] === "npm") {
    const value = JSON.parse(stdout);
    const after = /publishes a release after (\d+\.\d+\.\d+)/.exec(condition);
    if (after && typeof value === "string" && semver.valid(value)) {
      return semver.gt(value, after[1]);
    }
    const admits = /admits (\S+) (\d+)\b/.exec(condition);
    if (admits && value && typeof value[admits[1]] === "string") {
      return semver.intersects(value[admits[1]], `${admits[2]}.x`);
    }
    return null;
  }
  const names = /\bnames (\S+)$/.exec(condition);
  if (names) return words(stdout).includes(names[1]);
  if (/prints a tag of the form `?vX\.Y\.Z`?$/.test(condition)) {
    return words(stdout).some((w) => /^v\d+\.\d+\.\d+$/.test(w));
  }
  return null;
}

/**
 * Answer one trigger (its date already removed). `deps.readStatus(board, ids)`
 * resolves to a Map of item id to Status (null for an item it cannot read);
 * `deps.run(argv)` resolves to `{ ok, stdout }`. Resolves to `{ verdict,
 * detail }`, the verdict "fired", "not fired" or "cannot answer".
 */
export async function answerTrigger(trigger, deps) {
  const cannot = (detail) => ({ verdict: "cannot answer", detail });
  const board = BOARD_TRIGGER.exec(trigger);
  if (board) {
    const ids = board[2].split(/,? and |, /).map(Number);
    const status = await deps.readStatus(Number(board[1]), ids);
    const unread = ids.filter((id) => !status.get(id));
    if (unread.length)
      return cannot(`could not read item ${unread.join(", ")}`);
    const open = ids.filter((id) => status.get(id).toLowerCase() !== "done");
    return open.length
      ? { verdict: "not fired", detail: `not Done: ${open.join(", ")}` }
      : { verdict: "fired", detail: "Done" };
  }
  const m = /`([^`]+)`/.exec(trigger);
  const argv = m ? splitCommand(m[1]) : null;
  const npm = argv?.[0] === "npm" && argv[1] === "view";
  const gh = argv?.[0] === "gh" && argv[1] === "release" && argv[2] === "list";
  if (!npm && !gh) return cannot("no board read or command answers it");
  if (npm && !argv.includes("--json")) argv.push("--json");
  const condition = trigger.replace(/\s*\(`[^`]+`\)|`[^`]+`/, "").trim();
  const result = await deps.run(argv);
  if (!result.ok) return cannot(`${argv.join(" ")} failed`);
  let fired;
  try {
    fired = commandCondition(argv, condition, result.stdout);
  } catch {
    return cannot(`could not read the output of ${argv.join(" ")}`);
  }
  if (fired === null) return cannot(`no rule reads "${condition}"`);
  return { verdict: fired ? "fired" : "not fired", detail: argv.join(" ") };
}

/**
 * Re-test every parked item on `boards`. `deps.listParked(board)` resolves to
 * list-issues.mjs's --parked --json array. Resolves to one row per item.
 */
export async function retest(boards, deps) {
  const rows = [];
  for (const board of boards) {
    for (const item of await deps.listParked(board)) {
      const trigger = item.parkedUntil.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, "");
      rows.push({
        board,
        id: item.id,
        title: item.title,
        trigger,
        ...(await answerTrigger(trigger, deps)),
      });
    }
  }
  return rows;
}

function runCommand(argv) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { maxBuffer: 1 << 24 }, (err, stdout) =>
      resolve({ ok: !err, stdout }),
    );
  });
}

const liveDeps = {
  listParked: (board) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [LIST_ISSUES, "--parked", "--json", String(board)],
        { maxBuffer: 1 << 24 },
        (err, stdout, stderr) =>
          err
            ? reject(
                new Error(`list-issues.mjs ${board} failed: ${stderr.trim()}`),
              )
            : resolve(JSON.parse(stdout)),
      );
    }),
  readStatus: async (board, ids) =>
    new Map(
      (await fetchItems(board, ids)).map((it) => [
        it.id,
        it.type === "missing" ? null : (it.fields.Status ?? null),
      ]),
    ),
  run: runCommand,
};

async function main(argv) {
  if (!argv.length || argv.some((a) => !/^\d+$/.test(a))) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  for (const r of await retest(argv.map(Number), liveDeps)) {
    process.stdout.write(
      `${r.board} ${r.id}\t${r.verdict}\t${r.title} -- Parked until: ${r.trigger} -- ${r.detail}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message ?? err}\n`);
    process.exit(1);
  });
}
