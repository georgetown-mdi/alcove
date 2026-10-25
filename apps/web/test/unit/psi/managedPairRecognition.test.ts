import { describe, expect, test } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { decideCommandLinePairTarget } from "@psi/managed/managedPairRecognition";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// Where a command-line pair lands once no stored record holds its secret. The
// store makes the decision inside its transaction; the transaction itself,
// against real IndexedDB, is the browser suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function runnable(
  side: ManagedExchangeSide = "inviter",
  label = "Riverbend quarterly",
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord({
      label,
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side,
      sharedSecret: generateSharedSecret(),
    }),
  );
}

/** A configuration-only record on the same terms: what an alcove.yaml
 * imported without its key file installs. */
function configurationOnly(
  side: ManagedExchangeSide = "inviter",
): ManagedExchangeRecord {
  const { sharedSecret: _secret, ...rest } = runnable(side, "");
  return rest;
}

/** `record` on other agreed terms. */
function onOtherTerms(record: ManagedExchangeRecord): ManagedExchangeRecord {
  return {
    ...record,
    exchangeFile: {
      ...record.exchangeFile,
      linkageTerms: {
        ...linkageTerms,
        linkageKeys: linkageTerms.linkageKeys.slice(1),
      },
    },
  };
}

describe("a pair whose secret no stored record holds", () => {
  test("a configuration-only record with equal terms and side is offered, then completed in place", () => {
    const stored = configurationOnly();
    const imported = runnable();

    expect(decideCommandLinePairTarget([stored], imported)).toEqual({
      kind: "stored-copy",
      copies: [{ id: stored.id, label: "", state: "configuration-only" }],
    });
    expect(
      decideCommandLinePairTarget([stored], imported, { into: stored.id }),
    ).toEqual({ kind: "complete", into: stored });
  });

  test("declined, installs the pair as a new record", () => {
    const stored = configurationOnly();

    expect(
      decideCommandLinePairTarget([stored], runnable(), {
        besideIds: [stored.id],
      }),
    ).toEqual({ kind: "no-match" });
  });

  test("unequal terms or side offer nothing, and the pair installs fresh", () => {
    const imported = runnable("inviter");
    for (const stored of [
      configurationOnly("acceptor"),
      onOtherTerms(configurationOnly()),
    ])
      expect(decideCommandLinePairTarget([stored], imported)).toEqual({
        kind: "no-match",
      });
  });

  test("a runnable record with equal terms and side is not offered", () => {
    expect(decideCommandLinePairTarget([runnable()], runnable())).toEqual({
      kind: "no-match",
    });
  });

  test("names every qualifying record, less those declined", () => {
    const first = configurationOnly();
    const second = configurationOnly();
    const records = [first, runnable(), second];

    expect(decideCommandLinePairTarget(records, runnable())).toMatchObject({
      kind: "stored-copy",
      copies: [{ id: first.id }, { id: second.id }],
    });
    expect(
      decideCommandLinePairTarget(records, runnable(), {
        besideIds: [first.id],
      }),
    ).toMatchObject({ kind: "stored-copy", copies: [{ id: second.id }] });
  });

  test("a chosen record that no longer qualifies is refused rather than installed beside", () => {
    const stored = configurationOnly();

    for (const records of [
      [],
      [runnableManagedExchangeOrRefuse({ ...runnable(), id: stored.id })],
      [{ ...configurationOnly("acceptor"), id: stored.id }],
    ])
      expect(
        decideCommandLinePairTarget(records, runnable(), { into: stored.id }),
      ).toEqual({ kind: "chosen-copy-changed" });
  });
});
