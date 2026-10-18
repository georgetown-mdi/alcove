import { useId, useState } from "react";

import { ActionIcon, Collapse, Group, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

import { LESS_CERTAIN_KEY_COPY } from "@alcove/core";

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
 * an info button after it that shows {@link LESS_CERTAIN_KEY_COPY}'s
 * explanation below the line, followed by `remedy`. A button rather than a
 * hover tooltip, so the text is reachable from the keyboard and announced:
 * aria-expanded on the button, and aria-controls on an always-mounted wrapper
 * around a Collapse, as `DisclosureSection` does.
 *
 * The button sits outside `children`, so a line that is itself a control's
 * label (a checkbox) holds no nested control.
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
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <Group gap={4} wrap="nowrap" align="flex-start">
        {children}
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={lessCertainInfoLabel(keyName)}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((isOpen) => !isOpen)}
        >
          <IconInfoCircle size={15} aria-hidden />
        </ActionIcon>
      </Group>
      <div id={panelId}>
        <Collapse expanded={open}>
          <Text size="xs" mt={4}>
            {LESS_CERTAIN_KEY_COPY.explanation} {remedy}
          </Text>
        </Collapse>
      </div>
    </div>
  );
}
