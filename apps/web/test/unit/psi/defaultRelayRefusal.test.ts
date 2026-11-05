import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_RELAY_REFUSAL_CAUSES,
  defaultRelayNotEnrolledNotice,
  defaultRelayPreviousNotEnrolledNotice,
  defaultRelayRefusal,
  defaultRelayRefusalReason,
  retryWaitPhrase,
} from "../../../src/psi/transport/defaultRelayRefusal.js";

import type { DefaultRelayRefusalCause } from "../../../src/psi/transport/defaultRelayRefusal.js";
import type { RelayEnrollmentAnswer } from "@alcove/core";

// Which refusal a failed enrollment at the default relay is, read from the
// registrar's own answer, and how the app states it.

const REGISTRAR_SOURCE = readFileSync(
  new URL("../../../../../infra/relay/registrar.py", import.meta.url),
  "utf8",
);

/** The text of one of the registrar's message constants, its `%d` fields
 * filled in as the registrar fills them. */
function registrarMessage(name: string): string {
  const literal = `"(?:[^"\\\\]|\\\\.)*"`;
  const assignment =
    new RegExp(`^${name} = \\(\\s*((?:${literal}\\s*)+)\\)`, "m").exec(
      REGISTRAR_SOURCE,
    ) ?? new RegExp(`^${name} = (${literal})$`, "m").exec(REGISTRAR_SOURCE);
  if (assignment === null)
    throw new Error(`registrar.py assigns no ${name} as a string`);
  const pieces = [...assignment[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  return pieces
    .map((piece) => piece[1])
    .join("")
    .replaceAll("%d", "70");
}

function failed(answer?: RelayEnrollmentAnswer) {
  return {
    kind: "failed" as const,
    detail: "the detail core composed",
    ...(answer !== undefined && { answer }),
  };
}

describe("defaultRelayRefusal", () => {
  test.each([
    ["address-cap", 429, "TOKENLESS_CLIENT_CAP_REFUSAL"],
    ["rate-limit", 429, "TOKENLESS_LIMIT_REFUSAL"],
    ["address-table-full", 429, "TOKENLESS_FULL_REFUSAL"],
    ["relay-full", 503, "TOKENLESS_CEILING_REFUSAL"],
  ] as const)(
    "reads %s from the registrar's own %i answer (%s)",
    (cause, status, constant) => {
      const reason = registrarMessage(constant);
      expect(
        defaultRelayRefusal(
          failed({ status, reason, retryAfterSeconds: 1200 }),
        ),
      ).toEqual({ cause, retryAfterSeconds: 1200 });
    },
  );

  test("the registrar's busy answer, which names no cause, is other, and keeps its wait", () => {
    expect(
      defaultRelayRefusal(
        failed({
          status: 503,
          reason: registrarMessage("BUSY_REFUSAL"),
          retryAfterSeconds: 5,
        }),
      ),
    ).toEqual({ cause: "other", retryAfterSeconds: 5 });
  });

  test("a known reason under another status is other", () => {
    expect(
      defaultRelayRefusal(
        failed({
          status: 503,
          reason: registrarMessage("TOKENLESS_CLIENT_CAP_REFUSAL"),
        }),
      ),
    ).toEqual({ cause: "other" });
  });

  test("a failure with no answer is unreachable", () => {
    expect(defaultRelayRefusal(failed())).toEqual({ cause: "unreachable" });
  });

  test("an answer with no reason is other", () => {
    expect(defaultRelayRefusal(failed({ status: 429 }))).toEqual({
      cause: "other",
    });
  });
});

describe("what the run notice says", () => {
  test.each(DEFAULT_RELAY_REFUSAL_CAUSES)(
    "for %s, states what happened and what to do, in the app's words",
    (cause: DefaultRelayRefusalCause) => {
      const notice = defaultRelayNotEnrolledNotice({ cause });
      expect(notice).toContain(defaultRelayRefusalReason({ cause }));
      expect(notice).toMatch(/^The site's relay server could not be set up/);
      expect(notice).toMatch(/If the exchange does not connect without it/);
    },
  );

  test("each cause has a sentence of its own", () => {
    const reasons = DEFAULT_RELAY_REFUSAL_CAUSES.map((cause) =>
      defaultRelayRefusalReason({ cause }),
    );
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  test("states the wait the registrar asked for", () => {
    expect(
      defaultRelayNotEnrolledNotice({
        cause: "address-cap",
        retryAfterSeconds: 700,
      }),
    ).toBe(
      "The site's relay server could not be set up for this exchange, so " +
        "this run connects without it. Too many exchanges from your network " +
        "are already set up on it. It said to try again in about 12 " +
        "minutes. If the exchange does not connect without it, try again " +
        "after that.",
    );
  });

  test("with no wait, tells an unreachable run to check its network", () => {
    expect(defaultRelayNotEnrolledNotice({ cause: "unreachable" })).toBe(
      "The site's relay server could not be set up for this exchange, so " +
        "this run connects without it. It could not be reached, or did not " +
        "answer in time. If the exchange does not connect without it, check " +
        "your network connection and try again.",
    );
  });

  test("the previous secret's notice states the reason and the wait too", () => {
    expect(
      defaultRelayPreviousNotEnrolledNotice({
        cause: "rate-limit",
        retryAfterSeconds: 30,
      }),
    ).toBe(
      "The site's relay server could not be set up for the secret from " +
        "before the run that stopped partway. Your network asked it to set " +
        "up too many exchanges in a short time. It said to try again in less " +
        "than a minute. This run looks for your partner on that server under " +
        "the current secret only.",
    );
  });

  test("never repeats a reason the app does not know", () => {
    const reason =
      "visit https://registrar.example.org/help <b>now</b> to fix this";
    const refusal = defaultRelayRefusal(
      failed({ status: 429, reason, retryAfterSeconds: 60 }),
    );
    const notices = [
      defaultRelayNotEnrolledNotice(refusal),
      defaultRelayPreviousNotEnrolledNotice(refusal),
    ];
    for (const notice of notices) {
      expect(notice).not.toContain("registrar.example.org");
      expect(notice).not.toContain("<b>");
      expect(notice).toContain(defaultRelayRefusalReason({ cause: "other" }));
    }
  });
});

describe("retryWaitPhrase", () => {
  test.each([
    [0, "less than a minute"],
    [59, "less than a minute"],
    [60, "about 1 minute"],
    [61, "about 2 minutes"],
    [4200, "about 70 minutes"],
    [7140, "about 119 minutes"],
    [7200, "about 2 hours"],
    [86_400, "about 24 hours"],
  ])("states %i seconds as %s", (seconds, phrase) => {
    expect(retryWaitPhrase(seconds)).toBe(phrase);
  });
});
