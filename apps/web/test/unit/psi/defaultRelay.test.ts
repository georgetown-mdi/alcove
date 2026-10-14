import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithoutToken,
  generateSharedSecret,
} from "@alcove/core";

import {
  DEFAULT_RELAY_DIAL_WAIT_MS,
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  connectNoticingDefaultRelay,
  enrollAtDefaultRelay,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
  startDefaultRelayEnrollment,
} from "../../../src/psi/transport/defaultRelay.js";

import type { RelayRegistrationOutcome } from "@alcove/core";

// The enrollment each browser run lists the default relay under, with the
// registrar client mocked: core's suite holds the request it sends and its
// retries.

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
  test("with no enrollment on this page makes one attempt bounded by the dial's wait, and lists the relay once enrolled", async () => {
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
      {
        signal,
        timeoutMs: DEFAULT_RELAY_DIAL_WAIT_MS,
        retryDelaysMs: [],
      },
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

// A registrar that never answers.
function neverAnswering() {
  return vi.fn<typeof enrollRelayKeyWithoutToken>(
    () => new Promise<never>(() => {}),
  );
}

const REGISTERED: RelayRegistrationOutcome = {
  kind: "registered",
  maxAgeDays: null,
  lapsesAt: null,
};

const SHORT_WAIT_MS = 50;

const WITHOUT_DEFAULT = { relay: OWN, defaultRelayNotEnrolled: true };

const WITH_DEFAULT = {
  relay: { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] },
  defaultRelayNotEnrolled: false,
};

async function untilCalled(enroll: {
  mock: { calls: ReadonlyArray<unknown> };
}): Promise<void> {
  while (enroll.mock.calls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the dial's wait for the default relay enrollment", () => {
  test("an inviter's dial reuses the enrollment its invitation confirmed and contacts the registrar no more", async () => {
    const secret = generateSharedSecret();
    await enrollAtDefaultRelay(secret, {
      setting: () => DEFAULT_RELAY,
      enroll: answering(REGISTERED),
    });
    const atDial = neverAnswering();
    const run = await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: atDial,
      dialWaitMs: 60_000,
    });
    expect(atDial).not.toHaveBeenCalled();
    expect(run).toEqual(WITH_DEFAULT);
  });

  test("an inviter's dial with no confirmed enrollment dials without the relay once its one attempt's wait passes", async () => {
    const enroll = neverAnswering();
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      dialWaitMs: SHORT_WAIT_MS,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      timeoutMs: SHORT_WAIT_MS,
      retryDelaysMs: [],
    });
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("through the registrar client, a registrar that never answers costs the dial one request", async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: (params, env) =>
        enrollRelayKeyWithoutToken(params, { ...env, fetch: hangingFetch }),
      dialWaitMs: SHORT_WAIT_MS,
    });
    expect(hangingFetch).toHaveBeenCalledOnce();
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("an acceptor's dial waits for the enrollment started when it opened the invitation, then dials without the relay", async () => {
    const secret = generateSharedSecret();
    const opened = neverAnswering();
    startDefaultRelayEnrollment(secret, {
      setting: () => DEFAULT_RELAY,
      enroll: opened,
    });
    await untilCalled(opened);
    const atDial = neverAnswering();
    const run = await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: atDial,
      dialWaitMs: SHORT_WAIT_MS,
    });
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      {},
    );
    expect(atDial).not.toHaveBeenCalled();
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("an enrollment that confirms after a dial's wait is listed by the next dial", async () => {
    const secret = generateSharedSecret();
    let confirm: (outcome: RelayRegistrationOutcome) => void = () => {};
    const opened = vi.fn<typeof enrollRelayKeyWithoutToken>(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    startDefaultRelayEnrollment(secret, {
      setting: () => DEFAULT_RELAY,
      enroll: opened,
    });
    await untilCalled(opened);
    const dial = {
      setting: () => DEFAULT_RELAY,
      enroll: neverAnswering(),
      dialWaitMs: SHORT_WAIT_MS,
    };
    expect(await relayWithDefaultForRun(secret, OWN, dial)).toEqual(
      WITHOUT_DEFAULT,
    );
    confirm(REGISTERED);
    expect(await relayWithDefaultForRun(secret, OWN, dial)).toEqual(
      WITH_DEFAULT,
    );
    expect(dial.enroll).not.toHaveBeenCalled();
  });

  test("an enrollment that lapsed is made again", async () => {
    const secret = generateSharedSecret();
    await enrollAtDefaultRelay(secret, {
      setting: () => DEFAULT_RELAY,
      enroll: answering({
        kind: "registered",
        maxAgeDays: null,
        lapsesAt: "2020-01-01T00:00:00Z",
      }),
    });
    const atDial = neverAnswering();
    await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: atDial,
      dialWaitMs: SHORT_WAIT_MS,
    });
    expect(atDial).toHaveBeenCalledOnce();
  });

  test("by default a dial waits DEFAULT_RELAY_DIAL_WAIT_MS and no longer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const enroll = neverAnswering();
    let settled = false;
    const pending = relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
    }).finally(() => {
      settled = true;
    });
    await untilCalled(enroll);
    await vi.advanceTimersByTimeAsync(DEFAULT_RELAY_DIAL_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
  });

  test("a cancelled run stops waiting", async () => {
    const cancel = new AbortController();
    const pending = relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: neverAnswering(),
      signal: cancel.signal,
      dialWaitMs: 60_000,
    });
    cancel.abort();
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
  });
});

describe("invitationRelayWithDefault", () => {
  const enrolled = {
    kind: "enrolled",
    turnUrl: DEFAULT_RELAY.turnUrl,
  } as const;

  test("names the default relay after the own relay once enrolled", () => {
    expect(invitationRelayWithDefault(OWN, enrolled)).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: [],
    });
    expect(invitationRelayWithDefault(undefined, enrolled)).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
    });
  });

  test("withholds it when not enrolled or when the locator is full", () => {
    expect(
      invitationRelayWithDefault(OWN, {
        kind: "not-enrolled",
        turnUrl: DEFAULT_RELAY.turnUrl,
      }),
    ).toBe(OWN);
    const full = {
      turn: Array.from(
        { length: MAX_RELAY_LOCATOR_URLS },
        (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
      ),
    };
    expect(invitationRelayWithDefault(full, enrolled)).toBe(full);
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
