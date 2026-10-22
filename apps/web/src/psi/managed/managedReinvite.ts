/**
 * Fast re-invite from a stored managed record: the recovery for a lapsed, desynced,
 * restored, or persist-failed exchange (see docs/MANAGED_EXCHANGE.md, "Recovery: fast
 * re-invite"). "Fast" means the record retains everything a re-invite needs that is
 * NOT the secret -- this party's exchange-file document, with its terms -- so a
 * re-invite reuses the standing definition and re-mints and re-exchanges the setup
 * secret, naming the coordination server a new invitation would, rather than
 * re-authoring the exchange. The operator re-authors nothing.
 *
 * Re-invite is an INVITER-role act. The invitation holds the linkage terms in the
 * inviter's own namespace, which the partner's accept mirrors into its perspective
 * (core's `deriveAcceptedLinkageTerms`), its `payload.send` becoming the partner's
 * `payload.receive`. Only the
 * `side: "inviter"` party holds those terms verbatim; the acceptor's stored document
 * is its own MIRRORED perspective (identity replaced, payload mirrored) and cannot be
 * reversed to the original inviter terms, so the acceptor does not re-mint -- its
 * recovery is "your partner sends a fresh invitation; accept it here" (see
 * {@link canReinviteFromRecord}). This mirrors the CLI, where a re-invite is generated
 * from the existing configuration by the inviting party.
 *
 * What the freshly minted invitation must include so the partner's accept
 * records the same terms, sourced from the stored inviter document:
 *
 * - `linkageTerms` -- the document's terms (the inviter's own perspective), so the
 *   partner adopts the same set it did originally, with `payload.send` stated from
 *   the document's metadata where it holds one.
 * - `connectionEndpoint` -- the coordination server a new invitation from this
 *   browser names (this browser's setting where set and readable, else the
 *   deployment's), not the document's stored `server` locator, so a re-invite
 *   repoints an exchange whose saved server moved or was retired. The rotation
 *   stores it as the document's `server`, where this party's later runs register
 *   (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side` field"), so
 *   both runs reach the server the partner's accept saves.
 *   It names the inviter's own relay and the build's default relay, both passed
 *   in by the host, as a new invitation does.
 * - `sharedSecret` -- a fresh setup secret, superseding the desynced one.
 * - `expires` -- a fresh bounded setup lifetime on the TOKEN (the invitation-in-
 *   transit bound). The RECORD's own `expires` is re-derived from the max-age policy,
 *   never the setup lifetime -- the record's `expires` provenance is single-source
 *   (see {@link buildReinviteRotation}).
 *
 * The ongoing cost of this recovery, which the copy must not hide: every
 * re-invite puts a fresh live setup secret on the out-of-band channel, so the
 * invitation-confidentiality requirement is ongoing, not one-time (see
 * docs/MANAGED_EXCHANGE.md, "Recovery: fast re-invite").
 *
 * Pure and platform-free: this module composes the token and computes the record's
 * rotation write-back; the store write, the download, and the location live in
 * the host. Secret generation and token encoding are core's, injected so the
 * composition stays testable without real crypto.
 */

import {
  INVITATION_LIFETIME_SECONDS,
  assertInvitationLifetimeSeconds,
  invitationExpires,
  termsStatingDeclaredPayloadSend,
} from "@alcove/core";

import {
  deepLinkFor,
  invitationSignalingAddress,
  webrtcEndpointFromAddress,
  webrtcEndpointWithRelay,
} from "../invitation";
import { invitationRelayWithDefault } from "../transport/defaultRelay";
import { managedAllowedRelays } from "./managedExchangeRecord";
import { rotationWriteBack } from "./managedRunRotate";

import type { InvitationToken, WebRTCEndpoint } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeReinviteRotation,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { InvitationLocation } from "../invitation";
import type { RelayUrls } from "../transport/ownRelaySetting";

/**
 * Whether a record can re-invite from its own stored document. Only the inviter side
 * can: it holds the linkage terms in the inviter's namespace verbatim. The acceptor's
 * stored terms are its mirrored perspective and cannot be reversed to the original
 * inviter terms, so its recovery is to accept a fresh invitation from the partner, not
 * to re-mint one.
 */
