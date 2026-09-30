import { describe, expect, test } from "vitest";

import { disclosedColumnNames } from "@alcove/core";

import { acceptorServerJobConfig } from "@exchange/useAcceptorExchange";

import type {
  InvitationToken,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@alcove/core";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";

// The inviter-perspective terms an accepted invitation holds: the inviter is
// the identity, it SENDS `program_code` and REQUESTS nothing back, and it shares
// the result with the acceptor. The acceptor's server-job config must run on the
// MIRROR of these, not this raw set.
const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: false, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
  payload: {
    send: [{ name: "program_code" }],
  },
};

const token: InvitationToken = {
  version: "1",
  linkageTerms: inviterTerms,
  sharedSecret: "a".repeat(43),
};

// The acceptor's OWN authored column metadata (its own CSV namespace). `secret`
// is roled `ignored`, and `notes` is a plain payload column the operator chose to
// disclose. This is the operator's data-prep edit the server-job path must hold
// so the console's CLI honors it rather than inferring metadata from the column
// names -- inference would default the unrecognized `secret` column to disclosed
// payload.
const editedMetadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "notes", type: "other", role: "payload", isPayload: true },
  { name: "secret", type: "other", role: "ignored", isPayload: true },
];

const editedStandardization: Standardization = [
  {
    output: "firstName",
    input: "first_name",
    steps: [{ function: "trim" }, { function: "to_lowercase" }],
  },
];

const edits: AcceptorDataEdits = {
  metadata: editedMetadata,
  standardization: editedStandardization,
};

const inputCsv = "first_name,last_name,notes,secret\nAlice,Smith,hi,shh\n";

function configFor() {
  return acceptorServerJobConfig({
    deduplicate: false,
    token,
    acceptorName: "Accepting Org",
    edits,
    inputSource: { kind: "inline", csv: inputCsv },
    transport: { channel: "filedrop" },
  });
}

describe("acceptorServerJobConfig includes the party's own field delimiter", () => {
  // The accepting seat offers the same control the inviting one does, and the
  // console runs the accept from a config composed at a separate invocation, so a
  // choice held only in the browser would read the mounted file with commas.
  test("holds the operator's choice for the driver to state in the intent", () => {
    const config = acceptorServerJobConfig({
      deduplicate: false,
      token,
      acceptorName: "Accepting Org",
      edits,
      inputSource: { kind: "inline", csv: inputCsv },
      transport: { channel: "filedrop" },
      csvDelimiter: ";",
    });
    expect(config.csvDelimiter).toBe(";");
  });

  test("holds none when the operator named none", () => {
    expect(configFor().csvDelimiter).toBeUndefined();
  });
});

