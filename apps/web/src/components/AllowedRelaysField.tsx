import { useState } from "react";

import { Anchor, Box, Button, Group, Text, Textarea } from "@mantine/core";

import {
  ALLOWED_RELAYS_FIELD_DESCRIPTION,
  ALLOWED_RELAYS_UNSET_SUMMARY,
  NO_ALLOWED_RELAY_NOTE,
  NO_ALLOWED_RELAY_SUMMARY,
  allowedRelaysSummary,
  parseExchangeAllowedRelayLines,
} from "@psi/transport/relayRestriction";

import { SettingSummaryLine } from "./SettingSummaryLine";
import { useOpenCloseFocus } from "./useOpenCloseFocus";

import type { MantineSpacing } from "@mantine/core";

/**
 * An exchange's Allowed relays, one entry per line, shown as one line until
 * the user opens the field: every relay a run lists where no list is set,
 * with an action that opens the field, or the relays the list names, with
 * actions to change or remove them. A value the field refuses keeps it open.
 * Where the list is `fixed` the line shows it with no action. The caller
 * parses the text (`parseExchangeAllowedRelayLines`) and decides where the
 * field is offered, and keeps it offered once edited: Remove sends focus to
 * the line's action, which is lost to the page if the field then unmounts.
 */
export function AllowedRelaysField({
  value,
  error,
  onChange,
  fixed = false,
  allowsNoRelay = false,
  onRemove,
  onOpen,
  scope,
  guideUrl,
  mt,
  liveError,
}: {
  value: string;
  error: string | undefined;
  onChange: (text: string) => void;
  /** The list cannot be changed: a created invitation or a started exchange
   * took it. */
  fixed?: boolean;
  /** An empty value is a list allowing no relay rather than no list, as a
   * saved exchange's imported configuration can hold. */
  allowsNoRelay?: boolean;
  /** Remove the list; empties the text when absent. */
  onRemove?: () => void;
  /** Called as the user opens the field. */
  onOpen?: () => void;
  /** What the list decides, shown under it while it names a list. */
  scope?: string;
  /** The user guide's account of the list, linked from the opened field. */
  guideUrl: string;
  /** The space above the field, as the fields beside it set theirs. */
  mt?: MantineSpacing;
  /** The error follows typing, so it is not announced as an alert; the field
   * still names it to assistive technology through its description. */
  liveError?: boolean;
}) {
  const [open, setOpen] = useState(error !== undefined);
  // A refused value keeps the field open, so fixing it does not close it.
  if (error !== undefined && !open && !fixed) setOpen(true);
  const { fieldRef, actionRef, focusFieldNext, focusActionNext } =
    useOpenCloseFocus<HTMLTextAreaElement>();

  const lines = parseExchangeAllowedRelayLines(value);
  const entries = lines.ok ? lines.entries : undefined;
  const noRelay = allowsNoRelay && lines.ok && entries === undefined;
  const scopeNote =
    scope !== undefined && (entries !== undefined || noRelay) ? (
      <Text size="sm" mt="xs">
        {scope}
      </Text>
    ) : null;

  function openField() {
    onOpen?.();
    focusFieldNext();
    setOpen(true);
  }

  if (open && !fixed)
    return (
      <Box {...(mt !== undefined ? { mt } : {})}>
        <Textarea
          ref={fieldRef}
          label="Allowed relays"
          description={ALLOWED_RELAYS_FIELD_DESCRIPTION}
          autosize
          minRows={2}
          value={value}
          error={error}
          {...(liveError === true ? {} : { errorProps: { role: "alert" } })}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {noRelay && (
          <Text size="sm" mt="xs">
            {NO_ALLOWED_RELAY_NOTE}
          </Text>
        )}
        <Group gap="sm" mt="xs">
          <Button
            size="xs"
            variant="default"
            disabled={error !== undefined}
            onClick={() => {
              focusActionNext();
              setOpen(false);
            }}
          >
            Done
          </Button>
          <Anchor size="sm" href={guideUrl} target="_blank" rel="noreferrer">
            More about Allowed relays
          </Anchor>
        </Group>
        {scopeNote}
      </Box>
    );

  const summary =
    entries !== undefined
      ? allowedRelaysSummary(entries)
      : noRelay
        ? NO_ALLOWED_RELAY_SUMMARY
        : ALLOWED_RELAYS_UNSET_SUMMARY;
  return (
    <Box {...(mt !== undefined ? { mt } : {})}>
      <SettingSummaryLine
        summary={summary}
        isSet={entries !== undefined || noRelay}
        settingName="Allowed relays"
        setLabel="Set Allowed relays"
        actions={!fixed}
        actionRef={actionRef}
        onOpen={openField}
        onRemove={() => {
          focusActionNext();
          if (onRemove !== undefined) onRemove();
          else onChange("");
        }}
      />
      {scopeNote}
    </Box>
  );
}
