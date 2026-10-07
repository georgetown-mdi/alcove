import {
  InvitationTermDivergenceError,
  PayloadDisclosureDivergenceError,
} from "../errors.js";
import { declaresNoPayloadColumn } from "../linkageTermsPolicy.js";
import { sendAbort } from "../protocolSetup.js";

import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { MessageConnection } from "../connection/messageConnection.js";
import type { PreparedExchange } from "../exchange.js";

// The terms-time refusals one party can reach alone: the presented deduplicate
// held to the invitation, and the payload disclosure resolved both directions.

/**
 * Bind the `deduplicate` a partner presents at the terms exchange to the
 * value its invitation declared, for a run reached by accepting one: a
 * value presented as `true` where the invitation declared `false` widens
 * what this party's records disclose beyond what was consented to.
 * Refused before any key or payload moves. Scoped to the invitation path:
 * `undefined` ({@link PreparedExchange.expectedPartnerDeduplicate}) is a
 * no-op, since a config-authored exchange states no declaration to hold
 * the partner to.
 */
export function assertPresentedDeduplicateMatchesInvitation(
  invitationDeclared: boolean | undefined,
  presented: boolean,
): void {
  if (invitationDeclared === undefined) return;
  if (invitationDeclared === presented) return;
  throw new InvitationTermDivergenceError(
    "your partner presented linkage terms that differ from the invitation " +
      `you accepted: the invitation declared deduplicate ` +
      `${invitationDeclared}, and the terms your partner presented declare ` +
      `${presented}. Nothing was sent. Ask your partner for an invitation ` +
      "that declares the setting they will run, and accept that one.",
  );
}

/**
 * Apply {@link assertPresentedDeduplicateMatchesInvitation}, sending the
 * partner an abort before its refusal propagates.
 */
export async function assertPresentedDeduplicateOrAbort(
  conn: MessageConnection,
  p: {
    expected: PreparedExchange["expectedPartnerDeduplicate"];
    presented: LinkageTerms["deduplicate"];
  },
): Promise<void> {
  try {
    assertPresentedDeduplicateMatchesInvitation(p.expected, p.presented);
  } catch (err) {
    // Best-effort abort before the throw, as every refusal inside exchangeTerms
    // sends one. This refusal is one-sided -- only this party holds the
    // declaration -- so without it the partner would wait out its full
    // peer-inactivity budget (a full poll budget on a file channel) for rounds
    // this party never runs. The reason is a fixed literal about values the
    // partner itself declared, so the frame discloses nothing new. Whichever
    // receive the partner is parked on, the bootstrap frame or its first PSI
    // round, reads the frame as a peer abort before it parses what it awaited
    // (partnerAbortFrame.ts), so that run ends naming the termination.
    await sendAbort(conn, [
      "partner presented a deduplicate its invitation did not declare",
    ]);
    throw err;
  }
}

/**
 * Resolve whether ONE direction of the exchange discloses payload -- the
 * party whose document is `disclosingPartyTerms` to the party whose document
 * is `receivingPartyTerms` -- from the two agreed terms documents and the
 * disclosing party's own assertion (`disclosingPartyAsserts`: that party's
 * `disclosesPayload` flag off the terms exchange, or this party's own
 * metadata for its own direction).
 *
 * A direction whose RECEIVING party is entitled to no output discloses
 * nothing, whatever either document declares and whatever the disclosing
 * party asserts: the payload send gate transmits only to a partner entitled
 * to the result, so no column can move this way and there is nothing for a
 * declaration to contradict. Both parties read that entitlement off the same
 * agreed document, so both resolve the direction identically -- and false is
 * the value the withhold gate reads for a direction that moves no payload.
 *
 * Otherwise the assertion rides the envelope rather than the agreed-terms
 * hash, so it can only ADD disclosure to what the terms declare. Three cases:
 *
 * - The disclosing party's `payload.send` declared present and empty binds
 *   it to disclosing no column whatever it asserts, so this direction moves
 *   nothing and the exchange continues. A conforming party states its send
 *   set from what its metadata transmits (`termsStatingDeclaredPayloadSend`),
 *   so one in this shape discloses none.
 * - The receiving party's `payload.receive` declared present and empty, with
 *   no such declaration on the disclosing party's own document to hold it
 *   to, while that party asserts disclosure: the two contradict, and the
 *   exchange is refused rather than narrowed to a run whose payload never
 *   moves.
 * - Neither direction declared present and empty: the assertion decides.
 */