describe("acceptorServerJobConfig", () => {
  test("runs on the acceptor's OWN-PERSPECTIVE derived terms, not the raw inviter terms", () => {
    const config = configFor();

    // Identity is the acceptor's, not the inviter's.
    expect(config.linkageTerms.identity).toBe("Accepting Org");
    expect(config.linkageTerms.identity).not.toBe(inviterTerms.identity);
    // Output direction is mirrored: the inviter does not expect output but shares,
    // so the acceptor expects output and does not share.
    expect(config.linkageTerms.output).toStrictEqual({
      expectsOutput: true,
      shareWithPartner: false,
    });
  });

  test("mirrors the payload so `receive` is the inviter's declared `send`", () => {
    const config = configFor();

    // The derive-mirror puts the inviter's declared send into the acceptor's
    // payload.receive, which the terms exchange compares against the send set
    // the inviter states there.
    expect(config.linkageTerms.payload?.receive).toEqual([
      { name: "program_code" },
    ]);
  });

  test("has the acceptor's inline CSV source and the token's shared secret verbatim", () => {
    const config = configFor();

    expect(config.inputSource).toEqual({ kind: "inline", csv: inputCsv });
    expect(config.sharedSecret).toBe(token.sharedSecret);
  });

  test("threads a console workFile reference through as the input source verbatim", () => {
    // The console accept sources from the operator-mounted file: the driver config
    // has only the reference (name + profiled freshness pair), never content, so
    // the console's create can resolve and freshness-check the mounted file.
    const workFile = {
      kind: "workFile" as const,
      name: "clients.csv",
      sizeBytes: 4096,
      modifiedAt: 1_700_000_000_000,
    };
    const config = acceptorServerJobConfig({
      deduplicate: false,
      token,
      acceptorName: "Accepting Org",
      edits,
      inputSource: workFile,
      transport: { channel: "filedrop" },
    });
    expect(config.inputSource).toEqual(workFile);
  });

  test("rides the transport it is given (filedrop)", () => {
    expect(configFor().transport).toEqual({ channel: "filedrop" });
  });

  test("rides the sftp transport for an accepted SFTP endpoint", () => {
    // The console SFTP accept runs the same server job on the sftp intent arm; the
    // arm has no connection field (the console reads the operator-authored
    // connection off GET /api/jobs/sftp), so only the channel changes here.
    const config = acceptorServerJobConfig({
      deduplicate: false,
      token,
      acceptorName: "Accepting Org",
      edits,
      inputSource: { kind: "inline", csv: inputCsv },
      transport: { channel: "sftp" },
    });
    expect(config.transport).toEqual({ channel: "sftp" });
    // Everything below the transport discriminant is channel-independent: the
    // derived own-perspective terms are identical.
    expect(config.linkageTerms.identity).toBe("Accepting Org");
    expect(config.linkageTerms.payload?.receive).toEqual([
      { name: "program_code" },
    ]);
  });

  test("has the operator's authored metadata and standardization edits", () => {
    const config = configFor();

    expect(config.metadata).toEqual(editedMetadata);
    expect(config.standardization).toEqual(editedStandardization);
  });

  test("an operator-ignored column is NOT disclosed on the server-job path", () => {
    // The actual disclosure gap this slice closes: without the provided metadata
    // the console's CLI would infer `secret` as an unrecognized column and
    // default it to disclosed payload. The provided metadata roles it `ignored`, so
    // isDisclosedToPartner excludes it -- the single source of truth for what
    // leaves the machine. `notes`, a real payload column, is still disclosed.
    const config = configFor();
    const disclosed = disclosedColumnNames(config.metadata ?? []);
    expect(disclosed).toContain("notes");
    expect(disclosed).not.toContain("secret");
  });

  test("states the acceptor side", () => {
    expect(configFor().side).toBe("acceptor");
  });
});

// The terms-side commitment the console acceptor must hold: the console runs
// `alcove exchange` at a separate invocation, so a binding the browser held only
// in memory would bind nothing there. The value is the invitation's declaration for
// the INVITER's side, never read off the acceptor's derived mirror.
describe("acceptorServerJobConfig terms-side commitment", () => {
  function configWithDeclared(declared: boolean) {
    return acceptorServerJobConfig({
      deduplicate: false,
      token: {
        ...token,
        linkageTerms: { ...inviterTerms, deduplicate: declared },
      },
      acceptorName: "Accepting Org",
      edits,
      inputSource: { kind: "inline", csv: inputCsv },
      transport: { channel: "filedrop" },
    });
  }

  test("has the invitation's declared deduplicate, not the derived mirror", () => {
    for (const declared of [false, true]) {
      const config = configWithDeclared(declared);
      expect(config.expectedPartnerDeduplicate).toBe(declared);
      // The composed run's own terms are the mirror's false whatever the inviter
      // declared, so reading the binding off them would bind the wrong value.
      expect(config.linkageTerms.deduplicate).toBe(false);
    }
  });
});

describe("the accepting party's own deduplicate in the composed job config", () => {
  test.each([false, true])(
    "rides the terms the console hands the CLI (invitation declares %s)",
    (declared) => {
      // The console runs this config through `alcove exchange` at a separate
      // invocation, so a value held only in the browser would reach no run. It
      // travels on the acceptor's own-perspective terms; the binding on the
      // PARTNER's value stays the invitation's own declaration.
      const config = acceptorServerJobConfig({
        deduplicate: true,
        token: {
          ...token,
          linkageTerms: { ...inviterTerms, deduplicate: declared },
        },
        acceptorName: "Accepting Org",
        edits,
        inputSource: { kind: "inline", csv: inputCsv },
        transport: { channel: "filedrop" },
      });
      expect(config.linkageTerms.deduplicate).toBe(true);
      expect(config.expectedPartnerDeduplicate).toBe(declared);
    },
  );

  test("an omitted control leaves the composed terms one-to-one on this side", () => {
    expect(configFor().linkageTerms.deduplicate).toBe(false);
  });
});
