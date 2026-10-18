import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithinWait,
  generateSharedSecret,
} from "@alcove/core";

import {
  DEFAULT_RELAY_DIAL_WAIT_MS,
  DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
  invitationRelayWithDefault,
  relayWithDefaultForRun,
} from "../../../src/psi/transport/defaultRelay.js";

import type { RelayEnrollmentWithinWait } from "@alcove/core";

// The enrollment each browser run makes right before it connects. The first
// block mocks core's bounded enrollment; the dial's wait runs it over a
// registrar that never answers. Core's suite holds the request and its answers.

const DEFAULT_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
};

const OWN = {
  turn: ["turns:own-relay.example.org:443?transport=tcp"],
  stun: [],
};

const ENROLLED: RelayEnrollmentWithinWait = {
  kind: "enrolled",
  lapsesAt: "2026-10-15T13:10:00Z",
};

const SHORT_WAIT_MS = 50;

const NO_RESTRICTION = undefined;

const WITHOUT_DEFAULT = OWN;

const WITH_DEFAULT = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };

function answering(enrollment: RelayEnrollmentWithinWait) {
  return vi.fn<typeof enrollRelayKeyWithinWait>(() =>
    Promise.resolve(enrollment),
  );
}

// A registrar that takes each request and never answers it, until the
// request's signal aborts.
function neverAnsweringFetch() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason as Error),
        );
      }),
  );
}

// Core's bounded enrollment, sending through `fetch`.
function enrollingThrough(fetch: typeof globalThis.fetch) {
  return vi.fn<typeof enrollRelayKeyWithinWait>((params, options) =>
    enrollRelayKeyWithinWait(params, { ...options, fetch }),
  );
}

async function untilCalled(spy: {
  mock: { calls: ReadonlyArray<unknown> };
}): Promise<void> {
  while (spy.mock.calls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relayWithDefaultForRun", () => {
  test("makes one attempt bounded by the dial's wait, and lists the relay once enrolled, with no notice", async () => {
    const secret = generateSharedSecret();
    const signal = new AbortController().signal;
    const enroll = answering(ENROLLED);
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, {
      setting: () => DEFAULT_RELAY,
      enroll,
      signal,
      onRunNotice,
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith(
      { registrarUrl: DEFAULT_RELAY.registrarUrl, sharedSecret: secret },
      { waitMs: DEFAULT_RELAY_DIAL_WAIT_MS, signal },
    );
    expect(run).toEqual(WITH_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("enrolls again on every dial, and a same-key repeat lists the relay", async () => {
    const secret = generateSharedSecret();
    const enroll = answering(ENROLLED);
    const dial = { setting: () => DEFAULT_RELAY, enroll };
    expect(
      await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, dial),
    ).toEqual(WITH_DEFAULT);
    expect(
      await relayWithDefaultForRun(secret, OWN, NO_RESTRICTION, dial),
    ).toEqual(WITH_DEFAULT);
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  test("lists the default relay alone when the run has no other", async () => {
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      undefined,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering(ENROLLED),
      },
    );
    expect(run).toEqual({ turn: [DEFAULT_RELAY.turnUrl], stun: [] });
  });

  test("lists the default relay once, last, when the invitation already names it", async () => {
    const invited = {
      turn: [DEFAULT_RELAY.turnUrl, ...OWN.turn],
      stun: ["stun:stun.example.org:3478"],
    };
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      invited,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering(ENROLLED),
      },
    );
    expect(run).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: invited.stun,
    });
  });

  test("a failed enrollment says so once and dials with its other relays", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "failed", detail: "HTTP 409: held" }),
        onRunNotice,
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("leaves out the default relay an invitation names when this run could not enroll", async () => {
    const invited = { turn: [...OWN.turn, DEFAULT_RELAY.turnUrl], stun: [] };
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      invited,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "failed", detail: "HTTP 409" }),
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
  });

  test("a cancelled enrollment leaves the relay out and says nothing", async () => {
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: answering({ kind: "cancelled" }),
        onRunNotice,
      },
    );
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("contacts no registrar, lists nothing more and says nothing when the build names no default relay", async () => {
    const enroll = answering(ENROLLED);
    const onRunNotice = vi.fn();
    expect(
      await relayWithDefaultForRun(
        generateSharedSecret(),
        undefined,
        NO_RESTRICTION,
        {
          setting: () => undefined,
          enroll,
          onRunNotice,
        },
      ),
    ).toBeUndefined();
    expect(
      await relayWithDefaultForRun(
        generateSharedSecret(),
        OWN,
        NO_RESTRICTION,
        {
          setting: () => undefined,
          enroll,
          onRunNotice,
        },
      ),
    ).toEqual(OWN);
    expect(enroll).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});

