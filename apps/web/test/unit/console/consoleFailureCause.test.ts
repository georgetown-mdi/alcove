import { describe, expect, test } from "vitest";

import {
  KEX_HANDSHAKE_TIMEOUT_MESSAGE,
  PeerAbortError,
  errorWithPartnerCauseLinks,
  failureCauseFromUntrusted,
  failureCauseSentence,
  keepFirstPartyLineBreaks,
  partnerOriginText,
  sanitizeErrorForDisplay,
  setOverLimitError,
  setOverLimitRemedy,
} from "@alcove/core";
import {
  PARTNER_REFUSED_EXIT_CODE,
  failureCauseStreamField,
} from "@alcove/cli-contract";
import { REPRESENTATIVE_FAILURE_CAUSES } from "@alcove/core/testing";

import {
  CONNECTION_TUNING_HEADING,
  IGNORE_FILES_OLDER_THAN_LABEL,
  PEER_TIMEOUT_LABEL,
} from "@console/connectionTuningModel";
import {
  RUN_DIAGNOSTICS_HEADING,
  SWEEP_CONTROL_LABEL,
} from "@psi/runDiagnosticsModel";
import {
  RelayedSelfExplainingError,
  RelayedTerminalError,
  relayedTerminalErrorOf,
} from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";
import { validateAndSanitizeEvent } from "@jobs/cliDriver";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";
import type { FailureContext } from "@exchange/useInviterExchange";

// Every kind is a key, so a cause core adds fails to compile here until it
// has samples, and the checks below run over its copy.
const SAMPLES: {
  readonly [K in FailureCauseKind]: ReadonlyArray<FailureCauseOfKind<K>>;
} = {
  "partner-never-arrived": [
    { kind: "partner-never-arrived", channel: "filedrop", waitedMs: 90_000 },
    { kind: "partner-never-arrived", channel: "sftp" },
    { kind: "partner-never-arrived" },
    {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      sharedName: true,
    },
    {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      ignoredHello: { ageMs: 7_200_000, windowMs: 90_000 },
    },
    {
      kind: "partner-never-arrived",
      channel: "sftp",
      waitedMs: 90_000,
      sharedName: true,
      ignoredHello: { ageMs: 7_200_000, windowMs: 90_000 },
    },
  ],
  "folder-missing": [
    { kind: "folder-missing", path: "/data/drop", code: "ENOENT" },
    { kind: "folder-missing", path: "/data/drop", code: "ENOTDIR" },
  ],
  "relay-registrar-unreachable": [
    {
      kind: "relay-registrar-unreachable",
      host: "relay.example.org",
      port: 8443,
      failure: "no-connection",
      code: "ECONNREFUSED",
    },
    {
      kind: "relay-registrar-unreachable",
      host: "relay.example.org",
      port: 8443,
      failure: "name-not-resolved",
      code: "ENOTFOUND",
    },
    {
      kind: "relay-registrar-unreachable",
      host: "relay.example.org",
      port: 8443,
      failure: "no-answer",
      timedOutMs: 15_000,
    },
  ],
  "partner-stopped-responding": [
    { kind: "partner-stopped-responding", silentMs: 120_000 },
  ],
  "set-over-limit": [
    {
      kind: "set-over-limit",
      stage: "before-contact",
      limit: "set-maximum",
      valueCount: 17_000_000,
      limitValues: 16_777_216,
      scope: "first-key",
    },
    {
      kind: "set-over-limit",
      stage: "after-terms",
      limit: "partner-ceiling",
      valueCount: 12,
      limitValues: 11,
      scope: "every-key",
    },
    {
      kind: "set-over-limit",
      stage: "in-round",
      limit: "set-maximum",
      valueCount: 16_777_217,
      limitValues: 16_777_216,
    },
    { kind: "set-over-limit", stage: "before-contact", limit: "uncounted" },
    { kind: "set-over-limit", stage: "after-terms", limit: "uncounted" },
  ],
  "single-pass-over-limit": [
    {
      kind: "single-pass-over-limit",
      limit: "frame",
      frame: "request",
      frameBytes: 70_001,
      limitBytes: 65_536,
    },
    {
      kind: "single-pass-over-limit",
      limit: "distinct-values",
      limitValues: 122_713_351,
    },
  ],
  "matches-over-limit": [{ kind: "matches-over-limit", list: "grouping" }],
  "shared-secret-unusable": [
    { kind: "shared-secret-unusable", problem: "malformed" },
    {
      kind: "shared-secret-unusable",
      problem: "expired",
      expires: "2026-07-08T19:32:00.000Z",
      stage: "before-handshake",
    },
  ],
  "partner-stopped-at-matching": [{ kind: "partner-stopped-at-matching" }],
  "message-write-unconfirmed": [
    { kind: "message-write-unconfirmed", failure: "write-incomplete" },
    { kind: "message-write-unconfirmed", failure: "sequence-spent", seq: 4 },
  ],
  "shared-name-at-entry": [{ kind: "shared-name-at-entry" }],
  "key-exchange-timed-out": [{ kind: "key-exchange-timed-out" }],
};

