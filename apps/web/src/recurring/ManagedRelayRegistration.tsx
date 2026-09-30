import { useState } from "react";

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
} from "@psi/managed/managedRelayRegistration";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { dateTimeLabel } from "@psi/formatting";
import { persistManagedExchangeRelayRegistrar } from "@psi/managed/managedExchangeStore";

import styles from "@styles/app.module.css";

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

const URL_PROBLEM =
  "Enter the registrar's address as https:// followed by its host and an " +
  "optional port, with no path.";

const EXCHANGE_ID_PROBLEM =
  "Enter an exchange id of 1 to 128 letters, digits, '.', '_' and '-', not " +
  "starting with '-' or 'alcove-verify-'. The registrar's answers let anyone " +
  "learn whether an id is enrolled, so choose one that names neither party.";

/** What the last enrollment or removal on this page came to. */
type Outcome =
  | { kind: "enrolled" }
  | { kind: "removed" }
  | { kind: "failed"; message: string };

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
  const [problems, setProblems] = useState<Array<string>>([]);

  const enrolled = record.relayRegistrar;
  const pendingSince = record.relayRegistrationPendingSince;

  const enroll = async () => {
    const parsed = RelayRegistrarSchema.safeParse({ url, exchangeId });
    if (!parsed.success) {
      const paths = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      setProblems([
        ...(paths.has("url") ? [URL_PROBLEM] : []),
        ...(paths.has("exchangeId") ? [EXCHANGE_ID_PROBLEM] : []),
      ]);
      return;
    }
    setProblems([]);
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
      setOutcome({ kind: "failed", message: failureText(error) });
    } finally {
      setOwnerToken("");
      setBusy(false);
    }
  };

  const stop = async () => {
    setOutcome(undefined);
    setBusy(true);
    try {
      await persistManagedExchangeRelayRegistrar(record.id, undefined);
      setOutcome({ kind: "removed" });
      onChanged();
    } catch (error) {
      setOutcome({ kind: "failed", message: failureText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>{RELAY_REGISTRATION_TITLE}</h2>
      <p className={styles.small}>{RELAY_REGISTRATION_TEXT}</p>
      {enrolled !== undefined && (
        <p className={styles.small}>
          {`Enrolled at ${relayRegistrarLabel(enrolled)}.`}
          {pendingSince !== undefined &&
            ` The registration of the current key has not been confirmed ` +
              `since ${dateTimeLabel(new Date(pendingSince))}; the next run ` +
              "retries it before it connects."}
        </p>
      )}
      {runInFlight ? (
        <p className={styles.small}>
          A run of this exchange is under way. Enroll it once the run ends.
        </p>
      ) : (
        <Stack gap="xs">
          <TextInput
            label="Registrar address"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            disabled={busy}
          />
          <TextInput
            label="Exchange id at the registrar"
            value={exchangeId}
            onChange={(event) => setExchangeId(event.currentTarget.value)}
            disabled={busy}
          />
          <PasswordInput
            label="Relay-owner token"
            description={TOKEN_TEXT}
            value={ownerToken}
            onChange={(event) => setOwnerToken(event.currentTarget.value)}
            autoComplete="off"
            disabled={busy}
          />
          <Checkbox
            label="Replace the key the registrar holds for this exchange id"
            checked={replace}
            onChange={(event) => setReplace(event.currentTarget.checked)}
            disabled={busy || ownerToken === ""}
          />
          {problems.map((problem) => (
            <p key={problem} className={styles.small}>
              {problem}
            </p>
          ))}
          <Group gap="sm">
            <Button onClick={() => void enroll()} loading={busy}>
              Enroll
            </Button>
            {enrolled !== undefined && (
              <Button
                variant="default"
                onClick={() => void stop()}
                disabled={busy}
              >
                Stop registering
              </Button>
            )}
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
          Runs of this exchange no longer register a relay key. The registrar
          keeps the key it holds until its registration lapses.
        </p>
      )}
      {outcome?.kind === "failed" && (
        <Alert color="red" title="The exchange was not enrolled" mt="sm">
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
