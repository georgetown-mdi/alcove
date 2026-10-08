import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  LinkageTermsSchema,
  MAX_PARAMS_ENTRIES,
} from "./linkageTermsSchema.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { redactAndFitUnescaped } from "../utils/sanitizeErrorForDisplay.js";
import { DEFAULT_MAX_DISPLAY_LENGTH } from "../utils/sanitizeForDisplay.js";
import { SHARED_SECRET_REGEX, relayLocatorSchema } from "./connection.js";
import type { RelayLocator } from "./connection.js";
import { pathsResolveToSameDir } from "../utils/pathCompare.js";
import { parseBoundedJson } from "../utils/boundedJson.js";
import { fromBase64Url } from "../utils/crypto.js";
import { UsageError } from "../errors.js";

// --- Connection endpoint -----------------------------------------------------

/**
 * A WebRTC signaling locator: where the acceptor reaches the PeerJS
 * peer-coordination server, and optionally the inviting party's relay. Has no
 * PeerJS API key, relay credential, or other secret.
 */
export interface WebRTCEndpoint {
  channel: "webrtc";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** URL path for WebRTC signaling; non-empty when present. */
  path?: string;
  /**
   * The inviter's relay, TURN and STUN urls only, used in place of the
   * acceptor's own (`WebRTCConnectionConfig.invitationRelay`).
   */
  relay?: RelayLocator;
}

/** An SFTP locator: the host (and optional port and remote path) to reach. */
export interface SFTPEndpoint {
  channel: "sftp";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** Remote working directory (shared mode); non-empty when present. */
  path?: string;
  /**
   * Peer-written directory as the inviter sees it; the acceptor swaps the pair
   * (`connectionFromEndpoint`, apps/cli). Set together with
   * {@link outboundPath}, mutually exclusive with {@link path}.
   */
  inboundPath?: string;
  /** Self-written directory; the companion to {@link inboundPath}. */
  outboundPath?: string;
}

/** A file-drop locator: the shared directory both parties rendezvous in. */
export interface FileDropEndpoint {
  channel: "filedrop";
  /**
   * The inviter's shared directory, which the acceptor may remap to its own
   * mount. Exactly one of this and the split pair is present.
   */
  path?: string;
  /**
   * Peer-written directory as the inviter sees it; see
   * {@link SFTPEndpoint.inboundPath}.
   */
  inboundPath?: string;
  /** Self-written directory; the companion to {@link inboundPath}. */
  outboundPath?: string;
}

/**
 * A connection locator an invitation may include, discriminated by `channel`.
 * {@link ConnectionEndpointSchema} rejects any field outside the per-channel
 * allowlist (docs/SECURITY_DESIGN.md#invitation-contents-and-confidentiality).
 */
export type ConnectionEndpoint =
  WebRTCEndpoint | SFTPEndpoint | FileDropEndpoint;

// Fits one rejected key name, of any length the invitation admits, to one
// value's display budget.
const fittedEndpointKeyName = (name: string): string =>
  redactAndFitUnescaped(name, DEFAULT_MAX_DISPLAY_LENGTH);

// Rejects any field outside a channel's locator allowlist rather than
// stripping it, leading with the allowlist so a benign field is not called a
// credential.
const endpointKeyError: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "unrecognized_keys") {
    // Key names are partner-controlled and composed raw; the display sink
    // escapes them (CONTRIBUTING.md, Operator-facing escaping).
    return (
      "a connection endpoint may hold only a credential-free locator (channel " +
      "plus host/port/path and, on webrtc, a relay of turn and stun urls, or " +
      "an inbound_path/outbound_path pair for a split " +
      "file-sync directory), so that no password, private key, or host-key " +
      "fingerprint is sent in an invitation. Remove unexpected " +
      "field(s): " +
      issue.keys.map(fittedEndpointKeyName).join(", ")
    );
  }
  // undefined keeps Zod's default message for every other failure.
  return undefined;
};

// The inviter's relay: TURN and STUN urls only. Any other key, a credential
// included, is refused rather than stripped.
const InvitationRelayLocatorSchema = relayLocatorSchema(
  (keys) =>
    "a connection endpoint's relay may carry only turn and stun url lists; " +
    "a relay credential is derived by each party from the shared secret and " +
    "is never part of an invitation. Remove unexpected field(s): " +
    keys.map(fittedEndpointKeyName).join(", "),
);