// The kinds the console states in copy outside its remedy map.
const KINDS_WITHOUT_CONSOLE_REMEDY: ReadonlyArray<FailureCauseKind> = [
  "key-exchange-timed-out",
];

const hasConsoleRemedy = (cause: FailureCause): boolean =>
  !KINDS_WITHOUT_CONSOLE_REMEDY.includes(cause.kind);

/** A relayed failure as the job client builds it off the CLI's event. */
function relayed(
  message: string,
  fields: { failureCause?: FailureCause; exitCode?: number },
): RelayedTerminalError {
  const error = new RelayedSelfExplainingError(message);
  error.failureCause = fields.failureCause;
  error.exitCode = fields.exitCode;
  return error;
}

/**
 * The failure the seat raises for the CLI's terminal `error` event, through
 * the relay's validation and the seat's read of what the relay sent. `report`
 * and `nextStep` are the CLI's message without its step and the step, which
 * the CLI emits as `message` and `nextStep`.
 */
function relayedFromCli({
  report,
  nextStep,
  cause,
  exitCode,
  recoveryHint = nextStep !== undefined,
  internalFault = false,
  sendNextStep = true,
}: {
  report: string;
  nextStep?: string;
  cause?: FailureCause;
  exitCode: number;
  recoveryHint?: boolean;
  internalFault?: boolean;
  sendNextStep?: boolean;
}): RelayedTerminalError {
  const event = validateAndSanitizeEvent({
    v: 1,
    type: "error",
    category: "exchange",
    message: nextStep === undefined ? report : `${report}\n${nextStep}`,
    ...(nextStep !== undefined && sendNextStep ? { nextStep } : {}),
    ...(recoveryHint ? { recoveryHint: true } : {}),
    ...(internalFault ? { internalFault: true } : {}),
    exitCode,
    ...(cause !== undefined ? { cause } : {}),
  });
  if (event === null) throw new Error("the relay refused the event");
  return relayedTerminalErrorOf(event);
}

const BOTH_SWEPT =
  "If your partner also cleared leftover files when starting, one of you " +
  "may have removed the other's files. Both of you turn off " +
  `"${SWEEP_CONTROL_LABEL}" before the next run.`;

const CLI_NO_SHOW_MESSAGE =
  "Your partner did not arrive in the shared folder within 90 seconds.\n" +
  "Check that you and your partner use the same folder and that it is " +
  "syncing, then run again; --peer-timeout sets how long to wait.";

