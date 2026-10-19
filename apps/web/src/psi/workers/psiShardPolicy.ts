/**
 * The most PSI workers one browser exchange runs at once. Throughput stops
 * rising at the physical core count and falls past it, and each worker holds
 * its own engine of about 30 MB (docs/notes/wasm-parallel-evaluation.md).
 */
export const BROWSER_PSI_SHARD_CAP = 4;

/**
 * The parts of `navigator` the shard policy reads; `navigator` itself
 * satisfies it. `userAgentData` is the Chromium client-hints object, absent
 * in other engines.
 */
export interface BrowserPsiShardEnvironment {
  readonly hardwareConcurrency?: number;
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: { readonly platform?: string };
}

/**
 * Whether any of the browser's platform reports names a Mac. Any one is
 * enough, so a browser that reports a Mac through only one of them still
 * counts as macOS.
 */
export function browserRunsOnMacOs(
  environment: BrowserPsiShardEnvironment,
): boolean {
  if (environment.userAgentData?.platform === "macOS") return true;
  if (environment.platform?.startsWith("Mac") === true) return true;
  return environment.userAgent?.includes("Macintosh") === true;
}

/**
 * How many PSI workers a browser exchange runs: one on macOS, where Chrome's
 * renderer crashed at a low rate with several PSI engines computing at once
 * (docs/notes/wasm-parallel-evaluation.md, Renderer crash in the workers arm
 * on the Mac), and otherwise the reported logical core count up to
 * {@link BROWSER_PSI_SHARD_CAP}. A missing or unusable core count gives one.
 */
export function browserPsiShardCount(
  environment: BrowserPsiShardEnvironment,
): number {
  if (browserRunsOnMacOs(environment)) return 1;
  const cores = environment.hardwareConcurrency;
  if (cores === undefined || !Number.isInteger(cores) || cores < 1) return 1;
  return Math.min(cores, BROWSER_PSI_SHARD_CAP);
}
