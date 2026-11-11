import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  InvitationLinkageTermsSchema,
  PARAMS_WIDTH_BOUND,
} from "./linkageTermsSchema.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { redactAndFitUnescaped } from "../utils/sanitizeErrorForDisplay.js";
import { DEFAULT_MAX_DISPLAY_LENGTH } from "../utils/sanitizeForDisplay.js";
import { SHARED_SECRET_REGEX, relayLocatorSchema } from "./connection.js";
import type { RelayLocator } from "./connection.js";
import {
  directoryFormsAreExclusive,
  fileSyncDirectories,
  filedropNamesDirectory,
  splitDirectoriesAreWhole,
  splitDirectoriesDiffer,
  type FileSyncDirectories,
} from "./fileSyncDirectories.js";
import { DialPortSchema } from "./dialPort.js";
import { parseBoundedJson } from "../utils/boundedJson.js";
import { fromBase64Url, toBase64Url } from "../utils/crypto.js";
import { UsageError } from "../errors.js";
import { sftpRelayUrlRefusal } from "./sftpRelayUrl.js";
import {
  declaredFormatVersion,
  droppedMemberIssues,
  FORMAT_VERSION_TEXT,
  FormatInfoBlockSchema,
  formatVersionBelowNeededIssues,
  formatVersionNeeded,
  newerFormatMemberErrorMap,
  newerFormatVersionMessage,
  withoutOldDefaults,
  type FormatInfoBlock,
  type FormatVersionPolicy,
} from "./formatVersion.js";

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
   * The inviter's relay, its TURN and STUN urls, its WebSocket relay's url
   * with the exchange id that relay holds the key under, and the registrar a
   * run enrolls at without a token, listed beside the acceptor's own
   * (`WebRTCConnectionConfig.invitationRelay`).
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
  /**
   * The `wss://` url of the SFTP relay in front of the server, which a
   * browser party dials to reach it unless it sets its own
   * (docs/spec/INVITATION_TOKEN.md#the-sftp-relay-url). The CLI and the
   * console connect over TCP and do not read it.
   */
  relayUrl?: string;
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
      "plus host/port/path and, on webrtc, a relay of turn and stun urls, " +
      "a websocket url with its exchange id, and a registrar url, on sftp, " +
      "its SFTP relay's wss url, or " +
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

// The inviter's relay: TURN and STUN urls, a WebSocket relay url with its
// exchange id, and a registrar url only. Any other key, a credential included,
// is refused rather than stripped.
const InvitationRelayLocatorSchema = relayLocatorSchema(
  (keys) =>
    "a connection endpoint's relay may hold only turn and stun url lists, " +
    "a websocket url with its exchange id, and a registrar url; " +
    "a relay credential is derived by each party from the shared secret and " +
    "is never part of an invitation. Remove unexpected field(s): " +
    keys.map(fittedEndpointKeyName).join(", "),
);

/**
 * The relay locator an inviter names in its invitation, from its own relay's
 * TURN and STUN urls and its WebSocket relay's url, with the exchange id that
 * relay holds the key under beside the url only, or `undefined` when it has
 * none. Takes urls and that id alone, so no credential can reach the result.
 */
