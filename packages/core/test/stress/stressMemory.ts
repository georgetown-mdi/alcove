import { freemem, platform, totalmem } from "node:os";

/** The memory a stress case gates on, in bytes, and the name of that figure. */
export interface StressMemory {
  bytes: number;
  measure: string;
}

// macOS counts its reclaimable cache as used: os.freemem() there read 0.1 to
// 0.9 GB on a 32 GB host with about half its memory free to reclaim, so it
// would skip every case on any Mac. The gate takes the total memory there.
/** The memory this host's stress cases gate on. */
export function stressMemory(): StressMemory {
  return platform() === "darwin"
    ? { bytes: totalmem(), measure: "total memory (macOS)" }
    : { bytes: freemem(), measure: "free memory" };
}
