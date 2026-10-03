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

// macOS counts its reclaimable cache as used, so os.freemem() there reads a
// fraction of what a run can have; the gate takes free plus reclaimable pages.
/** The memory this host's stress cases gate on. */
export function stressMemory(): StressMemory {
  if (platform() === "darwin") {
    try {
      const bytes = availableBytesFromMemoryPressure(
        execFileSync("memory_pressure", { encoding: "utf8" }),
      );
      if (bytes !== undefined) {
        return { bytes, measure: "available memory (macOS)" };
      }
    } catch {
      // memory_pressure is unavailable: fall through to the free reading.
    }
  }
  return { bytes: freemem(), measure: "free memory" };
}
