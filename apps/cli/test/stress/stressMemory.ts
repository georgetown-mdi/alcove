import { execFileSync } from "node:child_process";
import { freemem, platform } from "node:os";

/** The memory a stress case gates on, in bytes, and the name of that figure. */
export interface StressMemory {
  bytes: number;
  measure: string;
}

/**
 * The available memory in the output of macOS `memory_pressure`: its free,
 * inactive (reclaimable cache) and speculative pages, times the page size.
 * Undefined when the output lacks any of those figures.
 */
export function availableBytesFromMemoryPressure(
  output: string,
): number | undefined {
  const pageSize = /page size of (\d+)/.exec(output)?.[1];
  const pages = ["free", "inactive", "speculative"].map(
    (kind) => new RegExp(`^Pages ${kind}:\\s+(\\d+)`, "m").exec(output)?.[1],
  );
  if (pageSize === undefined || pages.includes(undefined)) return undefined;
  return (
    pages.reduce((sum, count) => sum + Number(count), 0) * Number(pageSize)
  );
}

/**
 * The memory this host's stress cases gate on. macOS counts its reclaimable
 * cache as used, so os.freemem() there reads a fraction of what a run can
 * have; the gate takes free plus reclaimable pages when memory_pressure answers.
 */
export function stressMemory(): StressMemory {
  if (platform() === "darwin") {
    let output: string | undefined;
    try {
      output = execFileSync("memory_pressure", {
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch {
      output = undefined;
    }
    const bytes =
      output === undefined
        ? undefined
        : availableBytesFromMemoryPressure(output);
    if (bytes !== undefined) {
      return { bytes, measure: "available memory (macOS)" };
    }
    return {
      bytes: freemem(),
      measure: "free memory (memory_pressure gave no reading)",
    };
  }
  return { bytes: freemem(), measure: "free memory" };
}
