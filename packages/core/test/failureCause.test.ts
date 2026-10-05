import { describe, expect, test } from "vitest";

import {
  failureCauseError,
  failureCauseOf,
  failureCauseSentence,
  formatWaitDuration,
  markFailureCause,
  type FailureCause,
  type FailureCauseKind,
  type FailureCauseOfKind,
} from "../src/failureCause";

// Every kind is a key, so a cause added to the catalog fails to compile here
// until it has samples, and the checks below then run over its sentences.
const SAMPLES: {
  readonly [K in FailureCauseKind]: ReadonlyArray<FailureCauseOfKind<K>>;
} = {
  "partner-never-arrived": [
    { kind: "partner-never-arrived", channel: "filedrop" },
    { kind: "partner-never-arrived", channel: "sftp" },
    { kind: "partner-never-arrived", channel: "webrtc" },
    { kind: "partner-never-arrived", channel: "webrtc", waitedMs: 80_000 },
    { kind: "partner-never-arrived", channel: "filedrop", waitedMs: 3_600_000 },
    { kind: "partner-never-arrived", waitedMs: 90_000 },
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
    {
      kind: "relay-registrar-unreachable",
      host: "relay.example.org",
      port: 8443,
      code: "UND_ERR_CONNECT_TIMEOUT",
    },
    {
      kind: "relay-registrar-unreachable",
      host: "relay.example.org",
      port: 8443,
      timedOutMs: 15_000,
    },
  ],
};

const allSamples: FailureCause[] = Object.values(SAMPLES).flat();

describe("the failure-cause catalog", () => {
  test.each(allSamples.map((cause) => [JSON.stringify(cause), cause]))(
    "%s has one plain ASCII sentence ending in a period",
    (_, cause) => {
      const sentence = failureCauseSentence(cause);
      expect(sentence).toMatch(/^[A-Z][\x20-\x7e]*\.$/);
      // Exactly one sentence: no period followed by more words.
      expect(sentence).not.toMatch(/\.\s+\S/);
      // No flag, control or role tag: those belong to each app's remedy.
      expect(sentence).not.toMatch(/--|\[|\]/);
    },
  );

  test("the audit's causes read as expected", () => {
    expect(
      SAMPLES["partner-never-arrived"].map((cause) =>
        failureCauseSentence(cause),
      ),
    ).toEqual([
      "Your partner did not arrive in the shared folder in the time this run waited.",
      "Your partner did not arrive in the shared folder on the SFTP server in the time this run waited.",
      "Your partner did not connect in the time this run waited.",
      "Your partner did not connect within 80 seconds.",
      "Your partner did not arrive in the shared folder within 1 hour.",
      "Your partner did not arrive within 90 seconds.",
    ]);
    expect(
      SAMPLES["folder-missing"].map((cause) => failureCauseSentence(cause)),
    ).toEqual([
      "The shared folder /data/drop does not exist (ENOENT).",
      "The shared folder path /data/drop does not name a folder (ENOTDIR).",
    ]);
    expect(
      SAMPLES["relay-registrar-unreachable"].map((cause) =>
        failureCauseSentence(cause),
      ),
    ).toEqual([
      "The relay registrar at relay.example.org port 8443 could not be reached (ECONNREFUSED).",
      "The relay registrar at relay.example.org port 8443 could not be reached (connection timed out).",
      "The relay registrar at relay.example.org port 8443 did not answer within 15 seconds.",
    ]);
  });

  test("a path is composed raw, for the display sink to escape", () => {
    const path = "/data/a\nb";
    expect(
      failureCauseSentence({ kind: "folder-missing", path, code: "ENOENT" }),
    ).toContain(path);
  });
});

describe("formatWaitDuration", () => {
  test.each([
    [150, "0.15 seconds"],
    [1_000, "1 second"],
    [80_000, "80 seconds"],
    [60_000, "1 minute"],
    [600_000, "10 minutes"],
    [3_600_000, "1 hour"],
    [7_200_000, "2 hours"],
    [90_000, "90 seconds"],
    [0, "0 seconds"],
    [86_400_000, "24 hours"],
    [4_500_000, "75 minutes"],
    [1_234_500, "1,234.5 seconds"],
    [3_600_000_000, "1,000 hours"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatWaitDuration(ms)).toBe(text);
  });
});

describe("the failure-cause tag", () => {
  const cause: FailureCause = {
    kind: "folder-missing",
    path: "/data/drop",
    code: "ENOENT",
  };

  test("is read off the error itself and through its cause chain", () => {
    const tagged = markFailureCause(new Error("inner"), cause);
    expect(failureCauseOf(tagged)).toBe(cause);
    const outer = new Error("outer", {
      cause: new Error("middle", { cause: tagged }),
    });
    expect(failureCauseOf(outer)).toBe(cause);
  });

  test("leaves the message and class alone", () => {
    class Custom extends Error {}
    const tagged = markFailureCause(new Custom("unchanged"), cause);
    expect(tagged).toBeInstanceOf(Custom);
    expect(tagged.message).toBe("unchanged");
  });

  test("is absent from an untagged chain, including a cyclic one", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(failureCauseOf(b)).toBeUndefined();
    expect(failureCauseOf("not an error")).toBeUndefined();
  });

  test("failureCauseError states the sentence and holds the cause", () => {
    const err = failureCauseError(cause);
    expect(err.message).toBe(failureCauseSentence(cause));
    expect(failureCauseOf(err)).toBe(cause);
  });
});
