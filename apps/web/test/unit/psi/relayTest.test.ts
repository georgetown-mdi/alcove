import { afterEach, describe, expect, test, vi } from "vitest";

import {
  RELAY_TEST_BOUND_MS,
  relayTestResultText,
  relayTestRunningText,
  relayTestSupported,
  relayTestTargets,
  runRelayTest,
  turnUrlTransport,
} from "../../../src/psi/transport/relayTest.js";

import type {
  RelayTestResult,
  RelayTestTarget,
} from "../../../src/psi/transport/relayTest.js";

const OWN_URL = "turns:own-relay.example.org:443?transport=tcp";
const SITE_URL = "turn:site-relay.example.org:3478";
const SITE = {
  turnUrl: SITE_URL,
  registrarUrl: "https://registrar.example.org",
};

/** A peer connection holding only what the test reads and calls. */
class FakePeerConnection extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "new";
  close = vi.fn();
  createDataChannel = vi.fn();
  private markOffered: () => void = () => undefined;
  /** Resolves once the local offer is set, when gathering would start. */
  readonly offered = {
    promise: new Promise<void>((resolve) => {
      this.markOffered = resolve;
    }),
  };
  constructor(readonly configuration: RTCConfiguration) {
    super();
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: "" });
  }
  setLocalDescription(): Promise<void> {
    this.markOffered();
    return Promise.resolve();
  }
  fail(url: string, errorCode: number, errorText: string): void {
    this.dispatchEvent(
      Object.assign(new Event("icecandidateerror"), {
        url,
        errorCode,
        errorText,
      }),
    );
  }
  gather(relayProtocol: string): void {
    this.dispatchEvent(
      Object.assign(new Event("icecandidate"), {
        candidate: { type: "relay", relayProtocol },
      }),
    );
  }
  finishGathering(): void {
    this.iceGatheringState = "complete";
    this.dispatchEvent(
      Object.assign(new Event("icecandidate"), { candidate: null }),
    );
  }
}

function factory(): {
  created: Array<FakePeerConnection>;
  createPeerConnection: (configuration: RTCConfiguration) => RTCPeerConnection;
} {
  const created: Array<FakePeerConnection> = [];
  return {
    created,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration);
      created.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
  };
}

function target(url: string): RelayTestTarget {
  return { url, source: "own", transport: turnUrlTransport(url) };
}

/** The one result for `url` over its own transport. */
function only(results: Array<RelayTestResult>): RelayTestResult {
  expect(results).toHaveLength(1);
  return results[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relayTestTargets", () => {
  test("lists the saved TURN urls then the site's relay, each once", () => {
    const targets = relayTestTargets(
      () => ({
        kind: "set",
        relay: { turn: [OWN_URL, SITE_URL, OWN_URL], stun: [] },
      }),
      () => SITE,
    );
    expect(targets).toEqual([
      { url: OWN_URL, source: "own", transport: "tls" },
      { url: SITE_URL, source: "site", transport: "udp" },
    ]);
  });

  test("lists no STUN url, and nothing where neither names a relay", () => {
    expect(
      relayTestTargets(
        () => ({
          kind: "set",
          relay: { turn: [], stun: ["stun:stun.example.org:3478"] },
        }),
        () => undefined,
      ),
    ).toEqual([]);
  });

  test("a saved setting this build cannot read adds nothing, as for a run", () => {
    expect(
      relayTestTargets(
        () => ({ kind: "unreadable" }),
        () => SITE,
      ).map((t) => t.url),
    ).toEqual([SITE_URL]);
  });
});

describe("turnUrlTransport", () => {
  test.each([
    ["turns:relay.example.org:443", "tls"],
    ["turns:relay.example.org:443?transport=tcp", "tls"],
    ["turn:relay.example.org:3478?transport=tcp", "tcp"],
    ["turn:relay.example.org:3478?transport=udp", "udp"],
    ["turn:relay.example.org:3478", "udp"],
  ])("%s is %s", (url, transport) => {
    expect(turnUrlTransport(url)).toBe(transport);
  });
});

