import { describe, expect, test } from "vitest";

import {
  relayCheckLinesShown,
  relayCheckPanelState,
  relayCheckShowsUnavailable,
  relayCheckUnavailableText,
  relayCheckVerdictSummary,
} from "@console/relayCheckModel";

import type { RelayCheckLine } from "@jobContract/relayCheckResponses";
import type { RelayCheckOffer } from "@psi/jobClient/relayCheckClient";

describe("relayCheckLinesShown", () => {
  const skipped = (id: string, action: string): RelayCheckLine => ({
    id,
    status: "skipped",
    headline: `${id}: not contacted.`,
    meaning: "a run does not reach it.",
    action,
  });
  const turn2 = {
    id: "turn_2",
    status: "skipped",
    headline: "turn_2: not contacted.",
  };

  test.each([
    ["the same action drops both", "List it first.", turn2],
    [
      "a different action keeps the first one's action",
      "Remove it.",
      { ...turn2, action: "List it first." },
    ],
  ])(
    "a meaning shared by the next skipped check is stated once: %s",
    (_name, nextAction, firstShown) => {
      const checks: Array<RelayCheckLine> = [
        { id: "turn_1", status: "ok", headline: "reached." },
        skipped("turn_2", "List it first."),
        skipped("turn_3", nextAction),
      ];
      expect(relayCheckLinesShown(checks)).toEqual([
        checks[0],
        firstShown,
        checks[2],
      ]);
    },
  );

  test("each WebSocket relay's line is shown as the server sent it, its meaning and action included", () => {
    const checks: Array<RelayCheckLine> = [
      { id: "turn_1", status: "ok", headline: "reached." },
      { id: "websocket_1", status: "ok", headline: "admitted." },
      {
        id: "websocket_2",
        status: "fail",
        headline: "not admitted.",
        meaning: "the relay holds no key for this exchange.",
        action: "Run this check again.",
      },
    ];
    expect(relayCheckLinesShown(checks)).toEqual(checks);
  });
});

describe("relayCheckPanelState", () => {
  const hiddenReason: RelayCheckOffer = {
    kind: "unavailable",
    reason: "not-webrtc",
  };

  test("a reason the panel hides is hidden until the operator opens the check", () => {
    expect(relayCheckPanelState(hiddenReason, false)).toEqual({
      step: "hidden",
    });
    expect(relayCheckPanelState(hiddenReason, true)).toEqual({
      step: "unavailable",
      offer: hiddenReason,
    });
  });
});

describe("relayCheckShowsUnavailable", () => {
  test("states why where the files name a relay the operator may expect checked", () => {
    for (const reason of [
      "relays-left-out",
      "key-file",
      "configuration-refused",
    ] as const)
      expect(relayCheckShowsUnavailable({ reason })).toBe(true);
  });

  test("shows nothing where the files name no relay", () => {
    for (const reason of [
      "no-configuration",
      "not-webrtc",
      "ice-provision",
      "no-relay",
    ] as const)
      expect(relayCheckShowsUnavailable({ reason })).toBe(false);
  });

  test("a configuration with no relay is told it lists neither kind", () => {
    expect(relayCheckUnavailableText("no-relay")).toBe(
      "The alcove.yaml in your working folder lists no TURN server and no " +
        "WebSocket relay, so there is no relay to check.",
    );
  });
});

describe("relayCheckVerdictSummary", () => {
  test("speaks of every relay the check asked, not the TURN relay alone", () => {
    expect(relayCheckVerdictSummary("ok")).toBe(
      "Every relay the check asked answered this console as a run needs.",
    );
    expect(relayCheckVerdictSummary("fix_and_retry")).toMatch(
      /^A relay the check asked did not answer/,
    );
  });
});