export function resolveDirectionDisclosesPayload(
  disclosingPartyAsserts: boolean,
  disclosingPartyTerms: LinkageTerms,
  receivingPartyTerms: LinkageTerms,
): boolean {
  if (!receivingPartyTerms.output.expectsOutput) return false;
  if (declaresNoPayloadColumn(disclosingPartyTerms.payload?.send)) return false;
  if (
    disclosingPartyAsserts &&
    declaresNoPayloadColumn(receivingPartyTerms.payload?.receive)
  )
    throw new PayloadDisclosureDivergenceError();
  return disclosingPartyAsserts;
}

/** Which payload disclosure each direction of one exchange resolves to. */
export interface PayloadDisclosureDirections {
  /** Whether this party discloses payload to the partner. */
  localToPartner: boolean;
  /** Whether the partner discloses payload to this party. */
  partnerToLocal: boolean;
}

/**
 * Resolve BOTH directions of one exchange
 * ({@link resolveDirectionDisclosesPayload} applied twice), so a
 * `payload.receive` declared present and empty is held against the other
 * party's asserted disclosure whichever PSI seat role resolution goes on to
 * give either of them. Only which direction the single-pass
 * association-table withhold gate reads follows the seat
 * ({@link withholdsSenderAssociationTable}); the refusal does not.
 *
 * Both parties read the same pair of agreed documents but not the same pair
 * of assertions: each takes its own direction from its own metadata and the
 * other direction from the partner's advertised flag. A conforming party
 * advertises exactly what its metadata discloses, so against such a partner
 * the two resolutions match and a suppression, a skip and a refusal all
 * agree -- at this same point, before the linkage round, the association
 * table, and the payload. Where a partner's advertisement diverges from its
 * own metadata the two differ and one party can refuse alone, so the
 * refusal's call site sends the partner an abort before the throw.
 */
export function resolveBothDirectionsDisclosePayload(
  localAsserts: boolean,
  localTerms: LinkageTerms,
  partnerAsserts: boolean,
  partnerTerms: LinkageTerms,
): PayloadDisclosureDirections {
  return {
    localToPartner: resolveDirectionDisclosesPayload(
      localAsserts,
      localTerms,
      partnerTerms,
    ),
    partnerToLocal: resolveDirectionDisclosesPayload(
      partnerAsserts,
      partnerTerms,
      localTerms,
    ),
  };
}

/**
 * Apply {@link resolveBothDirectionsDisclosePayload}, sending the partner an
 * abort before its refusal propagates.
 */
export async function resolvePayloadDisclosureOrAbort(
  conn: MessageConnection,
  p: {
    localDisclosesPayload: boolean;
    localTerms: LinkageTerms;
    partnerDisclosesPayload: boolean;
    partnerTerms: LinkageTerms;
  },
): Promise<PayloadDisclosureDirections> {
  let payloadDisclosure: PayloadDisclosureDirections;
  try {
    payloadDisclosure = resolveBothDirectionsDisclosePayload(
      p.localDisclosesPayload,
      p.localTerms,
      p.partnerDisclosesPayload,
      p.partnerTerms,
    );
  } catch (err) {
    // Best-effort abort before the throw, as the deduplicate refusal above
    // sends one. The two parties read different assertions for the same
    // direction -- the disclosing party its own metadata, the other party the
    // advertised flag -- so a partner whose advertisement diverges from its
    // metadata fires this on one side alone, and without the frame the other
    // waits out its full peer-inactivity budget. The reason is a fixed literal,
    // disclosing nothing new.
    await sendAbort(conn, [
      "a party asserts a payload disclosure the agreed linkage terms " +
        "declare no column for",
    ]);
    throw err;
  }
  return payloadDisclosure;
}
