import { expect, test } from "vitest";
import { UsageError } from "@alcove/core";

import { decodeAndValidateInvitation } from "../../src/invitationDecode";
import { encodeRawInvitation } from "../support";

// A partner-crafted invitation whose count-only terms declare a candidate set:
// a `split_on` fan-out on the key's only element. No count-only round resolves
// one, so the exchange it invites cannot run.
function unrunnableInvitation(): Promise<string> {
  return encodeRawInvitation({
    version: "1",
    linkageTerms: {
      version: "1.0.0",
      identity: "Partner Authored Identity",
      date: "2025-01-01",
      algorithm: "psi-c",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: false },
      deduplicate: false,
      linkageFields: [{ name: "partner_given", type: "first_name" }],
      linkageKeys: [
        {
          name: "Partner Key Name",
          elements: [
            {
              field: "partner_given",
              transform: [{ function: "split_on", params: { delimiter: "," } }],
            },
          ],
        },
      ],
    },
    sharedSecret: "A".repeat(43),
  });
}

test("the accept path refuses unrunnable terms at its decode gate", async () => {
  // `decodeAndValidateInvitation` is the first step of `validateAccept`, the
  // one both the online and the offline mode reach: it produces the
  // `InvitationToken` the terms display and the y/N prompt read, and the
  // online mode's connection is opened after it. A refusal here therefore
  // reaches the operator with no terms shown and no endpoint contacted.
  const raised: unknown = await decodeAndValidateInvitation(
    await unrunnableInvitation(),
  ).then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as UsageError).message).toContain(
    "turns one value into several match candidates",
  );
});

test("the decode gate's refusal echoes nothing the partner authored", async () => {
  // The accept route renders a decode error with no sanitizing pass of its
  // own, so the refusal states fixed literals and locates the offending key by
  // its position rather than by the name the partner wrote.
  const raised: unknown = await decodeAndValidateInvitation(
    await unrunnableInvitation(),
  ).then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(raised).toBeInstanceOf(UsageError);
  for (const authored of [
    "Partner Authored Identity",
    "partner_given",
    "Partner Key Name",
  ])
    expect((raised as UsageError).message).not.toContain(authored);
});
