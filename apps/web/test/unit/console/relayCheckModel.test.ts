import { describe, expect, test } from "vitest";

import {
  relayCheckLinesShown,
  relayCheckPanelState,
  relayCheckShowsUnavailable,
  relayCheckShowsWebsocketNote,
} from "@console/relayCheckModel";

import type {
  RelayCheckOffer,
  RelayCheckOutcome,
} from "@psi/jobClient/relayCheckClient";
import type { RelayCheckLine } from "@jobContract/relayCheckResponses";

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
});

describe("relayCheckPanelState", () => {
  const hiddenReason: RelayCheckOffer = {
    kind: "unavailable",
    reason: "not-webrtc",
    websocketRelayNotChecked: false,
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

describe("relayCheckShowsWebsocketNote", () => {
  const verdict: RelayCheckOutcome = {
    kind: "verdict",
    overall: "ok",
    checks: [],
  };

  test.each<[RelayCheckOutcome, boolean, boolean]>([
    [verdict, true, true],
    [verdict, false, false],
    [
      {
        kind: "unavailable",
        reason: "key-file",
        websocketRelayNotChecked: true,
      },
      false,
      true,
    ],
    [
      {
        kind: "unavailable",
        reason: "key-file",
        websocketRelayNotChecked: false,
      },
      true,
      false,
    ],
    ...(
      [
        "refused",
        "timeout",
        "configuration-changed",
        "busy",
        "exchange-running",
        "error",
      ] as const
    ).map((kind): [RelayCheckOutcome, boolean, boolean] => [
      { kind },
      true,
      false,
    ]),
  ])(
    "%o with a WebSocket relay listed %s shows the note: %s",
    (outcome, websocketRelayNotChecked, shown) => {
      expect(
        relayCheckShowsWebsocketNote(outcome, { websocketRelayNotChecked }),
      ).toBe(shown);
    },
  );
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
