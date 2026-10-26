import { describe, expect, test } from "vitest";

import {
  relayCheckLinesShown,
  relayCheckShowsUnavailable,
} from "@console/relayCheckModel";

import type { RelayCheckLine } from "@psi/jobClient/relayCheckClient";

describe("relayCheckLinesShown", () => {
  test("states a meaning shared by a run of skipped checks once, under the last", () => {
    const skipped = (id: string): RelayCheckLine => ({
      id,
      status: "skipped",
      headline: `${id}: not contacted.`,
      meaning: "a run does not reach it.",
      action: "List it first.",
    });
    const checks: Array<RelayCheckLine> = [
      { id: "turn_1", status: "ok", headline: "reached." },
      skipped("turn_2"),
      skipped("turn_3"),
    ];

    expect(relayCheckLinesShown(checks)).toEqual([
      checks[0],
      { id: "turn_2", status: "skipped", headline: "turn_2: not contacted." },
      checks[2],
    ]);
  });
});

describe("relayCheckShowsUnavailable", () => {
  test("states why where the files name a relay the operator may expect checked", () => {
    expect(
      relayCheckShowsUnavailable({
        reason: "no-turn-url",
        websocketRelayNotChecked: true,
      }),
    ).toBe(true);
    expect(
      relayCheckShowsUnavailable({
        reason: "turn-urls-left-out",
        websocketRelayNotChecked: false,
      }),
    ).toBe(true);
    expect(
      relayCheckShowsUnavailable({
        reason: "key-file",
        websocketRelayNotChecked: false,
      }),
    ).toBe(true);
  });

  test("shows nothing where the files name no relay", () => {
    for (const reason of [
      "no-configuration",
      "not-webrtc",
      "ice-provision",
    ] as const)
      expect(
        relayCheckShowsUnavailable({ reason, websocketRelayNotChecked: false }),
      ).toBe(false);
    expect(
      relayCheckShowsUnavailable({
        reason: "no-turn-url",
        websocketRelayNotChecked: false,
      }),
    ).toBe(false);
  });
});
