import { useId, useState } from "react";

import {
  Alert,
  Button,
  Checkbox,
  Group,
  PasswordInput,
  Stack,
  TextInput,
} from "@mantine/core";

import {
  RelayRegistrarSchema,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  relayRegistrarLabel,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  enrollManagedRelayRegistrar,
  managedRelayEnrollmentFailureMessage,
  relayRegistrarExchangeIdProblems,
  relayRegistrarUrlProblems,
  stopManagedRelayRegistration,
} from "@psi/managed/managedRelayRegistration";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { managedExchangeRelaysThroughPartner } from "@psi/managed/managedExchangeRecord";

import styles from "@styles/app.module.css";

import { relayRegistrationPendingLine } from "./savedExchangesModel";

import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/** The section's heading. */
export const RELAY_REGISTRATION_TITLE = "Relay registration";

const RELAY_REGISTRATION_TEXT =
  "If the relay in this browser's relay settings runs the Alcove relay " +
  "registrar, enroll this exchange there once. Each run that relays through " +
  "that relay then registers the relay key derived from the exchange's new " +
  "shared secret, so the relay accepts only the current key. A run relaying " +
  "through a relay your partner's invitation named registers nothing.";

const TOKEN_TEXT =
  "The relay-owner token is sent to the registrar with this one request and " +
  "is not kept. Leave it empty when the registrar already holds this " +
  "exchange's current key, as after enrolling it from the command line.";

/** Why an exchange relaying through its partner's relay offers no
 * enrollment. */
export const PARTNER_RELAY_TEXT =
  "This exchange relays through the relay your partner's invitation named, " +
  "and your partner registers its key there, so it cannot be enrolled here.";

const STOPPED_TEXT =
  "Runs of this exchange no longer register a relay key. The registrar " +
  "keeps the key it holds until its registration lapses.";

/** What stopping registration means for the next run through this browser's
 * relay, in the words of the relay settings' notice. */
export const STOPPED_OWN_RELAY_TEXT =
  "The shared secret changes after every run that completes its handshake, " +
  "so from the next such run the relay refuses this exchange unless its key " +
  "is registered with the relay again after each run.";

const EXCHANGE_ID_PRIVACY =
  "The registrar's answers let anyone learn whether an id is enrolled, so " +
  "choose one that names neither party.";

/** What the last enrollment or removal on this page came to. */
type Outcome =
  | { kind: "enrolled" }
  | { kind: "removed" }
  | { kind: "failed"; action: "enroll" | "stop"; message: string };

const FAILURE_TITLE: Record<"enroll" | "stop", string> = {
  enroll: "The exchange was not enrolled",
  stop: "Registration was not stopped",
};

/**
 * Enrolling a saved exchange at its relay's registrar, and stopping its
 * registration. The relay-owner token is component state from the moment it is
 * typed until the request settles, then cleared; it reaches no store. Every
 * write is withheld while a run holds the exchange. `onChanged` is told once
 * the stored exchange changed, so the page reads it again.
 */
