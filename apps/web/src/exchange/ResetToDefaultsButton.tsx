import { ConfirmedActionButton } from "@components/ConfirmedActionButton";

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
  return (
    <ConfirmedActionButton
      label="Reset to defaults"
      variant={variant}
      disabled={disabled}
      statement={resets}
      onConfirm={onReset}
    />
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
