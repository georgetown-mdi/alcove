import { describe, expect, test } from "vitest";

import { deriveRelayExchangeId, deriveRelayKey } from "@alcove/core";
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
 * takes the connection and never replies. */
const silentFetch = (async (_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(init.signal?.reason as Error),
    );
  })) as typeof globalThis.fetch;

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

  test.each([
    [401, "HTTP 401: no"],
    [409, "HTTP 409: no"],
    [429, "HTTP 429: no"],
  ])(
    "a %i is a failure stating the status, after one attempt",
    async (status, detail) => {
      const registrar = fakeRegistrar([
        jsonResponse(status, { error: "no" }),
        registrationAnswer(),
      ]);
      expect(
        await enrollAtInvitationRelay(REGISTRAR, SECRET, {
          fetch: registrar.fetch,
        }),
      ).toEqual({ kind: "failed", detail });
      expect(registrar.requests).toHaveLength(1);
    },
  );

  test("a registrar that cannot be reached is a failure", async () => {
    const registrar = fakeRegistrar([]);
    const enrollment = await enrollAtInvitationRelay(REGISTRAR, SECRET, {
      fetch: registrar.fetch,
    });
    expect(enrollment.kind).toBe("failed");
    expect(registrar.requests).toHaveLength(1);
  });

  test("a registrar that does not answer within the wait is a failure, the request cut at the wait", async () => {
    const started = Date.now();
    expect(
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: silentFetch,
        waitMs: 50,
      }),
    ).toEqual({ kind: "failed", detail: "no answer within 50 ms" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a fetch that ignores the cut still costs no more than the wait", async () => {
    const neverSettles = (() =>
      new Promise<Response>(() => {})) as typeof globalThis.fetch;
    expect(
      await enrollAtInvitationRelay(REGISTRAR, SECRET, {
        fetch: neverSettles,
        waitMs: 50,
      }),
    ).toEqual({ kind: "failed", detail: "no answer within 50 ms" });
  });

  test("a cancelled run stops waiting and reports a cancellation", async () => {
    const cancel = new AbortController();
    const enrollment = enrollAtInvitationRelay(REGISTRAR, SECRET, {
      fetch: silentFetch,
      signal: cancel.signal,
    });
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
    const warnings: Array<{ source: string; message: string }> = [];
    const emitter = {
      warning: (source: string, message: string) =>
        warnings.push({ source, message }),
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

  test("a cancelled enrollment reports nothing", () => {
    const { lines, warnings, sinks: s } = sinks();
    reportInvitationRelayEnrollment(REGISTRAR, { kind: "cancelled" }, s);
    expect(lines).toEqual({ info: [], warn: [] });
    expect(warnings).toEqual([]);
  });
});
