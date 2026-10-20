import { useId, useState } from "react";

import { ActionIcon, Box, Collapse, Group, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

import type { MantineSpacing } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * What an {@link InfoButton} follows: a line, or a function rendering the
 * control the explanation is about, given the explanation's id to set as that
 * control's `aria-describedby` while the explanation is open (`undefined`
 * while it is closed).
 */
export type InfoButtonSubject =
  ReactNode | ((explanationId: string | undefined) => ReactNode);

/**
 * A line with an info button after it that shows `explanation` below the
 * line. A button rather than a hover tooltip, so the text is reachable from
 * the keyboard and announced: aria-expanded on the button, and aria-controls
 * on an always-mounted wrapper around a Collapse, as `DisclosureSection` does.
 *
 * The button sits outside `children`, so a line that is itself a control's
 * label (a checkbox) holds no nested control. A collapsed explanation stays in
 * the document, and an `aria-describedby` reference reads hidden text, so the
 * id is handed to the control only while the explanation is open.
 *
 * Where the line is the label of a group of controls, the group goes in
 * `controls`, under the line, so the button sits beside the label rather than
 * after the group's widest line.
 */
export function InfoButton({
  children,
  label,
  explanation,
  controls,
  mt,
}: {
  /** The line or control the button follows. */
  children: InfoButtonSubject;
  /** The button's accessible name. */
  label: string;
  /** The text the button shows. */
  explanation: ReactNode;
  /** The controls the line labels, shown between it and the explanation, given
   * the explanation's id as a `children` function is. */
  controls?: (explanationId: string | undefined) => ReactNode;
  mt?: MantineSpacing;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explanationId = useId();
  const describedBy = open ? explanationId : undefined;
  return (
    <Box {...(mt !== undefined ? { mt } : {})}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        {typeof children === "function" ? children(describedBy) : children}
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={label}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((isOpen) => !isOpen)}
        >
          <IconInfoCircle size={15} aria-hidden />
        </ActionIcon>
      </Group>
      {controls?.(describedBy)}
      <div id={panelId}>
        <Collapse expanded={open}>
          <Text id={explanationId} size="xs" mt={4}>
            {explanation}
          </Text>
        </Collapse>
      </div>
    </Box>
  );
}
