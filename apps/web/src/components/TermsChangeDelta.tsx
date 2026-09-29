import { List, Stack, Text } from "@mantine/core";

import { termsChangeView } from "@psi/termsChangeView";

import type { TermsDelta } from "@alcove/core";

/**
 * A partner terms change as the console's run step and the recurring run
 * surface show it: one labelled list per part that changed, one entry a line
 * so a name holding a list separator cannot read as two. What each list holds
 * and how it is escaped is {@link termsChangeView}'s.
 */
export function TermsChangeDelta({
  delta,
  escaped,
}: {
  delta: TermsDelta;
  escaped: boolean;
}) {
  return (
    <Stack gap="xs">
      {termsChangeView(delta, escaped).map((section) => (
        <div key={section.label}>
          <Text size="sm" fw={500}>
            {section.label}
          </Text>
          <List size="sm" withPadding listStyleType="circle" my={4}>
            {section.entries.map((entry, index) => (
              <List.Item key={index}>{entry}</List.Item>
            ))}
          </List>
        </div>
      ))}
    </Stack>
  );
}
