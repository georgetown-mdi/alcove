import { useId, useState } from "react";

import { ActionIcon, Box, Collapse, Group, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

import type { MantineSpacing } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A line with an info button after it that shows `explanation` below the
 * line. A button rather than a hover tooltip, so the text is reachable from
 * the keyboard and announced: aria-expanded on the button, and aria-controls
 * on an always-mounted wrapper around a Collapse, as `DisclosureSection` does.
 *
 * The button sits outside `children`, so a line that is itself a control's
 * label (a checkbox) holds no nested control.
 */
export function InfoButton({
  children,
  label,
  explanation,
  mt,
}: {
  /** The line the button follows. */
  children: ReactNode;
  /** The button's accessible name. */
  label: string;
  /** The text the button shows. */
  explanation: ReactNode;
  mt?: MantineSpacing;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <Box {...(mt !== undefined ? { mt } : {})}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        {children}
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
      <div id={panelId}>
        <Collapse expanded={open}>
          <Text size="xs" mt={4}>
            {explanation}
          </Text>
        </Collapse>
      </div>
    </Box>
  );
}
