import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithoutToken,
  generateSharedSecret,
} from "@alcove/core";

import {
  DEFAULT_RELAY_DIAL_WAIT_MS,
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "../../../src/psi/transport/defaultRelay.js";

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

const WITHOUT_DEFAULT = OWN;

const WITH_DEFAULT = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };

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
  test("makes one attempt bounded by the dial's wait, and lists the relay once enrolled, with no notice", async () => {
    const secret = generateSharedSecret();
    const signal = new AbortController().signal;
    const enroll = answering(REGISTERED);
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(secret, OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal,
      onRunNotice,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      { signal, timeoutMs: DEFAULT_RELAY_DIAL_WAIT_MS, retryDelaysMs: [] },
    );
    expect(run).toEqual(WITH_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
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
    expect(run).toEqual({ turn: [DEFAULT_RELAY.turnUrl], stun: [] });
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
    expect(run).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: invited.stun,
    });
  });

  test.each<[string, RelayRegistrationOutcome]>([
    ["a 409", { kind: "refused", status: 409, reason: "held" }],
    ["a 429", { kind: "unavailable", status: 429, reason: "too many" }],
    ["an unreachable registrar", { kind: "unavailable", reason: "no route" }],
  ])(
    "after %s says so once and dials with its other relays",
    async (_case, outcome) => {
      const onRunNotice = vi.fn();
      const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => DEFAULT_RELAY,
        enroll: answering(outcome),
        onRunNotice,
      });
      expect(run).toEqual(WITHOUT_DEFAULT);
      expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
      );
    },
  );

  test("a registrar client that throws says so once and leaves the relay out", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: vi.fn<typeof enrollRelayKeyWithoutToken>(() =>
        Promise.reject(new TypeError("failed to fetch")),
      ),
      onRunNotice,
    });
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("leaves out the default relay an invitation names when this run could not enroll", async () => {
    const invited = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };
    const run = await relayWithDefaultForRun(generateSharedSecret(), invited, {
      setting: () => DEFAULT_RELAY,
      enroll: answering({ kind: "refused", status: 409 }),
    });
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("contacts no registrar, lists nothing more and says nothing when the build names no default relay", async () => {
    const enroll = answering(REGISTERED);
    const onRunNotice = vi.fn();
    expect(
      await relayWithDefaultForRun(generateSharedSecret(), undefined, {
        setting: () => undefined,
        enroll,
        onRunNotice,
      }),
    ).toBeUndefined();
    expect(
      await relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => undefined,
        enroll,
        onRunNotice,
      }),
    ).toEqual(OWN);
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});

describe("the dial's wait for the enrollment", () => {
  test("a registrar that never answers costs the dial its wait and one request, and is reported once", async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll: (params, env) =>
        enrollRelayKeyWithoutToken(params, { ...env, fetch: hangingFetch }),
      dialWaitMs: SHORT_WAIT_MS,
      onRunNotice,
    });
    expect(hangingFetch).toHaveBeenCalledOnce();
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("by default a dial waits DEFAULT_RELAY_DIAL_WAIT_MS and no longer", async () => {
    expect(DEFAULT_RELAY_DIAL_WAIT_MS).toBe(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const enroll = neverAnswering();
    const onRunNotice = vi.fn();
    let settled = false;
    const pending = relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      onRunNotice,
    }).finally(() => {
      settled = true;
    });
    await untilCalled(enroll);
    await vi.advanceTimersByTimeAsync(DEFAULT_RELAY_DIAL_WAIT_MS - 1);
    expect(settled).toBe(false);
    expect(onRunNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("a cancelled run stops waiting and says nothing", async () => {
    const cancel = new AbortController();
    const enroll = neverAnswering();
    const onRunNotice = vi.fn();
    const pending = relayWithDefaultForRun(generateSharedSecret(), OWN, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal: cancel.signal,
      dialWaitMs: 60_000,
      onRunNotice,
    });
    await untilCalled(enroll);
    cancel.abort();
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("a run cancelled before it dials contacts no registrar and says nothing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const enroll = answering(REGISTERED);
    const onRunNotice = vi.fn();
    await expect(
      relayWithDefaultForRun(generateSharedSecret(), OWN, {
        setting: () => DEFAULT_RELAY,
        enroll,
        signal: cancel.signal,
        onRunNotice,
      }),
    ).resolves.toEqual(WITHOUT_DEFAULT);
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});

describe("invitationRelayWithDefault", () => {
  test("names the default relay after the own relay, with its registrar", () => {
    expect(invitationRelayWithDefault(OWN, DEFAULT_RELAY)).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: [],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names the default relay alone when there is no own relay", () => {
    expect(invitationRelayWithDefault(undefined, DEFAULT_RELAY)).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names it once when the own relay already names it, with its registrar", () => {
    const own = { turn: [DEFAULT_RELAY.turnUrl] };
    expect(invitationRelayWithDefault(own, DEFAULT_RELAY)).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names only the own relay, and no registrar, when the build names no default relay", () => {
    expect(invitationRelayWithDefault(OWN, undefined)).toBe(OWN);
    expect(invitationRelayWithDefault(undefined, undefined)).toBeUndefined();
  });

  test("withholds it and its registrar when the locator is full", () => {
    const full = {
      turn: Array.from(
        { length: MAX_RELAY_LOCATOR_URLS },
        (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
      ),
    };
    expect(invitationRelayWithDefault(full, DEFAULT_RELAY)).toBe(full);
  });
});
