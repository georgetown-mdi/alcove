import {
  MAX_TEXT_LENGTH,
  connectionFromLocator,
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM,
  buildManagedDeposit,
  composeManagedDocument,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
  retentionNoteError,
  retentionNoteValue,
  webrtcLocatorFromEndpoint,
} from "@exchange/manageOfferModel";
import { RETENTION_NOTE_PROBLEM } from "@psi/receiptsModel";

import type { ColumnMetadata, WebRTCEndpoint } from "@alcove/core";

import type {
  ManagedDepositInputs,
  ManagedExchangeDocumentParts,
} from "@exchange/manageOfferModel";

// The inviter's own signaling location (window.location-derived) is already the
// invitation's endpoint shape; the acceptor's endpoint is the invitation's own.
const inviterEndpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

// The acceptor composes from THIS endpoint (the inviter's signaling location
// held in the invitation), not from its own browser location.
const invitationEndpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "inviter.example.net",
  port: 8443,
  path: "/api/",
};

/** `name` declared as a column sent to the partner. */
function sentColumn(name: string): ColumnMetadata {
  return { name, type: "other", role: "payload", isPayload: true };
}

// ssn/first_name/last_name/dob infer matching keys; program_code is not in the
// alias map, so it is declared as sent -- a non-trivial published set for the
// inviter deposit to hold.
const keyColumns = ["ssn", "first_name", "last_name", "dob"];
const inviterMetadata = [
  ...inferMetadata(keyColumns, []),
  sentColumn("program_code"),
];
const inviterTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inviterMetadata,
);

function depositInputs(
  overrides: Partial<ManagedDepositInputs> = {},
): ManagedDepositInputs {
  return {
    documentParts: {
      side: "inviter",
      linkageTerms: inviterTerms,
      metadata: inviterMetadata,
    },
    connection: webrtcLocatorFromEndpoint(inviterEndpoint),
    rotatedSecret: generateSharedSecret(),
    choices: { label: "Riverbend quarterly" },
    ...overrides,
  };
}

describe("webrtcLocatorFromEndpoint", () => {
  test("re-shapes a webrtc endpoint into a credential-free locator", () => {
    expect(webrtcLocatorFromEndpoint(inviterEndpoint)).toEqual({
      channel: "webrtc",
      host: "signaling.example.org",
      port: 3000,
      path: "/api/",
    });
  });

  test("drops an absent optional rather than holding an explicit undefined", () => {
    const bare: WebRTCEndpoint = { channel: "webrtc", host: "peer.example" };
    const locator = webrtcLocatorFromEndpoint(bare);
    expect(locator).not.toHaveProperty("port");
    expect(locator).not.toHaveProperty("path");
    // The composer's strict parse must accept it, so an absent optional cannot be
    // an explicit `undefined` key.
    expect(() =>
      composeManagedDocument(
        { side: "inviter", linkageTerms: inviterTerms },
        locator,
      ),
    ).not.toThrow();
  });

  test("keeps the invitation's relay, which the acceptor's record holds as invitationRelay", () => {
    const relay = {
      turn: ["turns:relay.example.org:443?transport=tcp"],
      stun: ["stun:relay.example.org:3478"],
    };
    const locator = webrtcLocatorFromEndpoint({ ...invitationEndpoint, relay });
    expect(locator).toMatchObject({ relay });
    const doc = composeManagedDocument(
      { side: "acceptor", linkageTerms: inviterTerms },
      locator,
    );
    expect(doc.connection).toMatchObject({ invitationRelay: relay });
    expect(doc.connection).not.toHaveProperty("turn");
  });

  test("an invitation naming no relay leaves the record without one", () => {
    const doc = composeManagedDocument(
      { side: "acceptor", linkageTerms: inviterTerms },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    expect(doc.connection).not.toHaveProperty("invitationRelay");
  });
});

describe("composeManagedDocument", () => {
  test("composes a credential-free webrtc document with no authentication block", () => {
    const doc = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(inviterEndpoint)),
    );
    expect(doc.authentication).toBeUndefined();
    // No credential is representable: the webrtc server holds only host/port/path.
    expect(JSON.stringify(doc)).not.toContain("username");
    expect(JSON.stringify(doc)).not.toContain('"key"');
  });

  test("holds the caller's terms-side commitment verbatim, absent when none binds", () => {
    // The declaration is the token's, never re-derived from the terms composed
    // beside it: an acceptor's own `deduplicate` is the mirror's false whatever
    // the inviter declared, so deriving it here would bind the wrong value.
    for (const declared of [false, true]) {
      const doc = composeManagedDocument(
        {
          side: "acceptor",
          linkageTerms: deriveAcceptedLinkageTerms(inviterTerms, "Clinic A"),
          expectedPartnerDeduplicate: declared,
        },
        webrtcLocatorFromEndpoint(inviterEndpoint),
      );
      expect(doc.expectedPartnerDeduplicate).toBe(declared);
      expect(doc.linkageTerms.deduplicate).toBe(false);
    }
    const none = composeManagedDocument(
      { side: "inviter", linkageTerms: inviterTerms },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(none).not.toHaveProperty("expectedPartnerDeduplicate");
  });
});

