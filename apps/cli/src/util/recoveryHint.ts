/**
 * Core's `alcoveRecoveryHintEmitted` tag: an error holding it states its own
 * next step, so the CLI adds no generic advisory or fixed step beneath it.
 */

import { causeChainSome } from "@alcove/core";

/** `err`, tagged as stating its own next step. */
export function withRecoveryHintTag<E extends object>(
  err: E,
): E & { alcoveRecoveryHintEmitted: true } {
  return Object.assign(err, { alcoveRecoveryHintEmitted: true as const });
}

/**
 * Whether any link of `err`'s cause chain holds the tag: a wrap of a tagged
 * error still states the next step the tag promises.
 */
export function holdsRecoveryHintTag(err: unknown): boolean {
  return causeChainSome(
    err,
    (link) =>
      (link as { alcoveRecoveryHintEmitted?: unknown })
        .alcoveRecoveryHintEmitted === true,
  );
}
