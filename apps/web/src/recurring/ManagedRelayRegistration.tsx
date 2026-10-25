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
  EXCHANGE_ID_PRIVACY,
  enrollManagedRelayRegistrar,
  managedRelayEnrollmentFailureMessage,
  relayRegistrarExchangeIdProblems,
  relayRegistrarUrlProblems,
  stopManagedRelayRegistration,
} from "@psi/managed/managedRelayRegistration";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { stopWaitingManagedWindowRun } from "@psi/managed/managedWindowRuns";

import styles from "@styles/app.module.css";

import {
  RELAY_REGISTRATION_HELD_BY_RUN_TEXT,
  STOP_RUN_AND_ENROLL_LABEL,
} from "./managedRunHolder";
import { ManagedRunHolderNote } from "./ManagedRunHolderNote";
import { relayRegistrationPendingLine } from "./savedExchangesModel";

import type { ManagedRunHolder } from "./managedRunHolder";
import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/** The section's heading. */
export const RELAY_REGISTRATION_TITLE = "Relay registration";

const RELAY_REGISTRATION_TEXT =
  "If the relay in this browser's relay settings runs the Alcove relay " +
  "registrar, enroll this exchange there once. Each run that relays through " +
  "that relay then registers the relay key derived from the exchange's new " +
  "shared secret, so the relay accepts only the current key.";

const TOKEN_TEXT =
  "The relay-owner token is sent to the registrar with this one request and " +
  "is not kept. Leave it empty when the registrar already holds this " +
  "exchange's current key, as after enrolling it from the command line.";

const STOPPED_TEXT =
  "Runs of this exchange no longer register a relay key. The registrar " +
  "keeps the key it holds until its registration lapses.";

/** What stopping registration means for the next run through this browser's
 * relay, in the words of the relay settings' notice. */
export const STOPPED_OWN_RELAY_TEXT =
  "The shared secret changes after every run that completes its handshake, " +
  "so from the next such run the relay refuses this exchange unless its key " +
  "is registered with the relay again after each run.";

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
 * typed until the request settles, then cleared; it reaches no store. Both
 * writes take the exchange's run lock and are withheld while a run holds it;
 * the form stays editable, and a run of this window still waiting for its
 * partner can be stopped to enroll at once. `onChanged` is told once the
 * stored exchange changed, so the page reads it again.
 */
export function ManagedRelayRegistration({
  record,
  runInFlight,
  runHolder,
  onRunLockRefused,
  onRecheckRunLock,
  onChanged,
}: {
  record: RunnableManagedExchangeRecord;
  /** Whether a run of this exchange is under way anywhere this browser
   * profile can see; both writes wait it out. */
  runInFlight: boolean;
  /** Where that run is ({@link ./managedRunHolder.ts}). */
  runHolder: ManagedRunHolder | undefined;
  /** Report that a write found the run lock held. */
  onRunLockRefused: () => void;
  /** Re-read the run lock now. */
  onRecheckRunLock: () => void;
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

  const enrolled = record.relayRegistrar;
  const pendingLine = relayRegistrationPendingLine(record);

  const changeOwnerToken = (value: string) => {
    setOwnerToken(value);
    if (value === "") setReplace(false);
  };

  const enroll = async (afterStop: boolean) => {
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
    let keepToken = false;
    try {
      // After a stop the lock is requested queued, so the stopped run's next
      // scheduled attempt, which asks ifAvailable, cannot take it first.
      const result = await enrollManagedRelayRegistrar({
        id: record.id,
        registrar: parsed.data,
        ...(token !== undefined && { ownerToken: token }),
        replace,
        lock: afterStop ? {} : { ifAvailable: true },
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
      // A lock refusal sent nothing, so the token stays for the retry.
      keepToken = error instanceof ManagedExchangeLockUnavailableError;
      if (keepToken) onRunLockRefused();
      setOutcome({
        kind: "failed",
        action: "enroll",
        message: failureText(error),
      });
    } finally {
      if (!keepToken) changeOwnerToken("");
      setBusy(false);
    }
  };

  const stopRunAndEnroll = () => {
    if (stopWaitingManagedWindowRun(record.id) !== "stopped") {
      onRecheckRunLock();
      return;
    }
    void enroll(true);
  };

  const stop = async () => {
    setOutcome(undefined);
    setBusy(true);
    try {
      await stopManagedRelayRegistration(record.id);
      setOutcome({ kind: "removed" });
      onChanged();
    } catch (error) {
      if (error instanceof ManagedExchangeLockUnavailableError)
        onRunLockRefused();
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
    <Button
      variant="default"
      onClick={() => void stop()}
      disabled={busy || runInFlight}
    >
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
          <Button
            onClick={() => void enroll(false)}
            loading={busy}
            disabled={runInFlight}
          >
            Enroll
          </Button>
          {stopButton}
        </Group>
        <ManagedRunHolderNote
          holder={runInFlight ? runHolder : undefined}
          text={RELAY_REGISTRATION_HELD_BY_RUN_TEXT}
          stopLabel={STOP_RUN_AND_ENROLL_LABEL}
          busy={busy}
          onStop={stopRunAndEnroll}
        />
      </Stack>
      {outcome?.kind === "enrolled" && (
        <p className={styles.small}>
          The registrar holds this exchange&apos;s current relay key.
        </p>
      )}
      {outcome?.kind === "removed" && (
        <p className={styles.small}>
          {STOPPED_TEXT} {STOPPED_OWN_RELAY_TEXT}
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
    return (
      "A run of this exchange started before the request was sent, so " +
      "nothing changed. Try again once the run ends."
    );
  return sanitizeErrorForDisplay(error);
}