describe("the dial's wait for the enrollment", () => {
  test("a registrar that never answers costs the dial its wait and one request, and is reported once", async () => {
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    const run = await relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        dialWaitMs: SHORT_WAIT_MS,
        onRunNotice,
      },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(run).toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
    );
  });

  test("by default a dial waits DEFAULT_RELAY_DIAL_WAIT_MS and no longer", async () => {
    expect(DEFAULT_RELAY_DIAL_WAIT_MS).toBe(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    let settled = false;
    const pending = relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        onRunNotice,
      },
    ).finally(() => {
      settled = true;
    });
    await untilCalled(fetch);
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
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    const pending = relayWithDefaultForRun(
      generateSharedSecret(),
      OWN,
      NO_RESTRICTION,
      {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        signal: cancel.signal,
        dialWaitMs: 60_000,
        onRunNotice,
      },
    );
    await untilCalled(fetch);
    cancel.abort();
    await expect(pending).resolves.toEqual(WITHOUT_DEFAULT);
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("a run cancelled before it dials contacts no registrar and says nothing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const fetch = neverAnsweringFetch();
    const onRunNotice = vi.fn();
    await expect(
      relayWithDefaultForRun(generateSharedSecret(), OWN, NO_RESTRICTION, {
        setting: () => DEFAULT_RELAY,
        enroll: enrollingThrough(fetch),
        signal: cancel.signal,
        onRunNotice,
      }),
    ).resolves.toEqual(WITHOUT_DEFAULT);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunNotice).not.toHaveBeenCalled();
  });
});

describe("invitationRelayWithDefault", () => {
  test("names the default relay after the own relay, with its registrar", () => {
    expect(
      invitationRelayWithDefault(OWN, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [...OWN.turn, DEFAULT_RELAY.turnUrl],
      stun: [],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names the default relay alone when there is no own relay", () => {
    expect(
      invitationRelayWithDefault(undefined, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names it once when the own relay already names it, with its registrar", () => {
    const own = { turn: [DEFAULT_RELAY.turnUrl] };
    expect(
      invitationRelayWithDefault(own, DEFAULT_RELAY, NO_RESTRICTION),
    ).toEqual({
      turn: [DEFAULT_RELAY.turnUrl],
      registrar: DEFAULT_RELAY.registrarUrl,
    });
  });

  test("names only the own relay, and no registrar, when the build names no default relay", () => {
    expect(invitationRelayWithDefault(OWN, undefined, NO_RESTRICTION)).toBe(
      OWN,
    );
    expect(
      invitationRelayWithDefault(undefined, undefined, NO_RESTRICTION),
    ).toBeUndefined();
  });

  test("withholds it and its registrar when the locator is full", () => {
    const full = {
      turn: Array.from(
        { length: MAX_RELAY_LOCATOR_URLS },
        (_, index) => `turns:relay-${index}.example.org:443?transport=tcp`,
      ),
    };
    expect(
      invitationRelayWithDefault(full, DEFAULT_RELAY, NO_RESTRICTION),
    ).toBe(full);
  });
});
