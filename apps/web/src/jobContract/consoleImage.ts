import type { ImageRegistry } from "@utils/alcoveImage";

/**
 * The image the console runs, as `GET /api/jobs/image` reports it: the registry
 * its launcher downloaded it from and, when the launcher passed one, its digest.
 * Contract: docs/spec/SERVER_JOB_API.md, "The console's image".
 */
export interface ConsoleImage {
  registry: ImageRegistry;
  digest?: string;
}