// The acceptor's own perspective of the inviter's terms: identity replaced,
// output and payload mirrored -- what the accept flow composes its document from.
const acceptedTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");
// The acceptor's own file: ssn/first_name/last_name/dob infer linkage columns and
// visit_id is declared as sent, so the set it would send is non-empty and derived
// from the metadata.
const acceptorMetadataFixture = [
  ...inferMetadata(keyColumns, []),
  sentColumn("visit_id"),
];

describe("buildManagedDeposit (inviter)", () => {
  test("deposits side inviter with the run's rotated secret and composed document", () => {
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      depositInputs({ rotatedSecret: secret }),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit.side).toBe("inviter");
    expect(deposit.sharedSecret).toBe(secret);
    expect(deposit.exchangeFile.connection.channel).toBe("webrtc");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
    expect(deposit.label).toBe("Riverbend quarterly");
  });

  test("holds no folder grant and no schedule: both are taken on the exchange's page", () => {
    // The unattended runner fires on a record holding BOTH a schedule and a
    // working folder. The deposit writes neither -- the offer takes no folder
    // and has no schedule to make -- so this path cannot assemble that pair;
    // the import path, which can hold a schedule and reconstructs no handle, is
    // its converse (test/unit/psi/managedExchangeImport.test.ts).
    const deposit = buildManagedDeposit(
      depositInputs(),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit).not.toHaveProperty("workingDirectoryHandle");
    expect(deposit).not.toHaveProperty("schedule");
  });

  test("tokenMaxAgeDays and expires are absent unless the operator opts in", () => {
    const deposit = buildManagedDeposit(
      depositInputs(),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit).not.toHaveProperty("tokenMaxAgeDays");
    expect(deposit).not.toHaveProperty("expires");
  });

  test("an opted-in max age stamps expires N days out (not the invitation lifetime)", () => {
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const deposit = buildManagedDeposit(
      depositInputs({ choices: { label: "labelled", tokenMaxAgeDays: 30 } }),
      now,
    );
    expect(deposit.tokenMaxAgeDays).toBe(30);
    // The stamp is now + 30 days, from the max-age policy alone; the invitation's
    // setup lifetime never flows into the record's expires.
    expect(deposit.expires).toBe(new Date(now + 30 * 86_400_000).toISOString());
  });
});