/**
 * The relay locator an inviter names in its invitation, from its own relay's
 * TURN and STUN urls, or `undefined` when it has none. Takes urls alone, so no
 * credential can reach the result.
 */
export function relayLocatorFromOwnRelay(
  ownRelay:
    { turn?: ReadonlyArray<string>; stun?: ReadonlyArray<string> } | undefined,
): RelayLocator | undefined {
  const turn = ownRelay?.turn ?? [];
  const stun = ownRelay?.stun ?? [];
  if (turn.length === 0 && stun.length === 0) return undefined;
  return {
    ...(turn.length > 0 ? { turn: [...turn] } : {}),
    ...(stun.length > 0 ? { stun: [...stun] } : {}),
  };
}

/**
 * Upper bound on a partner-controlled endpoint `host`, webrtc and sftp alike,
 * above a 253-character FQDN. Length only, so an IPv6 literal, an internal name
 * or a punycode IDN is not refused.
 */
export const MAX_ENDPOINT_HOST_LENGTH = 256;

/**
 * Upper bound on a partner-controlled endpoint `path`, anchored to POSIX
 * `PATH_MAX`. Defense in depth beside {@link MAX_ENCODED_INVITATION_LENGTH}.
 */
export const MAX_ENDPOINT_PATH_LENGTH = 4096;

// No z.ZodType<T> annotation on these members: z.discriminatedUnion needs a
// concrete ZodObject. ConnectionEndpointSchema is annotated instead.
/**
 * The credential-free WebRTC locator schema, strict, so any field outside
 * `channel`/`host`/`port`/`path`/`relay` is rejected. Exported as the shape
 * `connectionFromLocator` (exchangeFile.ts) composes a webrtc connection from.
 */
export const WebRTCEndpointSchema = z.strictObject(
  {
    channel: z.literal("webrtc"),
    host: z.string().min(1).check(maxCodeUnits(MAX_ENDPOINT_HOST_LENGTH)),
    // Port 0 (OS-assigned) is never a connect target, so this is stricter than
    // connection.ts.
    port: z.int().min(1).max(65535).optional(),
    path: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    relay: InvitationRelayLocatorSchema.optional(),
  },
  { error: endpointKeyError },
);

const SFTPEndpointSchema = z.strictObject(
  {
    channel: z.literal("sftp"),
    host: z.string().min(1).check(maxCodeUnits(MAX_ENDPOINT_HOST_LENGTH)),
    // >= 1: see the WebRTCEndpointSchema port note.
    port: z.int().min(1).max(65535).optional(),
    path: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    // The inviter's split pair, which the acceptor swaps. The refines below
    // enforce both-or-neither, exclusion with `path` and distinctness;
    // connection.ts checks absoluteness on the acceptor's remapped config.
    inboundPath: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    outboundPath: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    // No identity field: the acceptor configures its SSH identity in its own
    // connection block.
  },
  { error: endpointKeyError },
);

// Paths are checked non-empty, not absolute: the acceptor remaps the inviter's
// mount path, and connection.ts checks absoluteness on its final config. The
// refines below require exactly one directory form.
const FileDropEndpointSchema = z.strictObject(
  {
    channel: z.literal("filedrop"),
    path: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    inboundPath: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
    outboundPath: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .optional(),
  },
  { error: endpointKeyError },
);

/**
 * The directory fields of a file-sync endpoint, or undefined for webrtc.
 * Mirrors `fileSyncPathMode` in connection.ts.
 */
function endpointDirMode(
  endpoint: ConnectionEndpoint,
): { path?: string; inboundPath?: string; outboundPath?: string } | undefined {
  if (endpoint.channel === "sftp" || endpoint.channel === "filedrop")
    return {
      path: endpoint.path,
      inboundPath: endpoint.inboundPath,
      outboundPath: endpoint.outboundPath,
    };
  return undefined;
}

/**
 * Whether every connection built from an endpoint runs in retain mode: true for
 * a file-sync endpoint with the split pair, which {@link ConnectionConfigSchema}
 * refuses without `retain_files`. The accept path's retain seeding and the
 * consent summary both read this, whatever
 * {@link InvitationToken.inviterRetainsFiles} declares.
 */
