import {
  AcceptedTermsShapeError,
  UsageError,
  assertDeduplicateImplemented,
  assertTransformsCompile,
  countOnlyShapeViolation,
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  isInvitationExpired,
  resolveLinkageCardinality,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import type { DeploymentProfile } from "@utils/clientConfig";

import type {
  ConnectionEndpoint,
  ExchangeDataSpec,
  FileDropEndpoint,
  InvitationToken,
  LinkageTerms,
  Metadata,
  SFTPEndpoint,
  Standardization,
  WebRTCEndpoint,
} from "@alcove/core";

/** The column metadata and standardization the acceptor authored in its
 * confirm-columns step; both are local to this party and never cross-checked
 * with the partner. */
export interface AcceptorDataEdits {
  metadata: Metadata;
  standardization: Standardization;
}

/** A decoded invitation that passed every local precondition for acceptance. */
export interface AcceptableInvitation {
  token: InvitationToken;
  /** The token's endpoint, narrowed to the channels this build can drive
   * ({@link endpointDrivableHere}). An SFTP endpoint contains only its
   * credential-free locator; the operator authors the rest in the console. */
  endpoint: WebRTCEndpoint | FileDropEndpoint | SFTPEndpoint;
}

/**
 * Decode and validate an encoded invitation for acceptance, failing closed
 * before the consent screen or any connection: an expired token (or an
 * unparseable `expires`), an endpoint this build cannot drive, a `deduplicate`
 * the run cannot honor, and a linkage-key transform that does not compile are
 * each refused.
 *
 * @param encoded  The encoded invitation string (bare code or deep-link
 *                 fragment).
 * @param options.now      The instant to compare `expires` against. Defaults
 *                         to now.
 * @param options.profile  This build's deployment profile.
 * @throws {Error} on an expired token or an endpoint this build cannot drive.
 * @throws {UsageError} from `assertDeduplicateImplemented` or
 *   `assertTransformsCompile`.
 * @throws whatever `decodeInvitation` throws; the accept route renders every
 *   failure through `describeDecodeError`.
 */
export async function prepareAcceptedInvitation(
  encoded: string,
  options: { now?: Date; profile: DeploymentProfile },
): Promise<AcceptableInvitation> {
  const { now = new Date(), profile } = options;
  const token = await decodeInvitation(encoded);

  if (isInvitationExpired(token.expires, now)) {
    throw new Error(
      "This invitation has expired. Ask your partner to send a new one.",
    );
  }

  const endpoint = token.connectionEndpoint;
  if (endpoint === undefined || !endpointDrivableHere(endpoint, profile)) {
    throw new Error(
      "This invitation does not include a connection endpoint this build can " +
        "accept, so it cannot be run here.",
    );
  }

  // The two refusals `deriveAcceptedLinkageTerms` applies on the launch path,
  // raised here before the consent screen.
  assertDeduplicateImplemented(token.linkageTerms);
  assertTransformsCompile(token.linkageTerms);

  return { token, endpoint };
}

/**
 * Whether this build can drive an endpoint: WebRTC always, file-drop and SFTP
 * on a console build only. The switch has no default, so a new channel fails
 * to compile here until classified.
 */
function endpointDrivableHere(
  endpoint: ConnectionEndpoint,
  profile: DeploymentProfile,
): boolean {
  switch (endpoint.channel) {
    case "webrtc":
      return true;
    case "filedrop":
    case "sftp":
      return profile === "console";
  }
}

/**
 * Build the data-preparation spec an acceptor runs against its own CSV: the
 * inviter's terms with this party's identity and mirrored output and payload
 * ({@link deriveAcceptedLinkageTerms}), plus the acceptor's own edits when it
 * made any (docs/COMMUNICATION.md, "Running the agreed terms"). Without edits,
 * `prepareForExchange` infers metadata and standardization from the CSV. Also
 * backs the CLI acceptor.
 *
 * `deduplicate` is this party's own side, never taken from the invitation.
 *
 * @param linkageTerms  The inviter's linkage terms from the decoded token.
 * @param acceptorName  The accepting party's name, recorded as the prepared
 *                      terms' identity.
 * @param edits         The acceptor's edits; omitted to fall back to CSV
 *                      inference.
 * @param deduplicate   Whether several of this party's records may match one
 *                      of the partner's.
 */
export function acceptorExchangeDataSpec(
  linkageTerms: LinkageTerms,
  acceptorName: string,
  edits?: AcceptorDataEdits,
  deduplicate: boolean = false,
): ExchangeDataSpec {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(
      linkageTerms,
      acceptorName,
      deduplicate,
    ),
    ...(edits && {
      metadata: edits.metadata,
      standardization: edits.standardization,
    }),
  };
}

/**
 * The placeholder identity for the pre-run deduplicate check, which runs before
 * the operator enters a name and reads no identity. Never displayed or run.
 */
const DEDUPLICATE_CHECK_IDENTITY = "you";

/**
 * Whether the accepting party may declare a `deduplicate` of its own against
 * this invitation: only a party that receives the result may, and the
 * count-only shape refuses it outright. Both are core's own rules, so the
 * control is offered exactly where the accept would take the value.
 */
export function acceptorMaySetDeduplicate(linkageTerms: LinkageTerms): boolean {
  return (
    linkageTerms.output.shareWithPartner &&
    countOnlyShapeViolation({ ...linkageTerms, deduplicate: true }) ===
      undefined
  );
}

/**
 * A deduplicate refusal read before the run. A `pair` refusal clears when the
 * accepting operator clears its own side, so it renders beside that control; a
 * `terms` refusal remains whatever this party sets, so it blocks the accept.
 */
export interface AcceptorDeduplicateRefusal {
  scope: "pair" | "terms";
  message: string;
}

/**
 * The refusal the accepting party's `deduplicate` value meets against this
 * invitation, or `undefined` when the pair runs. It resolves the pair at the
 * run's own boundary, so it refuses exactly the pairs the run refuses
 * (docs/spec/PROTOCOL.md, "Deduplicating cardinalities: many-to-X matching").
 * A refusal the closed default also meets is `terms`. Never throws, since the
 * accept screen reads it while rendering; the message is escaped here.
 */
export function acceptorDeduplicateRefusal(
  linkageTerms: LinkageTerms,
  deduplicate: boolean,
): AcceptorDeduplicateRefusal | undefined {
  try {
    resolvePresentedCardinality(linkageTerms, deduplicate);
    return undefined;
  } catch (error) {
    const clearingRuns = deduplicate && acceptorClosedDefaultRuns(linkageTerms);
    return {
      scope:
        error instanceof UsageError &&
        !(error instanceof AcceptedTermsShapeError) &&
        clearingRuns
          ? "pair"
          : "terms",
      message: sanitizeErrorForDisplay(error),
    };
  }
}

/** Resolve the joint cardinality this party's `deduplicate` makes with the
 * invitation, throwing what the run would throw. */
function resolvePresentedCardinality(
  linkageTerms: LinkageTerms,
  deduplicate: boolean,
): void {
  resolveLinkageCardinality(
    deriveAcceptedLinkageTerms(
      linkageTerms,
      DEDUPLICATE_CHECK_IDENTITY,
      deduplicate,
    ),
    linkageTerms,
  );
}

/** Whether this invitation runs with the accepting party's side closed. */
function acceptorClosedDefaultRuns(linkageTerms: LinkageTerms): boolean {
  try {
    resolvePresentedCardinality(linkageTerms, false);
    return true;
  } catch {
    return false;
  }
}
