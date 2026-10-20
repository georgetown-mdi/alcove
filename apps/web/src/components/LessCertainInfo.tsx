import { LESS_CERTAIN_KEY_COPY } from "@alcove/core";

import { InfoButton } from "@components/InfoButton";

import type { ReactNode } from "react";

/**
 * The accessible name of the button that shows why a key is marked less
 * certain: it names the key, as the move buttons on a key's row do, or, for a
 * line about several keys, says so.
 */
export function lessCertainInfoLabel(keyName?: string): string {
  return keyName === undefined
    ? "Why some keys are less certain"
    : `Why ${keyName} is less certain`;
}

/**
 * A line naming a key marked less certain (`linkageKeyIsLessCertain`), with
 * an {@link InfoButton} after it that shows {@link LESS_CERTAIN_KEY_COPY}'s
 * explanation below the line, followed by `remedy`.
 */
export function LessCertainInfo({
  children,
  remedy,
  keyName,
}: {
  /** The line the mark is on; it states the mark itself, in words. */
  children: ReactNode;
  /** What the reader of this screen does to leave such keys out. */
  remedy: string;
  /** The key the line names, already escaped for display; absent for a line
   * about several keys. */
  keyName?: string;
}) {
  return (
    <InfoButton
      label={lessCertainInfoLabel(keyName)}
      explanation={`${LESS_CERTAIN_KEY_COPY.explanation} ${remedy}`}
    >
      {children}
    </InfoButton>
  );
}