describe("a console run that failed on a catalog cause", () => {
  test.each(
    Object.values(SAMPLES)
      .flat()
      .filter(hasConsoleRemedy)
      .map((cause) => [JSON.stringify(cause), cause] as const),
  )("%s shows core's sentence and the console's remedy", (_, cause) => {
    const failure = failureFor(
      "exchange",
      relayed("the CLI's text", { failureCause: cause, exitCode: 69 }),
      { channel: "filedrop" },
    );
    expect(failure.message.startsWith(`${failureCauseSentence(cause)} `)).toBe(
      true,
    );
    expect(failure.message).not.toContain("--");
    expect(failure.message).not.toContain("the CLI's text");
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.title).not.toBe("Exchange failed");
    expect(failure.retry).toBe(
      cause.kind === "partner-stopped-at-matching" ||
        cause.kind === "shared-secret-unusable" ||
        cause.kind === "message-write-unconfirmed"
        ? "withheld"
        : "offered",
    );
  });

  test("an unusable shared secret asks for a new invitation without naming a command", () => {
    const [malformed, expired] = SAMPLES["shared-secret-unusable"];
    const step =
      "Ask your partner for a new invitation, or start over and create one " +
      "for your partner to accept.";
    const shown = (cause: FailureCause) =>
      failureFor(
        "exchange",
        relayed("the CLI's text", { failureCause: cause, exitCode: 69 }),
      );
    expect(shown(malformed)).toMatchObject({
      title: "This invitation's shared secret is not valid",
      message: `${failureCauseSentence(malformed)} ${step}`,
    });
    expect(shown(expired)).toMatchObject({
      title: "This invitation can no longer be used",
      message: `The shared secret expired at 2026-07-08T19:32:00.000Z. ${step}`,
    });
    expect(shown(expired).message).not.toContain("alcove invite");
  });

  test("a partner stop at matching keeps the partner-refusal disposition", () => {
    const failure = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["partner-stopped-at-matching"][0],
        exitCode: 69,
      }),
    );
    expect(failure).toMatchObject({
      title: "Matching could not start",
      message:
        "Matching could not start because your partner's run stopped. Make " +
        "sure you both run the current version of Alcove, then run the " +
        "exchange again.",
      category: "config",
      settingsCannotResolve: true,
      retry: "withheld",
    });
  });

  test("a file of this side's name at entry names the name control and the sweep control", () => {
    const failure = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["shared-name-at-entry"][0],
        exitCode: 64,
      }),
      { channel: "filedrop" },
    );
    expect(failure.title).toBe("Both sides may be using the same name");
    expect(failure.message).toBe(
      "The exchange directory holds a hello file with this side's name, so " +
        "this run takes it for its own leftover. The likely cause is that " +
        'both sides set the same name: change "Name for this side" under ' +
        '"How files are handled" so the two names differ. If instead the ' +
        "listed files are left over from an earlier run of this side, remove " +
        "them after confirming no other session is using this folder, or " +
        `turn on "${SWEEP_CONTROL_LABEL}" under "${RUN_DIAGNOSTICS_HEADING}", ` +
        "then run again.",
    );
    expect(failure.sharedName).toBe(true);
  });

  // The CLI writes its remedy beneath the chain and states it in its own
  // field, so the relay splits the chain from the report alone.
  test.each([
    [
      "an unconfirmed write",
      { kind: "message-write-unconfirmed", failure: "rename-unconfirmed" },
      "the file may or may not have reached the partner. Destination: " +
        "/x/a-1.json",
      "Re-run the exchange in a clean directory; both parties must start " +
        "the new exchange fresh.",
    ],
    [
      "a file of this side's name at entry",
      { kind: "shared-name-at-entry" },
      "1 unexpected protocol file(s) in /x: site-hello-0.json",
      "The likely cause is that both parties set the same peer_id: set a " +
        "different peer_id on one side, changing its text rather than only " +
        "fields such as %Y or %K. If instead the listed files are left over " +
        "from an earlier run of this party, remove them after confirming no " +
        "other session is using this path, or re-run with " +
        "--sweep-exchange-files to clear every protocol file.",
    ],
  ] as const)(
    "%s, relayed as the CLI reports it, keeps the chain and shows no escaped break",
    (_, cause, link, cliRemedy) => {
      const failure = failureFor(
        "exchange",
        relayedFromCli({
          report: `${failureCauseSentence(cause)}\ncaused by: ${link}`,
          nextStep: cliRemedy,
          cause,
          exitCode: 64,
        }),
      );
      expect(failure.reportedCause).toBe(link);
      expect(`${failure.message}\n${failure.reportedCause}`).not.toContain(
        "x0a",
      );
    },
  );

  const SHARED_NAME_REMEDY =
    "The likely cause is that both parties set the same peer_id: set a " +
    "different peer_id on one side.";

  function sharedNameReport(names: ReadonlyArray<string>): {
    relayedLink: string;
    reportedCause: string | undefined;
  } {
    const cause = { kind: "shared-name-at-entry" } as const;
    const link = `${names.length + 1} unexpected protocol file(s) in /x: ${names.join(", ")}, and 1 more`;
    const error = relayedFromCli({
      report: sanitizeErrorForDisplay(
        new Error(failureCauseSentence(cause), { cause: new Error(link) }),
      ),
      nextStep: SHARED_NAME_REMEDY,
      cause,
      exitCode: 64,
    });
    const failure = failureFor("exchange", error);
    return {
      relayedLink: error.message.split("\ncaused by: ")[1],
      reportedCause: failure.reportedCause,
    };
  }

  test.each([
    ["a newline", "site-a\nINJECTED.json"],
    ["a literal backslash then x0a", "site-a\\x0aINJECTED.json"],
    ["a backslash before a newline", "site-a\\\nINJECTED.json"],
  ])(
    "a file name holding %s keeps every name and the count in the report",
    (_, name) => {
      const { reportedCause } = sharedNameReport([name, "site-b.json"]);
      expect(reportedCause).toContain("site-b.json, and 1 more");
      expect(reportedCause).not.toContain(SHARED_NAME_REMEDY);
      // eslint-disable-next-line no-control-regex
      expect(reportedCause).not.toMatch(/[\x00-\x1f\x7f]/);
    },
  );

  test("a file name holding an escape byte shows as the relay sent it", () => {
    const { relayedLink, reportedCause } = sharedNameReport([
      "site-\x1b[31m.json",
    ]);
    expect(relayedLink).toContain("\\x1b");
    expect(reportedCause).toBe(relayedLink);
    // eslint-disable-next-line no-control-regex
    expect(reportedCause).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  // The CLI's suite drives the same causes (runEndingRemedy.test.ts) and holds
  // its message to core's sentence first, so the two state the cause alike.
  test.each(
    Object.values(REPRESENTATIVE_FAILURE_CAUSES).filter(hasConsoleRemedy),
  )(
    "the representative $kind, read off the CLI's event, leads with core's sentence",
    (cause) => {
      const streamed = failureCauseFromUntrusted(
        JSON.parse(JSON.stringify(failureCauseStreamField(cause))),
      );
      expect(streamed).toEqual(cause);
      const failure = failureFor(
        "exchange",
        relayed("the CLI's text", { failureCause: streamed, exitCode: 69 }),
        { channel: "filedrop" },
      );
      expect(
        failure.message.startsWith(`${failureCauseSentence(cause)} `),
      ).toBe(true);
    },
  );

  test("a partner that never arrived names the console's wait control, not the flag", () => {
    const failure = failureFor(
      "exchange",
      relayed(CLI_NO_SHOW_MESSAGE, {
        failureCause: SAMPLES["partner-never-arrived"][0],
        exitCode: 69,
      }),
      { channel: "filedrop" },
    );
    expect(failure.title).toBe("Your partner did not arrive");
    expect(failure.message).toBe(
      "Your partner did not arrive in the shared folder within 90 seconds. " +
        "Check that you and your partner use the same shared folder and " +
        "that it is syncing, then try again. " +
        `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets ` +
        "how long to wait.",
    );
    expect(failure.message).not.toContain("--peer-timeout");
  });

  test("a file with this side's name names the console's name control and offers the way back", () => {
    for (const thisSideNamed of [false, true]) {
      const failure = failureFor(
        "exchange",
        relayed("the CLI's text naming peer_id", {
          failureCause: SAMPLES["partner-never-arrived"][3],
          exitCode: 69,
        }),
        {
          channel: "filedrop",
          seat: "inviter",
          identityLocationPicked: false,
          singleColumnInput: false,
          thisSideNamed,
        },
      );
      expect(failure.title).toBe("Both sides may be using the same name");
      expect(failure.message).toBe(
        "Your partner did not arrive in the shared folder within 90 seconds, " +
          "and a file with this side's name appeared in it. The likely cause " +
          'is that both sides set the same name: change "Name for this side" ' +
          'under "How files are handled" so the two names differ, then run ' +
          "again.",
      );
      expect(failure.message).not.toContain("peer_id");
      expect(failure.message).not.toContain(PEER_TIMEOUT_LABEL);
      expect(failure.sharedName).toBe(true);
      expect(failure.retry).toBe("offered");
    }
  });

  test("an ignored partner hello states its age and names the window and wait controls", () => {
    const IGNORED_HELLO_REMEDY =
      "If the file this run ignored was your partner's, raise " +
      `"${IGNORE_FILES_OLDER_THAN_LABEL}" under ${CONNECTION_TUNING_HEADING}, ` +
      `or give both sides the same "${PEER_TIMEOUT_LABEL}", then run again.`;
    const [, , , , ignored, both] = SAMPLES["partner-never-arrived"];
    for (const thisSideNamed of [false, true]) {
      const failure = failureFor(
        "exchange",
        relayed("the CLI's text naming ignore_files_older_than_ms", {
          failureCause: ignored,
          exitCode: 69,
        }),
        {
          channel: "filedrop",
          seat: "inviter",
          identityLocationPicked: false,
          singleColumnInput: false,
          thisSideNamed,
        },
      );
      expect(failure.title).toBe(
        "Your partner's hello file may have been ignored",
      );
      expect(failure.message).toBe(
        "Your partner did not arrive in the shared folder within 90 seconds; " +
          "at start-up, this run ignored a partner hello file nobody had " +
          "answered for 2 hours, past the limit of 90 seconds. " +
          IGNORED_HELLO_REMEDY,
      );
      expect(failure.message).not.toContain("ignore_files_older_than_ms");
      expect(failure.sharedName).toBeUndefined();
      expect(failure.retry).toBe("offered");
    }
    const shared = failureFor(
      "exchange",
      relayed("the CLI's text", { failureCause: both, exitCode: 69 }),
      { channel: "sftp" },
    );
    expect(shared.title).toBe("Both sides may be using the same name");
    expect(shared.message).toContain(
      "nobody had answered for 2 hours, past the limit of 90 seconds. The " +
        "likely cause is that both sides set the same name",
    );
    expect(shared.message.endsWith(` ${IGNORED_HELLO_REMEDY}`)).toBe(true);
    expect(shared.sharedName).toBe(true);
    const plain = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["partner-never-arrived"][0],
        exitCode: 69,
      }),
      { channel: "filedrop" },
    );
    expect(plain.message).not.toContain(IGNORE_FILES_OLDER_THAN_LABEL);
    expect(plain.message).not.toContain("ignored");
  });

  test("a plain no-show gains the names clause only when this side set a name", () => {
    const CLAUSE =
      'If both sides set a name under "How files are handled", check that ' +
      "the names differ.";
    const noShow = (
      cause: FailureCauseOfKind<"partner-never-arrived">,
      thisSideNamed: boolean,
    ) =>
      failureFor(
        "exchange",
        relayed("the CLI's text", { failureCause: cause, exitCode: 69 }),
        {
          channel: cause.channel,
          seat: "inviter",
          identityLocationPicked: false,
          singleColumnInput: false,
          thisSideNamed,
        },
      );
    const [filedrop, sftp] = SAMPLES["partner-never-arrived"];
    expect(noShow(filedrop, true).message).toBe(
      "Your partner did not arrive in the shared folder within 90 seconds. " +
        "Check that you and your partner use the same shared folder and " +
        `that it is syncing, then try again. ${CLAUSE} ` +
        `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets ` +
        "how long to wait.",
    );
    expect(noShow(sftp, true).message).toContain(CLAUSE);
    expect(noShow(filedrop, false).message).not.toContain(CLAUSE);
    expect(noShow(sftp, false).message).not.toContain(CLAUSE);
    expect(
      noShow({ kind: "partner-never-arrived", channel: "webrtc" }, true)
        .message,
    ).not.toContain(CLAUSE);
    for (const thisSideNamed of [false, true]) {
      expect(noShow(filedrop, thisSideNamed).title).toBe(
        "Your partner did not arrive",
      );
      expect(noShow(filedrop, thisSideNamed).sharedName).toBeUndefined();
    }
  });

  test("a no-show after a delete-mode sweep leads with the both-swept line", () => {
    const noShow = (
      cause: FailureCauseOfKind<"partner-never-arrived">,
      sweep: { sweepExchangeFiles?: boolean; retainFiles?: boolean },
    ) =>
      failureFor(
        "exchange",
        relayed("the CLI's text", { failureCause: cause, exitCode: 69 }),
        { channel: cause.channel, ...sweep },
      );
    const [filedrop, sftp] = SAMPLES["partner-never-arrived"];
    const plain = noShow(filedrop, {});
    const swept = noShow(filedrop, { sweepExchangeFiles: true });
    expect(swept.title).toBe("Your partner did not arrive");
    expect(swept.message).toBe(
      "Your partner did not arrive in the shared folder within 90 seconds. " +
        `${BOTH_SWEPT} ` +
        "Check that you and your partner use the same shared folder and " +
        "that it is syncing, then try again. " +
        `"${PEER_TIMEOUT_LABEL}" under ${CONNECTION_TUNING_HEADING} sets ` +
        "how long to wait.",
    );
    expect(swept.message).not.toContain("--sweep-exchange-files");
    expect(noShow(sftp, { sweepExchangeFiles: true }).message).toContain(
      BOTH_SWEPT,
    );
    for (const unchanged of [
      noShow(filedrop, { sweepExchangeFiles: false }),
      noShow(filedrop, { sweepExchangeFiles: true, retainFiles: true }),
    ]) {
      expect(unchanged.title).toBe(plain.title);
      expect(unchanged.message).toBe(plain.message);
    }
    expect(
      noShow(
        { kind: "partner-never-arrived", channel: "webrtc" },
        { sweepExchangeFiles: true },
      ).message,
    ).not.toContain(BOTH_SWEPT);
  });

  test("the first entrant's handshake timeout after a delete-mode sweep shows the both-swept line, then the channel's step", () => {
    // The CLI's report for this failure, as apps/cli's protocol.test.ts pins
    // it: the key-exchange cause, no next step, no recoveryHint, exit 69.
    const handshakeReport =
      `${KEX_HANDSHAKE_TIMEOUT_MESSAGE}\ncaused by: no message arrived ` +
      "within 30000 ms; run again with a longer --inactivity-timeout.";
    const handshakeTimeout = () =>
      relayedFromCli({
        report: handshakeReport,
        cause: { kind: "key-exchange-timed-out" },
        exitCode: 69,
      });
    const timedOut = (context: FailureContext) =>
      failureFor("exchange", handshakeTimeout(), context);
    const swept = timedOut({ channel: "filedrop", sweepExchangeFiles: true });
    expect(swept.title).toBe("Your partner did not answer");
    expect(swept.message).toBe(
      `Your partner did not answer in time. ${BOTH_SWEPT} ` +
        "Otherwise, check that the shared folder is in place and syncing, then try again.",
    );
    expect(swept.reportedCause).toBeUndefined();
    const sweptSftp = timedOut({ channel: "sftp", sweepExchangeFiles: true });
    expect(sweptSftp.title).toBe("Your partner did not answer");
    expect(sweptSftp.message).toBe(
      `Your partner did not answer in time. ${BOTH_SWEPT} ` +
        "Otherwise this is usually a temporary connection problem rather " +
        "than an issue with your data, so try again.",
    );
    expect(sweptSftp.reportedCause).toBeUndefined();
    // The CLI's report is left out: without a next step it still names the
    // flag that sets the inactivity limit.
    expect(handshakeTimeout().nextStep).toBeUndefined();
    expect(handshakeTimeout().message).toContain("--inactivity-timeout");
    // The partner had reached the shared location, and the wait setting does
    // not bound the key exchange.
    for (const { message } of [swept, sweptSftp]) {
      expect(message).not.toContain("--inactivity-timeout");
      expect(message).not.toContain("use the same");
      expect(message).not.toContain(PEER_TIMEOUT_LABEL);
    }
    const plain = {
      filedrop: timedOut({ channel: "filedrop" }),
      sftp: timedOut({ channel: "sftp" }),
      webrtc: timedOut({ channel: "webrtc" }),
    };
    expect(plain.filedrop.title).toBe("Exchange failed");
    expect(plain.filedrop.message).not.toContain(BOTH_SWEPT);
    expect(plain.sftp.message).not.toContain(BOTH_SWEPT);
    expect(plain.filedrop.reportedCause).toBe(handshakeReport);
    for (const context of [
      { channel: "filedrop", sweepExchangeFiles: false },
      { channel: "filedrop", sweepExchangeFiles: true, retainFiles: true },
      { channel: "sftp", sweepExchangeFiles: false },
      { channel: "sftp", sweepExchangeFiles: true, retainFiles: true },
      { channel: "webrtc", sweepExchangeFiles: true },
    ] satisfies Array<FailureContext & { channel: keyof typeof plain }>) {
      expect(timedOut(context)).toEqual(plain[context.channel]);
    }
    // The cause is what is recognized, not the report's text: the same report
    // without it, or another cause beside it, takes other copy.
    for (const error of [
      relayedFromCli({ report: handshakeReport, exitCode: 69 }),
      relayedFromCli({
        report: handshakeReport,
        cause: { kind: "partner-stopped-responding", silentMs: 30_000 },
        exitCode: 69,
      }),
    ])
      expect(
        failureFor("exchange", error, {
          channel: "filedrop",
          sweepExchangeFiles: true,
        }).message,
      ).not.toContain(BOTH_SWEPT);
  });

  test("a missing shared folder names the mount, not a flag", () => {
    const failure = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["folder-missing"][0],
        exitCode: 66,
      }),
    );
    expect(failure.title).toBe("The shared folder is not available");
    expect(failure.message).toBe(
      "The shared folder /data/drop does not exist (ENOENT). Check that the " +
        "shared folder is mounted into the console and still in place, then " +
        "try again.",
    );
  });

  test("an unreachable relay registrar names the port to open, not a setting", () => {
    const failure = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["relay-registrar-unreachable"][0],
        exitCode: 69,
      }),
    );
    expect(failure.title).toBe("The relay registrar could not be reached");
    expect(failure.message).toBe(
      "The relay registrar at relay.example.org port 8443 could not be " +
        "reached (ECONNREFUSED). This computer needs outbound access to " +
        "relay.example.org on TCP port 8443: if this network allows only " +
        "some ports out, have that port opened or run from a network that " +
        "allows it.",
    );
    expect(failure.message).not.toContain(CONNECTION_TUNING_HEADING);
  });

  test("a registrar name that does not resolve and a registrar that does not answer take core's remedy as is", () => {
    const resolved = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["relay-registrar-unreachable"][1],
        exitCode: 69,
      }),
    );
    expect(resolved.message).toContain(
      "Check the registrar address this exchange is configured with and " +
        "that this computer's DNS resolves relay.example.org, then run again.",
    );
    const silent = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["relay-registrar-unreachable"][2],
        exitCode: 69,
      }),
    );
    expect(silent.message).toContain(
      "The registrar did not complete the request: ask whoever runs the " +
        "relay to check that its registrar is running and reachable from " +
        "this network, then run again.",
    );
  });

  test("a failure this browser raised keeps its own copy whatever it holds", () => {
    // Only a relayed failure takes the console's remedy.
    const failure = failureFor("exchange", new PeerAbortError());
    expect(failure.title).toBe("Exchange failed");
  });

  test("a single-pass or matched-list refusal takes a title naming the limit and core's remedy", () => {
    const [frame, distinct] = SAMPLES["single-pass-over-limit"];
    const tooLargeFrame = failureFor(
      "exchange",
      relayed("the CLI's text", { failureCause: frame, exitCode: 64 }),
    );
    expect(tooLargeFrame.title).toBe(
      "This exchange is too large for single-pass linkage",
    );
    expect(tooLargeFrame.message).toBe(
      "The single-pass request came to 70,001 bytes, above the 65,536 bytes " +
        "one encrypted message can hold, so the exchange stopped and your " +
        "partner was told. Reduce the record count or split the dataset into " +
        "smaller batches, or agree on new terms with fewer linkage keys with " +
        "your partner.",
    );
    expect(
      failureFor(
        "exchange",
        relayed("the CLI's text", { failureCause: distinct, exitCode: 64 }),
      ).title,
    ).toBe("Your file is too large to send");
    const matches = failureFor(
      "exchange",
      relayed("the CLI's text", {
        failureCause: SAMPLES["matches-over-limit"][0],
        exitCode: 64,
      }),
    );
    expect(matches.title).toBe(
      "This exchange found more matches than it can send",
    );
    expect(matches.message).toMatch(
      /told your partner\. This usually means many records on both sides share a key value\./,
    );
  });

  test("a set too large to send takes the browser's title for it and core's remedy", () => {
    const [overMaximum, overCeiling] = SAMPLES["set-over-limit"];
    const tooLarge = failureFor(
      "exchange",
      relayed("the CLI's text", { failureCause: overMaximum, exitCode: 64 }),
    );
    expect(tooLarge.title).toBe("Your file is too large to send");
    expect(tooLarge.message).toBe(
      "Too large to send: the first linkage key gives you at least " +
        "17,000,000 values to send, over the 16,777,216 one PSI set can " +
        "hold, so nothing was sent. Split the input into smaller files and " +
        "run one exchange for each.",
    );
    const forPartner = failureFor(
      "exchange",
      relayed("the CLI's text", { failureCause: overCeiling, exitCode: 64 }),
    );
    expect(forPartner.title).toBe(
      "Your file is too large for your partner to receive",
    );
    expect(forPartner.message).toMatch(
      /, or ask your partner to run the exchange with the command-line application\.$/,
    );
  });

  test("an uncounted set keeps the CLI's report, which states why the count failed", () => {
    const report =
      "Alcove could not count the values the first linkage key gives you " +
      "to send, so it cannot confirm one PSI set can hold them, and nothing " +
      "was sent.\ncaused by: Map maximum size exceeded";
    const failure = failureFor(
      "exchange",
      relayed(report, {
        failureCause: {
          kind: "set-over-limit",
          stage: "before-contact",
          limit: "uncounted",
        },
        exitCode: 64,
      }),
    );
    expect(failure.title).toBe(
      "The values built from your file could not be counted",
    );
    expect(failure.reportedCause).toContain("Map maximum size exceeded");
  });

  test.each(
    SAMPLES["set-over-limit"].map(
      (cause) => [JSON.stringify(cause), cause] as const,
    ),
  )(
    "%s, relayed as the CLI reports it, shows core's sentence and the remedy once",
    (_, cause) => {
      const countFailure =
        cause.limit === "uncounted"
          ? { cause: new RangeError("Map maximum size exceeded") }
          : undefined;
      const err = setOverLimitError(cause, countFailure);
      const failure = failureFor(
        "exchange",
        relayedFromCli({
          report: sanitizeErrorForDisplay(err),
          nextStep: setOverLimitRemedy(cause),
          cause,
          exitCode: 64,
        }),
      );
      const shown = `${failure.message}\n${failure.reportedCause ?? ""}`;
      const times = (part: string): number => shown.split(part).length - 1;
      expect(times(failureCauseSentence(cause))).toBe(1);
      expect(times(setOverLimitRemedy(cause))).toBe(1);
      expect(shown).not.toContain("\\x0a");
      expect(failure.reportedCause).toBe(
        countFailure === undefined ? undefined : "Map maximum size exceeded",
      );
    },
  );

  test.each([1_000, 1_100])(
    "an uncounted set whose count failure runs to %i characters shows no cut remedy in the report",
    (length) => {
      const cause = {
        kind: "set-over-limit",
        stage: "after-terms",
        limit: "uncounted",
      } as const;
      const countFailure = "Map maximum size exceeded "
        .repeat(64)
        .slice(0, length);
      const err = setOverLimitError(cause, {
        cause: new RangeError(countFailure),
      });
      const failure = failureFor(
        "exchange",
        relayedFromCli({
          report: sanitizeErrorForDisplay(err),
          nextStep: setOverLimitRemedy(cause),
          cause,
          exitCode: 64,
        }),
      );
      expect(failure.reportedCause).toContain("Map maximum size exceeded");
      expect(failure.reportedCause).not.toContain("x0a");
      expect(failure.reportedCause).not.toContain("Split");
      const shown = `${failure.message}\n${failure.reportedCause ?? ""}`;
      const times = (part: string): number => shown.split(part).length - 1;
      expect(times(failureCauseSentence(cause))).toBe(1);
      expect(times(setOverLimitRemedy(cause))).toBe(1);
    },
  );

  test("an uncounted set whose count failure spans lines shows it whole", () => {
    const cause = {
      kind: "set-over-limit",
      stage: "before-contact",
      limit: "uncounted",
    } as const;
    const lines = [
      "Map maximum size exceeded",
      "while counting the second linkage key",
    ];
    const err = setOverLimitError(cause, {
      cause: keepFirstPartyLineBreaks(new RangeError(lines.join("\n")), lines),
    });
    const report = sanitizeErrorForDisplay(err);
    expect(report).toContain(lines.join("\n"));
    const failure = failureFor(
      "exchange",
      relayedFromCli({
        report,
        nextStep: setOverLimitRemedy(cause),
        cause,
        exitCode: 64,
      }),
    );
    expect(failure.reportedCause).toBe(lines.join("\n"));
    expect(failure.reportedCause).not.toContain("x0a");
    expect(failure.reportedCause).not.toContain(setOverLimitRemedy(cause));
  });

  test("a partner's value holding a line break opens no line of the report", () => {
    const cause = {
      kind: "set-over-limit",
      stage: "before-contact",
      limit: "uncounted",
    } as const;
    const err = setOverLimitError(cause, {
      cause: errorWithPartnerCauseLinks(
        "Map maximum size exceeded",
        "partner value: ",
        partnerOriginText("email\nINJECTED line"),
      ),
    });
    const failure = failureFor(
      "exchange",
      relayedFromCli({
        report: sanitizeErrorForDisplay(err),
        nextStep: setOverLimitRemedy(cause),
        cause,
        exitCode: 64,
      }),
    );
    const shown = failure.reportedCause?.split("\n") ?? [];
    expect(shown).toContain("Map maximum size exceeded");
    const partnerLine = shown.find((line) => line.includes("INJECTED line"));
    // Control-replaced by core before the CLI placed its breaks.
    expect(partnerLine).toBe(
      "caused by: partner value: email<0a>INJECTED line",
    );
    expect(shown.some((line) => line.startsWith("INJECTED"))).toBe(false);
  });

  test("an uncounted set whose report holds no chain shows no report", () => {
    const cause = {
      kind: "set-over-limit",
      stage: "before-contact",
      limit: "uncounted",
    } as const;
    const failure = failureFor(
      "exchange",
      relayedFromCli({
        report: failureCauseSentence(cause),
        nextStep: setOverLimitRemedy(cause),
        cause,
        exitCode: 64,
      }),
    );
    expect(failure.reportedCause).toBeUndefined();
  });
});

