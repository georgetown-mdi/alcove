import { useState } from "react";

import { Button, Group, Modal } from "@mantine/core";

/**
 * A button whose action replaces what the operator set, behind a confirm
 * naming what it replaces: the action discards edits that have no undo.
 */
export function ConfirmedActionButton({
  label,
  variant,
  disabled = false,
  statement,
  onConfirm,
}: {
  /** The button's label, the confirm's title as a question, and its confirm
   * button's label. */
  label: string;
  variant: "default" | "subtle";
  disabled?: boolean;
  /** What the action replaces, stated in the confirm. */
  statement: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        variant={variant === "subtle" ? "subtle" : "default"}
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={`${label}?`}
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{statement}</p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
          >
            {label}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
