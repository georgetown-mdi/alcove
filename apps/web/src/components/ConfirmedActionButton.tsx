import { useState } from "react";

import { Button, Group, Modal } from "@mantine/core";

import type { ReactNode } from "react";

/**
 * A button whose action replaces what the operator set, behind a confirm
 * naming what it replaces: the action discards edits that have no undo. Where
 * `asksFirst` is false, the click runs the action with no confirm.
 */
export function ConfirmedActionButton({
  label,
  variant,
  leftSection,
  disabled = false,
  asksFirst = true,
  statement,
  onConfirm,
}: {
  /** The button's label, the confirm's title as a question, and its confirm
   * button's label. */
  label: string;
  /** `danger` is a subtle red button, for an action that removes. */
  variant: "default" | "subtle" | "danger";
  /** An icon before the button's label. */
  leftSection?: ReactNode;
  disabled?: boolean;
  /** Whether the click opens the confirm, rather than running the action. */
  asksFirst?: boolean;
  /** What the action replaces, stated in the confirm. */
  statement: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = {
    leftSection,
    disabled,
    "aria-haspopup": asksFirst ? ("dialog" as const) : undefined,
    onClick: () => (asksFirst ? setConfirming(true) : onConfirm()),
    children: label,
  };
  return (
    <>
      {variant === "danger" ? (
        <Button variant="subtle" color="red" {...trigger} />
      ) : (
        <Button
          variant={variant === "subtle" ? "subtle" : "default"}
          {...trigger}
        />
      )}
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
