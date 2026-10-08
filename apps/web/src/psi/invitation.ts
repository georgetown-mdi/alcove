import {
  INVITATION_ACCEPT_ROUTE_PATH,
  INVITATION_LIFETIME_SECONDS,
  assertFanOutImplemented,
  assertInvitationLifetimeSeconds,
  assertPayloadSendDisclosed,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
  assessLinkageSatisfiability,
  decideLinkageTermsVerdict,
  encodeInvitation,
  endpointRequiresRetainedFiles,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  invitationExpires,
  overlongDisclosedColumnPositions,
  relayLocatorFromOwnRelay,
  stripInvitationWhitespace,
  termsStatingDeclaredPayloadSend,
} from "@alcove/core";

import { emptyColumnPositions } from "./columnNames";
import { linkageRefusalFor } from "./linkageRefusal";
import { loadCSVFileOffMainThread } from "./workers/csvParseController";
import { ownColumnsField } from "./ownColumnsModel";
import { relayForRun } from "./transport/ownRelaySetting";
import { standardizationForTerms } from "./authoring/advancedInviteTerms";

import type {
  CSVRow,
  ConnectionEndpoint,
  FileDropEndpoint,
  InvitationToken,
  LinkageTerms,
  Metadata,
  OwnColumnSelection,
  SFTPEndpoint,
  Standardization,
  WebRTCEndpoint,
} from "@alcove/core";

import type { LinkageRefusal } from "./linkageRefusal";
import type { OwnColumnsChoice } from "./ownColumnsModel";
import type { RelayUrls } from "./transport/ownRelaySetting";
import type { SignalingAddress } from "./transport/signalingAddress";

/** The CSV input {@link generateInvitation} parses, typed from
 * {@link loadCSVFileOffMainThread} so this module adds no papaparse dependency. */
type InvitationCSVInput = Parameters<typeof loadCSVFileOffMainThread>[0];

/** The acceptor's consent route; the token is in the URL fragment
 * ({@link deepLinkFor}). */
export const ACCEPT_ROUTE_PATH = INVITATION_ACCEPT_ROUTE_PATH;

/** The start page's paste-an-invitation field, which takes focus when the page
 * opens at this fragment: `/quick#` + this id. */
export const PASTE_INVITATION_FIELD_ID = "accept-invitation";

/**
 * The deep-link origin and signaling address an invitation names, passed in so
 * {@link generateInvitation} reads no `window`.
 */
export interface InvitationLocation {
  /** Deep-link origin, e.g. `https://example.org:3000` (no trailing slash). */
  origin: string;
  /** Where this app's inviter registers, or undefined on a build with no
   * browser signaling (the console), which mints no webrtc invitation. */
  signaling: SignalingAddress | undefined;
}

/** A webrtc mint refused because the build names no signaling address. Its
 * message is fixed operator-facing copy. */
export class NoSignalingAddressError extends Error {
  constructor() {
    super(
      "This console does not make browser-to-browser invitations: it coordinates no browser connections, so your partner could not reach you. Run the exchange over SFTP or a shared folder, or create the invitation in the Alcove web app.",
    );
    this.name = "NoSignalingAddressError";
  }
}

/**
 * The signaling address a webrtc invitation from `loc` names.
 *
 * @throws {NoSignalingAddressError} when `loc` has none.
 */
export function invitationSignalingAddress(
  loc: InvitationLocation,
): SignalingAddress {
  if (loc.signaling === undefined) throw new NoSignalingAddressError();
  return loc.signaling;
}

/**
 * An invitation composed from the inviter's file: the shareable token
 * ({@link encoded}, {@link deepLink}), its secret and expiry, and the terms and
 * parsed rows the inviter's own run uses. Only the token is shared.
 */
export interface GeneratedInvitation {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /**
   * Deep-link URL `<origin>/accept#<encoded>`. The token is in the fragment so
   * it is never sent to the server (docs/SECURITY_DESIGN.md, "Invitation
   * contents and confidentiality").
   */
  deepLink: string;
  /** The secret inside `encoded`, from which the inviter derives its
   * rendezvous peer id. Never sent to a backend. */
  sharedSecret: string;
  /** The token's expiry (ISO 8601), for the key exchange's expiry checks. */
  expires: string;
  /**
   * The terms embedded in the token. The inviter's run must use this object,
   * or the terms-compatibility check with the partner fails.
   */
  linkageTerms: LinkageTerms;
  /** The parsed rows {@link linkageTerms} was derived from, so the inviter's
   * run needs no re-parse. Empty on the profiled-columns path. */
  rawRows: Array<CSVRow>;
  /** The CSV column names, paired with {@link rawRows} -- the two inputs the
   * inviter's exchange feeds to `prepareForExchange`. Local-only. */
  columns: Array<string>;
  /** The inviter's edited column metadata, for its own `prepareForExchange`;
   * absent on the quick path. Never in the token. */
  metadata?: Metadata;
  /**
   * The inviter's authored standardization, reconciled to {@link linkageTerms}
   * at the mint (the draft keeps a disabled key's cleaning), for its own
   * `prepareForExchange`; absent on the quick path. Never in the token.
   */
  standardization?: Standardization;
  /**
   * Which of the inviter's own columns its result file includes, narrowed at
   * the mint to terms that give it a result table. Every copy of the mint
   * reads it from here. Never in the token.
   */
  includeOwnColumns?: OwnColumnSelection;
}