export function ManagedRelayRegistration({
  record,
  runInFlight,
  onChanged,
}: {
  record: RunnableManagedExchangeRecord;
  runInFlight: boolean;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState(record.relayRegistrar?.url ?? "");
  const [exchangeId, setExchangeId] = useState(
    record.relayRegistrar?.exchangeId ?? "",
  );
  const [ownerToken, setOwnerToken] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [urlProblems, setUrlProblems] = useState<Array<string>>([]);
  const [exchangeIdProblems, setExchangeIdProblems] = useState<Array<string>>(
    [],
  );
  const partnerRelayTextId = useId();

  const enrolled = record.relayRegistrar;
  const pendingLine = relayRegistrationPendingLine(record);
  const relaysThroughPartner = managedExchangeRelaysThroughPartner(record);

  const changeOwnerToken = (value: string) => {
    setOwnerToken(value);
    if (value === "") setReplace(false);
  };

  const enroll = async () => {
    const parsed = RelayRegistrarSchema.safeParse({ url, exchangeId });
    if (!parsed.success) {
      const { issues } = parsed.error;
      const idProblems = relayRegistrarExchangeIdProblems(issues);
      setUrlProblems(relayRegistrarUrlProblems(issues));
      setExchangeIdProblems(
        idProblems.length > 0 ? [...idProblems, EXCHANGE_ID_PRIVACY] : [],
      );
      return;
    }
    setUrlProblems([]);
    setExchangeIdProblems([]);
    setOutcome(undefined);
    setBusy(true);
    const token = ownerToken === "" ? undefined : ownerToken;
    try {
      const result = await enrollManagedRelayRegistrar({
        id: record.id,
        registrar: parsed.data,
        ...(token !== undefined && { ownerToken: token }),
        replace,
      });
      if (result.kind === "enrolled") {
        setOutcome({ kind: "enrolled" });
        onChanged();
      } else
        setOutcome({
          kind: "failed",
          action: "enroll",
          message: sanitizeForDisplay(
            managedRelayEnrollmentFailureMessage(
              parsed.data,
              result.outcome,
              token !== undefined,
            ),
            { maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH },
          ),
        });
    } catch (error) {
      setOutcome({
        kind: "failed",
        action: "enroll",
        message: failureText(error),
      });
    } finally {
      changeOwnerToken("");
      setBusy(false);
    }
  };

  const stop = async () => {
    setOutcome(undefined);
    setBusy(true);
    try {
      await stopManagedRelayRegistration(record.id);
      setOutcome({ kind: "removed" });
      onChanged();
    } catch (error) {
      setOutcome({
        kind: "failed",
        action: "stop",
        message: failureText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const stopButton = enrolled !== undefined && (
    <Button variant="default" onClick={() => void stop()} disabled={busy}>
      Stop registering
    </Button>
  );

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>{RELAY_REGISTRATION_TITLE}</h2>
      <p className={styles.small}>{RELAY_REGISTRATION_TEXT}</p>
      {(enrolled !== undefined || pendingLine !== undefined) && (
        <p className={styles.small}>
          {[
            ...(enrolled !== undefined
              ? [`Enrolled at ${relayRegistrarLabel(enrolled)}.`]
              : []),
            ...(pendingLine !== undefined ? [pendingLine] : []),
          ].join(" ")}
        </p>
      )}
      {runInFlight ? (
        <p className={styles.small}>
          A run of this exchange is under way. Change its relay registration
          once the run ends.
        </p>
      ) : relaysThroughPartner ? (
        <Stack gap="xs">
          <p id={partnerRelayTextId} className={styles.small}>
            {PARTNER_RELAY_TEXT}
          </p>
          <Group gap="sm">
            <Button disabled aria-describedby={partnerRelayTextId}>
              Enroll
            </Button>
            {stopButton}
          </Group>
        </Stack>
      ) : (
        <Stack gap="xs">
          <TextInput
            label="Registrar address"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            error={urlProblems.length > 0 ? urlProblems.join(" ") : undefined}
            errorProps={{ role: "alert" }}
            disabled={busy}
          />
          <TextInput
            label="Exchange id at the registrar"
            value={exchangeId}
            onChange={(event) => setExchangeId(event.currentTarget.value)}
            error={
              exchangeIdProblems.length > 0
                ? exchangeIdProblems.join(" ")
                : undefined
            }
            errorProps={{ role: "alert" }}
            disabled={busy}
          />
          <PasswordInput
            label="Relay-owner token"
            description={TOKEN_TEXT}
            value={ownerToken}
            onChange={(event) => changeOwnerToken(event.currentTarget.value)}
            autoComplete="off"
            disabled={busy}
          />
          <Checkbox
            label="Replace the key the registrar holds for this exchange id"
            checked={replace}
            onChange={(event) => setReplace(event.currentTarget.checked)}
            disabled={busy || ownerToken === ""}
          />
          <Group gap="sm">
            <Button onClick={() => void enroll()} loading={busy}>
              Enroll
            </Button>
            {stopButton}
          </Group>
        </Stack>
      )}
      {outcome?.kind === "enrolled" && (
        <p className={styles.small}>
          The registrar holds this exchange&apos;s current relay key.
        </p>
      )}
      {outcome?.kind === "removed" && (
        <p className={styles.small}>
          {relaysThroughPartner
            ? STOPPED_TEXT
            : `${STOPPED_TEXT} ${STOPPED_OWN_RELAY_TEXT}`}
        </p>
      )}
      {outcome?.kind === "failed" && (
        <Alert
          role="alert"
          color="red"
          title={FAILURE_TITLE[outcome.action]}
          mt="sm"
        >
          {outcome.message}
        </Alert>
      )}
    </div>
  );
}

function failureText(error: unknown): string {
  if (error instanceof ManagedExchangeLockUnavailableError)
    return "A run of this exchange holds it. Try again once the run ends.";
  return sanitizeErrorForDisplay(error);
}
