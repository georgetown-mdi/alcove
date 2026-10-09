// Vitest's own JSON report, written only when ALCOVE_VITEST_JSON_DIR names a
// directory. CI sets it on its test steps so each run's per-file timings are
// kept as an artifact (`.github/actions/test-durations`); a local run, which
// leaves it unset, writes nothing and prints nothing.
//
// It is registered beside the skipped-leg reporter in every config that owns a
// run, for the reason that reporter's header gives. Each run writes a file of
// its own, named by workspace and process, because one CI step can start
// several runs that share the directory.

import { basename, join } from "node:path";

import { JsonReporter } from "vitest/node";

/** The environment variable naming the directory the report goes to. */
export const JSON_REPORT_DIR_VARIABLE = "ALCOVE_VITEST_JSON_DIR";

/** The report file for a run started in `cwd`, or `undefined` when unset. */
export function jsonReportFile(env = process.env, cwd = process.cwd()) {
  const dir = env[JSON_REPORT_DIR_VARIABLE];
  if (dir === undefined || dir === "") return undefined;
  return join(dir, `${basename(cwd)}-${process.pid}.json`);
}

/** The vitest reporter. Registered alongside `default`, never in place of it. */
export default class JsonReportReporter extends JsonReporter {
  constructor() {
    const outputFile = jsonReportFile();
    super({ outputFile });
    this.enabled = outputFile !== undefined;
  }

  onInit(ctx) {
    if (this.enabled) super.onInit(ctx);
  }

  onCoverage(coverageMap) {
    if (this.enabled) super.onCoverage(coverageMap);
  }

  async onTestRunEnd(testModules, ...rest) {
    if (this.enabled) await super.onTestRunEnd(testModules, ...rest);
  }
}