/** Why {@link generateInvitation} refused the inviter's file. Each is
 * user-actionable and thrown before any secret is generated; anything else it
 * throws is an internal fault. */
export type InvitationFileFailure =
  | {
      /** The CSV could not be read or parsed. */
      kind: "unreadable";
      /** The read or parse error, to show (sanitized) and log. */
      cause: unknown;
    }
  | {
      /** The file cannot satisfy every linkage key the terms declare, so the
       * run would be refused after the partner accepted (core's
       * `assertLinkageTermsSatisfiable`). */
      kind: "unlinkable";
      /** Why, in the shape the operator-facing alert is total over. */
      refusal: LinkageRefusal;
    }
  | {
      /** The header has an empty column name. Refused here so the operator
       * sees a clear error, not a raw ZodError at encode. */
      kind: "unnameable";
      /** 1-based positions of the empty-named columns. */
      positions: Array<number>;
      /** 1-based positions the parse removed control characters from, so the
       * message can tell such a name from a blank header cell. */
      sanitizedPositions: Array<number>;
    }
  | {
      /** A column marked to send has a name longer than `MAX_NAME_LENGTH`,
       * which the partner's parse refuses. Unsent columns do not count. */
      kind: "overlong";
      /** 1-based positions of the offending columns; the name itself is too
       * long to show. */
      positions: Array<number>;
    };

/**
 * Thrown by {@link generateInvitation} when the inviter's file cannot back an
 * invitation. `message` is a fixed summary safe to log.
 */
export class InvitationFileError extends Error {
  readonly failure: InvitationFileFailure;
  constructor(failure: InvitationFileFailure) {
    super(
      failure.kind === "unreadable"
        ? "invitation file could not be read"
        : failure.kind === "unlinkable"
          ? "invitation file cannot satisfy the linkage terms"
          : failure.kind === "overlong"
            ? "invitation file sends an over-long column name"
            : "invitation file has an empty column name",
    );
    this.name = "InvitationFileError";
    this.failure = failure;
  }
}

/**
 * The credential-free WebRTC signaling locator the acceptor uses to reach the
 * signaling server at `address`. It names no scheme: the acceptor resolves ws
 * or wss from its own page, and an omitted port from that same scheme.
 */
export function webrtcEndpointFromAddress(
  address: SignalingAddress,
): WebRTCEndpoint {
  const endpoint: WebRTCEndpoint = {
    channel: "webrtc",
    host: address.host,
    path: address.path,
  };
  if (address.port !== undefined) endpoint.port = address.port;
  return endpoint;
}

/**
 * The webrtc endpoint in a web invitation: the signaling locator plus the
 * inviter's own relay, if any. Both mint paths, a new invitation and a managed
 * re-invite, call it.
 */
export function invitationWebrtcEndpoint(
  loc: InvitationLocation,
  ownRelay: RelayUrls | undefined,
): WebRTCEndpoint {
  const endpoint = webrtcEndpointFromAddress(invitationSignalingAddress(loc));
  const relay = relayLocatorFromOwnRelay(ownRelay);
  return relay !== undefined ? { ...endpoint, relay } : endpoint;
}

/** Build the deep-link URL with `encoded` in the fragment. */
export function deepLinkFor(origin: string, encoded: string): string {
  return `${origin}${ACCEPT_ROUTE_PATH}#${encoded}`;
}

/**
 * Extract the token from a pasted deep link or bare code, the inverse of
 * {@link deepLinkFor}. `stripInvitationWhitespace` leaves input past its length
 * bound unchanged, for `decodeInvitation` to refuse at `/accept`.
 */
export function tokenFromInput(input: string): string {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  const token = hash === -1 ? trimmed : trimmed.slice(hash + 1);
  return stripInvitationWhitespace(token);
}

/**
 * The endpoint to put in an invitation: `{ channel: "webrtc" }` for this
 * app's signaling locator, or an authored sftp or filedrop locator. No endpoint
 * type has a credential field, and `encodeInvitation` re-validates the token
 * through the strict schema.
 */
export type ConnectionEndpointRequest =
  { channel: "webrtc" } | SFTPEndpoint | FileDropEndpoint;