describe("the CLI's next step, relayed in its own field", () => {
  const report = "the exchange stopped\ncaused by: the partner refused";

  test("crosses apart from the report, which the relay splits alone", () => {
    const error = relayedFromCli({
      report,
      nextStep: "Contact your partner before running again.",
      exitCode: 69,
    });
    expect(error.message).toBe(report);
    expect(error.nextStep).toBe("Contact your partner before running again.");
  });

  test("absent, leaves the whole message as the report", () => {
    const error = relayedFromCli({
      report,
      nextStep: "Contact your partner before running again.",
      exitCode: 69,
      sendNextStep: false,
    });
    expect(error.nextStep).toBeUndefined();
    expect(error.message).toBe(
      "the exchange stopped\ncaused by: the partner refused\nContact " +
        "your partner before running again.",
    );
  });

  test("keeps a line break inside the step", () => {
    const termsStep =
      "Agree on the linkage terms with your partner, then run again.\n" +
      'Your file\'s column "email" (email) is matched on.';
    const failure = failureFor(
      "exchange",
      relayedFromCli({ report, nextStep: termsStep, exitCode: 69 }),
      { channel: "filedrop" },
    );
    expect(failure.reportedCause).toBe(`${report}\n${termsStep}`);
    expect(failure.reportedCause).not.toContain("x0a");
  });

  test("leaves the partner refusal's report without the step, which the console's copy states", () => {
    const partnerStep =
      "Contact your partner before running again: the partner or the agreed " +
      "terms refused this exchange, and retrying unchanged will fail the " +
      "same way.";
    const failure = failureFor(
      "exchange",
      relayedFromCli({
        report: "the peer authentically signaled that it aborted the exchange",
        nextStep: partnerStep,
        exitCode: PARTNER_REFUSED_EXIT_CODE,
      }),
      { channel: "filedrop" },
    );
    expect(failure.title).toBe("Your partner refused this exchange");
    expect(failure.reportedCause).toBe(
      "the peer authentically signaled that it aborted the exchange",
    );
    expect(failure.message).not.toContain("x0a");
  });

  test("follows an internal fault's report on a line of its own", () => {
    const faultStep =
      "This is a fault in Alcove itself: report it with this message. " +
      "Retrying will not help.";
    const failure = failureFor(
      "exchange",
      relayedFromCli({
        report,
        nextStep: faultStep,
        exitCode: 70,
        internalFault: true,
      }),
      { channel: "sftp" },
    );
    expect(failure.title).toBe("Exchange failed");
    expect(failure.message).toBe(
      "The exchange stopped. Its report below states the cause and what to " +
        "do next.",
    );
    expect(failure.reportedCause).toBe(`${report}\n${faultStep}`);
    expect(failure.retry).toBe("withheld");
  });

  test("follows a self-explaining report on a line of its own", () => {
    const termsStep =
      "Agree on the linkage terms with your partner, then run the same " +
      "command again.";
    const failure = failureFor(
      "exchange",
      relayedFromCli({ report, nextStep: termsStep, exitCode: 69 }),
      { channel: "filedrop" },
    );
    expect(failure.reportedCause).toBe(`${report}\n${termsStep}`);
    expect(failure.reportedCause).not.toContain("x0a");
  });

  test("is dropped where the message does not end with it", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "exchange",
      message: report,
      nextStep: "a step the message does not state",
      exitCode: 69,
    });
    expect(event?.nextStep).toBeUndefined();
    const error = relayedTerminalErrorOf(event!);
    expect(error.message).toBe(report);
    expect(error.nextStep).toBeUndefined();
  });
});