describe("buildManagedDeposit (acceptor)", () => {
  const acceptorMetadata = acceptorMetadataFixture;
  // The acceptor's own perspective: identity replaced, output/payload mirrored.
  const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");

  function acceptorDeposit(declaredDeduplicate?: boolean) {
    return buildManagedDeposit(
      {
        documentParts: {
          side: "acceptor",
          linkageTerms: acceptorTerms,
          metadata: acceptorMetadata,
          ...(declaredDeduplicate !== undefined
            ? { expectedPartnerDeduplicate: declaredDeduplicate }
            : {}),
        },
        connection: webrtcLocatorFromEndpoint(invitationEndpoint),
        rotatedSecret: generateSharedSecret(),
        choices: { label: "Clinic A partnership" },
      },
      Date.now(),
    );
  }

  test("deposits side acceptor composing from the invitation endpoint and derived terms", () => {
    const deposit = acceptorDeposit();
    expect(deposit.side).toBe("acceptor");
    // The connection block is composed from the INVITATION's endpoint.
    expect(deposit.exchangeFile.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(invitationEndpoint)),
    );
    expect(deposit.exchangeFile.linkageTerms.identity).toBe("Clinic A");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
  });

  test("commits the token's declared deduplicate for later re-runs", () => {
    // A managed re-run runs from this document alone, with no token in hand, so
    // the declaration the acceptance consented to has to be in it or every re-run
    // after the one-shot runs unbound.
    for (const declared of [false, true]) {
      const deposit = acceptorDeposit(declared);
      expect(deposit.exchangeFile.expectedPartnerDeduplicate).toBe(declared);
    }
  });
});

// The record's side and the document both come from the one `side` in the
// deposit's parts, which is the single statement each screen makes at its
// deposit call.
describe("the deposit's side and its document", () => {
  const connection = webrtcLocatorFromEndpoint(invitationEndpoint);

  function depositFor(parts: ManagedExchangeDocumentParts) {
    return buildManagedDeposit(
      {
        documentParts: parts,
        connection,
        rotatedSecret: generateSharedSecret(),
        choices: { label: "Clinic A partnership" },
      },
      Date.now(),
    );
  }

  const acceptorParts: ManagedExchangeDocumentParts = {
    side: "acceptor",
    linkageTerms: acceptedTerms,
    metadata: acceptorMetadataFixture,
  };

  test("an acceptor deposit stores side acceptor", () => {
    const deposit = depositFor(acceptorParts);
    expect(deposit.side).toBe("acceptor");
  });

  test("an inviter deposit stores side inviter", () => {
    const deposit = depositFor({ ...acceptorParts, side: "inviter" });
    expect(deposit.side).toBe("inviter");
  });

  test("the stored document is what the parts compose", () => {
    const deposit = depositFor(acceptorParts);
    expect(deposit.exchangeFile).toEqual(
      composeManagedDocument(acceptorParts, connection),
    );
  });
});

describe("the label cap", () => {
  test("labelWithinCap accepts a label at the cap and rejects one past it", () => {
    expect(labelWithinCap("x".repeat(MAX_LABEL_LENGTH))).toBe(true);
    expect(labelWithinCap("x".repeat(MAX_LABEL_LENGTH + 1))).toBe(false);
    expect(labelWithinCap("")).toBe(true);
  });

  test("buildManagedDeposit produces a record the store's cap accepts, and rejects an over-long one", () => {
    const atCap = "x".repeat(MAX_LABEL_LENGTH);
    expect(() =>
      buildManagedDeposit(
        depositInputs({ choices: { label: atCap } }),
        Date.now(),
      ),
    ).not.toThrow();
    // The deposit itself does not throw on an over-long label (the store's build
    // enforces the cap), but the field holds it verbatim for that check.
    const overCap = "x".repeat(MAX_LABEL_LENGTH + 1);
    const deposit = buildManagedDeposit(
      depositInputs({ choices: { label: overCap } }),
      Date.now(),
    );
    expect(deposit.label.length).toBe(MAX_LABEL_LENGTH + 1);
    expect(labelWithinCap(deposit.label)).toBe(false);
  });
});