/** Resolve a request to the token's endpoint; webrtc names the relay
 * this inviter's own run uses ({@link relayForRun}). */
function resolveConnectionEndpoint(
  request: ConnectionEndpointRequest,
  location: InvitationLocation,
): ConnectionEndpoint {
  if (request.channel === "webrtc")
    return invitationWebrtcEndpoint(location, relayForRun());
  return request;
}

/**
 * Whether an invitation minted from these inputs declares
 * `inviterRetainsFiles`: the caller's `retain_files`, or a split-directory
 * endpoint, which always runs in retain mode
 * ({@link endpointRequiresRetainedFiles}). The accept kit reads it from here
 * too, so the token and the sheet agree.
 */
export function invitationDeclaresRetainedFiles(params: {
  connectionEndpoint?: ConnectionEndpointRequest;
  retainsFiles?: boolean;
}): boolean {
  const { connectionEndpoint = { channel: "webrtc" }, retainsFiles = false } =
    params;
  if (connectionEndpoint.channel === "webrtc") return retainsFiles;
  return retainsFiles || endpointRequiresRetainedFiles(connectionEndpoint);
}

/**
 * Generate a single-use invitation from the inviter's CSV or profiled columns:
 * a new shared secret, the linkage terms, and the endpoint, encoded and as a
 * deep link. The inviter's own run must use the returned terms and rows. Every
 * refusal is raised before the secret is generated.
 *
 * @throws {InvitationFileError} when the file is unreadable, unlinkable, has an
 *                               unnamed column, or sends a column whose name is
 *                               too long.
 * @throws {UsageError} (from core) when authored `payload.send` does not match
 *                      the metadata's disclosed set, or a transform expands one
 *                      value into several match candidates.
 * @throws {StandardizationTermsError} (from core) when the reconciled
 *                      standardization still contradicts the terms.
 */
