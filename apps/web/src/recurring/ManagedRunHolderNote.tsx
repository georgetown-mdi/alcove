import { Button } from "@mantine/core";

import styles from "@styles/app.module.css";

import type { ManagedRunHolder } from "./managedRunHolder";

/**
 * What a control the run lock withholds says while a run holds the exchange
 * ({@link ./managedRunHolder.ts}), and, while that run is this window's and
 * still waits for its partner, the one control that stops it and goes on.
 */
export function ManagedRunHolderNote({
  holder,
  text,
  stopLabel,
  busy,
  onStop,
}: {
  holder: ManagedRunHolder | undefined;
  text: Readonly<Record<ManagedRunHolder, string>>;
  stopLabel: string;
  busy: boolean;
  onStop: () => void;
}) {
  if (holder === undefined) return null;
  return (
    <>
      <p className={styles.small}>{text[holder]}</p>
      {holder === "here-waiting" && (
        <Button mt="xs" variant="default" loading={busy} onClick={onStop}>
          {stopLabel}
        </Button>
      )}
    </>
  );
}
