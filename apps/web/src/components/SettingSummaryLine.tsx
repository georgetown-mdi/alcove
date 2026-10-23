import { Button, Group, Text } from "@mantine/core";

import type { ReactNode, Ref } from "react";

/**
 * A setting shown as one line until the user opens it: its summary, then the
 * action that opens it where it is unset, or Change and Remove where it is
 * set, each named for the setting to assistive technology. `actionRef` takes
 * the action that opens it, for focus to return to as it closes.
 */
export function SettingSummaryLine({
  summary,
  isSet,
  settingName,
  setLabel,
  onOpen,
  onRemove,
  actionRef,
  actions = true,
}: {
  summary: ReactNode;
  isSet: boolean;
  /** The setting's name in "Change <name>" and "Remove <name>". */
  settingName: string;
  /** The action that opens the setting while it is unset. */
  setLabel: string;
  onOpen: () => void;
  onRemove: () => void;
  actionRef?: Ref<HTMLButtonElement>;
  /** Whether the line offers its actions; false where the setting is fixed. */
  actions?: boolean;
}) {
  return (
    <Group gap="xs" align="center">
      <Text size="sm">{summary}</Text>
      {actions &&
        (isSet ? (
          <>
            <Button
              ref={actionRef}
              size="xs"
              variant="default"
              aria-label={`Change ${settingName}`}
              onClick={onOpen}
            >
              Change
            </Button>
            <Button
              size="xs"
              variant="subtle"
              aria-label={`Remove ${settingName}`}
              onClick={onRemove}
            >
              Remove
            </Button>
          </>
        ) : (
          <Button ref={actionRef} size="xs" variant="default" onClick={onOpen}>
            {setLabel}
          </Button>
        ))}
    </Group>
  );
}