export function relayLocatorFromOwnRelay(
  ownRelay:
    | {
        turn?: ReadonlyArray<string>;
        stun?: ReadonlyArray<string>;
        websocket?: string;
        websocketExchangeId?: string;
      }
    | undefined,
): RelayLocator | undefined {
  const turn = ownRelay?.turn ?? [];
  const stun = ownRelay?.stun ?? [];
  const websocket = ownRelay?.websocket;
  if (turn.length === 0 && stun.length === 0 && websocket === undefined)
    return undefined;
  const websocketExchangeId =
    websocket !== undefined ? ownRelay?.websocketExchangeId : undefined;
  return {
    ...(turn.length > 0 ? { turn: [...turn] } : {}),
    ...(stun.length > 0 ? { stun: [...stun] } : {}),
    ...(websocket !== undefined ? { websocket } : {}),
    ...(websocketExchangeId !== undefined ? { websocketExchangeId } : {}),
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
    // Stricter than the connection block's webrtc server port, which admits 0.
    port: DialPortSchema.optional(),
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
    port: DialPortSchema.optional(),
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
    relayUrl: z
      .string()
      .superRefine((url, ctx) => {
        const refusal = sftpRelayUrlRefusal(url, "relayUrl");
        if (refusal !== undefined)
          ctx.addIssue({
            code: "custom",
            message: refusal.message,
            params: { sftpRelayUrlProblem: refusal.problem },
          });
      })
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

function endpointDirectories(
  endpoint: ConnectionEndpoint,
): FileSyncDirectories | undefined {
  return fileSyncDirectories(endpoint.channel, endpoint);
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
  return endpointDirectories(endpoint)?.inboundPath !== undefined;
}

// The directory rules of connection.ts, in this site's own order and wording
// (fileSyncDirectories.ts). Distinctness survives the acceptor's swap, so it is
// checked here at decode.
const ConnectionEndpointSchema: z.ZodType<ConnectionEndpoint> = z
  .discriminatedUnion("channel", [
    WebRTCEndpointSchema,
    SFTPEndpointSchema,
    FileDropEndpointSchema,
  ])
  // A lone half cannot be swapped into a pair.
  .refine(
    (endpoint) => splitDirectoriesAreWhole(endpointDirectories(endpoint)),
    {
      message:
        "inbound_path and outbound_path must be set together; a split " +
        "directory endpoint needs both halves",
    },
  )
  .refine((endpoint) => splitDirectoriesDiffer(endpointDirectories(endpoint)), {
    message:
      "inbound_path and outbound_path on a connection endpoint must differ",
  })
  .refine(
    (endpoint) => directoryFormsAreExclusive(endpointDirectories(endpoint)),
    {
      message:
        "set either a single path or the inbound_path/outbound_path pair on a " +
        "connection endpoint, not both",
    },
  )
  .refine(
    (endpoint) =>
      filedropNamesDirectory(endpoint.channel, endpointDirectories(endpoint)),
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
   * Token format version, a decimal string. {@link encodeInvitation} writes
   * the lowest version the token's content needs, whatever this states;
   * {@link decodeInvitation} refuses one above {@link INVITATION_VERSION_POLICY}'s.
   */
  version: string;
  /** Notes about the token that no reader acts on. */
  about?: FormatInfoBlock;
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
   * (docs/spec/FILE_SYNC_MODES.md#retain-mode-declaration-on-the-token). Never read
   * into a connection: a mismatch fails at the hello. Absence means nothing
   * declared. The schemas refuse it where the endpoint contradicts it.
   */
  inviterRetainsFiles?: boolean;
}

/** @internal */
export { InvitationLinkageTermsSchema };

// Each member of a token's or terms update's `linkageTerms` that
// InvitationLinkageTermsSchema dropped, refused as one a newer Alcove wrote.
// Runs on a successful parse of `rawTerms` only.
function droppedLinkageTermsIssues(
  fileName: string,
  remedy: string,
  rawTerms: unknown,
  parsedTerms: LinkageTerms,
): Array<z.core.$ZodIssue> {
  return droppedMemberIssues(
    fileName,
    remedy,
    ["linkageTerms"],
    rawTerms,
    camelizeKeys(rawTerms, PARAMS_WIDTH_BOUND),
    parsedTerms,
  );
}

// A token's or terms update's body as the file states it, before any schema
// default, with its `linkageTerms` folded to camelCase as
// InvitationLinkageTermsSchema folds them: what the version-needed check
// reads. Runs on a successful parse of `body` only.
function statedBody(body: unknown): Record<string, unknown> {
  const fields = body as Record<string, unknown>;
  return {
    ...fields,
    linkageTerms: camelizeKeys(fields["linkageTerms"], PARAMS_WIDTH_BOUND),
  };
}

/**
 * What a token or terms update whose body parsed is still refused for, in
 * order: each member of its `linkageTerms` the parse dropped, as one a newer
 * Alcove wrote, then a field needing a version above the one `version`
 * declares. Empty where neither applies. `raw` is the body as decoded, before
 * the parse that produced `parsed`.
 *
 * @internal not a stable public API.
 */
export function parsedBodyRefusals(
  fileName: string,
  remedy: string,
  raw: unknown,
  parsed: { version: string; linkageTerms: LinkageTerms },
  policy: FormatVersionPolicy,
): Array<z.core.$ZodIssue> {
  return [
    ...droppedLinkageTermsIssues(
      fileName,
      remedy,
      (raw as Record<string, unknown>)["linkageTerms"],
      parsed.linkageTerms,
    ),
    ...formatVersionBelowNeededIssues(
      fileName,
      "version",
      statedBody(raw),
      Number(parsed.version),
      policy,
    ),
  ];
}

/**
 * The format version table of the invitation token
 * (docs/spec/INVITATION_TOKEN.md#version-policy). An older reader takes no
 * value for the SFTP relay url's absence, so a token naming one is written at
 * version 2 and every other token at version 1.
 */
export const INVITATION_VERSION_POLICY: FormatVersionPolicy = Object.freeze({
  current: 2,
  features: Object.freeze([
    Object.freeze({
      path: Object.freeze(["connectionEndpoint", "relayUrl"]),
      name: "connectionEndpoint.relayUrl",
      version: 2,
    }),
  ]),
});

const INVITATION_FILE_NAME = "The invitation";

/** What to do with an invitation a newer Alcove made. */
export const INVITATION_NEWER_REMEDY =
  "Update Alcove, then open the invitation again.";

/** The `params` of the issue {@link decodeInvitation} raises for a token on a
 * format version newer than the policy's. */
const NEWER_VERSION_PARAMS = Object.freeze({ newerFormatVersion: true });

/**
 * Whether `error` is {@link decodeInvitation}'s refusal of a token on a format
 * version newer than this build reads, whose remedy is updating Alcove
 * ({@link INVITATION_NEWER_REMEDY}) rather than asking for a new invitation.
 */
export function isNewerInvitationVersionError(
  error: unknown,
): error is z.ZodError {
  if (!(error instanceof z.ZodError) || error.issues.length !== 1) return false;
  const [issue] = error.issues;
  return (
    issue?.code === "custom" &&
    issue.params?.["newerFormatVersion"] ===
      NEWER_VERSION_PARAMS.newerFormatVersion
  );
}

// Strict: a member outside this shape is one a newer Alcove wrote, and is
// refused by name rather than dropped. `about` is the one block skipped.
const InvitationTokenBodySchema = z.strictObject(
  {
    version: z.string().regex(FORMAT_VERSION_TEXT),
    about: FormatInfoBlockSchema.optional(),
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
    // No default: absence means nothing declared.
    inviterRetainsFiles: z.boolean().optional(),
  },
  {
    error: newerFormatMemberErrorMap(
      INVITATION_FILE_NAME,
      INVITATION_NEWER_REMEDY,
    ),
  },
);

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
 * {@link MintedInvitationTokenSchema}, at the lowest format version its
 * content needs: a field holding the value an older reader assumes for its
 * absence is left out, and `version` states the version the rest needs.
 *
 * @param policy the token's version table; this build's by default.
 * @throws {UsageError} if `expires` is not in the future, or the encoded token
 *   exceeds {@link MAX_ENCODED_INVITATION_LENGTH} (a long exclude list can).
 * @throws {ZodError} if the token fails {@link MintedInvitationTokenSchema}.
 * @throws {NestingDepthExceededError|NodeCountExceededError} from the
 *   camelCase pre-pass, reachable only through a type-bypassed `token`.
 */
export async function encodeInvitation(
  token: InvitationToken,
  policy: FormatVersionPolicy = INVITATION_VERSION_POLICY,
): Promise<string> {
  // Only the schema's own members are serialized, so a type-bypassed extra
  // field never reaches the wire.
  const lowest = withoutOldDefaults(
    Object.fromEntries(
      Object.entries(token).filter(([name]) =>
        Object.hasOwn(InvitationTokenBodySchema.shape, name),
      ),
    ),
    policy,
  );
  const validated = MintedInvitationTokenSchema.parse({
    ...lowest,
    version: String(formatVersionNeeded(lowest, policy).version),
  });
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
 * A token a newer Alcove made is refused naming what this build does not
 * read: a `version` above the policy's, or a member outside the schema
 * anywhere but the `about` block, which is skipped.
 *
 * @param policy the token's version table; this build's by default.
 * @throws {InvitationDecodeError} if the string is too long (checked first),
 *   too short, not base64url, fails the checksum, or is not JSON.
 * @throws {ZodError} on schema validation failure, a newer version or
 *   member, or a version below what the token's fields need.
 * @throws {NestingDepthExceededError|NodeCountExceededError} from the
 *   camelCase pre-pass; both are `UsageError` subclasses.
 * @throws {KeyFoldCollisionError} if two keys of one object fold to one name.
 */
export async function decodeInvitation(
  encoded: string,
  policy: FormatVersionPolicy = INVITATION_VERSION_POLICY,
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
  // The token's version is a string; a number is left to the schema refusal.
  const stated =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["version"]
      : undefined;
  const declared =
    typeof stated === "string" ? declaredFormatVersion(stated) : undefined;
  if (declared !== undefined && declared > policy.current)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["version"],
        params: NEWER_VERSION_PARAMS,
        message: newerFormatVersionMessage(
          INVITATION_FILE_NAME,
          declared,
          policy.current,
          INVITATION_NEWER_REMEDY,
        ),
      },
    ]);
  const token = InvitationTokenSchema.parse(raw);
  const refused = parsedBodyRefusals(
    INVITATION_FILE_NAME,
    INVITATION_NEWER_REMEDY,
    raw,
    token,
    policy,
  );
  if (refused.length > 0) throw new z.ZodError(refused);
  return token;
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