export function endpointRequiresRetainedFiles(
  endpoint: ConnectionEndpoint | undefined,
): boolean {
  if (endpoint === undefined) return false;
  // The pair is whole or absent (the refine below), so the inbound half decides.
  return endpointDirMode(endpoint)?.inboundPath !== undefined;
}

const ConnectionEndpointSchema: z.ZodType<ConnectionEndpoint> = z
  .discriminatedUnion("channel", [
    WebRTCEndpointSchema,
    SFTPEndpointSchema,
    FileDropEndpointSchema,
  ])
  // Both halves or neither: a lone half cannot be swapped into a pair. Mirrors
  // connection.ts.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (m === undefined) return true;
      return (m.inboundPath !== undefined) === (m.outboundPath !== undefined);
    },
    {
      message:
        "inbound_path and outbound_path must be set together; a split " +
        "directory endpoint needs both halves",
    },
  )
  // The halves must differ. Distinctness survives the swap, so it is checked
  // here at decode, by the same function connection.ts applies.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (
        m === undefined ||
        m.inboundPath === undefined ||
        m.outboundPath === undefined
      )
        return true;
      return !pathsResolveToSameDir(m.inboundPath, m.outboundPath);
    },
    {
      message:
        "inbound_path and outbound_path on a connection endpoint must differ",
    },
  )
  // A directory is named in one form or the other, never both.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (m === undefined) return true;
      const hasPair =
        m.inboundPath !== undefined || m.outboundPath !== undefined;
      return !(m.path !== undefined && hasPair);
    },
    {
      message:
        "set either a single path or the inbound_path/outbound_path pair on a " +
        "connection endpoint, not both",
    },
  )
  // filedrop must name a directory in one form or the other; sftp may leave all
  // three unset (the SFTP login-home shared directory), as in connection.ts.
  .refine(
    (endpoint) => {
      if (endpoint.channel !== "filedrop") return true;
      const hasPair =
        endpoint.inboundPath !== undefined &&
        endpoint.outboundPath !== undefined;
      return endpoint.path !== undefined || hasPair;
    },
    {
      message:
        "a filedrop endpoint requires a directory: set path, or both " +
        "inbound_path and outbound_path",
    },
  );

// --- Token -------------------------------------------------------------------

/**
 * The invitation token passed from inviter to acceptor out of band: linkage
 * terms, the short-lived shared secret, and an optional locator-only
 * {@link ConnectionEndpoint}. Confidential, since the secret authenticates its
 * holder (docs/SECURITY_DESIGN.md#invitation-contents-and-confidentiality).
 */
export interface InvitationToken {
  /**
   * Token format version, bumped only on a change an existing decoder cannot
   * read. An optional top-level field is compatible (the top level is
   * non-strict); a field added to a strict endpoint sub-schema is not, and once
   * a release ships it must bump the version. The split pair and `relay` were
   * added before any release, without a bump.
   */
  version: "1";
  linkageTerms: LinkageTerms;
  /**
   * Short-lived setup secret, rotated to a persistent shared secret on first
   * successful exchange.
   */
  sharedSecret: string;
  /** ISO 8601 datetime after which this token is rejected at accept time. */
  expires?: string;
  /** Optional locator-only connection endpoint. */
  connectionEndpoint?: ConnectionEndpoint;
  /**
   * The inviter's declaration that its exchange runs in retain mode, shown to
   * the acceptor before it consents
   * (docs/spec/FILE_SYNC.md#retain-mode-declaration-on-the-token). Never read
   * into a connection: a mismatch fails at the hello. Absence means nothing
   * declared. The schemas refuse it where the endpoint contradicts it.
   */
  inviterRetainsFiles?: boolean;
}

// Mirrors linkageTermsSchema.ts's module-private PARAMS_WIDTH_BOUND; both
// derive from MAX_PARAMS_ENTRIES.
const PARAMS_WIDTH_BOUND: ReadonlyMap<string, number> = new Map([
  ["params", MAX_PARAMS_ENTRIES],
]);

