import { useEffect, useState } from "react";

import { Button, Group, Stack, Text } from "@mantine/core";

import { RELAY_CHECK_AGAIN_LABEL } from "@console/relayCheckModel";

import {
  EXCHANGE_RELAY_CHECK_OPEN_LABEL,
  ExchangeRelayCheckReport,
} from "./ExchangeRelayCheck";
import {
  INVITER_RELAY_CHECK_INTRO,
  inviterRelayCheckAt,
} from "./inviterRelayCheckModel";
import { EXCHANGE_RELAY_CHECK_RUNNING } from "./exchangeRelayCheckModel";

import type { RunRelayWatch } from "@psi/transport/runRelayWatch";

import type { InviterRelayCheckState } from "./inviterRelayCheckModel";

/** How often a running check reads the run's connections. An arbitrary
 * working value. */
const READ_INTERVAL_MS = 250;

const NOT_STARTED: InviterRelayCheckState = { step: "not_started" };

/**
 * The share screen's check of the relays, read from the run's own relay
 * connections: it opens no connection, and reads nothing until the user
 * starts it. A new run attempt resets it.
 */
export function InviterRelayCheck({ watch }: { watch: RunRelayWatch }) {
  const [entered, setState] = useState<{
    watch: RunRelayWatch;
    state: InviterRelayCheckState;
  }>({ watch, state: NOT_STARTED });
  const state = entered.watch === watch ? entered.state : NOT_STARTED;

  useEffect(() => {
    if (state.step !== "running") return;
    const read = (): void => {
      const next = inviterRelayCheckAt(
        state,
        watch.hosts,
        watch.snapshot(),
        Date.now(),
      );
      if (next !== state) setState({ watch, state: next });
    };
    read();
    const timer = setInterval(read, READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state, watch]);

  const running = state.step === "running";
  const start = (): void => {
    if (!running)
      setState({ watch, state: { step: "running", startedAt: Date.now() } });
  };

  // The status region stays mounted so a screen reader announces each change
  // of its content. The button takes aria-disabled, not disabled, while the
  // check runs, so it keeps keyboard focus.
  return (
    <Stack gap="xs" mt="xs">
      {state.step !== "done" && (
        <Text size="sm">{INVITER_RELAY_CHECK_INTRO}</Text>
      )}
      <div role="status">
        {state.step === "done" && (
          <ExchangeRelayCheckReport
            verdict={state.verdict}
            lines={state.lines}
          />
        )}
        {running && <Text size="sm">{EXCHANGE_RELAY_CHECK_RUNNING}</Text>}
      </div>
      <Group>
        <Button
          variant="default"
          aria-disabled={running}
          data-disabled={running}
          onClick={start}
        >
          {state.step === "done"
            ? RELAY_CHECK_AGAIN_LABEL
            : EXCHANGE_RELAY_CHECK_OPEN_LABEL}
        </Button>
      </Group>
    </Stack>
  );
}
