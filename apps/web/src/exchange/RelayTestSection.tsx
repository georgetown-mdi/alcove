import { useEffect, useRef, useState } from "react";

import { Button, Loader } from "@mantine/core";

import { sanitizeForDisplay } from "@alcove/core";

import {
  RELAY_TEST_BOUND_MS,
  relayTestResultText,
  relayTestRunningText,
  relayTestSourceLabel,
  relayTestSupported,
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
  "The test checks that this browser can reach each relay below. It does not check " +
  "that an exchange's traffic will pass through it. Each relay's operator " +
  "learns this browser's network address.";

/** Shown in place of the test when there is no relay to test. */
export const RELAY_TEST_NOTHING_TO_TEST =
  "No relay is saved in this browser and this site names none, so there is " +
  "no relay to test. Enter a TURN server url above and save it to test it.";

/** Shown when the TURN field differs from the saved setting. */
export const RELAY_TEST_SAVED_ONLY =
  "The test uses the saved addresses. Save to test the ones entered above.";

/** Shown in place of the test in a browser without WebRTC connections. */
export const RELAY_TEST_UNSUPPORTED =
  "This browser cannot run the test: it does not support the connections " +
  "the test uses.";

/** Shown when the test itself failed, with no result for any relay. */
export const RELAY_TEST_FAILED =
  "The test could not run in this browser. Reload the page and run it again.";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "failed" }
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
  boundMs = RELAY_TEST_BOUND_MS,
}: {
  /** The urls the test contacts, in a run's order. */
  targets: ReadonlyArray<RelayTestTarget>;
  /** Whether the TURN field differs from the saved setting. */
  unsavedChanges: boolean;
  /** Runs the test; {@link runRelayTest} when unset. */
  runTest?: typeof runRelayTest;
  /** How long each relay is waited on; {@link RELAY_TEST_BOUND_MS}. */
  boundMs?: number;
}) {
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const controller = useRef<AbortController | undefined>(undefined);
  const running = state.kind === "running";

  useEffect(() => () => controller.current?.abort(), []);

  function start() {
    // The busy button keeps focus, so it stays enabled and ignores a press.
    if (running) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ kind: "running" });
    runTest(targets, { signal: current.signal, boundMs }).then(
      (results) => {
        if (!current.signal.aborted) setState({ kind: "done", results });
      },
      () => {
        if (!current.signal.aborted) setState({ kind: "failed" });
      },
    );
  }

  if (!relayTestSupported())
    return (
      <>
        <h2>Test the relays</h2>
        <p>{RELAY_TEST_UNSUPPORTED}</p>
      </>
    );

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
        data-disabled={running || undefined}
        aria-disabled={running || undefined}
        leftSection={running ? <Loader size="xs" /> : undefined}
      >
        Test these relays
      </Button>
      <div aria-live="polite">
        {running && <p>{relayTestRunningText(targets.length, boundMs)}</p>}
        {state.kind === "failed" && <p>{RELAY_TEST_FAILED}</p>}
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