/**
 * {@link LinkageTermsSchema} behind the bounded {@link camelizeKeys} pre-pass,
 * so a token's `transform.params` fold to camelCase before the length screens
 * and dialect gate read them, as on every other parse path. The pre-pass can
 * throw (`NestingDepthExceededError`, `NodeCountExceededError`), so this stays
 * off the public export: a throwing preprocess breaks `.safeParse()`.
 */
export const InvitationLinkageTermsSchema: z.ZodType<LinkageTerms> =
  z.preprocess(
    (raw) => camelizeKeys(raw, PARAMS_WIDTH_BOUND),
    LinkageTermsSchema,
  );

const InvitationTokenBodySchema = z.object({
  version: z.literal("1"),
  // Camelizes transform.params before validating (InvitationLinkageTermsSchema).
  linkageTerms: InvitationLinkageTermsSchema,
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "invitation sharedSecret must be a base64url-encoded 32-byte value " +
        "(43 base64url characters; final character must be in " +
        "[AEIMQUYcgkosw048])",
    ),
  expires: z.iso.datetime().optional(),
  connectionEndpoint: ConnectionEndpointSchema.optional(),
  // Top-level and optional, so an older decoder ignores it. No default:
  // absence means nothing declared.
  inviterRetainsFiles: z.boolean().optional(),
});

const InvitationTokenSchema: z.ZodType<InvitationToken> =
  InvitationTokenBodySchema
    // A webrtc endpoint has no retain mode, so a retain declaration beside it
    // states a mode no run could be in. A token with no endpoint is
    // unconstrained.
    .refine(
      (token) =>
        token.connectionEndpoint?.channel !== "webrtc" ||
        token.inviterRetainsFiles !== true,
      {
        message:
          "inviterRetainsFiles is not valid for a webrtc connection endpoint; " +
          "retain mode is a file-sync setting the webrtc channel does not have",
        path: ["inviterRetainsFiles"],
      },
    )
    // A split endpoint requires retain mode (endpointRequiresRetainedFiles), so
    // an explicit `false` beside it is refused the same way. An omitted field
    // declares nothing.
    .refine(
      (token) =>
        !endpointRequiresRetainedFiles(token.connectionEndpoint) ||
        token.inviterRetainsFiles !== false,
      {
        message:
          "inviterRetainsFiles cannot be false for a connection endpoint with " +
          "the inbound_path/outbound_path pair; a split directory " +
          "requires retain mode of every connection built from it",
        path: ["inviterRetainsFiles"],
      },
    );

/**
 * {@link InvitationTokenSchema} plus a rule binding a mint only: a split
 * endpoint must declare `inviterRetainsFiles: true`, so an artifact composed
 * from the declaration states the retention. Decode still accepts an omitted
 * declaration, since every read path derives retention from the endpoint's
 * shape.
 */
const MintedInvitationTokenSchema: z.ZodType<InvitationToken> =
  InvitationTokenSchema.refine(
    (token) =>
      !endpointRequiresRetainedFiles(token.connectionEndpoint) ||
      token.inviterRetainsFiles === true,
    {
      message:
        "inviterRetainsFiles must be true on an invitation whose connection " +
        "endpoint has the inbound_path/outbound_path pair, because a split " +
        "directory keeps every exchange file",
      path: ["inviterRetainsFiles"],
    },
  );

// --- Lifetime policy ---------------------------------------------------------

/**
 * The web app's accept route: `<app origin>` + this path + `#` + the encoded
 * invitation. The token is in the fragment, so it never reaches the server.
 */
export const INVITATION_ACCEPT_ROUTE_PATH = "/accept";

/**
 * Default invitation lifetime in seconds: one hour
 * (docs/SECURITY_DESIGN.md#recurring-exchange-authentication). Both inviters
 * read this value.
 */
export const INVITATION_LIFETIME_SECONDS = 60 * 60;

/**
 * Upper bound on an invitation lifetime in seconds: one year. Each inviter
 * refuses an over-ceiling lifetime before minting; {@link encodeInvitation}
 * checks only that `expires` is in the future.
 */
export const MAX_INVITATION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/**
 * Refuse an invitation lifetime that is not a finite, positive number of
 * seconds within {@link MAX_INVITATION_LIFETIME_SECONDS}. An inviter calls it
 * before anything is minted; {@link invitationExpires} applies it again at the
 * mint.
 *
 * @throws {RangeError} naming which bound `lifetimeSeconds` breaks.
 */
