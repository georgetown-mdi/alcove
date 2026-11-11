import { describe, expect, test } from "vitest";

import {
  PARTNER_REFUSED_EXIT_CODE,
  failureCauseStreamField,
} from "@alcove/cli-contract";
import {
  PeerAbortError,
  failureCauseFromUntrusted,
  failureCauseSentence,
  joinErrorCauseChain,
  sanitizeErrorChainLinks,
  sanitizeErrorForDisplay,
  setOverLimitError,
  setOverLimitRemedy,
} from "@alcove/core";
import { REPRESENTATIVE_FAILURE_CAUSES } from "@alcove/core/testing";

import {
  CONNECTION_TUNING_HEADING,
  IGNORE_FILES_OLDER_THAN_LABEL,
  PEER_TIMEOUT_LABEL,
} from "@console/connectionTuningModel";
import {
  RelayedSelfExplainingError,
  RelayedTerminalError,
} from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";

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
};

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

const CLI_NO_SHOW_MESSAGE =
  "Your partner did not arrive in the shared folder within 90 seconds.\n" +
  "Check that you and your partner use the same folder and that it is " +
  "syncing, then run again; --peer-timeout sets how long to wait.";

describe("a console run that failed on a catalog cause", () => {
  test.each(
    Object.values(SAMPLES)
      .flat()
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
    expect(failure.retry).toBe("offered");
  });

  // The CLI's suite drives the same causes (runEndingRemedy.test.ts) and holds
  // its message to core's sentence first, so the two state the cause alike.
  test.each(Object.values(REPRESENTATIVE_FAILURE_CAUSES))(
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
      const cliMessage = `${sanitizeErrorForDisplay(err)}\n${setOverLimitRemedy(cause)}`;
      const relayedMessage = joinErrorCauseChain(
        sanitizeErrorChainLinks(cliMessage),
      );
      const failure = failureFor(
        "exchange",
        relayed(relayedMessage, { failureCause: cause, exitCode: 64 }),
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
      const cliMessage = `${sanitizeErrorForDisplay(err)}\n${setOverLimitRemedy(cause)}`;
      const relayedLinks = sanitizeErrorChainLinks(cliMessage);
      // The relay's cap cuts the last link inside the remedy or before it.
      expect(relayedLinks.at(-1)).not.toContain(setOverLimitRemedy(cause));
      const failure = failureFor(
        "exchange",
        relayed(joinErrorCauseChain(relayedLinks), {
          failureCause: cause,
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

  test("an uncounted set whose report holds no chain shows no report", () => {
    const cause = {
      kind: "set-over-limit",
      stage: "before-contact",
      limit: "uncounted",
    } as const;
    const relayedMessage = joinErrorCauseChain(
      sanitizeErrorChainLinks(
        `${failureCauseSentence(cause)}\n${setOverLimitRemedy(cause)}`,
      ),
    );
    const failure = failureFor(
      "exchange",
      relayed(relayedMessage, { failureCause: cause, exitCode: 64 }),
    );
    expect(failure.reportedCause).toBeUndefined();
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
