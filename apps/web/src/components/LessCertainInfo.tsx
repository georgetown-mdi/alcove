import { useId, useState } from "react";

import { ActionIcon, Collapse, Group, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

import { LESS_CERTAIN_KEY_COPY } from "@alcove/core";

import type { ReactNode } from "react";

/** The accessible name of the button that shows why a key is marked less
 * certain. */
export const LESS_CERTAIN_INFO_LABEL = "Why less certain";

/**
 * A line naming a key marked less certain (`linkageKeyIsLessCertain`), with
 * an info button after it that shows {@link LESS_CERTAIN_KEY_COPY}'s
 * explanation below the line, and its remedy on the accepting party's
 * screen. A button rather than a hover tooltip, so the text is reachable from
 * the keyboard and announced: aria-expanded on the button, and aria-controls
 * on an always-mounted wrapper around a Collapse, as `DisclosureSection` does.
 *
 * The button sits outside `children`, so a line that is itself a control's
 * label (a checkbox) holds no nested control.
 */
export function LessCertainInfo({
  children,
  acceptor = false,
}: {
  /** The line the mark is on; it states the mark itself, in words. */
  children: ReactNode;
  /** Whether the reader is accepting an invitation, who takes its terms
   * whole and so needs the remedy. */
  acceptor?: boolean;
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
          aria-label={LESS_CERTAIN_INFO_LABEL}
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
            {LESS_CERTAIN_KEY_COPY.explanation}
            {acceptor && ` ${LESS_CERTAIN_KEY_COPY.acceptorRemedy}`}
          </Text>
        </Collapse>
      </div>
    </div>
  );
}
