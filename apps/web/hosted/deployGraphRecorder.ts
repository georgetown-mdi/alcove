import fs from "node:fs";

import type { Plugin } from "vite";

/**
 * The environment variable scripts/check-deploy-trigger-graph.mjs sets to the
 * path the hosted build records its module ids into. Unset -- every developer
 * build, every CI build that is not that check -- no recorder is installed.
 */
export const DEPLOY_GRAPH_RECORD_ENV = "ALCOVE_DEPLOY_GRAPH_RECORD";

/**
 * Records the module ids of one build into `recordPath`, so the deploy-trigger
 * check holds the deploy workflow's path filter against the real graph instead
 * of predicting it. It resolves, loads and rewrites nothing (`transform`
 * returns null), so a recorded build's output is a plain build's. The page
 * bundle and each worker bundle close separately, so each write merges with
 * the record already there.
 */
export function deployGraphRecorder(recordPath: string): Plugin {
  const moduleIds = new Set<string>();
  return {
    name: "alcove-deploy-graph-recorder",
    apply: "build",
    transform(_code, id) {
      moduleIds.add(id);
      return null;
    },
    closeBundle() {
      let recorded: Array<string> = [];
      try {
        recorded = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.writeFileSync(
        recordPath,
        JSON.stringify([...new Set([...recorded, ...moduleIds])].sort()),
      );
    },
  };
}

/** The recorder {@link DEPLOY_GRAPH_RECORD_ENV} asks for, or none. */
export function deployGraphRecorderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Array<Plugin> {
  const recordPath = env[DEPLOY_GRAPH_RECORD_ENV];
  return recordPath ? [deployGraphRecorder(recordPath)] : [];
}
