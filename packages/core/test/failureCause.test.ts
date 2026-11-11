import { describe, expect, test } from "vitest";

import { RoundSetLimitError, statesItsOwnNextStep } from "../src/errors";
import {
  CLEAN_DIRECTORY_RESTART_REMEDY,
  FAILURE_CAUSE_KINDS,
  failureCauseError,
  failureCauseFromUntrusted,
  failureCauseOf,
  failureCauseSentence,
  formatFileAge,
  formatWaitDuration,
  MATCHES_OVER_LIMIT_REMEDY,
  PARTNER_STOPPED_AT_MATCHING_REMEDY,
  relayRegistrarUnreachableRemedy,
  markFailureCause,
  setOverLimitError,
  setOverLimitRemedy,
  singlePassOverLimitRemedy,
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
    {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      sharedName: true,
    },
    { kind: "partner-never-arrived", channel: "sftp", sharedName: true },
    { kind: "partner-never-arrived", sharedName: true },
    {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      ignoredHello: { ageMs: 3 * 3_600_000 + 59_999, windowMs: 90_000 },
    },
    {
      kind: "partner-never-arrived",
      channel: "sftp",
      waitedMs: 150,
      sharedName: true,
      ignoredHello: { ageMs: 59_999, windowMs: 150 },
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
      failure: "no-connection",
      code: "UND_ERR_CONNECT_TIMEOUT",
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
      stage: "before-contact",
      limit: "set-maximum",
      valueCount: 301,
      limitValues: 300,
      scope: "every-key",
    },
    {
      kind: "set-over-limit",
      stage: "after-terms",
      limit: "set-maximum",
      valueCount: 10,
      limitValues: 9,
      scope: "widest-key",
    },
    {
      kind: "set-over-limit",
      stage: "after-terms",
      limit: "partner-ceiling",
      valueCount: 9_000_000,
      limitValues: 8_388_608,
      scope: "first-key",
    },
    {
      kind: "set-over-limit",
      stage: "in-round",
      limit: "set-maximum",
      valueCount: 16_777_217,
      limitValues: 16_777_216,
    },
    {
      kind: "set-over-limit",
      stage: "in-round",
      limit: "partner-ceiling",
      valueCount: 3,
      limitValues: 2,
    },
    { kind: "set-over-limit", stage: "before-contact", limit: "uncounted" },
    { kind: "set-over-limit", stage: "after-terms", limit: "uncounted" },
  ],
  "single-pass-over-limit": [
    {
      kind: "single-pass-over-limit",
      limit: "browser-dataset",
      recordCount: 1_200_000,
      linkageKeyCount: 3,
    },
    {
      kind: "single-pass-over-limit",
      limit: "browser-dataset",
      recordCount: 1,
      linkageKeyCount: 1,
      fansOut: true,
    },
    {
      kind: "single-pass-over-limit",
      limit: "value-slots",
      local: { effectiveKeyCount: 3, recordCount: 2_000_000 },
      partner: { effectiveKeyCount: 3, recordCount: 400_000 },
      limitSlots: 3_000_000,
      localFansOut: true,
    },
    {
      kind: "single-pass-over-limit",
      limit: "value-slots",
      local: { effectiveKeyCount: 3, recordCount: 400_000 },
      partner: { effectiveKeyCount: 3, recordCount: 2_000_000 },
      limitSlots: 3_000_000,
      partnerFansOut: true,
    },
    {
      kind: "single-pass-over-limit",
      limit: "value-slots",
      local: { effectiveKeyCount: 3, recordCount: 2_000_000 },
      partner: { effectiveKeyCount: 4, recordCount: 1_000_000 },
      limitSlots: 3_000_000,
    },
    {
      kind: "single-pass-over-limit",
      limit: "frame",
      frame: "reply",
      frameBytes: 70_000,
      limitBytes: 65_536,
    },
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
  "matches-over-limit": [
    { kind: "matches-over-limit", list: "grouping" },
    {
      kind: "matches-over-limit",
      list: "resolved",
      matchCount: 9_000_000,
      limitMatches: 8_388_607,
    },
    {
      kind: "matches-over-limit",
      list: "resolved",
      matchCount: 1,
      limitMatches: 0,
    },
  ],
  "shared-secret-unusable": [
    { kind: "shared-secret-unusable", problem: "malformed" },
    {
      kind: "shared-secret-unusable",
      problem: "expired",
      expires: "2026-07-08T19:32:00.000Z",
      stage: "before-handshake",
    },
    {
      kind: "shared-secret-unusable",
      problem: "expired",
      expires: "2026-07-08T19:32:00Z",
      stage: "before-next-saved",
    },
  ],
  "partner-stopped-at-matching": [{ kind: "partner-stopped-at-matching" }],
  "message-write-unconfirmed": [
    { kind: "message-write-unconfirmed", failure: "rename-unconfirmed" },
    { kind: "message-write-unconfirmed", failure: "write-incomplete" },
    { kind: "message-write-unconfirmed", failure: "sequence-spent", seq: 4 },
  ],
  "shared-name-at-entry": [{ kind: "shared-name-at-entry" }],
  "key-exchange-timed-out": [{ kind: "key-exchange-timed-out" }],
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
      "Your partner did not arrive in the shared folder within 90 seconds, and a file with this side's name appeared in it.",
      "Your partner did not arrive in the shared folder on the SFTP server in the time this run waited, and a file with this side's name appeared in it.",
      "Your partner did not arrive in the time this run waited, and a file with this side's name appeared during the wait.",
      "Your partner did not arrive in the shared folder within 90 seconds; at start-up, this run ignored a partner hello file nobody had answered for 3 hours, past the limit of 90 seconds.",
      "Your partner did not arrive in the shared folder on the SFTP server within 0.15 seconds, and a file with this side's name appeared in it; at start-up, this run ignored a partner hello file nobody had answered for 59 seconds, past the limit of 0.15 seconds.",
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
      "The relay registrar's host name relay.example.org did not resolve to an address (ENOTFOUND).",
      "The relay registrar at relay.example.org port 8443 closed the connection without answering (ECONNRESET).",
      "The relay registrar at relay.example.org port 8443 did not answer within 15 seconds.",
    ]);
    expect(failureCauseSentence(SAMPLES["partner-stopped-responding"][0])).toBe(
      "Your partner stopped responding during matching: nothing arrived from them for 2 minutes.",
    );
    expect(
      SAMPLES["set-over-limit"].map((cause) => failureCauseSentence(cause)),
    ).toEqual([
      "Too large to send: the first linkage key gives you at least 17,000,000 values to send, over the 16,777,216 one PSI set can hold, so nothing was sent.",
      "Too large to send: a count-only exchange sends 301 values for every linkage key, over the 300 one PSI set can hold, so nothing was sent.",
      "Too large to send: a count-only exchange sends 10 values for its widest linkage key, over the 9 one PSI set can hold, so the exchange stopped before any linkage key was sent and told your partner.",
      "Too large for your partner: the first linkage key gives you at least 9,000,000 values to send, over the 8,388,608 your partner can receive in one PSI set, so the exchange stopped before any linkage key was sent and told your partner.",
      "Too large to send: the set you send for this linkage key holds 16,777,217 values, over the 16,777,216 one set can hold, so the exchange stopped before sending it and told your partner.",
      "Too large for your partner: the set you send for this linkage key holds 3 values, over the 2 your partner can receive in one PSI set, so the exchange stopped before sending it and told your partner.",
      "Alcove could not count the values the first linkage key gives you to send, so it cannot confirm one PSI set can hold them, and nothing was sent.",
      "Alcove could not count the values the first linkage key gives you to send, so it cannot confirm your partner can receive them, and the exchange stopped before any linkage key was sent and told your partner.",
    ]);
    expect(
      SAMPLES["single-pass-over-limit"].map((cause) =>
        failureCauseSentence(cause),
      ),
    ).toEqual([
      "This dataset is too large for single-pass linkage in a browser: 1,200,000 declared records across 3 linkage keys exceed the single-pass limit.",
      "This dataset is too large for single-pass linkage in a browser: 1 declared record across 1 linkage key exceed the single-pass limit.",
      "This dataset is too large for single-pass linkage: you declared 3 effective linkage keys across 2,000,000 records, which is 6,000,000 value slots, above the single-pass limit of 3,000,000 value slots per party in an exchange with a browser.",
      "This exchange is too large for single-pass linkage: your partner declared 3 effective linkage keys across 2,000,000 records, which is 6,000,000 value slots, above the single-pass limit of 3,000,000 value slots per party in an exchange with a browser, while your own 1,200,000 value slots are within it.",
      "This exchange is too large for single-pass linkage: you declared 3 effective linkage keys across 2,000,000 records, which is 6,000,000 value slots, and your partner declared 4 effective linkage keys across 1,000,000 records, which is 4,000,000 value slots, above the single-pass limit of 3,000,000 value slots per party in an exchange with a browser.",
      "The single-pass reply came to 70,000 bytes, above the 65,536 bytes one encrypted message can hold, so the exchange stopped and your partner was told.",
      "The single-pass request came to 70,001 bytes, above the 65,536 bytes one encrypted message can hold, so the exchange stopped and your partner was told.",
      "Too large to send: your records give more than 122,713,351 distinct linkage key values, the most one single-pass set can hold, so the exchange stopped before masking them and told your partner.",
    ]);
    expect(
      SAMPLES["matches-over-limit"].map((cause) => failureCauseSentence(cause)),
    ).toEqual([
      "This exchange found more matches than it can send, so it stopped and told your partner.",
      "This exchange found 9,000,000 matches, more than the 8,388,607 it can send, so it stopped and told your partner.",
      "This exchange found 1 match, more than the 0 it can send, so it stopped and told your partner.",
    ]);
    expect(
      SAMPLES["shared-secret-unusable"].map((cause) =>
        failureCauseSentence(cause),
      ),
    ).toEqual([
      "The key file's sharedSecret is not a base64url-encoded 32-byte value (43 base64url characters).",
      "The shared secret expired at 2026-07-08T19:32:00.000Z.",
      "The shared secret expired at 2026-07-08T19:32:00Z, before the next one was saved.",
    ]);
    expect(
      failureCauseSentence(SAMPLES["partner-stopped-at-matching"][0]),
    ).toBe("Matching could not start because your partner's run stopped.");
    expect(
      SAMPLES["message-write-unconfirmed"].map((cause) =>
        failureCauseSentence(cause),
      ),
    ).toEqual([
      "The message may or may not have reached the partner: renaming its file into place was cut off before the server answered and could not be confirmed afterwards.",
      "The message may or may not have reached the partner: its write did not complete.",
      "Cannot send: sequence number 4 was spent on a write the transport could not confirm, so the partner may already hold a message under it.",
    ]);
    expect(failureCauseSentence(SAMPLES["shared-name-at-entry"][0])).toBe(
      "The exchange directory holds a hello file with this side's name, so this run takes it for its own leftover.",
    );
    expect(failureCauseSentence(SAMPLES["key-exchange-timed-out"][0])).toBe(
      "Your partner did not answer in time during the key exchange.",
    );
  });

  test("the remedies the apps share for the run-ending refusals name no setting", () => {
    expect(PARTNER_STOPPED_AT_MATCHING_REMEDY).toBe(
      "Make sure you both run the current version of Alcove, then run the exchange again.",
    );
    expect(CLEAN_DIRECTORY_RESTART_REMEDY).toBe(
      "Re-run the exchange in a clean directory; both parties must start the new exchange fresh.",
    );
  });

  test("the single-pass remedy names the party whose data is over the limit", () => {
    const local =
      "Reduce the record count or split the dataset into smaller batches, " +
      "or agree on new terms with fewer linkage keys with your partner.";
    const fanOut =
      " Removing a step that splits values or expands a key also lowers the count.";
    expect(
      SAMPLES["single-pass-over-limit"].map((cause) =>
        singlePassOverLimitRemedy(cause),
      ),
    ).toEqual([
      local,
      local + fanOut,
      local + fanOut,
      "Ask your partner to reduce their record count or split their dataset. Your partner can also remove a step that splits values or expands a key.",
      `${local} Ask your partner to reduce their record count or split their dataset too.`,
      "To shrink it, either party can reduce its record count or split its dataset into smaller batches, or the two parties can agree on new terms with fewer linkage keys.",
      local,
      local,
    ]);
    expect(MATCHES_OVER_LIMIT_REMEDY).toBe(
      "This usually means many records on both sides share a key value. Use a more distinctive key or split the data into smaller batches.",
    );
  });

  test("the set-size remedy names the command-line application only for a first round over the partner's ceiling", () => {
    const split =
      "Split the input into smaller files and run one exchange for each.";
    expect(
      SAMPLES["set-over-limit"].map((cause) => setOverLimitRemedy(cause)),
    ).toEqual([
      split,
      split,
      split,
      `${split.slice(0, -1)}, or ask your partner to run the exchange with the command-line application.`,
      split,
      split,
      split,
      split,
    ]);
  });

  test("a set-size refusal is a RoundSetLimitError stating its sentence, its reason read from the limit", () => {
    const failure = new RangeError("Map maximum size exceeded");
    const [overMaximum, , , overCeiling] = SAMPLES["set-over-limit"];
    const uncounted = SAMPLES["set-over-limit"][6];
    const reasons = [overMaximum, overCeiling, uncounted].map((cause) => {
      const err = setOverLimitError(cause, { cause: failure });
      expect(err).toBeInstanceOf(RoundSetLimitError);
      expect(err.message).toBe(failureCauseSentence(cause));
      expect(err.cause).toBe(failure);
      expect(failureCauseOf(err)).toBe(cause);
      expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(true);
      return err.reason;
    });
    expect(reasons).toEqual([
      "over-set-maximum",
      "over-partner-ceiling",
      "uncounted",
    ]);
  });

  test("the registrar remedy names no setting or file for any class", () => {
    expect(
      SAMPLES["relay-registrar-unreachable"].map((cause) =>
        relayRegistrarUnreachableRemedy(cause),
      ),
    ).toEqual([
      "This computer needs outbound access to relay.example.org on TCP port 8443: if this network allows only some ports out, have that port opened or run from a network that allows it.",
      "This computer needs outbound access to relay.example.org on TCP port 8443: if this network allows only some ports out, have that port opened or run from a network that allows it.",
      "Check the registrar address this exchange is configured with and that this computer's DNS resolves relay.example.org, then run again.",
      "The registrar did not complete the request: ask whoever runs the relay to check that its registrar is running and reachable from this network, then run again.",
      "The registrar did not complete the request: ask whoever runs the relay to check that its registrar is running and reachable from this network, then run again.",
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

describe("formatFileAge", () => {
  test.each([
    [-5_000, "0 seconds"],
    [999, "0 seconds"],
    [59_999, "59 seconds"],
    [60_000, "1 minute"],
    [119_999, "1 minute"],
    [3 * 3_600_000 + 59_999, "3 hours"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatFileAge(ms)).toBe(text);
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

describe("failureCauseFromUntrusted", () => {
  test("lists every kind the catalog declares", () => {
    expect([...FAILURE_CAUSE_KINDS].sort()).toEqual(
      Object.keys(SAMPLES).sort(),
    );
  });

  test.each(allSamples.map((cause) => [JSON.stringify(cause), cause]))(
    "rebuilds %s unchanged",
    (_, cause) => {
      expect(failureCauseFromUntrusted(cause)).toEqual(cause);
    },
  );

  test("keeps the facts its kind holds and drops every other key", () => {
    expect(
      failureCauseFromUntrusted({
        kind: "partner-never-arrived",
        channel: "filedrop",
        path: "/elsewhere",
        extra: { nested: true },
      }),
    ).toEqual({ kind: "partner-never-arrived", channel: "filedrop" });
  });

  test("rebuilds an uncounted set-size cause from its stage and limit alone", () => {
    expect(
      failureCauseFromUntrusted({
        kind: "set-over-limit",
        stage: "after-terms",
        limit: "uncounted",
        valueCount: 12,
        scope: "first-key",
      }),
    ).toEqual({
      kind: "set-over-limit",
      stage: "after-terms",
      limit: "uncounted",
    });
  });

  test("rebuilds an ignored hello from its age and window alone", () => {
    expect(
      failureCauseFromUntrusted({
        kind: "partner-never-arrived",
        ignoredHello: { ageMs: 120_000, windowMs: 60_000, name: "p1-hello" },
      }),
    ).toEqual({
      kind: "partner-never-arrived",
      ignoredHello: { ageMs: 120_000, windowMs: 60_000 },
    });
  });

  // An older build rebuilt this kind from channel and waitedMs alone, so the
  // shared-name fact it did not know was dropped with the cause kept; a fact
  // added after this build is dropped the same way.
  test("drops a fact added after this build and keeps the cause", () => {
    expect(
      failureCauseFromUntrusted({
        kind: "partner-never-arrived",
        channel: "sftp",
        waitedMs: 90_000,
        sharedName: true,
        laterFact: "unknown to this build",
      }),
    ).toEqual({
      kind: "partner-never-arrived",
      channel: "sftp",
      waitedMs: 90_000,
      sharedName: true,
    });
  });

  test.each([
    ["an unknown kind", { kind: "partner-refused" }],
    ["a kind of the wrong type", { kind: 1 }],
    ["no kind", { channel: "filedrop" }],
    ["an inherited kind name", { kind: "toString" }],
    [
      "a channel off the list",
      { kind: "partner-never-arrived", channel: "carrier-pigeon" },
    ],
    ["a negative wait", { kind: "partner-never-arrived", waitedMs: -1 }],
    ["a fractional wait", { kind: "partner-never-arrived", waitedMs: 1.5 }],
    ["a wait as text", { kind: "partner-never-arrived", waitedMs: "90000" }],
    [
      "a shared name stated false",
      { kind: "partner-never-arrived", sharedName: false },
    ],
    [
      "a shared name as text",
      { kind: "partner-never-arrived", sharedName: "true" },
    ],
    [
      "an ignored hello stated true",
      { kind: "partner-never-arrived", ignoredHello: true },
    ],
    [
      "an ignored hello as a list",
      { kind: "partner-never-arrived", ignoredHello: [1, 2] },
    ],
    [
      "an ignored hello with no window",
      { kind: "partner-never-arrived", ignoredHello: { ageMs: 1 } },
    ],
    [
      "an ignored hello with a negative age",
      {
        kind: "partner-never-arrived",
        ignoredHello: { ageMs: -1, windowMs: 1 },
      },
    ],
    [
      "an ignored hello with a fractional window",
      {
        kind: "partner-never-arrived",
        ignoredHello: { ageMs: 1, windowMs: 0.5 },
      },
    ],
    ["a folder with no path", { kind: "folder-missing", code: "ENOENT" }],
    [
      "a folder code off the list",
      { kind: "folder-missing", path: "/data", code: "EACCES" },
    ],
    [
      "a registrar with no host",
      {
        kind: "relay-registrar-unreachable",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar host that is empty",
      {
        kind: "relay-registrar-unreachable",
        host: "",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar host that is not text",
      {
        kind: "relay-registrar-unreachable",
        host: 7,
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port of zero",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 0,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port past 65535",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 65536,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a fractional registrar port",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443.5,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port as text",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: "443",
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar failure class off the list",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "refused",
        code: "ECONNREFUSED",
      },
    ],
    [
      "a registrar with no failure class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        code: "ECONNREFUSED",
      },
    ],
    [
      "a no-connection code from another class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-connection",
        code: "ENOTFOUND",
      },
    ],
    [
      "a name-not-resolved code from another class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "name-not-resolved",
        code: "ECONNREFUSED",
      },
    ],
    [
      "a no-answer code off the list",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        code: "ETIMEDOUT",
      },
    ],
    [
      "a no-answer with both a code and a timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        code: "ECONNRESET",
        timedOutMs: 1,
      },
    ],
    [
      "a no-answer with neither a code nor a timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
      },
    ],
    [
      "a fractional registrar timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1.5,
      },
    ],
    [
      "a negative registrar timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        timedOutMs: -1,
      },
    ],
    [
      "a set-size cause with no stage",
      { kind: "set-over-limit", limit: "uncounted" },
    ],
    [
      "a set-size stage off the list",
      { kind: "set-over-limit", stage: "mid-round", limit: "uncounted" },
    ],
    [
      "a set-size limit off the list",
      { kind: "set-over-limit", stage: "in-round", limit: "memory" },
    ],
    [
      "a set-size count with no limit figure",
      {
        kind: "set-over-limit",
        stage: "in-round",
        limit: "set-maximum",
        valueCount: 3,
      },
    ],
    [
      "a fractional set-size count",
      {
        kind: "set-over-limit",
        stage: "in-round",
        limit: "partner-ceiling",
        valueCount: 3.5,
        limitValues: 2,
      },
    ],
    [
      "a set-size scope off the list",
      {
        kind: "set-over-limit",
        stage: "after-terms",
        limit: "set-maximum",
        valueCount: 3,
        limitValues: 2,
        scope: "every-round",
      },
    ],
    [
      "a single-pass limit off the list",
      { kind: "single-pass-over-limit", limit: "memory", limitValues: 1 },
    ],
    [
      "a browser dataset with no key count",
      {
        kind: "single-pass-over-limit",
        limit: "browser-dataset",
        recordCount: 1,
      },
    ],
    [
      "a browser dataset whose fan-out is false",
      {
        kind: "single-pass-over-limit",
        limit: "browser-dataset",
        recordCount: 1,
        linkageKeyCount: 1,
        fansOut: false,
      },
    ],
    [
      "a value-slot count no party breaches",
      {
        kind: "single-pass-over-limit",
        limit: "value-slots",
        local: { effectiveKeyCount: 1, recordCount: 2 },
        partner: { effectiveKeyCount: 1, recordCount: 2 },
        limitSlots: 2,
      },
    ],
    [
      "a value-slot party with a negative record count",
      {
        kind: "single-pass-over-limit",
        limit: "value-slots",
        local: { effectiveKeyCount: 1, recordCount: -3 },
        partner: { effectiveKeyCount: 1, recordCount: 3 },
        limitSlots: 2,
      },
    ],
    [
      "a value-slot party as a list",
      {
        kind: "single-pass-over-limit",
        limit: "value-slots",
        local: [1, 3],
        partner: { effectiveKeyCount: 1, recordCount: 3 },
        limitSlots: 2,
      },
    ],
    [
      "a single-pass frame off the list",
      {
        kind: "single-pass-over-limit",
        limit: "frame",
        frame: "table",
        frameBytes: 2,
        limitBytes: 1,
      },
    ],
    [
      "a fractional distinct-value limit",
      {
        kind: "single-pass-over-limit",
        limit: "distinct-values",
        limitValues: 1.5,
      },
    ],
    [
      "a matched list off the list",
      { kind: "matches-over-limit", list: "pairs" },
    ],
    [
      "a resolved table with no limit figure",
      { kind: "matches-over-limit", list: "resolved", matchCount: 3 },
    ],
    [
      "a shared-secret problem off the list",
      { kind: "shared-secret-unusable", problem: "revoked" },
    ],
    [
      "an expired secret with an empty expiry",
      {
        kind: "shared-secret-unusable",
        problem: "expired",
        expires: "",
        stage: "before-handshake",
      },
    ],
    [
      "an expired secret with a numeric expiry",
      {
        kind: "shared-secret-unusable",
        problem: "expired",
        expires: 1_783_539_120_000,
        stage: "before-handshake",
      },
    ],
    [
      "an expired secret with no stage",
      {
        kind: "shared-secret-unusable",
        problem: "expired",
        expires: "2026-07-08T19:32:00Z",
      },
    ],
    [
      "a message write failure off the list",
      { kind: "message-write-unconfirmed", failure: "write-refused" },
    ],
    [
      "a spent sequence number with no number",
      { kind: "message-write-unconfirmed", failure: "sequence-spent" },
    ],
    [
      "a negative spent sequence number",
      { kind: "message-write-unconfirmed", failure: "sequence-spent", seq: -1 },
    ],
    ["an array", ["partner-never-arrived"]],
    ["a string", "partner-never-arrived"],
    ["null", null],
  ])("refuses %s", (_, value) => {
    expect(failureCauseFromUntrusted(value)).toBeUndefined();
  });
});