export async function generateInvitation(params: {
  inviterName: string;
  /** The inviter's CSV. Exactly one of `file` or `profiledColumns` is set. */
  file?: InvitationCSVInput;
  /** The delimiter the intake step read `file` with; a comma when omitted. */
  csvDelimiter?: string;
  /** Column names the console profiled server-side, bound without reading a
   * file in the browser; `rawRows` is then empty. */
  profiledColumns?: Array<string>;
  location: InvitationLocation;
  /** Lifetime in seconds, default {@link INVITATION_LIFETIME_SECONDS}, bounded
   * by {@link assertInvitationLifetimeSeconds}. */
  lifetimeSeconds?: number;
  /**
   * Authored terms (`buildAdvancedTerms`), embedded as written apart from an
   * unset `payload.send`, and re-checked for satisfiability against the file;
   * `inviterName` is then unused. Omitted on the quick path, which derives the
   * terms from the columns.
   */
  linkageTerms?: LinkageTerms;
  /** The inviter's edited column metadata, used in the satisfiability
   * re-check and returned. Omitted on the quick path. */
  metadata?: Metadata;
  /** The inviter's authored standardization, used in the satisfiability
   * re-check and returned reconciled. Omitted on the quick path. */
  standardization?: Standardization;
  /** The token's endpoint; webrtc when omitted. */
  connectionEndpoint?: ConnectionEndpointRequest;
  /**
   * The inviter's resolved `retain_files` for a file-sync exchange, declared on
   * the token as `inviterRetainsFiles` so the partner sees it before
   * consenting. A split-directory endpoint declares it regardless
   * ({@link invitationDeclaresRetainedFiles}); the token schema refuses it on
   * webrtc.
   */
  retainsFiles?: boolean;
  /** Which of the inviter's own columns its result file includes, narrowed
   * against the emitted terms and returned. Omitted on the quick path. */
  includeOwnColumns?: OwnColumnsChoice;
}): Promise<GeneratedInvitation> {
  const {
    inviterName,
    file,
    csvDelimiter,
    profiledColumns,
    location,
    lifetimeSeconds = INVITATION_LIFETIME_SECONDS,
    connectionEndpoint = { channel: "webrtc" },
    retainsFiles = false,
    includeOwnColumns = "none",
  } = params;

  // Exactly one input source; neither or both is misuse.
  if ((file === undefined) === (profiledColumns === undefined))
    throw new Error(
      "generateInvitation requires exactly one of file or profiledColumns",
    );

  assertInvitationLifetimeSeconds(lifetimeSeconds);

  // An unreadable file or a row-level parse fault aborts with the typed
  // failure before anything is minted.
  let rawRows: Array<CSVRow>;
  let columns: Array<string>;
  // The profiled path parses nothing here; its caller states the removal
  // from the profile.
  let sanitizedPositions: Array<number> = [];
  if (file !== undefined) {
    try {
      const csvResult = await loadCSVFileOffMainThread(file, {
        ...(csvDelimiter !== undefined ? { delimiter: csvDelimiter } : {}),
      });
      rawRows = csvResult.data;
      columns = csvResult.meta.fields ?? [];
      sanitizedPositions = csvResult.meta.sanitizedColumnPositions;
    } catch (cause) {
      throw new InvitationFileError({ kind: "unreadable", cause });
    }
  } else {
    rawRows = [];
    columns = profiledColumns ?? [];
  }

  // Refuse an empty column name with the typed failure; past here it fails
  // only as a raw error the UI shows as a generic retry.
  const emptyPositions = emptyColumnPositions(columns);
  if (emptyPositions.length > 0)
    throw new InvitationFileError({
      kind: "unnameable",
      positions: emptyPositions,
      sanitizedPositions,
    });

  // Authored terms are embedded as written apart from payload.send; the quick
  // path derives them from the columns.
  let linkageTerms: LinkageTerms;
  // The metadata whose marks decide what is disclosed.
  let disclosureMetadata: Metadata;
  if (params.linkageTerms !== undefined) {
    linkageTerms = params.linkageTerms;
    // Re-check with the inputs the inviter's own run is graded on: a token
    // the run refuses would fail after the partner accepted it.
    const verdict = decideLinkageTermsVerdict(
      columns,
      linkageTerms,
      params.standardization,
      params.metadata,
    );
    const refusal = linkageRefusalFor(
      verdict,
      verdict.unsatisfiedFieldColumns.map(({ field }) => field),
      columns,
    );
    if (refusal !== undefined)
      throw new InvitationFileError({ kind: "unlinkable", refusal });
    // A safety check behind the editor: the consent screen must not misstate
    // what is sent, and prepareForExchange's check runs too late for it.
    if (params.metadata !== undefined)
      assertPayloadSendDisclosed(
        linkageTerms.payload,
        params.metadata,
        linkageTerms.output,
      );
    disclosureMetadata =
      params.metadata ?? inferMetadata(columns, sanitizedPositions);
  } else {
    const metadata = inferMetadata(columns, sanitizedPositions);
    disclosureMetadata = metadata;
    linkageTerms = getDefaultLinkageTerms(inviterName, metadata);

    // The alert names missing field types from the full default terms, since
    // the narrowed set no longer declares them.
    const refusal = linkageRefusalFor(
      decideLinkageTermsVerdict(columns, linkageTerms, undefined, metadata),
      assessLinkageSatisfiability(columns, getDefaultLinkageTerms(inviterName))
        .unsatisfied,
      columns,
    );
    if (refusal !== undefined)
      throw new InvitationFileError({ kind: "unlinkable", refusal });
  }

  // State payload.send from the disclosing metadata, as the CLI's mint does.
  linkageTerms = termsStatingDeclaredPayloadSend(
    linkageTerms,
    disclosureMetadata,
  );

  // Quick-path header names are unbounded, and encode would refuse an
  // over-long one only as a raw ZodError.
  const overlongPositions =
    overlongDisclosedColumnPositions(disclosureMetadata);
  if (overlongPositions.length > 0)
    throw new InvitationFileError({
      kind: "overlong",
      positions: overlongPositions,
    });

  // prepareForExchange refuses fan-out only at exchange time, after the
  // invitation is sent; the CLI's mint runs the same check.
  assertFanOutImplemented(linkageTerms, params.standardization);

  // A step whose compile throws would abort both runs after the invitation
  // was accepted; no editor validation runs this check.
  assertTransformsCompile(linkageTerms, params.standardization);

  // Reconcile the cleaning to the embedded terms once: every copy of the mint
  // (managed record, CLI exchange file, console job config) passes it to
  // prepareForExchange with no check of its own.
  const standardization =
    params.standardization === undefined
      ? undefined
      : standardizationForTerms(params.standardization, linkageTerms);
  if (standardization !== undefined)
    assertStandardizationMatchesTerms(standardization, linkageTerms);

  // encodeInvitation re-checks that the expiry is in the future.
  const expires = invitationExpires(lifetimeSeconds, Date.now());
  const sharedSecret = generateSharedSecret();
  const declaresRetainedFiles = invitationDeclaresRetainedFiles({
    connectionEndpoint,
    retainsFiles,
  });
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
    sharedSecret,
    expires,
    connectionEndpoint: resolveConnectionEndpoint(connectionEndpoint, location),
    ...(declaresRetainedFiles ? { inviterRetainsFiles: true } : {}),
  };

  const encoded = await encodeInvitation(token);
  return {
    encoded,
    deepLink: deepLinkFor(location.origin, encoded),
    sharedSecret,
    expires,
    linkageTerms,
    rawRows,
    columns,
    metadata: params.metadata,
    standardization,
    // Terms that leave this party no result file omit the field.
    ...ownColumnsField(includeOwnColumns, linkageTerms),
  };
}