describe("maxAgeCadenceNote", () => {
  test("names the cadence implication when a policy is set", () => {
    const note = maxAgeCadenceNote(30);
    expect(note).toContain("30 days");
    expect(note).toContain("run or be renewed");
  });

  test("singularizes one day", () => {
    expect(maxAgeCadenceNote(1)).toContain("1 day");
    expect(maxAgeCadenceNote(1)).not.toContain("1 days");
  });

  test("returns undefined when no policy is set (the default)", () => {
    expect(maxAgeCadenceNote(undefined)).toBeUndefined();
  });
});

describe("maxAgeDaysError", () => {
  test("accepts a positive whole day count up to the schema's cap", () => {
    expect(maxAgeDaysError(1)).toBeUndefined();
    expect(maxAgeDaysError(90)).toBeUndefined();
    expect(maxAgeDaysError(MAX_TOKEN_MAX_AGE_DAYS)).toBeUndefined();
  });

  test("rejects a cleared field (the input reports a string), not silently no-bound", () => {
    expect(maxAgeDaysError("")).toBeDefined();
    expect(maxAgeDaysError("12.")).toBeDefined();
  });

  test("rejects zero, negatives, and fractions", () => {
    expect(maxAgeDaysError(0)).toBeDefined();
    expect(maxAgeDaysError(-7)).toBeDefined();
    expect(maxAgeDaysError(2.5)).toBeDefined();
  });

  test("rejects a value past the record schema's cap, naming the bound", () => {
    const error = maxAgeDaysError(MAX_TOKEN_MAX_AGE_DAYS + 1);
    expect(error).toContain(String(MAX_TOKEN_MAX_AGE_DAYS));
  });
});

describe("the retention note at setup", () => {
  const note = "Filed with the program office for seven years.";

  test("a note the operator writes lands in the deposited document", () => {
    const deposit = buildManagedDeposit(
      depositInputs({
        choices: { label: "Riverbend quarterly", retentionDisposition: note },
      }),
      Date.now(),
    );
    expect(deposit.exchangeFile.retentionDisposition).toBe(note);
  });

  test("no note deposits a document without the field", () => {
    const deposit = buildManagedDeposit(depositInputs(), Date.now());
    expect(deposit.exchangeFile).not.toHaveProperty("retentionDisposition");
  });

  test("the note is trimmed, and a blank one is no note", () => {
    expect(retentionNoteValue(`  ${note}\n`)).toBe(note);
    expect(retentionNoteValue(" \n ")).toBeUndefined();
  });

  test("a note within the document's bound, line breaks and tabs included, is admitted", () => {
    expect(retentionNoteError("")).toBeUndefined();
    expect(retentionNoteError("Filed:\tdb\r\nKept six years.")).toBeUndefined();
    expect(retentionNoteError("x".repeat(MAX_TEXT_LENGTH))).toBeUndefined();
  });

  test("a note past the bound or holding a control character is refused", () => {
    expect(retentionNoteError("x".repeat(MAX_TEXT_LENGTH + 1))).toBe(
      RETENTION_NOTE_PROBLEM,
    );
    expect(retentionNoteError("Filed\u0000")).toBe(
      RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM,
    );
  });
});

describe("the label guidance", () => {
  test("directs the operator to keep sensitive counterparty detail out", () => {
    expect(LABEL_GUIDANCE).toContain("Name the partnership");
    expect(LABEL_GUIDANCE.toLowerCase()).toContain("never sent");
  });

  test("names every place the label reaches", () => {
    const guidance = LABEL_GUIDANCE.toLowerCase();
    expect(guidance).toContain("this browser's storage");
    expect(guidance).toContain("anyone reading it can see");
    expect(guidance).toContain("name of every results file");
    expect(guidance).toContain("folder you grant");
    expect(guidance).toContain("copy you download");
    expect(guidance).toContain("between-visit notifications");
    expect(guidance).toContain("locked screen");
  });
});
