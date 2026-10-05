import { describe, expect, test } from "vitest";

import { PeerAbortError, failureCauseSentence } from "@alcove/core";

import {
  CONNECTION_TUNING_HEADING,
  PEER_TIMEOUT_LABEL,
} from "@console/connectionTuningModel";
import {
  PARTNER_REFUSED_EXIT_CODE,
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
      undefined,
      "filedrop",
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

  test("a partner that never arrived names the console's wait control, not the flag", () => {
    const failure = failureFor(
      "exchange",
      relayed(CLI_NO_SHOW_MESSAGE, {
        failureCause: SAMPLES["partner-never-arrived"][0],
        exitCode: 69,
      }),
      undefined,
      "filedrop",
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

  test("a failure this browser raised keeps its own copy whatever it holds", () => {
    // Only a relayed failure takes the console's remedy: the public web app
    // does not draw on the catalog.
    const failure = failureFor("exchange", new PeerAbortError());
    expect(failure.title).toBe("Exchange failed");
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
        undefined,
        "filedrop",
        seat,
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
      undefined,
      "filedrop",
    );
    expect(failure.message).not.toMatch(/never appeared|never arrived/);
    expect(failure.message).toContain("shared folder");
    expect(failure.reportedCause).toBe("read ECONNRESET");
    expect(failure.retry).toBe("offered");
  });
});