describe("runRelayTest", () => {
  test("contacts nothing until it is run, then one peer connection per url", async () => {
    const { created, createPeerConnection } = factory();
    const targets = [target(OWN_URL), target(SITE_URL)];
    expect(created).toHaveLength(0);

    const running = runRelayTest(targets, { createPeerConnection });
    expect(created).toHaveLength(2);
    for (const [index, pc] of created.entries()) {
      expect(pc.configuration.iceTransportPolicy).toBe("relay");
      expect(pc.configuration.iceServers).toEqual([
        {
          urls: [targets[index].url],
          username: "alcove-relay-test",
          credential: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      ]);
      await pc.offered.promise;
      pc.fail(targets[index].url, 401, "Unauthorized");
    }
    await running;
    expect(created[0].configuration.iceServers?.[0]?.credential).not.toBe(
      created[1].configuration.iceServers?.[0]?.credential,
    );
  });

  test("a relay that sends back a 401 answered, and the test ends there", async () => {
    vi.useFakeTimers();
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(OWN_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.fail(OWN_URL, 401, "Unauthorized");

    const result = only(await running);
    expect(result).toEqual({
      url: OWN_URL,
      source: "own",
      transport: "tls",
      outcome: { kind: "answered", relayAddress: false },
    });
    expect(pc.close).toHaveBeenCalledOnce();
    expect(relayTestResultText(result)).toBe(
      "Answered over TLS: the relay refused the test's placeholder " +
        "credential, so this browser reaches it over TLS.",
    );
  });

  test("a relay that gives a relay address answered", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    await created[0].offered.promise;
    created[0].gather("udp");

    expect(only(await running).outcome).toEqual({
      kind: "answered",
      relayAddress: true,
    });
  });

  test("a relay that answers with another error refused, with the reason and a remedy", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.fail(`${SITE_URL}?transport=udp`, 403, "Forbidden IP");
    pc.finishGathering();

    const result = only(await running);
    expect(result.outcome).toEqual({
      kind: "refused",
      errorCode: 403,
      errorText: "Forbidden IP",
    });
    expect(relayTestResultText(result)).toBe(
      "Refused over UDP: the relay answered, so this browser reaches it over " +
        "UDP, but it refused the request with error 403: Forbidden IP. " +
        "Check the relay's settings for this error, or ask whoever runs it, " +
        "then run the test again.",
    );
    expect(pc.close).toHaveBeenCalledOnce();
  });

  test("an error with no code is no reply from the relay, so it is no answer", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.dispatchEvent(
      Object.assign(new Event("icecandidateerror"), {
        url: SITE_URL,
        errorText: "Something failed.",
      }),
    );
    pc.finishGathering();

    const result = only(await running);
    expect(result.outcome).toEqual({
      kind: "no-answer",
      reason: "reported",
      errorCode: undefined,
      errorText: "Something failed.",
    });
    expect(relayTestResultText(result)).toBe(
      "No answer over UDP: the browser reported an error: Something failed. " +
        "Check that the relay address is correct and that this network " +
        "allows connections to it, then run the test again.",
    );
  });

  test("gathering that ends with nothing reported says the browser reported no answer", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    await created[0].offered.promise;
    created[0].finishGathering();

    const result = only(await running);
    expect(result.outcome).toEqual({
      kind: "no-answer",
      reason: "gathering-ended",
    });
    expect(relayTestResultText(result)).toBe(
      "No answer over UDP: the browser reported no answer from the relay. " +
        "A relay that refused the test's credential can also show this, " +
        "when the browser does not report the refusal. Check that the relay " +
        "address is correct and that this network allows connections to it, " +
        "then run the test again.",
    );
  });

  test("a relay that gives no answer within the bound is reported as no answer", async () => {
    vi.useFakeTimers();
    const { created, createPeerConnection } = factory();
    let settled = false;
    const running = runRelayTest([target(OWN_URL)], {
      createPeerConnection,
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(RELAY_TEST_BOUND_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = only(await running);
    expect(result.outcome).toEqual({
      kind: "no-answer",
      reason: "bound",
      boundMs: RELAY_TEST_BOUND_MS,
    });
    expect(created[0].close).toHaveBeenCalledOnce();
    expect(relayTestResultText(result)).toBe(
      "No answer over TLS: the relay did not answer within 30 seconds. " +
        "Check that the relay address is correct and that this network " +
        "allows connections to it, then run the test again.",
    );
  });

  test("the no-answer text states the bound the run used", async () => {
    vi.useFakeTimers();
    const { createPeerConnection } = factory();
    const running = runRelayTest([target(OWN_URL)], {
      createPeerConnection,
      boundMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(relayTestResultText(only(await running))).toMatch(
      /^No answer over TLS: the relay did not answer within 5 seconds\. /,
    );
  });

  test("a relay the browser reports unreachable is no answer, naming the browser's error", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(OWN_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.fail(OWN_URL, 701, "Failed to establish connection.");
    pc.finishGathering();

    const result = only(await running);
    expect(relayTestResultText(result)).toBe(
      "No answer over TLS: the browser reported error 701: Failed to " +
        "establish connection. Check that the relay address is correct and " +
        "that this network allows connections to it, then run the test again.",
    );
  });

  test("no result uses the exchange failure's wording", async () => {
    vi.useFakeTimers();
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(OWN_URL)], { createPeerConnection });
    await vi.advanceTimersByTimeAsync(RELAY_TEST_BOUND_MS);
    const results = await running;
    expect(created).toHaveLength(1);
    const texts = [
      ...results,
      {
        ...results[0],
        outcome: { kind: "refused", errorCode: 403, errorText: "" },
      },
      { ...results[0], outcome: { kind: "answered", relayAddress: false } },
    ].map((result) => relayTestResultText(result as RelayTestResult));
    for (const text of texts) {
      expect(text).not.toContain("did not open");
      expect(text).not.toMatch(/then try again/);
    }
  });

  test("an error over another transport is a result of its own", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.fail(`${SITE_URL}?transport=tcp`, 701, "");
    pc.fail(`${SITE_URL}?transport=udp`, 401, "Unauthorized");

    const results = await running;
    expect(
      results.map((result) => [result.transport, result.outcome.kind]),
    ).toEqual([
      ["udp", "answered"],
      ["tcp", "no-answer"],
    ]);
  });

  test("the browser's error text is escaped for display", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], { createPeerConnection });
    const pc = created[0];
    await pc.offered.promise;
    pc.fail(SITE_URL, 403, "Forbidden\u001b[31m\u202e");
    pc.finishGathering();

    const text = relayTestResultText(only(await running));
    expect(text).toContain("error 403: Forbidden\\x1b[31m\\u202e.");
  });

  test.each([
    ["a SyntaxError", new SyntaxError("bad url")],
    ["a DOMException SyntaxError", new DOMException("bad url", "SyntaxError")],
    [
      "a DOMException NotSupportedError",
      new DOMException("bad scheme", "NotSupportedError"),
    ],
  ])(
    "a url the browser refuses with %s is reported as not tested",
    async (_name, error) => {
      const results = await runRelayTest([target(OWN_URL)], {
        createPeerConnection: () => {
          throw error;
        },
      });
      const result = only(results);
      expect(result.outcome).toEqual({ kind: "not-asked" });
      expect(relayTestResultText(result)).toBe(
        "Not tested: this browser did not accept the address, so the relay " +
          "was not asked. Check that the relay address is correct.",
      );
    },
  );

  test("any other failure building the peer connection is not a bad address", async () => {
    const results = await runRelayTest([target(OWN_URL)], {
      createPeerConnection: () => {
        throw new ReferenceError("RTCPeerConnection is not defined");
      },
    });
    const result = only(results);
    expect(result.outcome).toEqual({ kind: "not-run" });
    expect(relayTestResultText(result)).toBe(
      "Not tested: the test could not run for this relay in this browser. " +
        "Reload the page and run the test again.",
    );
  });

  test("a throw while setting up one url is that url's result, not the run's", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(OWN_URL), target(SITE_URL)], {
      createPeerConnection: (configuration) => {
        const pc = createPeerConnection(configuration);
        if (created.length === 1)
          (pc as unknown as FakePeerConnection).createDataChannel = vi.fn(
            () => {
              throw new Error("no data channel");
            },
          );
        return pc;
      },
    });
    await created[1].offered.promise;
    created[1].fail(SITE_URL, 401, "Unauthorized");

    const results = await running;
    expect(results.map((result) => [result.url, result.outcome])).toEqual([
      [OWN_URL, { kind: "not-run" }],
      [SITE_URL, { kind: "answered", relayAddress: false }],
    ]);
    expect(created[0].close).toHaveBeenCalledOnce();
  });

  test("an offer the browser fails to make is not reported as no answer", async () => {
    const { created, createPeerConnection } = factory();
    const running = runRelayTest([target(SITE_URL)], {
      createPeerConnection: (configuration) => {
        const pc = createPeerConnection(
          configuration,
        ) as unknown as FakePeerConnection;
        pc.createOffer = () => Promise.reject(new Error("no offer"));
        return pc as unknown as RTCPeerConnection;
      },
    });

    expect(only(await running).outcome).toEqual({ kind: "not-run" });
    expect(created[0].close).toHaveBeenCalledOnce();
  });

  test("relayTestSupported is false where the browser has no peer connection", () => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    expect(relayTestSupported()).toBe(true);
    vi.stubGlobal("RTCPeerConnection", undefined);
    expect(relayTestSupported()).toBe(false);
    vi.unstubAllGlobals();
  });

  test("the running announcement names the count and the bound", () => {
    expect(relayTestRunningText(2, RELAY_TEST_BOUND_MS)).toBe(
      "Testing 2 relays. This can take up to 30 seconds.",
    );
    expect(relayTestRunningText(1, 1_000)).toBe(
      "Testing 1 relay. This can take up to 1 second.",
    );
  });

  test("cancelling the test closes every peer connection", async () => {
    vi.useFakeTimers();
    const { created, createPeerConnection } = factory();
    const controller = new AbortController();
    const running = runRelayTest([target(OWN_URL), target(SITE_URL)], {
      createPeerConnection,
      signal: controller.signal,
    });
    controller.abort();
    await running;
    for (const pc of created) expect(pc.close).toHaveBeenCalledOnce();
  });
});