describe("a console run the partner refused", () => {
  test("is flagged as the partner's refusal, with no retry and no settings fix", () => {
    const report =
      "the peer authentically signaled that it aborted the exchange";
    for (const seat of ["inviter", "acceptor"] as const) {
      const failure = failureFor(
        "exchange",
        relayed(report, { exitCode: PARTNER_REFUSED_EXIT_CODE }),
        { channel: "filedrop", seat },
      );
      expect(failure.title).toBe("Your partner refused this exchange");
      expect(failure.category).toBe("config");
      expect(failure.settingsCannotResolve).toBe(true);
      expect(failure.retry).toBe("withheld");
      expect(failure.reportedCause).toBe(report);
    }
  });

  test("keeps the trust-check copy for a refused partner receipt", () => {
    const failure = failureFor(
      "security",
      relayed("the partner's receipt did not verify", {
        exitCode: PARTNER_REFUSED_EXIT_CODE,
      }),
    );
    expect(failure.category).toBe("security");
    expect(failure.settingsCannotResolve).toBeUndefined();
  });

  test("a run that exited otherwise is not flagged", () => {
    const failure = failureFor(
      "exchange",
      relayed("the server went away", { exitCode: 69 }),
    );
    expect(failure.settingsCannotResolve).toBeUndefined();
    expect(failure.retry).toBe("offered");
  });
});

describe("the file-drop fallback", () => {
  test("names no cause for a failure it cannot classify", () => {
    const failure = failureFor(
      "exchange",
      new RelayedTerminalError("read ECONNRESET"),
      { channel: "filedrop" },
    );
    expect(failure.message).not.toMatch(/never appeared|never arrived/);
    expect(failure.message).toContain("shared folder");
    expect(failure.reportedCause).toBe("read ECONNRESET");
    expect(failure.retry).toBe("offered");
  });
});
