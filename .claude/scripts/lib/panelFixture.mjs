// Answer directories for the deliberating-panel suites
// (panel-relay.test.mjs, panel-record.test.mjs), built in a temp directory.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAnswerFile } from "../panel-answer-check.mjs";

export const QUESTION =
  "Should the adapter retry a stalled transfer or fail closed?";
export const BASE = "/tmp/tmp.panelBase";
export const STATED = {
  name: "two-party-state",
  lens: "what each party can see",
};
export const SEATS = ["failure-modes", "design-ux", STATED];

const made = [];

/** Remove every directory this module made. */
export function removeFixtures() {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

/** A fresh temp directory. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** An answer directory holding panel.json, with `extra` merged into it. */
export function panelDir(extra = {}) {
  const dir = tempDir("panel-");
  writeFileSync(
    join(dir, "panel.json"),
    JSON.stringify({
      question: QUESTION,
      base: BASE,
      docs: ["docs/DESIGN.md"],
      seats: SEATS,
      ...extra,
    }),
  );
  return dir;
}

/** An answer whose position names its seat and round. */
export const answer = (seat, round, later = {}) => ({
  position: `position of ${seat} in round ${round}`,
  rationale: "what the code showed",
  keyRisk: "the other reading",
  ...(round > 1 ? { changed: false, movedBy: "", ...later } : {}),
});

/** Write `seat`'s answer for `round` and run the check on it, as a panelist does. */
export function writeAnswer(dir, seat, round, value = answer(seat, round)) {
  const path = join(dir, `${seat}-r${round}.json`);
  writeFileSync(path, JSON.stringify(value));
  checkAnswerFile(path);
  return path;
}
