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

  const start = (): void =>
    setState({ watch, state: { step: "running", startedAt: Date.now() } });

  return (
    <Stack gap="xs" mt="xs">
      {state.step === "done" ? (
        <div role="status">
          <ExchangeRelayCheckReport
            verdict={state.verdict}
            lines={state.lines}
          />
        </div>
      ) : (
        <Text size="sm">{INVITER_RELAY_CHECK_INTRO}</Text>
      )}
      <Group>
        <Button
          variant="default"
          loading={state.step === "running"}
          onClick={start}
        >
          {state.step === "done"
            ? RELAY_CHECK_AGAIN_LABEL
            : EXCHANGE_RELAY_CHECK_OPEN_LABEL}
        </Button>
      </Group>
      {state.step === "running" && (
        <Text size="sm" role="status">
          {EXCHANGE_RELAY_CHECK_RUNNING}
        </Text>
      )}
    </Stack>
  );
}
