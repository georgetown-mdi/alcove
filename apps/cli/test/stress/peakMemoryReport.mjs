// Loaded with `--import` into each party `fileSyncCompletion.stress.test.ts`
// spawns: as the process exits, it writes the process's peak resident set, in
// bytes, to the file ALCOVE_STRESS_PEAK_RSS_FILE names. The PSI worker is a
// thread of the same process, so the figure covers it.
import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

const target = process.env.ALCOVE_STRESS_PEAK_RSS_FILE;
if (isMainThread && target !== undefined)
  process.on("exit", () => {
    writeFileSync(target, String(process.resourceUsage().maxRSS * 1024));
  });
