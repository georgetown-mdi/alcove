import { expect, test } from "vitest";
import {
  failureCauseSentence,
  markFailureCause,
  type FailureCause,
  type FailureCauseKind,
  type FailureCauseOfKind,
} from "@alcove/core";

import {
  CLI_FAILURE_REMEDIES,
  configAppearedLateStepShown,
  failureRemedy,
  keyFileSavedConfigNotWrittenRemedy,
  markArrivalWait,
  markKeyFileSavedConfigNotWritten,
  OLDER_KEY_FILE_NO_SHOW_REMEDY,
  remedyForCause,
  type ArrivalWait,
} from "../../src/failureRemedy";
import { renderFailureForOperator } from "../../src/util/exit";

// Keyed on every kind, so a cause core adds fails to compile here until it has
// samples, as CLI_FAILURE_REMEDIES fails until it has a remedy.
const SAMPLES: {
  readonly [K in FailureCauseKind]: ReadonlyArray<FailureCauseOfKind<K>>;
} = {
  "partner-never-arrived": [
    { kind: "partner-never-arrived", channel: "filedrop" },
    { kind: "partner-never-arrived", channel: "sftp" },
    { kind: "partner-never-arrived", channel: "webrtc", waitedMs: 600_000 },
    {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      sharedName: true,
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
      code: "ECONNRESET",
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

const ARRIVAL_WAITS: ArrivalWait[] = ["exchange", "online-invitation"];

const cases = Object.values(SAMPLES)
  .flat()
  .flatMap((cause: FailureCause) =>
    ARRIVAL_WAITS.map((arrivalWait) => ({ cause, arrivalWait })),
  );

test("every catalog kind has a CLI remedy", () => {
  expect(Object.keys(CLI_FAILURE_REMEDIES).sort()).toEqual(
    Object.keys(SAMPLES).sort(),
  );
});

test.each(cases)(
  "the remedy for $cause.kind ($arrivalWait) is plain ASCII, ends with a period and names at most one flag",
  ({ cause, arrivalWait }) => {
    const remedy = remedyForCause(cause, { arrivalWait });
    expect(remedy).toMatch(/^[A-Z][\x20-\x7e]*\.$/);
    expect((remedy.match(/--[a-z-]+/g) ?? []).length).toBeLessThanOrEqual(1);
  },
);

function rendered(cause: FailureCause, arrivalWait?: ArrivalWait): string {
  const err = markFailureCause(new Error(failureCauseSentence(cause)), cause);
  if (arrivalWait !== undefined) markArrivalWait(err, arrivalWait);
  return renderFailureForOperator(err);
}

test("a file-drop no-show on alcove exchange names --peer-timeout only", () => {
  expect(rendered(SAMPLES["partner-never-arrived"][0])).toBe(
    "Your partner did not arrive in the shared folder in the time this run " +
      "waited.\n" +
      "Check that you and your partner use the same folder and that it is " +
      "syncing, then run again; --peer-timeout sets how long to wait.",
  );
});

test("a WebRTC no-show from a key file names an older copy of the key file among its causes", () => {
  const [, , webrtc] = SAMPLES["partner-never-arrived"];
  const err = markFailureCause(
    new Error(failureCauseSentence(webrtc!)),
    webrtc!,
  );
  markArrivalWait(err, "exchange", { fromKeyFile: true });
  expect(renderFailureForOperator(err)).toContain(
    "Check that your partner has started their side, then run again; " +
      "--peer-timeout sets how long to wait. " +
      OLDER_KEY_FILE_NO_SHOW_REMEDY,
  );
  expect(OLDER_KEY_FILE_NO_SHOW_REMEDY).toContain("restored from a backup");
  // A run with no key file of its own, and the file-sync channels, where two
  // copies meet in the key exchange, do not name it.
  expect(rendered(webrtc!, "exchange")).not.toContain(
    OLDER_KEY_FILE_NO_SHOW_REMEDY,
  );
  for (const fileSync of SAMPLES["partner-never-arrived"].slice(0, 2)) {
    const e = markFailureCause(
      new Error(failureCauseSentence(fileSync)),
      fileSync,
    );
    markArrivalWait(e, "exchange", { fromKeyFile: true });
    expect(renderFailureForOperator(e)).not.toContain(
      OLDER_KEY_FILE_NO_SHOW_REMEDY,
    );
  }
});

test("an SFTP no-show names the server and --peer-timeout only", () => {
  expect(rendered(SAMPLES["partner-never-arrived"][1])).toBe(
    "Your partner did not arrive in the shared folder on the SFTP server in " +
      "the time this run waited.\n" +
      "Check that you and your partner use the same server and folder, then " +
      "run again; --peer-timeout sets how long to wait.",
  );
});

test("a no-show with a file of this side's name names peer_id and no timeout flag", () => {
  const shared = SAMPLES["partner-never-arrived"][3]!;
  for (const arrivalWait of [undefined, ...ARRIVAL_WAITS])
    expect(rendered(shared, arrivalWait)).toBe(
      "Your partner did not arrive in the shared folder within 90 seconds, " +
        "and a file with this side's name appeared in it.\n" +
        "The likely cause is that both parties set the same peer_id: set a " +
        "different peer_id on one side, changing its text rather than only " +
        "its % fields, then run again.",
    );
  const sftp = rendered({ kind: "partner-never-arrived", channel: "sftp" });
  expect(sftp).toContain("--peer-timeout");
  expect(sftp).not.toContain("peer_id");
});

test("a no-show on an online invitation names --accept-timeout only", () => {
  expect(
    rendered(SAMPLES["partner-never-arrived"][2], "online-invitation"),
  ).toBe(
    "Your partner did not connect within 10 minutes.\n" +
      "Run alcove invite again and have your partner accept the new " +
      "invitation while it waits; --accept-timeout sets how long to wait.",
  );
});

test("a missing shared folder names the path and the errno", () => {
  expect(rendered(SAMPLES["folder-missing"][0])).toBe(
    "The shared folder /data/drop does not exist (ENOENT).\n" +
      "Create or mount the folder, or correct its path, then run again.",
  );
  expect(rendered(SAMPLES["folder-missing"][1])).toBe(
    "The shared folder path /data/drop does not name a folder (ENOTDIR).\n" +
      "Correct the path so it names a folder, then run again.",
  );
});

test("a relay registrar with no connection names its host and port and the outbound access it needs", () => {
  expect(rendered(SAMPLES["relay-registrar-unreachable"][0])).toBe(
    "The relay registrar at relay.example.org port 8443 could not be " +
      "reached (ECONNREFUSED).\n" +
      "This computer needs outbound access to relay.example.org on TCP port " +
      "8443: if this network allows only some ports out, have that port " +
      "opened or run from a network that allows it.",
  );
});

test("a relay registrar name that does not resolve points at the configured address and DNS, not the port", () => {
  expect(rendered(SAMPLES["relay-registrar-unreachable"][1])).toBe(
    "The relay registrar's host name relay.example.org did not resolve to " +
      "an address (ENOTFOUND).\n" +
      "Check the registrar address in connection.relay_registrar.url and " +
      "that this computer's DNS resolves relay.example.org, then run again.",
  );
});

test.each([
  [
    2,
    "The relay registrar at relay.example.org port 8443 closed the " +
      "connection without answering (ECONNRESET).",
  ],
  [
    3,
    "The relay registrar at relay.example.org port 8443 did not answer " +
      "within 15 seconds.",
  ],
])(
  "a relay registrar that connected and did not answer points at the registrar, not the port (sample %i)",
  (index, sentence) => {
    expect(rendered(SAMPLES["relay-registrar-unreachable"][index])).toBe(
      `${sentence}\n` +
        "The registrar did not complete the " +
        "request: check that it is running and reachable from this network " +
        "(infra/relay/README.md, The registrar), then run again.",
    );
  },
);

test("the remedy follows the cause through a wrap", () => {
  const cause = SAMPLES["folder-missing"][0];
  const inner = markFailureCause(new Error(failureCauseSentence(cause)), cause);
  const outer = new Error("failed during synchronization", { cause: inner });
  expect(renderFailureForOperator(outer).split("\n").at(-1)).toBe(
    "Create or mount the folder, or correct its path, then run again.",
  );
});

test("an error with no catalog cause gets no remedy line", () => {
  expect(renderFailureForOperator(new Error("something else"))).toBe(
    "something else",
  );
});

test("a tagged cause of a kind with no row gets no remedy rather than a throw", () => {
  const unknown = { kind: "partner-went-away" } as unknown as FailureCause;
  const err = markFailureCause(new Error("the partner went away"), unknown);
  expect(failureRemedy(err)).toBeUndefined();
  expect(renderFailureForOperator(err)).toBe("the partner went away");
});

const EXCHANGE_WAIT_REMEDY =
  "Check that your partner has started their side, then run again; " +
  "--peer-timeout sets how long to wait.";
const INVITATION_WAIT_REMEDY =
  "Run alcove invite again and have your partner accept the new " +
  "invitation while it waits; --accept-timeout sets how long to wait.";

test("an error without the partner-never-arrived cause is not marked", () => {
  // A mark on the inner error would reach the outer one through the cause
  // chain, so the outer remedy shows whether the inner one was marked.
  const cause = SAMPLES["partner-never-arrived"][2];
  for (const inner of [
    new Error("something else"),
    markFailureCause(new Error("missing"), SAMPLES["folder-missing"][0]),
  ]) {
    expect(markArrivalWait(inner, "online-invitation")).toBe(inner);
    const outer = markFailureCause(
      new Error(failureCauseSentence(cause), { cause: inner }),
      cause,
    );
    expect(failureRemedy(outer)).toBe(EXCHANGE_WAIT_REMEDY);
  }
});

test("the arrival wait follows the error through a wrap", () => {
  const cause = SAMPLES["partner-never-arrived"][2];
  const inner = markArrivalWait(
    markFailureCause(new Error(failureCauseSentence(cause)), cause),
    "online-invitation",
  );
  const outer = new Error("the invitation was not accepted", { cause: inner });
  expect(failureRemedy(outer)).toBe(INVITATION_WAIT_REMEDY);
});

test("a frozen error is marked like any other", () => {
  const cause = SAMPLES["partner-never-arrived"][2];
  const err = Object.freeze(
    markFailureCause(new Error(failureCauseSentence(cause)), cause),
  );
  expect(markArrivalWait(err, "online-invitation")).toBe(err);
  expect(renderFailureForOperator(err)).toBe(
    "Your partner did not connect within 10 minutes.\n" +
      INVITATION_WAIT_REMEDY,
  );
});

// The step is appended at the display sink after the error chain is escaped,
// so the paths in it are escaped where it is composed.
test("the step for a key file saved before its configuration escapes both paths", () => {
  const state = {
    keyPath: "/keys/\x1b[31mEVIL\n.alcove.key",
    configPath: "/conf/\x1b[31mEVIL\nalcove.yaml",
    kept: false,
    configWriteFailed: false,
  };
  for (const ending of [
    { kind: "failed", errorStatesItsStep: false },
    { kind: "interrupted" },
  ] as const) {
    const step = keyFileSavedConfigNotWrittenRemedy(state, ending);
    expect(step).not.toContain("\x1b");
    expect(step).not.toContain("\n");
    expect(step).toContain("/keys/<1b>[31mEVIL<0a>.alcove.key");
  }
});

test("the step for a key file saved where a file appeared at the configuration path is the refusal's own step on every ending", () => {
  const state = {
    keyPath: "/k/.alcove.key",
    configPath: "/k/alcove.yaml",
    kept: false,
    configWriteFailed: true,
    configAppearedLate: true,
  };
  for (const ending of [
    { kind: "failed", errorStatesItsStep: false },
    { kind: "failed", errorStatesItsStep: true },
    { kind: "interrupted" },
  ] as const) {
    const step = keyFileSavedConfigNotWrittenRemedy(state, ending);
    expect(
      step.endsWith(` ${configAppearedLateStepShown("/k/alcove.yaml")}`),
    ).toBe(true);
    expect(step).toContain("a file appeared at /k/alcove.yaml");
    expect(step).not.toMatch(/delete/i);
  }
});

test("the step for a key file saved before its configuration takes a catalog remedy's place beneath the error", () => {
  const cause = SAMPLES["folder-missing"][0];
  const err = markKeyFileSavedConfigNotWritten(
    markFailureCause(new Error(failureCauseSentence(cause)), cause),
    {
      keyPath: "/k/.alcove.key",
      configPath: "/k/alcove.yaml",
      kept: false,
      configWriteFailed: false,
    },
  );
  const rendered = renderFailureForOperator(err);
  expect(rendered).not.toContain(failureRemedy(err) ?? "no catalog remedy");
  expect(
    rendered.endsWith(
      "Delete /k/.alcove.key before you start again. Ask your partner for a " +
        "new invitation, or create one with 'alcove invite' and have your " +
        "partner accept it.",
    ),
  ).toBe(true);
});
