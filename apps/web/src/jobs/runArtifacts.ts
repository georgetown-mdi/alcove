import fs from "node:fs";

import {
  latestRunStamp,
  parseRunArtifactName,
  runArtifactNames,
} from "./runArtifactNames";
import { resolveWorkdirFile } from "./workdir";

import type { RunArtifactKind, RunArtifactNames } from "./runArtifactNames";

/** One run's artifact paths inside a job workdir, all under one stamp. Each
 * names where the CLI writes that artifact; whether it did is checked where the
 * file is read. */
export interface RunArtifactPaths extends RunArtifactNames {
  stamp: string;
}

/** Every run artifact name in `workdir`, parsed; empty where the directory
 * cannot be listed. */
function runArtifactsIn(
  workdir: string,
): Array<{ kind: RunArtifactKind; stamp: string }> {
  let names: Array<string>;
  try {
    names = fs.readdirSync(workdir);
  } catch {
    return [];
  }
  return names.map(parseRunArtifactName).filter((parsed) => parsed !== null);
}

/** The stamp of the latest run whose artifacts `workdir` holds, or null when it
 * holds none. */
export function latestRunStampIn(workdir: string): string | null {
  return latestRunStamp(runArtifactsIn(workdir).map(({ stamp }) => stamp));
}

/** Which artifact kinds `workdir` holds for any run. Presence is the directory
 * listing, so a file the console cannot read still counts. */
export function runArtifactKindsIn(workdir: string): Set<RunArtifactKind> {
  return new Set(runArtifactsIn(workdir).map(({ kind }) => kind));
}

/**
 * The paths of the run with `stamp` inside `workdir`, each resolved through the
 * workdir's containment check. A stamp is digits, hyphens, `T` and `Z` only
 * ({@link ./runArtifactNames}), so a refusal here is a caller bug and throws.
 */
export function runArtifactPaths(
  workdir: string,
  stamp: string,
): RunArtifactPaths {
  const names = runArtifactNames(stamp);
  const resolve = (name: string): string => {
    const resolved = resolveWorkdirFile(workdir, name);
    if (resolved === null)
      throw new Error(
        `the run artifact ${name} did not resolve inside the workdir`,
      );
    return resolved;
  };
  return {
    stamp,
    result: resolve(names.result),
    record: resolve(names.record),
    keys: resolve(names.keys),
    terms: resolve(names.terms),
    receipt: resolve(names.receipt),
  };
}
