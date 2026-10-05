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
  markArrivalWait,
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
      code: "ECONNREFUSED",
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

test("an SFTP no-show names the server and --peer-timeout only", () => {
  expect(rendered(SAMPLES["partner-never-arrived"][1])).toBe(
    "Your partner did not arrive in the shared folder on the SFTP server in " +
      "the time this run waited.\n" +
      "Check that you and your partner use the same server and folder, then " +
      "run again; --peer-timeout sets how long to wait.",
  );
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

test("an unreachable relay registrar names its host and port and the outbound access it needs", () => {
  expect(rendered(SAMPLES["relay-registrar-unreachable"][0])).toBe(
    "The relay registrar at relay.example.org port 8443 could not be " +
      "reached (ECONNREFUSED).\n" +
      "This computer needs outbound access to relay.example.org on TCP port " +
      "8443: if this network allows only some ports out (such as 443), have " +
      "that port opened or run from a network that allows it.",
  );
});

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

test("an error without the partner-never-arrived cause is not tagged", () => {
  const plain = new Error("something else");
  expect(markArrivalWait(plain, "online-invitation")).toBe(plain);
  expect(Object.keys(plain)).toEqual([]);

  const folder = markFailureCause(
    new Error("missing"),
    SAMPLES["folder-missing"][0],
  );
  const keysBefore = Object.keys(folder);
  markArrivalWait(folder, "online-invitation");
  expect(Object.keys(folder)).toEqual(keysBefore);
});

test("a frozen error is returned unchanged rather than throwing", () => {
  const cause = SAMPLES["partner-never-arrived"][2];
  const err = Object.freeze(
    markFailureCause(new Error(failureCauseSentence(cause)), cause),
  );
  expect(markArrivalWait(err, "online-invitation")).toBe(err);
  expect(renderFailureForOperator(err)).toBe(
    "Your partner did not connect within 10 minutes.\n" +
      "Check that your partner has started their side, then run again; " +
      "--peer-timeout sets how long to wait.",
  );
});
