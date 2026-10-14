import { describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  connectNoticingDefaultRelay,
  relayWithDefaultForRun,
} from "../../../src/psi/transport/defaultRelay.js";

import type {
  RelayRegistrationOutcome,
  enrollRelayKeyWithoutToken,
} from "@alcove/core";

// The enrollment each browser run makes at dial, with the registrar client
// mocked: core's suite holds the request it sends and its retries.

const DEFAULT_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};

const OWN = {
  turn: ["turns:own-relay.example.org:443?transport=tcp"],
  stun: [],
};

function answering(outcome: RelayRegistrationOutcome) {
  return vi.fn<typeof enrollRelayKeyWithoutToken>(() =>
    Promise.resolve(outcome),
  );
}

describe("relayWithDefaultForRun", () => {
  test("enrolls the run's key with its signal and lists the relay once enrolled", async () => {
    const secret = generateSharedSecret();
    const signal = new AbortController().signal;
    const enroll = answering({
      kind: "registered",
      maxAgeDays: null,
      lapsesAt: "2026-10-15T13:10:00Z",
    });
    const run = await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      { signal },
    );
    expect(run).toEqual({
      relay: { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] },
      defaultRelayNotEnrolled: false,
    });
  });

  test.each<[string, RelayRegistrationOutcome]>([
    ["a 409", { kind: "refused", status: 409, reason: "held" }],
    ["a 429", { kind: "unavailable", status: 429, reason: "too many" }],
    ["no answer", { kind: "unavailable", reason: "it could not be reached" }],
  ])(
    "after %s dials with the relay it had, and marks the enrollment failed",
    async (_case, outcome) => {
      const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => DEFAULT_RELAY,
        enroll: answering(outcome),
      });
      expect(run).toEqual({ relay: OWN, defaultRelayNotEnrolled: true });
    },
  );

  test("contacts no registrar when the build names no default relay", async () => {
    const enroll = answering({ kind: "refused", status: 409 });
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      undefined,
      {
        setting: () => undefined,
        enroll,
      },
    );
    expect(enroll).not.toHaveBeenCalled();
    expect(run).toEqual({ relay: undefined, defaultRelayNotEnrolled: false });
  });
});

describe("connectNoticingDefaultRelay", () => {
  const failing = () => Promise.reject(new Error("timed out"));

  test("shows the notice when a run whose enrollment failed does not connect", async () => {
    const onRunNotice = vi.fn();
    await expect(
      connectNoticingDefaultRelay(
        { defaultRelayNotEnrolled: true },
        { onRunNotice },
        failing,
      ),
    ).rejects.toThrow("timed out");
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("shows nothing when the run connects, enrolled, or cancelled", async () => {
    const onRunNotice = vi.fn();
    await expect(
      connectNoticingDefaultRelay(
        { defaultRelayNotEnrolled: true },
        { onRunNotice },
        () => Promise.resolve("open"),
      ),
    ).resolves.toBe("open");
    await expect(
      connectNoticingDefaultRelay(
        { defaultRelayNotEnrolled: false },
        { onRunNotice },
        failing,
      ),
    ).rejects.toThrow();
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      connectNoticingDefaultRelay(
        { defaultRelayNotEnrolled: true },
        { onRunNotice, signal: cancel.signal },
        failing,
      ),
    ).rejects.toThrow();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});
