import { useEffect, useRef, useState } from "react";

import { Button, Group, Stack, Text } from "@mantine/core";

import {
  RELAY_CHECK_AGAIN_LABEL,
  RELAY_CHECK_CANCEL_LABEL,
  RELAY_CHECK_START_LABEL,
} from "@console/relayCheckModel";
import { runExchangeRelayCheck } from "@psi/transport/exchangeRelayCheck";
import styles from "@styles/app.module.css";

import {
  EXCHANGE_RELAY_CHECK_ERROR,
  EXCHANGE_RELAY_CHECK_INTRO,
  EXCHANGE_RELAY_CHECK_RUNNING,
  exchangeRelayCheckLineShown,
  exchangeRelayCheckOffered,
  exchangeRelayCheckStatement,
  exchangeRelayCheckVerdict,
} from "./exchangeRelayCheckModel";

import type {
  ExchangeRelayCheckDependencies,
  ExchangeRelayCheckSubject,
} from "@psi/transport/exchangeRelayCheck";
import type { RelayUrls } from "@psi/transport/ownRelaySetting";

import type {
  ExchangeRelayCheckHost,
  ExchangeRelayCheckLineShown,
} from "./exchangeRelayCheckModel";

/** The control that shows the hosts a check contacts, before any is contacted. */
export const EXCHANGE_RELAY_CHECK_OPEN_LABEL = "Check the relays";

// Every step past closed names the hosts it was entered under, so a step
// entered under other hosts than the current ones shows as closed.
type CheckState =
  | { step: "closed" }
  | { step: "hosts"; hostsKey: string }
  | { step: "checking"; hostsKey: string }
  | {
      step: "done";
      hostsKey: string;
      lines: Array<ExchangeRelayCheckLineShown>;
    }
  | { step: "error"; hostsKey: string };

const CLOSED: CheckState = { step: "closed" };

function HostList({ hosts }: { hosts: ReadonlyArray<ExchangeRelayCheckHost> }) {
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
 * The check of an exchange's relays, in its connection settings: offered
 * where a run of the exchange lists a relay, it shows the hosts it contacts
 * when the user opens it, contacts them only when the user starts it, and
 * reports for each relay whether it works and, where it does not, why and
 * what to change. A change of the hosts closes it and aborts a check still
 * running, as unmounting does, so the hosts shown are always the ones a
 * start contacts and a result is shown only under the hosts it checked.
 */
export function ExchangeRelayCheck({
  subject,
  invitationRelay,
  relayRegistrationOffered = false,
  scope,
  dependencies,
}: {
  subject: ExchangeRelayCheckSubject;
  /** The relay the accepted invitation names, which a line's words name. */
  invitationRelay?: RelayUrls;
  /** Relay registration follows on the page, so a line's words point at it. */
  relayRegistrationOffered?: boolean;
  /** A sentence after the intro saying which settings are checked. */
  scope?: string;
  /** Tests only. */
  dependencies?: ExchangeRelayCheckDependencies;
}) {
  const [entered, setState] = useState<CheckState>(CLOSED);
  const hostsKey = JSON.stringify(subject.hosts);
  // Aborted when the hosts change or the component unmounts; every check
  // started under these hosts runs under it.
  const hostsAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    hostsAbort.current = abort;
    setState(CLOSED);
    return () => abort.abort();
  }, [hostsKey]);
  const state =
    entered.step !== "closed" && entered.hostsKey !== hostsKey
      ? CLOSED
      : entered;
  const statement = exchangeRelayCheckStatement(subject.hosts);

  if (!exchangeRelayCheckOffered(subject.hosts)) return null;

  async function start(): Promise<void> {
    const signal = hostsAbort.current?.signal;
    if (signal === undefined) return;
    setState({ step: "checking", hostsKey });
    try {
      const lines = await runExchangeRelayCheck(subject, signal, dependencies);
      setState({
        step: "done",
        hostsKey,
        lines: lines.map((line) =>
          exchangeRelayCheckLineShown(line, {
            hosts: subject.hosts,
            ...(invitationRelay !== undefined && { invitationRelay }),
            relayRegistrationOffered,
          }),
        ),
      });
    } catch {
      if (!signal.aborted) setState({ step: "error", hostsKey });
    }
  }

  const intro = (
    <Text size="sm">
      {EXCHANGE_RELAY_CHECK_INTRO}
      {scope !== undefined && ` ${scope}`}
    </Text>
  );

  switch (state.step) {
    case "closed":
      return (
        <Stack gap="xs" mt="xs">
          {intro}
          <Group>
            <Button
              variant="default"
              onClick={() => setState({ step: "hosts", hostsKey })}
            >
              {EXCHANGE_RELAY_CHECK_OPEN_LABEL}
            </Button>
          </Group>
        </Stack>
      );
    case "hosts":
    case "checking": {
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
          <Group>
            <Button loading={checking} onClick={() => void start()}>
              {RELAY_CHECK_START_LABEL}
            </Button>
            {!checking && (
              <Button variant="default" onClick={() => setState(CLOSED)}>
                {RELAY_CHECK_CANCEL_LABEL}
              </Button>
            )}
          </Group>
          {checking && (
            <Text size="sm" role="status">
              {EXCHANGE_RELAY_CHECK_RUNNING}
            </Text>
          )}
        </Stack>
      );
    }
    case "done":
    case "error":
      return (
        <Stack gap="xs" mt="xs">
          <div role="status">
            {state.step === "done" ? (
              <>
                <Text size="sm">{exchangeRelayCheckVerdict(state.lines)}</Text>
                <ul>
                  {state.lines.map((line, index) => (
                    <li key={index}>
                      <Text size="sm">
                        <span className={styles.mono}>{line.url}</span>{" "}
                        <strong>
                          {line.works ? "Works" : "Does not work"}
                        </strong>
                        : {line.summary}
                      </Text>
                      {line.meaning !== undefined && (
                        <Text size="sm">What this means: {line.meaning}</Text>
                      )}
                      {line.action !== undefined && (
                        <Text size="sm">What to do: {line.action}</Text>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Text size="sm">{EXCHANGE_RELAY_CHECK_ERROR}</Text>
            )}
          </div>
          <Group>
            <Button
              variant="default"
              onClick={() => setState({ step: "hosts", hostsKey })}
            >
              {RELAY_CHECK_AGAIN_LABEL}
            </Button>
          </Group>
        </Stack>
      );
  }
}
