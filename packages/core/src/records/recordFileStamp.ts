/**
 * The stamp a run's artifact file names share: the exchange record's own
 * `createdAt` made filesystem-safe, its colons and fractional-second dot
 * replaced with hyphens. The CLI's output folder and the web app's downloads
 * name a run's files with it, so the files of one run pair by name wherever
 * they were written (docs/spec/EXCHANGE_RECORD.md, Result file name).
 */
export function recordFileStamp(createdAt: string): string {
  return createdAt.replace(/[:.]/g, "-");
}