export function canReinviteFromRecord(record: ManagedExchangeRecord): boolean {
  return record.side === "inviter";
}

/** The freshly minted re-invite artifacts plus the record write the recovery
 * persists. The operator forwards {@link encoded}/{@link deepLink} out-of-band; the
 * host writes {@link rotation} to the record so this party's own re-run listens on the
 * rendezvous the fresh secret derives, at the coordination server the invitation
 * names, superseding the desynced secret. */
export interface ManagedReinvite {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /** The deep-link URL holding the token in its fragment -- the URL copy artifact. */
  deepLink: string;
  /** The fresh setup secret the token holds and the record adopts. */
  sharedSecret: string;
  /** The token's bounded setup expiry (the invitation-in-transit bound), ISO 8601. */
  tokenExpires: string;
  /** The record rotation to persist: the fresh secret, the record's own `expires`
   * re-derived from the max-age policy (never the setup lifetime), and the
   * coordination server the invitation names. */
  rotation: ManagedExchangeReinviteRotation;
}

/**
 * Compute the record write a re-invite persists: the fresh setup secret and the
 * record's `expires` re-derived from the max-age policy, exactly as a rotation would
 * restamp it -- through {@link rotationWriteBack}, so the date math and its guards are
 * reused, not duplicated -- and `signalingEndpoint`, the server the invitation names.
 * The setup lifetime never flows into the record's `expires` (its provenance is
 * single-source, the max-age stamp), so a record with no policy clears any standing
 * bound and a record with a policy stamps `now + tokenMaxAgeDays`.
 *
 * @throws {RangeError} (from {@link rotationWriteBack}) if the policy is not a
 *   positive integer or stamps an expiry outside the representable range.
 */
function buildReinviteRotation(
  freshSecret: string,
  tokenMaxAgeDays: number | undefined,
  now: number,
  signalingEndpoint: WebRTCEndpoint,
): ManagedExchangeReinviteRotation {
  const { host, port, path } = signalingEndpoint;
  return {
    ...rotationWriteBack(freshSecret, tokenMaxAgeDays, now),
    signalingServer: {
      host,
      ...(port !== undefined ? { port } : {}),
      ...(path !== undefined ? { path } : {}),
    },
  };
}

/**
 * Build the fresh invitation token a re-invite mints from the stored inviter
 * document: the document's linkage terms, `signalingEndpoint` (the server a
 * new invitation from this browser names), the fresh setup secret, and the
 * bounded setup expiry.
 * Where the document holds metadata, `payload.send` is stated from it, as a
 * first mint states it; without metadata the terms
 * are sent as stored. The token holds no credential -- the endpoint is
 * credential-free by construction and `encodeInvitation` re-validates it
 * through the strict endpoint schema (see {@link ./invitation.ts}).
 */
function buildReinviteToken(
  record: RunnableManagedExchangeRecord,
  signalingEndpoint: WebRTCEndpoint,
  freshSecret: string,
  tokenExpires: string,
  relay: RelayUrls | undefined,
): InvitationToken {
  const { linkageTerms, metadata } = record.exchangeFile;
  return {
    version: "1",
    linkageTerms:
      metadata === undefined
        ? linkageTerms
        : termsStatingDeclaredPayloadSend(linkageTerms, metadata),
    sharedSecret: freshSecret,
    expires: tokenExpires,
    connectionEndpoint: webrtcEndpointWithRelay(signalingEndpoint, relay),
  };
}

// `ownRelay` naming, beside its WebSocket relay url, the exchange id a run of
// the record proves to that relay under: the record's registrar's, where it
// names one.
function withOwnWebSocketExchangeId(
  ownRelay: RelayUrls | undefined,
  record: ManagedExchangeRecord,
): RelayUrls | undefined {
  const websocketExchangeId = record.relayRegistrar?.exchangeId;
  if (ownRelay?.websocket === undefined || websocketExchangeId === undefined)
    return ownRelay;
  return { ...ownRelay, websocketExchangeId };
}

