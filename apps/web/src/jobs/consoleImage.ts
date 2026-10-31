import { getLogger } from "@alcove/core";

import {
  DEFAULT_IMAGE_REGISTRY,
  IMAGE_REGISTRIES,
  imageDigest,
  imageRegistry,
} from "@utils/alcoveImage";

import { isJobApiEnabled, readJobApiConfig } from "./gate";

import type { ConsoleImage } from "@jobContract/consoleImage";

const log = getLogger("job-api");

/**
 * The registry the launcher downloaded the console's image from, `docker.io` or
 * `ghcr.io`, so the commands the console hands the operator name an image this
 * machine can download. Unset, the console names {@link DEFAULT_IMAGE_REGISTRY}.
 *
 * Server-side configuration; reaches the browser through `GET /api/jobs/image`.
 */
export const JOB_IMAGE_REGISTRY_ENV = "JOB_IMAGE_REGISTRY";

/**
 * The digest of the image the launcher runs, which the partner accept kit
 * prints beside each registry's reference. Unset, the kit names no digest.
 *
 * Server-side configuration; reaches the browser through `GET /api/jobs/image`.
 */
export const JOB_IMAGE_DIGEST_ENV = "JOB_IMAGE_DIGEST";

/** The console's image, read from the environment. A value of the wrong shape
 * is read as unset, and {@link warnConsoleImage} names it at startup. */
export function resolveConsoleImage(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleImage {
  const registry =
    imageRegistry(env[JOB_IMAGE_REGISTRY_ENV]?.trim()) ??
    DEFAULT_IMAGE_REGISTRY;
  const digest = imageDigest(env[JOB_IMAGE_DIGEST_ENV]?.trim());
  return digest === undefined ? { registry } : { registry, digest };
}

/**
 * Log a startup warning for each image variable set to a value the console does
 * not read, naming the value it uses instead. Non-fatal: the two decide only
 * what the console's commands and accept kit name. A no-op when the job API is
 * disabled.
 */
export function warnConsoleImage(env: NodeJS.ProcessEnv = process.env): void {
  if (!isJobApiEnabled(readJobApiConfig(env))) return;
  const registry = env[JOB_IMAGE_REGISTRY_ENV]?.trim();
  if (
    registry !== undefined &&
    registry !== "" &&
    imageRegistry(registry) === undefined
  )
    log.warn(
      `${JOB_IMAGE_REGISTRY_ENV} is not ${IMAGE_REGISTRIES.join(" or ")}; ` +
        `the console's commands name ${DEFAULT_IMAGE_REGISTRY}.`,
    );
  const digest = env[JOB_IMAGE_DIGEST_ENV]?.trim();
  if (
    digest !== undefined &&
    digest !== "" &&
    imageDigest(digest) === undefined
  )
    log.warn(
      `${JOB_IMAGE_DIGEST_ENV} is not sha256: followed by 64 lowercase hex ` +
        "digits; the accept kit names no digest.",
    );
}
