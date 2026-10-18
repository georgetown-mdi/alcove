import { Textarea } from "@mantine/core";

import type { MantineSpacing } from "@mantine/core";

/**
 * The field that sets the relays an exchange may use, one entry per line. The
 * caller parses the text (`parseAllowedRelayLines` for this browser's stored
 * setting, `parseExchangeAllowedRelayLines` for an exchange's own) and states
 * the field's scope beside it.
 */
export function AllowedRelaysField({
  value,
  error,
  onChange,
  disabled,
  mt,
  liveError,
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
}) {
  return (
    <Textarea
      label="Allowed relays"
      description="One host per line, with a port where needed, for example relay.example.org or relay.example.org:443. Each run uses only the relay servers listed here, yours, the invitation's or this site's. The setting covers relay servers only: a run still contacts the STUN servers an invitation names. Leave it empty to use every relay a run lists."
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
