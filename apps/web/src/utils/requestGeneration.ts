/**
 * Which of a sequence of asynchronous requests is the live one, so a response or
 * continuation that lands after a newer request -- or after the screen disowned
 * every request in flight -- is discarded rather than applied.
 */

import { useEffect, useState } from "react";

/**
 * A request counter. Each request takes a token from {@link next}; a later
 * {@link next} or an {@link invalidate} makes every earlier token stale, and a
 * response applies its result only while {@link isCurrent} holds for its token.
 */
export interface RequestGeneration {
  /** Starts a request, superseding every earlier one, and returns its token. */
  next: () => number;
  /** Supersedes every request in flight without starting one. */
  invalidate: () => void;
  /** Whether the request holding `token` is still the latest. */
  isCurrent: (token: number) => boolean;
}

/** A fresh {@link RequestGeneration} with no request in flight. */
export function createRequestGeneration(): RequestGeneration {
  let latest = 0;
  return {
    next: () => (latest += 1),
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

/**
 * A {@link RequestGeneration} that is the same object for the component's whole
 * life and is invalidated when the component unmounts, so no response applies to
 * a screen that has gone.
 */
export function useRequestGeneration(): RequestGeneration {
  const [generation] = useState(createRequestGeneration);
  useEffect(() => () => generation.invalidate(), [generation]);
  return generation;
}
