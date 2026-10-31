import {
  DEFAULT_IMAGE_REGISTRY,
  imageDigest,
  imageRegistry,
} from "@utils/alcoveImage";

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readBoundedJson,
} from "./jobApiBody";

import type { ConsoleImage } from "@jobContract/consoleImage";

/**
 * The browser-side reader for `GET /api/jobs/image`: the registry and digest
 * of the image this console runs, which the commands it shows and the partner
 * accept kit name.
 */

/** What a build that cannot ask, or a console that did not answer, names. */
export const UNREPORTED_CONSOLE_IMAGE: ConsoleImage = {
  registry: DEFAULT_IMAGE_REGISTRY,
};

/** Validate a response body into a {@link ConsoleImage}, or null when its
 * registry is not one the app names. A digest of any other shape is dropped,
 * so the accept kit names none rather than an unchecked value.
 *
 * @internal exported for the unit test. */
export function parseConsoleImage(body: unknown): ConsoleImage | null {
  if (!isRecord(body)) return null;
  const registry = imageRegistry(body.registry);
  if (registry === undefined) return null;
  const digest = imageDigest(body.digest);
  return digest === undefined ? { registry } : { registry, digest };
}

/** Fetch the console's image, or {@link UNREPORTED_CONSOLE_IMAGE} on any
 * failure. Injectable `fetchImpl` for the tests. */
export async function fetchConsoleImage(
  fetchImpl: typeof fetch = fetch,
): Promise<ConsoleImage> {
  try {
    const response = await fetchImpl("/api/jobs/image", { method: "GET" });
    if (!response.ok) return UNREPORTED_CONSOLE_IMAGE;
    return (
      parseConsoleImage(
        await readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
      ) ?? UNREPORTED_CONSOLE_IMAGE
    );
  } catch {
    return UNREPORTED_CONSOLE_IMAGE;
  }
}
