import { useEffect, useState } from "react";

import { Button, Group, Stack, Text } from "@mantine/core";

import {
  fetchRelayCheckOffer,
  startRelayCheck,
} from "@psi/jobClient/relayCheckClient";
import styles from "@styles/app.module.css";

import {
  RELAY_CHECK_AGAIN_LABEL,
  RELAY_CHECK_CANCEL_LABEL,
  RELAY_CHECK_INTRO,
  RELAY_CHECK_OPEN_LABEL,
  RELAY_CHECK_RUNNING,
  RELAY_CHECK_START_LABEL,
  RELAY_CHECK_UNREADABLE,
  WEBSOCKET_RELAY_NOT_CHECKED,
  relayCheckLinesShown,
  relayCheckOutcomeText,
  relayCheckPanelState,
  relayCheckShowsWebsocketNote,
  relayCheckStatusLabel,
  relayCheckUnavailableText,
  relayCheckVerdictSummary,
} from "./relayCheckModel";

import type { RelayCheckHost } from "@jobContract/relayCheckResponses";
import type { RelayCheckOffer } from "@psi/jobClient/relayCheckClient";

import type { RelayCheckPanelState } from "./relayCheckModel";

type AvailableOffer = Extract<RelayCheckOffer, { kind: "available" }>;

function HostList({ hosts }: { hosts: ReadonlyArray<RelayCheckHost> }) {
  return (
    <ul>
      {hosts.map(({ host, explanation }, index) => (
        <li key={index}>
          <span className={styles.mono}>{host}</span>
          {explanation.map((line, lineIndex) => (
            <Text size="sm" key={lineIndex}>
              {line}
            </Text>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * The console's relay check: the hosts `alcove doctor relay` contacts for the
 * working folder's `alcove.yaml` and `.alcove.key`, read from the console
 * before any is contacted, then the check itself, run by the console's CLI
 * only when the operator starts it, and its verdict in the CLI's words.
 * Shows nothing where the files name no TURN relay to check.
 */
export function RelayCheckPanel() {
  const [state, setState] = useState<RelayCheckPanelState>({ step: "reading" });

  useEffect(() => {
    let current = true;
    void fetchRelayCheckOffer().then((offer) => {
      if (current) setState(relayCheckPanelState(offer, false));
    });
    return () => {
      current = false;
    };
  }, []);

  async function open(): Promise<void> {
    setState({ step: "opening" });
    setState(relayCheckPanelState(await fetchRelayCheckOffer(), true));
  }

  async function start(offer: AvailableOffer): Promise<void> {
    setState({ step: "checking", offer });
    const outcome = await startRelayCheck(offer.configurationDigest);
    setState({
      step: "done",
      outcome,
      websocketNote: relayCheckShowsWebsocketNote(outcome, offer),
    });
  }

  switch (state.step) {
    case "reading":
    case "hidden":
      return null;
    case "closed":
    case "opening":
      return (
        <Stack gap="xs" mt="xs">
          <Text size="sm">{RELAY_CHECK_INTRO}</Text>
          <Group>
            <Button
              variant="default"
              loading={state.step === "opening"}
              onClick={() => void open()}
            >
              {RELAY_CHECK_OPEN_LABEL}
            </Button>
          </Group>
          {state.step === "closed" && state.unreadable && (
            <Text size="sm" role="status">
              {RELAY_CHECK_UNREADABLE}
            </Text>
          )}
        </Stack>
      );
    case "unavailable":
      return (
        <Stack gap="xs" mt="xs">
          <Text size="sm">{relayCheckUnavailableText(state.offer.reason)}</Text>
          {state.offer.websocketRelayNotChecked && (
            <Text size="sm">{WEBSOCKET_RELAY_NOT_CHECKED}</Text>
          )}
        </Stack>
      );
    case "hosts":
    case "checking": {
      const { offer } = state;
      const { statement } = offer;
      const checking = state.step === "checking";
      return (
        <Stack gap="xs" mt="xs">
          <Text size="sm">{statement.contactedHeading}</Text>
          <HostList hosts={statement.contacted} />
          {statement.notContacted !== undefined && (
            <>
              <Text size="sm">{statement.notContacted.heading}</Text>
              <HostList hosts={statement.notContacted.hosts} />
            </>
          )}
          <Text size="sm">{statement.closing}</Text>
          {offer.websocketRelayNotChecked && (
            <Text size="sm">{WEBSOCKET_RELAY_NOT_CHECKED}</Text>
          )}
          <Group>
            <Button loading={checking} onClick={() => void start(offer)}>
              {RELAY_CHECK_START_LABEL}
            </Button>
            {!checking && (
              <Button
                variant="default"
                onClick={() => setState({ step: "closed", unreadable: false })}
              >
                {RELAY_CHECK_CANCEL_LABEL}
              </Button>
            )}
          </Group>
          {checking && (
            <Text size="sm" role="status">
              {RELAY_CHECK_RUNNING}
            </Text>
          )}
        </Stack>
      );
    }
    case "done": {
      const { outcome, websocketNote } = state;
      return (
        <Stack gap="xs" mt="xs">
          <div role="status">
            {outcome.kind === "verdict" ? (
              <>
                <Text size="sm">
                  {relayCheckVerdictSummary(outcome.overall)}
                </Text>
                <ul>
                  {relayCheckLinesShown(outcome.checks).map((check) => (
                    <li key={check.id}>
                      <Text size="sm">
                        <strong>{relayCheckStatusLabel(check.status)}:</strong>{" "}
                        {check.headline}
                      </Text>
                      {check.meaning !== undefined && (
                        <Text size="sm">What this means: {check.meaning}</Text>
                      )}
                      {check.action !== undefined && (
                        <Text size="sm">What to do: {check.action}</Text>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Text size="sm">{relayCheckOutcomeText(outcome)}</Text>
            )}
            {websocketNote && (
              <Text size="sm">{WEBSOCKET_RELAY_NOT_CHECKED}</Text>
            )}
          </div>
          <Group>
            <Button variant="default" onClick={() => void open()}>
              {RELAY_CHECK_AGAIN_LABEL}
            </Button>
          </Group>
        </Stack>
      );
    }
  }
}
