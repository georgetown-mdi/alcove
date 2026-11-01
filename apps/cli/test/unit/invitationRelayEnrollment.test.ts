import { describe, expect, test, vi } from "vitest";

import {
  REMOVED_EXCHANGE_ID_TEXT,
  REMOVED_RELAY_KEY_TEXT,
  deriveRelayExchangeId,
  deriveRelayKey,
} from "@alcove/core";
import type { EventStreamEmitter } from "../../src/eventStream";

import {
  INVITATION_RELAY_ENROLLMENT_WAIT_MS,
  enrollAtInvitationRelay,
  invitationRelayNotEnrolledWarning,
  reportInvitationRelayEnrollment,
} from "../../src/invitationRelayEnrollment";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
} from "./relayRegistrarFake";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const REGISTRAR = "https://default-relay.example.net";
const LAPSES_AT = "2026-01-01T01:10:00Z";

/** A fetch that answers only when its request is aborted, as a registrar that
 * takes the connection and never replies; `called` resolves at its first
 * request. */
function silentRegistrar() {
  let markCalled = () => {};
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const fetch = ((_input: unknown, init?: RequestInit) => {
    markCalled();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason as Error),
      );
    });
  }) as typeof globalThis.fetch;
  return { fetch, called };
}

describe("enrollAtInvitationRelay", () => {
  test("enrolls the relay key under the derived exchange id, with no token", async () => {
    const registrar = fakeRegistrar([registrationAnswer(null, LAPSES_AT)]);
    expect(
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: registrar.fetch,
      }),
    ).toEqual({ kind: "enrolled", lapsesAt: LAPSES_AT });
    expect(registrar.requests).toHaveLength(1);
    expect(registrar.requests[0]).toMatchObject({
      url: `${REGISTRAR}/exchanges/${await deriveRelayExchangeId(SECRET)}`,
      method: "POST",
      redirect: "manual",
      authorization: null,
    });
    expect(JSON.parse(registrar.requests[0]!.body)).toEqual({
      key: await deriveRelayKey(SECRET),
      maxAgeDays: null,
    });
  });

  test("a repeat with the same key is answered as enrolled, unchanged", async () => {
    const registrar = fakeRegistrar([
      registrationAnswer(null, LAPSES_AT),
      registrationAnswer(null, LAPSES_AT),
    ]);
    const first = await enrollAtInvitationRelay(REGISTRAR, SECRET, {
      fetch: registrar.fetch,
    });
    const repeat = await enrollAtInvitationRelay(REGISTRAR, SECRET, {
      fetch: registrar.fetch,
    });
    expect(repeat).toEqual(first);
    expect(repeat).toEqual({ kind: "enrolled", lapsesAt: LAPSES_AT });
    expect(registrar.requests[1]).toEqual(registrar.requests[0]);
  });

  test("a 409 is a failure stating the status, after one attempt", async () => {
    const registrar = fakeRegistrar([
      jsonResponse(409, { error: "no" }),
      registrationAnswer(),
    ]);
    expect(
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: registrar.fetch,
      }),
    ).toEqual({ kind: "failed", detail: "HTTP 409: no" });
    expect(registrar.requests).toHaveLength(1);
  });

  test("a registrar that does not answer is cut at the run's wait, and not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const silent = silentRegistrar();
      let settled = false;
      const pending = enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: silent.fetch,
      }).finally(() => {
        settled = true;
      });
      await silent.called;
      await vi.advanceTimersByTimeAsync(
        INVITATION_RELAY_ENROLLMENT_WAIT_MS - 1,
      );
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        kind: "failed",
        detail: `no answer within ${INVITATION_RELAY_ENROLLMENT_WAIT_MS} ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cancelled run stops waiting and reports a cancellation", async () => {
    const cancel = new AbortController();
    const silent = silentRegistrar();
    const enrollment = enrollAtInvitationRelay(REGISTRAR, SECRET, {
      fetch: silent.fetch,
      signal: cancel.signal,
    });
    await silent.called;
    cancel.abort();
    expect(await enrollment).toEqual({ kind: "cancelled" });
    const before = new AbortController();
    before.abort();
    const registrar = fakeRegistrar([registrationAnswer()]);
    expect(
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: registrar.fetch,
        signal: before.signal,
      }),
    ).toEqual({ kind: "cancelled" });
    expect(registrar.requests).toHaveLength(0);
  });

  test("the wait is an arbitrary three seconds", () => {
    expect(INVITATION_RELAY_ENROLLMENT_WAIT_MS).toBe(3_000);
  });
});

describe("reportInvitationRelayEnrollment", () => {
  function sinks() {
    const lines = { info: [] as string[], warn: [] as string[] };
    const warnings: Array<{
      source: string;
      message: string;
      secretKind?: string;
    }> = [];
    const emitter = {
      invitationRelayEnrollment: (message: string, secretKind?: string) =>
        warnings.push({
          source: "invitationRelayEnrollment",
          message,
          ...(secretKind !== undefined && { secretKind }),
        }),
    } as unknown as EventStreamEmitter;
    return {
      lines,
      warnings,
      sinks: {
        log: {
          info: (message: string) => lines.info.push(String(message)),
          warn: (message: string) => lines.warn.push(String(message)),
        },
        emit: (fn: (e: EventStreamEmitter) => void) => fn(emitter),
      },
    };
  }

  test("a confirmed enrollment is stated on the log and raises no warning", () => {
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "enrolled", lapsesAt: LAPSES_AT },
      s,
    );
    expect(lines.info).toEqual([
      `the relay registrar at ${REGISTRAR} that your partner's invitation ` +
        `names enrolled this exchange, until ${LAPSES_AT}`,
    ]);
    expect(lines.warn).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a failure is warned about on the log and the event stream", () => {
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "failed", detail: "HTTP 429: slow down" },
      s,
    );
    const warning = invitationRelayNotEnrolledWarning(
      REGISTRAR,
      "HTTP 429: slow down",
    );
    expect(warning).toBe(
      `the relay registrar at ${REGISTRAR} that your partner's invitation ` +
        "names did not enroll this exchange (HTTP 429: slow down). The run " +
        "continues with its other relays, and that relay takes it only if " +
        "your partner enrolled the exchange there.",
    );
    expect(lines.warn).toEqual([warning]);
    expect(warnings).toEqual([
      { source: "invitationRelayEnrollment", message: warning },
    ]);
  });

  test("on a run enrolling both secrets, each line and warning names the secret it enrolled", () => {
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "enrolled", lapsesAt: LAPSES_AT },
      s,
      "current",
    );
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "enrolled", lapsesAt: LAPSES_AT },
      s,
      "previous",
    );
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "failed", detail: "HTTP 409: held" },
      s,
      "current",
    );
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "failed", detail: "HTTP 409: held" },
      s,
      "previous",
    );
    const enrolled =
      `the relay registrar at ${REGISTRAR} that your partner's invitation ` +
      `names enrolled this exchange, until ${LAPSES_AT}`;
    expect(lines.info).toEqual([
      `for the current shared secret, ${enrolled}`,
      `for the shared secret from before a run that stopped partway, ${enrolled}`,
    ]);
    const refused = invitationRelayNotEnrolledWarning(
      REGISTRAR,
      "HTTP 409: held",
    );
    const current = `for the current shared secret, ${refused}`;
    const previous = `for the shared secret from before a run that stopped partway, ${refused}`;
    expect(lines.warn).toEqual([current, previous]);
    expect(warnings).toEqual([
      {
        source: "invitationRelayEnrollment",
        message: current,
        secretKind: "current",
      },
      {
        source: "invitationRelayEnrollment",
        message: previous,
        secretKind: "previous",
      },
    ]);
  });

  test("the registrar's text is escaped on the log", () => {
    const { lines, sinks: s } = sinks();
    reportInvitationRelayEnrollment(
      REGISTRAR,
      { kind: "failed", detail: "HTTP 409: held\u001b[31m" },
      s,
    );
    expect(lines.warn[0]).toContain("held\\x1b[31m");
    expect(lines.warn[0]).not.toContain("\u001b");
  });

  test("a registrar repeating the exchange id and relay key gets neither onto the log or the event stream", async () => {
    const exchangeId = await deriveRelayExchangeId(SECRET);
    const key = await deriveRelayKey(SECRET);
    const registrar = fakeRegistrar([
      jsonResponse(409, { error: `exchange ${exchangeId} holds no ${key}` }),
    ]);
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(
      REGISTRAR,
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: registrar.fetch,
      }),
      s,
    );
    const reported = [...lines.warn, ...warnings.map((w) => w.message)];
    expect(reported).toHaveLength(2);
    for (const message of reported) {
      expect(message).toContain(
        `(HTTP 409: exchange ${REMOVED_EXCHANGE_ID_TEXT} holds no ` +
          `${REMOVED_RELAY_KEY_TEXT})`,
      );
      expect(message).not.toContain(exchangeId);
      expect(message).not.toContain(key);
    }
  });

  test("a cancelled enrollment reports nothing", () => {
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(REGISTRAR, { kind: "cancelled" }, s);
    expect(lines).toEqual({ info: [], warn: [] });
    expect(warnings).toEqual([]);
  });
});
