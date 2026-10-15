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
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "../../../src/psi/transport/defaultRelay.js";
import { PartnerNoShowError } from "../../../src/psi/transport/waitForConnection.js";

import type { RelayRegistrationOutcome } from "@alcove/core";

// The enrollment each browser run makes right before it connects, with the
// registrar client mocked: core's suite holds the request it sends.

const DEFAULT_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};

const OWN = {
  turn: ["turns:own-relay.example.org:443?transport=tcp"],
  stun: [],
};

const REGISTERED: RelayRegistrationOutcome = {
  kind: "registered",
  maxAgeDays: null,
  lapsesAt: "2026-10-15T13:10:00Z",
};

const SHORT_WAIT_MS = 50;

const WITHOUT_DEFAULT = { relay: OWN, defaultRelayNotEnrolled: true };

const WITH_DEFAULT = {
  relay: { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] },
  defaultRelayNotEnrolled: false,
};

function answering(outcome: RelayRegistrationOutcome) {
  return vi.fn<typeof enrollRelayKeyWithoutToken>(() =>
    Promise.resolve(outcome),
  );
}

// A registrar that never answers.
function neverAnswering() {
  return vi.fn<typeof enrollRelayKeyWithoutToken>(
    () => new Promise<never>(() => {}),
  );
}

async function untilCalled(enroll: {
  mock: { calls: ReadonlyArray<unknown> };
}): Promise<void> {
  while (enroll.mock.calls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relayWithDefaultForRun", () => {
  test("makes one attempt bounded by the dial's wait, and lists the relay once enrolled", async () => {
    const secret = generateSharedSecret();
    const signal = new AbortController().signal;
    const enroll = answering(REGISTERED);
    const run = await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      { signal, timeoutMs: DEFAULT_RELAY_DIAL_WAIT_MS, retryDelaysMs: [] },
    );
    expect(run).toEqual(WITH_DEFAULT);
  });

  test("enrolls again on every dial, and a same-key repeat lists the relay", async () => {
    const secret = generateSharedSecret();
    const enroll = answering(REGISTERED);
    const dial = { setting: () => DEFAULT_RELAY, enroll };
    expect(await relayWithDefaultForRun(secret, OWN, dial)).toEqual(
      WITH_DEFAULT,
    );
    expect(await relayWithDefaultForRun(secret, OWN, dial)).toEqual(
      WITH_DEFAULT,
    );
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  test("lists the default relay alone when the run has no other", async () => {
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      undefined,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering(REGISTERED),
      },
    );
    expect(run).toEqual({
      relay: { turn: [DEFAULT_RELAY.turnUrl], stun: [] },
      defaultRelayNotEnrolled: false,
    });
  });

  test("lists the default relay once, last, when the invitation already names it", async () => {
    const invited = {
      turn: [DEFAULT_RELAY.turnUrl, ...OWN.turn],
      stun: ["stun:stun.example.org:3478"],
    };
    const run = await relayWithDefaultForRun(generateSharedSecret(), invited, {
      setting: () => DEFAULT_RELAY,
      enroll: answering(REGISTERED),
    });
    expect(run.relay).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: invited.stun,
    });
  });

  test.each<[string, RelayRegistrationOutcome]>([
    ["a 409", { kind: "refused", status: 409, reason: "held" }],
    ["a 429", { kind: "unavailable", status: 429, reason: "too many" }],
    ["an unreachable registrar", { kind: "unavailable", reason: "no route" }],
  ])(
    "after %s dials with its other relays, and marks the enrollment failed",
    async (_case, outcome) => {
      const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => DEFAULT_RELAY,
        enroll: answering(outcome),
      });
      expect(run).toEqual(WITHOUT_DEFAULT);
    },
  );

  test("a registrar client that throws leaves the relay out", async () => {
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: vi.fn<typeof enrollRelayKeyWithoutToken>(() =>
        Promise.reject(new TypeError("failed to fetch")),
      ),
    });
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("leaves out the default relay an invitation names when this run could not enroll", async () => {
    const invited = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };
    const run = await relayWithDefaultForRun(generateSharedSecret(), invited, {
      setting: () => DEFAULT_RELAY,
      enroll: answering({ kind: "refused", status: 409 }),
    });
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("contacts no registrar and lists nothing more when the build names no default relay", async () => {
    const enroll = answering(REGISTERED);
    expect(
      await relayWithDefaultForRun(generateSharedSecret(), undefined, {
        setting: () => undefined,
        enroll,
      }),
    ).toEqual({ relay: undefined, defaultRelayNotEnrolled: false });
    expect(
      await relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => undefined,
        enroll,
      }),
    ).toEqual({ relay: OWN, defaultRelayNotEnrolled: false });
    expect(enroll).not.toHaveBeenCalled();
  });
});

