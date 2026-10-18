import { Textarea } from "@mantine/core";

import {
  ALLOWED_RELAYS_FIELD_DESCRIPTION,
  CONSOLE_ALLOWED_RELAYS_FIELD_DESCRIPTION,
} from "@psi/transport/relayRestriction";

import type { MantineSpacing } from "@mantine/core";

/**
 * The field that sets the relays an exchange may use, one entry per line. The
 * caller parses the text (`parseExchangeAllowedRelayLines`) and states the
 * field's scope beside it.
 */
export function AllowedRelaysField({
  value,
  error,
  onChange,
  disabled,
  mt,
  liveError,
  consoleRun,
}: {
  value: string;
  error: string | undefined;
  onChange: (text: string) => void;
  disabled?: boolean;
  /** The space above the field, as the fields beside it set theirs. */
  mt?: MantineSpacing;
  /** The error follows typing, so it is not announced as an alert; the field
   * still names it to assistive technology through its description. */
  liveError?: boolean;
  /** The list is for a run the console conducts, which has no relay of the
   * site's for the description to name. */
  consoleRun?: boolean;
}) {
  return (
    <Textarea
      label="Allowed relays"
      description={
        consoleRun === true
          ? CONSOLE_ALLOWED_RELAYS_FIELD_DESCRIPTION
          : ALLOWED_RELAYS_FIELD_DESCRIPTION
      }
      autosize
      minRows={2}
      value={value}
      error={error}
      {...(liveError === true ? {} : { errorProps: { role: "alert" } })}
      onChange={(event) => onChange(event.currentTarget.value)}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(mt !== undefined ? { mt } : {})}
    />
  );
}
