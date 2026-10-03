import { useState } from "react";

import { Button, Group, Modal } from "@mantine/core";

/**
 * "Reset to defaults" beside a step's primary action, behind a confirm naming
 * what the reset replaces: the reset discards edits that have no undo.
 */
export function ResetToDefaultsButton({
  variant,
  disabled = false,
  resets,
  onReset,
}: {
  variant: "default" | "subtle";
  disabled?: boolean;
  /** What the reset replaces, stated in the confirm. */
  resets: string;
  onReset: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      {variant === "default" ? (
        <Button
          variant="default"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => setConfirming(true)}
        >
          Reset to defaults
        </Button>
      ) : (
        <Button
          variant="subtle"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => setConfirming(true)}
        >
          Reset to defaults
        </Button>
      )}
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Reset to defaults?"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{resets}</p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            onClick={() => {
              setConfirming(false);
              onReset();
            }}
          >
            Reset to defaults
          </Button>
        </Group>
      </Modal>
    </>
  );
}

/** What the inviter's review step's reset replaces. */
export const INVITER_RESET_STATEMENT =
  "This replaces every setting on these steps - linkage keys, column types " +
  "and sharing, cleaning steps, who receives the results, how long the " +
  "invitation lasts, and the agreement - with the defaults read from your " +
  "file. Your name and your file stay. This cannot be undone.";

/** What the acceptor's columns step's reset replaces. */
export const ACCEPTOR_RESET_STATEMENT =
  "This returns every column's type and use to what was read from your " +
  "file, and removes your cleaning changes. This cannot be undone.";