describe("the dial's wait for the enrollment", () => {
  test("a registrar that never answers costs the dial its wait and one request", async () => {
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

  test("by default a dial waits DEFAULT_RELAY_DIAL_WAIT_MS and no longer", async () => {
    expect(DEFAULT_RELAY_DIAL_WAIT_MS).toBe(3_000);
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
    const enroll = neverAnswering();
    const pending = relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal: cancel.signal,
      dialWaitMs: 60_000,
    });
    await untilCalled(enroll);
    cancel.abort();
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
  });

  test("a run cancelled before it dials contacts no registrar", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const enroll = answering(REGISTERED);
    await expect(
      relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => DEFAULT_RELAY,
        enroll,
        signal: cancel.signal,
      }),
    ).resolves.toEqual(WITHOUT_DEFAULT);
    expect(enroll).not.toHaveBeenCalled();
  });
});

describe("invitationRelayWithDefault", () => {
  test("names the default relay after the own relay", () => {
    expect(invitationRelayWithDefault(OWN, DEFAULT_RELAY.turnUrl)).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: [],
    });
  });

  test("names the default relay alone when there is no own relay", () => {
    expect(
      invitationRelayWithDefault(undefined, DEFAULT_RELAY.turnUrl),
    ).toEqual({ turn: [DEFAULT_RELAY.turnUrl] });
  });

  test("names it once when the own relay already names it", () => {
    const own = { turn: [DEFAULT_RELAY.turnUrl] };
    expect(invitationRelayWithDefault(own, DEFAULT_RELAY.turnUrl)).toBe(own);
  });

  test("names only the own relay when the build names no default relay", () => {
    expect(invitationRelayWithDefault(OWN, undefined)).toBe(OWN);
    expect(invitationRelayWithDefault(undefined, undefined)).toBeUndefined();
  });

  test("withholds it when the locator is full", () => {
    const full = {
      turn: Array.from(
        { length: MAX_RELAY_LOCATOR_URLS },
        (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
      ),
    };
    expect(invitationRelayWithDefault(full, DEFAULT_RELAY.turnUrl)).toBe(full);
  });
});

describe("connectNoticingDefaultRelay", () => {
  const failing = () => Promise.reject(new Error("timed out"));

  test("shows the notice once when a run whose enrollment failed does not connect", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: answering({ kind: "unavailable", reason: "no route" }),
    });
    const connect = vi.fn(failing);
    await expect(
      connectNoticingDefaultRelay(run, { onRunNotice }, connect),
    ).rejects.toThrow("timed out");
    expect(connect).toHaveBeenCalledOnce();
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

  test("shows nothing when the partner never arrived", async () => {
    const onRunNotice = vi.fn();
    const noShow = new PartnerNoShowError("nobody arrived");
    await expect(
      connectNoticingDefaultRelay(
        { defaultRelayNotEnrolled: true },
        { onRunNotice },
        () => Promise.reject(noShow),
      ),
    ).rejects.toBe(noShow);
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});
