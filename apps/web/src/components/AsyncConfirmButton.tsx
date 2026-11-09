import { useState } from "react";

import { Alert, Button, Modal } from "@mantine/core";

import styles from "@styles/app.module.css";

import type { ReactNode } from "react";

/**
 * A subtle red button opening a confirm for a destructive step that can fail:
 * the confirm closes only once `onConfirm` resolves. A rejection keeps it open
 * with the failure stated, so the operator retries rather than believing a
 * step took that did not.
 */
export function AsyncConfirmButton({
  triggerLabel,
  title,
  confirmLabel,
  failureTitle,
  failureText,
  onConfirm,
  placeTrigger = (trigger) => trigger,
  children,
}: {
  /** The label of the button that opens the confirm. */
  triggerLabel: string;
  /** The confirm's title. */
  title: string;
  /** The label of the confirm's own destructive button. */
  confirmLabel: string;
  /** The title of the alert a rejected step shows. */
  failureTitle: string;
  /** The text of that alert. */
  failureText: string;
  /** The destructive step; rejects where it did not take. */
  onConfirm: () => Promise<void>;
  /** Where the trigger renders, given whether the confirm is open; the trigger
   * alone by default. */
  placeTrigger?: (trigger: ReactNode, confirming: boolean) => ReactNode;
  /** What the confirm states before its buttons. */
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  function confirm() {
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await onConfirm();
        setConfirming(false);
      } catch {
        setFailed(true);
      } finally {
        setPending(false);
      }
    })();
  }

  const trigger = (
    <Button
      variant="subtle"
      color="error"
      disabled={pending}
      onClick={() => {
        setFailed(false);
        setConfirming(true);
      }}
    >
      {triggerLabel}
    </Button>
  );

  return (
    <>
      {placeTrigger(trigger, confirming)}
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={title}
        centered
        transitionProps={{ duration: 0 }}
      >
        {children}
        {failed && (
          <Alert
            role="alert"
            color="error"
            title={failureTitle}
            mt="sm"
            mb="sm"
          >
            {failureText}
          </Alert>
        )}
        <div
          className={`${styles.savedRowActions} ${styles.savedRowActionsBelow}`}
        >
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="light"
            loading={pending}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </Modal>
    </>
  );
}