export function assertInvitationLifetimeSeconds(lifetimeSeconds: number): void {
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0)
    throw new RangeError(
      "invitation lifetimeSeconds must be a finite, positive number of seconds",
    );
  if (lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS)
    throw new RangeError(
      "invitation lifetimeSeconds must not exceed " +
        `${MAX_INVITATION_LIFETIME_SECONDS} seconds (one year)`,
    );
}

/**
 * An invitation's `expires`: `now` plus `lifetimeSeconds`, as an ISO 8601 UTC
 * instant. The caller passes the moment the shared secret is minted, so the
 * lifetime runs from when the secret exists.
 *
 * @throws {RangeError} if `lifetimeSeconds` fails
 *   {@link assertInvitationLifetimeSeconds}.
 */
export function invitationExpires(
  lifetimeSeconds: number,
  now: number,
): string {
  assertInvitationLifetimeSeconds(lifetimeSeconds);
  return new Date(now + lifetimeSeconds * 1000).toISOString();
}

// --- Base64url helpers -------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// --- Encode / Decode ---------------------------------------------------------

// 4 bytes always encodes to exactly 6 unpadded base64url characters (3 bytes ->
// 4 chars, 1 byte -> 2 chars)
const CHECKSUM_CHARS = 6;

/**
 * Upper bound on an encoded invitation, checked by {@link decodeInvitation}
 * before any other work. The checksum is no barrier to a crafted payload, so
 * this cap bounds every untrusted field at decode; the per-field bounds are
 * defense in depth. {@link encodeInvitation} applies the same cap.
 */
export const MAX_ENCODED_INVITATION_LENGTH = 64 * 1024;

/**
 * Bound on a raw pasted invitation, checked before
 * {@link stripInvitationWhitespace} does any work: twice the encoded bound
 * leaves room for hard-wrap whitespace.
 */
export const MAX_RAW_INVITATION_LENGTH = 2 * MAX_ENCODED_INVITATION_LENGTH;

/**
 * Serialize an {@link InvitationToken} as base64url plus a 4-byte truncated
 * SHA-256 checksum, which detects transcription errors only. Every Alcove
 * invitation is emitted here, validated against the stricter
 * {@link MintedInvitationTokenSchema}.
 *
 * @throws {UsageError} if `expires` is not in the future, or the encoded token
 *   exceeds {@link MAX_ENCODED_INVITATION_LENGTH} (a long exclude list can).
 * @throws {ZodError} if the token fails {@link MintedInvitationTokenSchema}.
 * @throws {NestingDepthExceededError|NodeCountExceededError} from the
 *   camelCase pre-pass, reachable only through a type-bypassed `token`.
 */
