import { useEffect, useRef, useState } from "react";

import { Button } from "@mantine/core";

import { sanitizeForDisplay } from "@alcove/core";

import {
  relayTestResultText,
  relayTestSourceLabel,
  relayTestTransportLabel,
  runRelayTest,
} from "@psi/transport/relayTest";
import styles from "@styles/app.module.css";

import type {
  RelayTestResult,
  RelayTestTarget,
} from "@psi/transport/relayTest";

/** What the test does and proves, shown above the relays it contacts. */
export const RELAY_TEST_INTRO =
  "The test asks each relay below for a relay address, signing in with a " +
  "placeholder credential the relay is expected to refuse. A relay that " +
  "refuses it has answered, which shows that this browser reaches it over " +
  "that transport. It does not show that the relay passes an exchange's " +
  "traffic. Whoever runs each relay learns this browser's network address.";

/** Shown in place of the test when there is no relay to test. */
export const RELAY_TEST_NOTHING_TO_TEST =
  "No relay is saved in this browser and this site names none, so there is " +
  "no relay to test.";

/** Shown when the TURN field differs from the saved setting. */
export const RELAY_TEST_SAVED_ONLY =
  "The test uses the saved addresses. Save to test the ones entered above.";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; results: Array<RelayTestResult> };

/**
 * The relay test: the TURN urls a browser run lists from the saved setting and
 * the site's default relay, named before anything is contacted, and a button
 * that asks each of them. Nothing is contacted until the button is pressed.
 * Its parent keys it by the urls, so a changed list drops a shown result.
 */
export function RelayTestSection({
  targets,
  unsavedChanges,
  runTest = runRelayTest,
}: {
  /** The urls the test contacts, in a run's order. */
  targets: ReadonlyArray<RelayTestTarget>;
  /** Whether the TURN field differs from the saved setting. */
  unsavedChanges: boolean;
  /** Runs the test; {@link runRelayTest} when unset. */
  runTest?: typeof runRelayTest;
}) {
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controller.current?.abort(), []);

  function start() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ kind: "running" });
    void runTest(targets, { signal: current.signal }).then((results) => {
      if (!current.signal.aborted) setState({ kind: "done", results });
    });
  }

  if (targets.length === 0)
    return (
      <>
        <h2>Test the relays</h2>
        <p>{RELAY_TEST_NOTHING_TO_TEST}</p>
      </>
    );

  return (
    <>
      <h2>Test the relays</h2>
      <p>{RELAY_TEST_INTRO}</p>
      <ul>
        {targets.map((target) => (
          <li key={target.url}>
            <code>{sanitizeForDisplay(target.url)}</code> -{" "}
            {relayTestSourceLabel(target.source)}, over{" "}
            {relayTestTransportLabel(target.transport)}
          </li>
        ))}
      </ul>
      {unsavedChanges && (
        <p className={`${styles.small} ${styles.sub}`}>
          {RELAY_TEST_SAVED_ONLY}
        </p>
      )}
      <Button
        variant="outline"
        onClick={start}
        loading={state.kind === "running"}
      >
        Test these relays
      </Button>
      <div aria-live="polite">
        {state.kind === "done" && (
          <>
            <h3>Test results</h3>
            <ul>
              {state.results.map((result) => (
                <li key={`${result.url}\n${result.transport}`}>
                  <code>{sanitizeForDisplay(result.url)}</code>:{" "}
                  {relayTestResultText(result)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