/** What a re-invite injects: fresh-secret generation and token encoding are
 * core's, and the setup lifetime is bounded here exactly as {@link generateInvitation}
 * bounds it, so none of these can mint an unbounded or effectively-permanent token. */
interface ManagedReinviteSeams {
  /** Mint a fresh setup secret (core's `generateSharedSecret`). */
  generateSecret: () => string;
  /** Encode the token to the shareable string (core's `encodeInvitation`). */
  encode: (token: InvitationToken) => Promise<string>;
  /** The instant the setup lifetime and the record's max-age stamp count from. */
  now: () => number;
  /** The setup lifetime in seconds; defaults to the one-hour
   * {@link INVITATION_LIFETIME_SECONDS} and is bounded by
   * {@link assertInvitationLifetimeSeconds}. */
  lifetimeSeconds?: number;
  /** This browser's own relay, less the TURN urls the record's allowed relays
   * leave out, which the invitation names; `undefined` names none. */
  ownRelay: RelayUrls | undefined;
  /** The build's default relay, whose TURN url the invitation names after the
   * own relay, with its registrar; `undefined` names none. */
  defaultRelay: DefaultRelaySetting | undefined;
}

/**
 * Compose a fast re-invite from a stored inviter record: mint a fresh setup secret,
 * build and encode the invitation token from the record's own document, and compute
 * the record rotation the host persists. The operator re-authors nothing -- the terms,
 * the committed send set, and the record's `id`/handle are all retained. The
 * invitation names no TURN url the record's allowed relays leave out
 * (`turnUrlIsAllowed` in core), and names the record's registrar's exchange id
 * beside this browser's own WebSocket relay url. `location` gives the deep
 * link's origin and the coordination server the invitation names, which the
 * rotation stores on the record; the record's saved server is not read.
 *
 * @throws {Error} if the record is not the inviter side (only the inviter re-mints; an
 *   acceptor's recovery is to accept the partner's fresh invitation), or if the setup
 *   lifetime is not a finite positive number of seconds within the one-year ceiling.
 * @throws {NoSignalingAddressError} if `location` names no coordination server.
 * @throws {RangeError} if the max-age policy stamps an expiry outside the range.
 * @throws {ZodError} if the assembled token fails the strict endpoint/schema
 *   validation at encode.
 */
export async function composeManagedReinvite(
  record: RunnableManagedExchangeRecord,
  location: InvitationLocation,
  seams: ManagedReinviteSeams,
): Promise<ManagedReinvite> {
  if (!canReinviteFromRecord(record))
    throw new Error(
      "only the inviter side can re-invite from its stored document; the acceptor " +
        "accepts a fresh invitation from the partner",
    );
  const signalingEndpoint = webrtcEndpointFromAddress(
    invitationSignalingAddress(location),
  );
  const lifetimeSeconds = seams.lifetimeSeconds ?? INVITATION_LIFETIME_SECONDS;
  try {
    assertInvitationLifetimeSeconds(lifetimeSeconds);
  } catch (err: unknown) {
    if (err instanceof RangeError)
      throw new RangeError(`re-invite: ${err.message}`, { cause: err });
    throw err;
  }

  const now = seams.now();
  const freshSecret = seams.generateSecret();
  const tokenExpires = invitationExpires(lifetimeSeconds, now);
  const token = buildReinviteToken(
    record,
    signalingEndpoint,
    freshSecret,
    tokenExpires,
    invitationRelayWithDefault(
      withOwnWebSocketExchangeId(seams.ownRelay, record),
      seams.defaultRelay,
      managedAllowedRelays(record.exchangeFile),
    ),
  );
  const encoded = await seams.encode(token);
  return {
    encoded,
    deepLink: deepLinkFor(location.origin, encoded),
    sharedSecret: freshSecret,
    tokenExpires,
    rotation: buildReinviteRotation(
      freshSecret,
      record.tokenMaxAgeDays,
      now,
      signalingEndpoint,
    ),
  };
}