export async function encodeInvitation(
  token: InvitationToken,
): Promise<string> {
  // Serialize the parse result: the top-level schema is non-strict for
  // forward compatibility, and parsing strips a type-bypassed extra field.
  const validated = MintedInvitationTokenSchema.parse(token);
  if (
    validated.expires !== undefined &&
    new Date(validated.expires) <= new Date()
  ) {
    throw new UsageError("invitation expires must be in the future");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
  const encoded = body + checksum;
  // In-bounds fields can still exceed the decode cap in aggregate; refuse on
  // the inviter's side rather than at the partner's decode.
  if (encoded.length > MAX_ENCODED_INVITATION_LENGTH) {
    throw new UsageError(
      `the invitation is ${encoded.length} characters encoded, over the ` +
        `maximum of ${MAX_ENCODED_INVITATION_LENGTH}, so the partner could ` +
        "not read it; shorten the linkage terms, for example the exclude " +
        "list of a linkage field, and create the invitation again",
    );
  }
  return encoded;
}

/**
 * Remove every ECMAScript `\s` character, interior included, from a pasted
 * invitation, so a token wrapped by an email or chat client decodes. The full
 * class matches what `String.prototype.trim` strips ahead of it. An input over
 * {@link MAX_RAW_INVITATION_LENGTH} is returned unchanged, for the decode
 * boundary to refuse. Never throws.
 */
export function stripInvitationWhitespace(input: string): string {
  if (input.length > MAX_RAW_INVITATION_LENGTH) {
    return input;
  }
  return input.replace(/\s+/g, "");
}

/**
 * Why {@link decodeInvitation} could not read a string before schema
 * validation: a transcription fault (`tooShort`, `notBase64Url`,
 * `checksumMismatch`), or an intact string this build does not read (`tooLong`,
 * `notJson`).
 */
export type InvitationDecodeFailure =
  "tooLong" | "tooShort" | "notBase64Url" | "checksumMismatch" | "notJson";

/**
 * The error {@link decodeInvitation} throws for an {@link InvitationDecodeFailure},
 * so a surface can choose its remedy from `failure` rather than the message text.
 */
export class InvitationDecodeError extends Error {
  readonly failure: InvitationDecodeFailure;
  constructor(failure: InvitationDecodeFailure, message: string) {
    super(message);
    this.name = "InvitationDecodeError";
    this.failure = failure;
  }
}

/**
 * Decode an invitation from {@link encodeInvitation}, verifying the checksum
 * and the schema. Does not check expiry ({@link isInvitationExpired}).
 *
 * @throws {InvitationDecodeError} if the string is too long (checked first),
 *   too short, not base64url, fails the checksum, or is not JSON.
 * @throws {ZodError} on schema validation failure.
 * @throws {NestingDepthExceededError|NodeCountExceededError} from the
 *   camelCase pre-pass; both are `UsageError` subclasses.
 */
export async function decodeInvitation(
  encoded: string,
): Promise<InvitationToken> {
  // The checksum gates nothing, so this cap is the size bound.
  if (encoded.length > MAX_ENCODED_INVITATION_LENGTH) {
    throw new InvitationDecodeError(
      "tooLong",
      "the invitation exceeds the maximum length of " +
        `${MAX_ENCODED_INVITATION_LENGTH} characters`,
    );
  }
  if (encoded.length <= CHECKSUM_CHARS) {
    throw new InvitationDecodeError("tooShort", "the invitation is too short");
  }
  const body = encoded.slice(0, -CHECKSUM_CHARS);
  const receivedChecksum = encoded.slice(-CHECKSUM_CHARS);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(body);
  } catch {
    // A fixed message, so nothing derived from the partner's body reaches a
    // display.
    throw new InvitationDecodeError(
      "notBase64Url",
      "the invitation contains characters an invitation cannot hold",
    );
  }
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const expectedChecksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));

  if (receivedChecksum !== expectedChecksum) {
    throw new InvitationDecodeError(
      "checksumMismatch",
      "invitation checksum mismatch",
    );
  }

  let raw: unknown;
  try {
    // Bounds the structure before parsing and fatal-decodes the UTF-8.
    raw = parseBoundedJson(bytes);
  } catch {
    throw new InvitationDecodeError(
      "notJson",
      "invitation payload is not valid JSON",
    );
  }
  return InvitationTokenSchema.parse(raw);
}

/**
 * The verdict for an instant {@link hasExpiryInstantPassed} cannot read. The
 * safe direction depends on what the bound governs, so the caller states it.
 */
type UnparseableExpiryVerdict = "fail-closed" | "fail-open";

/**
 * Whether `expires` is present and at or before `now`; a bound equal to `now`
 * has passed. The comparison every acceptor and managed-exchange screen uses.
 * `onUnparseable` has no default, since `NaN <= x` is false: the call site
 * decides, for an unreadable `now` as well.
 */
export function hasExpiryInstantPassed(
  expires: string | undefined,
  now: Date,
  { onUnparseable }: { onUnparseable: UnparseableExpiryVerdict },
): boolean {
  if (expires === undefined) return false;
  const expiresMs = new Date(expires).getTime();
  const nowMs = now.getTime();
  if (Number.isNaN(expiresMs) || Number.isNaN(nowMs))
    return onUnparseable === "fail-closed";
  return expiresMs <= nowMs;
}

/**
 * Whether an invitation is rejected on expiry at `now`, failing closed: an
 * `expires` equal to `now` or unparseable is expired. Decode already refuses a
 * non-ISO `expires`; this does not rely on it. Shared by the CLI and web
 * acceptors.
 */
export function isInvitationExpired(
  expires: string | undefined,
  now: Date = new Date(),
): boolean {
  return hasExpiryInstantPassed(expires, now, { onUnparseable: "fail-closed" });
}
