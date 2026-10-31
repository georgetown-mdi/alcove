import { z } from "zod";

import {
  enc,
  toBase64Url,
  fromBase64Url,
  bytesEqual,
  hmacSha256,
  sha256,
  hkdfDerive,
} from "./utils/crypto.js";
import type { HandshakeRole } from "./types.js";
import {
  isReceiveDeadlineFailure,
  type MessageConnection,
} from "./connection/messageConnection.js";
import {
  AuthenticationError,
  InternalConsistencyError,
  LocalCopyBehindError,
  PartnerCopyBehindError,
  markPeerWaitTimeout,
} from "./errors.js";
import {
  drawRotationValue,
  unwrapRotationValue,
  wrapRotationValue,
} from "./nextSecret.js";
import {
  BEHIND_NOTICE_MAX_COUNT,
  behindNotice,
  historyProof,
  historyVerifierBytes,
  matchHistoryProof,
  type CheckedHistory,
  type HandshakeShares,
} from "./rotationHistory.js";

// The authenticated key exchange that produces the exchange session key: an
// ephemeral P-256 Diffie-Hellman pinned to the Noise NNpsk0 pattern plus an
// explicit, role-asymmetric mutual key confirmation. Only the NNpsk0 glue --
// key-schedule mixing, the confirmation tags, and their trial verification
// under a previous secret -- is written here; every cryptographic operation is
// a crypto.subtle call, and the full Noise framework is not implemented.
// Construction, key schedule, wire format, and what the vectors pin:
// docs/spec/PROTOCOL.md ("P-256 authenticated key exchange"). Decision and module boundary: docs/SECURITY_DESIGN.md
// ("Key-agreement design") and
// docs/notes/key-establishment-fips-boundary.md.

// The pre-shared secret is psk0, which Noise mandates be 32 bytes.
const PSK_LEN = 32;

// Wire encoding of an ephemeral public key: the SEC1 uncompressed point
// `0x04 || X || Y`, 65 bytes over P-256. Enforcing it is this module's job,
// not importKey's, which accepts other encodings of the same point and not
// the same ones on every platform; docs/spec/PROTOCOL.md ("Curve and point
// encoding") states the pin and what it rests on. kex.test.ts and the browser
// suite drive importKey with the alternative encodings on their own platform,
// so the divergence is measured rather than assumed.
const PUBLIC_KEY_LEN = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

// SP 800-56A Rev 3 Z for P-256: the 32-byte X coordinate of the shared point.
// It is derived straight into a non-extractable HKDF key, never read as bytes.
const SHARED_SECRET_LEN = 32;

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// SHA-256 output length: the width of every chaining-key, handshake-hash, and
// confirmation-tag value, and the block size the Noise chaining HKDF counts in.
const HASH_LEN = 32;

// The Noise "protocol name", which is the initial handshake hash. When it
// is bumped, docs/spec/PROTOCOL.md ("Protocol-version tag") is what governs:
// it states what the tag covers, what a bump is reserved for, and what a
// mismatch does.
const PROTOCOL_NAME = "alcove-kex-v3:NNpsk0_P256_SHA256";

// Domain-separation labels for the derivations below, in the disjoint label
// space docs/spec/PROTOCOL.md ("The domain-separation label space")
// enumerates. Their namespace version does not track the suite tag above; the
// two confirm labels are role-asymmetric.
const SESSION_LABEL = "alcove-kex-v2:session";
const CONFIRM_KEY_LABEL = "alcove-kex-v2:confirm";
const INITIATOR_CONFIRM_LABEL = "alcove-kex-v2:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "alcove-kex-v2:responder-confirm";
const KEY_AGREEMENT_LABEL = "alcove-kex-v2:key-agreement";

// The one message every authentication failure throws, and it must stay
// non-oracular: no throw site may narrow it to the check that failed, and the
// error's class, AuthenticationError, is what consumers classify on. What that
// property covers and what it does not: docs/spec/PROTOCOL.md ("Failure
// handling").
const GENERIC_FAILURE = "key exchange authentication failed";
const TIMEOUT_FAILURE = "key exchange handshake timed out";

// 30 s is a generous ceiling for a single handshake round-trip on any realistic
// network; exceeding it almost certainly means the peer is gone.
const HANDSHAKE_TIMEOUT_MS = 30_000;

// A polling transport adds up to one poll interval on each leg of a round
// trip: the peer finding this party's message, then this party finding the
// reply.
const HANDSHAKE_POLL_INTERVALS_PER_ROUND_TRIP = 2;

// The bound on one handshake receive over `conn`. The connection's own
// inactivity budget still caps the wait (MessageConnection.receive).
function handshakeReceiveTimeoutMs(conn: MessageConnection): number {
  const pollIntervalMs = conn.inboundPollIntervalMs?.() ?? 0;
  return (
    HANDSHAKE_TIMEOUT_MS +
    HANDSHAKE_POLL_INTERVALS_PER_ROUND_TRIP * pollIntervalMs
  );
}

const EMPTY = new Uint8Array(0);

// --- Wire message schemas ----------------------------------------------------
//
// The three handshake messages, whose field encodings are in
// docs/spec/PROTOCOL.md ("Message flow"). Every schema is `.strict()`, so an
// unexpected key fails the parse rather than being silently stripped; keep it
// that way, since the strictness is half of what makes a flag-unaware peer
// fail closed rather than negotiate.

interface KexMsg1 {
  kexMsg: "1";
  e: string;
  reqEnc: boolean;
}

const KexMsg1Schema: z.ZodType<KexMsg1> = z
  .object({
    kexMsg: z.literal("1"),
    e: z.string(),
    reqEnc: z.boolean(),
  })
  .strict();

interface KexMsg2 {
  kexMsg: "2";
  e: string;
  confirm: string;
  previousConfirm: string;
  historyProof: string;
  reqEnc: boolean;
}

const KexMsg2Schema: z.ZodType<KexMsg2> = z
  .object({
    kexMsg: z.literal("2"),
    e: z.string(),
    confirm: z.string(),
    previousConfirm: z.string(),
    historyProof: z.string(),
    reqEnc: z.boolean(),
  })
  .strict();

interface KexMsg3 {
  kexMsg: "3";
  confirm: string;
  initiatorValue: string;
  usedPrevious: boolean;
}

const KexMsg3Schema: z.ZodType<KexMsg3> = z
  .object({
    kexMsg: z.literal("3"),
    confirm: z.string(),
    initiatorValue: z.string(),
    usedPrevious: z.boolean(),
  })
  .strict();

interface BehindNotice {
  count: number;
  tag: string;
}

interface KexAbort {
  kexMsg: "abort";
  historyProof?: string;
  behindNotice?: BehindNotice;
}

const KexAbortSchema: z.ZodType<KexAbort> = z
  .object({
    kexMsg: z.literal("abort"),
    historyProof: z.string().optional(),
    behindNotice: z
      .object({
        count: z.number().int().min(1).max(BEHIND_NOTICE_MAX_COUNT),
        tag: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

// --- Byte helpers ------------------------------------------------------------

function concatBytes(
  ...arrays: Array<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return fromBase64Url(value);
  } catch {
    return undefined;
  }
}

// Canonical single-byte encoding of a flag for the transcript hash and the
// confirmation tags: 0x01 when it is set (a party requests the additional
// application-encryption layer, or a tag is made under the previous
// schedule), 0x00 otherwise. Both implementations (this one and the
// independent vector generator) must agree on these bytes.
function flagByte(requested: boolean): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(requested ? 1 : 0);
}

// --- Noise NNpsk0 symmetric state --------------------------------------------
//
// The minimal subset of Noise's SymmetricState needed for NNpsk0: a chaining
// key `ck` and a handshake hash `h`, with MixHash / MixKey / MixKeyAndHash.
// There is no CipherState: NNpsk0's handshake messages hold no encrypted
// payload here, so the symmetric cipher half of Noise is omitted entirely.

interface SymmetricState {
  ck: Uint8Array<ArrayBuffer>;
  h: Uint8Array<ArrayBuffer>;
}

/**
 * The Noise chaining HKDF, keyed by the running chaining key and returning
 * `numOutputs` 32-byte blocks. It is issued as one `crypto.subtle`
 * `deriveBits` call rather than a chain of HMAC calls assembled here, so the
 * platform -- and any validated module beneath it -- serves the
 * extract-and-expand as a unit; docs/spec/PROTOCOL.md ("Key schedule") states
 * the equality that makes the two forms interchangeable. It differs from the
 * application-level {@link hkdfDerive} (zero salt, named info) because the
 * Noise schedule chains the salt.
 *
 * @internal exported only for the RFC 5869 cross-check test.
 */
export async function noiseHkdf(
  ck: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  numOutputs: 2 | 3,
): Promise<Array<Uint8Array<ArrayBuffer>>> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: ck, info: EMPTY },
      key,
      numOutputs * HASH_LEN * 8,
    ),
  );
  const blocks: Array<Uint8Array<ArrayBuffer>> = [];
  for (let i = 0; i < numOutputs; i++)
    blocks.push(bits.slice(i * HASH_LEN, (i + 1) * HASH_LEN));
  return blocks;
}

/**
 * @internal exported only for the protocol-name rule test.
 */
export async function initializeSymmetric(
  protocolName: string = PROTOCOL_NAME,
): Promise<SymmetricState> {
  // Noise InitializeSymmetric: a name of at most 32 bytes is zero-padded to
  // 32 bytes, a longer one is hashed. PROTOCOL_NAME is exactly 32 bytes, so h0
  // is the name itself.
  const nameBytes = enc.encode(protocolName);
  let h: Uint8Array<ArrayBuffer>;
  if (nameBytes.length <= HASH_LEN) {
    h = new Uint8Array(HASH_LEN);
    h.set(nameBytes);
  } else {
    h = await sha256(nameBytes);
  }
  // Noise sets ck = h here. Keep them as distinct buffers (not one shared
  // reference) so a future in-place mutation of one could never corrupt the
  // other; their values are identical at init regardless.
  return { ck: Uint8Array.from(h), h };
}

async function mixHash(
  s: SymmetricState,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  s.h = await sha256(concatBytes(s.h, data));
}

async function mixKey(
  s: SymmetricState,
  ikm: Uint8Array<ArrayBuffer>,
): Promise<void> {
  // ck, temp_k = HKDF(ck, ikm, 2); temp_k (the cipher key) is unused.
  const [ck] = await noiseHkdf(s.ck, ikm, 2);
  s.ck = ck;
}

async function mixKeyAndHash(
  s: SymmetricState,
  ikm: Uint8Array<ArrayBuffer>,
): Promise<void> {
  // ck, temp_h, temp_k = HKDF(ck, ikm, 3); MixHash(temp_h). The third output
  // (temp_k, the CipherState key) is unused here but still requested so this
  // matches the Noise MixKeyAndHash definition verbatim; the extra block is
  // negligible next to the elliptic-curve scalar multiplication.
  const [ck, tempH] = await noiseHkdf(s.ck, ikm, 3);
  s.ck = ck;
  await mixHash(s, tempH);
}

// --- Key schedule + confirmation ---------------------------------------------

/**
 * The pure NNpsk0 key schedule and key-confirmation derivation. Both peers
 * call this with identical arguments after the ephemeral exchange and get
 * identical outputs. The mixing order, what each derivation is taken over,
 * and why that is the critical invariant: docs/spec/PROTOCOL.md ("Key
 * schedule"), which the steps below implement in the order it states.
 *
 * @internal exported only for the known-answer-vector and RFC cross-check
 *   tests.
 */
export async function computeKexKeys(
  psk: Uint8Array<ArrayBuffer>,
  initiatorEphemeralPublic: Uint8Array<ArrayBuffer>,
  responderEphemeralPublic: Uint8Array<ArrayBuffer>,
  eeInput: Uint8Array<ArrayBuffer>,
  initiatorRequestsEncryption: boolean,
  responderRequestsEncryption: boolean,
): Promise<{
  sessionKey: Uint8Array<ArrayBuffer>;
  confirmKey: Uint8Array<ArrayBuffer>;
  handshakeHash: Uint8Array<ArrayBuffer>;
  chainingKey: Uint8Array<ArrayBuffer>;
}> {
  const s = await initializeSymmetric();
  // NNpsk0 token sequence: -> psk, e ; <- e, ee (empty prologue). Each
  // message's request-encryption flag is mixed in as that message's
  // handshake payload, right after its `e` token. In PSK mode Noise (rev 34
  // section 9.2) processes every `e` token with MixKey(e.public) in addition
  // to MixHash(e.public), folding the ephemeral publics into the chaining
  // key as well as the hash -- both are done below, so this is faithful
  // NNpsk0. MixHash and MixKey touch disjoint state (h and ck), so order
  // within one `e` token is immaterial; what is fixed is the ck-chain order
  // psk -> e_i -> e_r -> ee and the h-chain order e_i -> flag_i -> e_r ->
  // flag_r.
  await mixHash(s, EMPTY);
  await mixKeyAndHash(s, psk); // psk token at position 0
  await mixHash(s, initiatorEphemeralPublic); // initiator e: MixHash
  await mixKey(s, initiatorEphemeralPublic); //              and MixKey (PSK mode)
  await mixHash(s, flagByte(initiatorRequestsEncryption)); // msg1 payload: initiator flag
  await mixHash(s, responderEphemeralPublic); // responder e: MixHash
  await mixKey(s, responderEphemeralPublic); //              and MixKey (PSK mode)
  await mixHash(s, flagByte(responderRequestsEncryption)); // msg2 payload: responder flag
  await mixKey(s, eeInput); // ee: the derivation's first block, not Z

  const master = concatBytes(s.ck, s.h);
  const sessionKey = await hkdfDerive(master, SESSION_LABEL, 32);
  // Confirmation key is derived from ck alone under a distinct label, so it is
  // independent of the session key. It does not fold in h the way the session
  // key (ck||h) does: the confirmation tags bind the transcript hash h
  // explicitly in the HMAC message, so the tags are fully transcript-bound
  // without h also entering the key.
  const confirmKey = await hkdfDerive(s.ck, CONFIRM_KEY_LABEL, 32);
  return {
    sessionKey,
    confirmKey,
    handshakeHash: s.h,
    chainingKey: s.ck,
  };
}

/**
 * The responder's confirmation tag, which binds after `h` a byte naming the
 * message 2 field the tag is sent in: 0 for `confirm`, made under the current
 * secret, and 1 for `previousConfirm`, made under the previous secret or the
 * value drawn in its place. A tag moved to the other field fails.
 *
 * @internal exported only for the known-answer-vector tests.
 */
export async function responderConfirmTag(
  confirmKey: Uint8Array<ArrayBuffer>,
  handshakeHash: Uint8Array<ArrayBuffer>,
  previousSchedule: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  return hmacSha256(
    confirmKey,
    concatBytes(
      enc.encode(RESPONDER_CONFIRM_LABEL),
      handshakeHash,
      flagByte(previousSchedule),
    ),
  );
}

/**
 * The initiator's confirmation tag, which binds the previous-secret flag and
 * the wrapped initiator value after `h`, so a changed byte of any fails the
 * tag. Neither is mixed into `h`: the wrapping key derives from the session
 * key, which `h` feeds.
 *
 * @internal exported only for the known-answer-vector tests.
 */
export async function initiatorConfirmTag(
  confirmKey: Uint8Array<ArrayBuffer>,
  handshakeHash: Uint8Array<ArrayBuffer>,
  usedPrevious: boolean,
  wrappedInitiatorValue: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return hmacSha256(
    confirmKey,
    concatBytes(
      enc.encode(INITIATOR_CONFIRM_LABEL),
      handshakeHash,
      flagByte(usedPrevious),
      wrappedInitiatorValue,
    ),
  );
}

// --- P-256 ECDH --------------------------------------------------------------

// A fresh ephemeral P-256 key pair. `extractable: false` applies to the private
// key only (WebCrypto always marks a generated public key extractable), so the
// ephemeral secret never becomes JavaScript-visible bytes at all. Its one usage,
// deriveKey, makes the platform refuse deriveBits on it, so no value
// application code can read holds Z either. The public key is exported raw,
// which for P-256 is the 65-byte uncompressed point that goes on the wire.
async function generateEphemeral(): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
}> {
  const pair = await crypto.subtle.generateKey(ECDH_P256, false, ["deriveKey"]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey };
}

// The single path from peer-supplied wire bytes to a usable public key,
// returning undefined on every rejection so the caller applies its uniform
// abort-and-fail handling. The two validation layers and the split between
// them are docs/spec/PROTOCOL.md ("Peer-share validation"); kex.test.ts and
// the browser suite assert each rejection against the real crypto.subtle.
async function importPeerShare(
  share: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey | undefined> {
  if (share.length !== PUBLIC_KEY_LEN || share[0] !== UNCOMPRESSED_POINT_PREFIX)
    return undefined;
  try {
    return await crypto.subtle.importKey("raw", share, ECDH_P256, false, []);
  } catch {
    return undefined;
  }
}

// --- Key-agreement derivation ------------------------------------------------
//
// The one SP 800-56C two-step HKDF call over Z. Its FixedInfo layout, the
// parameters, and what each output block feeds: docs/spec/PROTOCOL.md ("The
// key-agreement derivation").

// SHA-256's block length: the 56C default salt is this many zero bytes.
const KEY_AGREEMENT_SALT_LEN = 64;
const KEY_AGREEMENT_OUTPUT_BITS = 2048;
const KEY_AGREEMENT_BLOCK_COUNT = 3;

/**
 * The output blocks the key-agreement derivation takes from the front of its
 * output, each 32 bytes.
 *
 * @internal exported only for the known-answer-vector tests.
 */
export interface KeyAgreementBlocks {
  /** The Noise `ee` input, mixed into both key schedules. */
  ee: Uint8Array<ArrayBuffer>;
  /** The rotation input `ka` the next secret is derived over. */
  ka: Uint8Array<ArrayBuffer>;
  /** The input the history proofs and behind notices are keyed over. */
  historyInput: Uint8Array<ArrayBuffer>;
}

function partyInfo(
  role: HandshakeRole,
  share: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return concatBytes(
    enc.encode(KEY_AGREEMENT_LABEL),
    enc.encode(PROTOCOL_NAME),
    enc.encode(role),
    share,
  );
}

/**
 * The derivation's FixedInfo, `uPartyInfo || vPartyInfo` with U the initiator
 * and V the responder. Every item is fixed-length, so the concatenation parses
 * one way.
 *
 * @internal exported only for the FixedInfo layout test.
 */
export function keyAgreementFixedInfo(
  initiatorShare: Uint8Array<ArrayBuffer>,
  responderShare: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return concatBytes(
    partyInfo("initiator", initiatorShare),
    partyInfo("responder", responderShare),
  );
}

async function expandKeyAgreement(
  sharedSecret: CryptoKey,
  fixedInfo: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(KEY_AGREEMENT_SALT_LEN),
        info: fixedInfo,
      },
      sharedSecret,
      KEY_AGREEMENT_OUTPUT_BITS,
    ),
  );
  return okm.slice(0, KEY_AGREEMENT_BLOCK_COUNT * HASH_LEN);
}

/**
 * Derives Z from the ECDH pair into a non-extractable HKDF key and runs the
 * key-agreement derivation over it, returning undefined when the ECDH
 * derivation fails (the only step the peer's share can fail); a fault in the
 * HKDF steps is a local fault and rejects. The all-zero check compares the blocks, in constant time, against the same
 * derivation over a zero Z: a stated safety check, not the validation
 * (docs/spec/PROTOCOL.md, "Peer-share validation").
 *
 * @internal exported only for the tests' hand-rolled peers.
 */
export async function deriveKeyAgreement(
  myPrivate: CryptoKey,
  peerPublic: CryptoKey,
  initiatorShare: Uint8Array<ArrayBuffer>,
  responderShare: Uint8Array<ArrayBuffer>,
): Promise<KeyAgreementBlocks | undefined> {
  const fixedInfo = keyAgreementFixedInfo(initiatorShare, responderShare);
  let sharedSecret: CryptoKey;
  try {
    sharedSecret = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerPublic },
      myPrivate,
      { name: "HKDF" },
      false,
      ["deriveBits"],
    );
  } catch {
    return undefined;
  }
  const blocks = await expandKeyAgreement(sharedSecret, fixedInfo);
  const zeroSecret = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(SHARED_SECRET_LEN),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const zeroBlocks = await expandKeyAgreement(zeroSecret, fixedInfo);
  if (bytesEqual(blocks, zeroBlocks)) return undefined;
  return {
    ee: blocks.slice(0, HASH_LEN),
    ka: blocks.slice(HASH_LEN, 2 * HASH_LEN),
    historyInput: blocks.slice(2 * HASH_LEN, 3 * HASH_LEN),
  };
}

// --- Receive / abort helpers -------------------------------------------------

// Best-effort abort signal: if the peer is still waiting for our next message,
// telling them to give up shortens their recovery from the handshake
// timeout to immediately. A failure to send the abort is non-fatal -- the peer
// will time out on its own -- so the send error is swallowed.
async function sendAbort(
  conn: MessageConnection,
  abort: KexAbort = { kexMsg: "abort" },
): Promise<void> {
  try {
    await conn.send(abort);
  } catch {
    // Peer will hit the handshake timeout if abort delivery fails.
  }
}

// Receive one handshake message, bounded by handshakeReceiveTimeoutMs. The
// receive deadline firing is re-thrown as the distinct timeout error; any other
// receive failure -- a transport refusal, a dropped link -- is re-thrown as it
// is, so the operator reads its own class and message. Neither sends an abort:
// the receive path is what failed, so there is no one to notify over it.
async function receiveHandshake(conn: MessageConnection): Promise<unknown> {
  try {
    return await conn.receive(handshakeReceiveTimeoutMs(conn));
  } catch (e) {
    if (isReceiveDeadlineFailure(e))
      throw markPeerWaitTimeout(new Error(TIMEOUT_FAILURE, { cause: e }));
    throw e;
  }
}

// --- Result ------------------------------------------------------------------

/**
 * Result of a completed P-256 key exchange.
 *
 * `sessionKey` is a 32-byte key suitable for passing to `deriveAeadKey`
 * (exported from `./auth.ts`) to derive channel encryption keys, and to the
 * rotation's wrapping keys. Both parties hold the same value after a
 * successful handshake.
 */
interface KexResult {
  /** 32-byte session key. */
  sessionKey: Uint8Array<ArrayBuffer>;
  /** The key-agreement output the next secret is derived over: the
   * derivation's `ka` block. */
  keyAgreementOutput: Uint8Array<ArrayBuffer>;
  /** The initiator's 32-byte rotation value: drawn by the initiator, unwrapped
   * from message 3 by the responder. */
  initiatorValue: Uint8Array<ArrayBuffer>;
  /**
   * The negotiated decision to wrap the post-handshake connection in an
   * additional application-encryption layer, identical on both ends. The
   * caller applies the extra AEAD layer when this is `true` and a session key
   * is in hand. How it is negotiated and what binds it: docs/spec/PROTOCOL.md
   * ("Request-encryption flag").
   */
  applyEncryption: boolean;
  /** Whether this side completed under its previous secret. */
  localUsedPrevious: boolean;
  /** Whether the peer completed under its previous secret. */
  partnerUsedPrevious: boolean;
}

/**
 * The secrets beyond the current one a handshake may complete under, and the
 * history it checks a peer's proof against (docs/spec/PROTOCOL.md, "Which
 * secret a handshake uses").
 */
export interface KexCandidates {
  /** The raw 32-byte previous secret, kept until the partner confirms the
   * next one; omitted when this side holds none. */
  previous?: Uint8Array<ArrayBuffer>;
  /** The verifiers of the secrets this side retired, newest first. */
  history: CheckedHistory;
}

type KexSchedule = Awaited<ReturnType<typeof computeKexKeys>>;

// Both schedules, the previous one under a value drawn on every run so the
// work does not depend on whether a previous secret is held.
async function computeBothSchedules(
  psk: Uint8Array<ArrayBuffer>,
  candidates: KexCandidates,
  shares: HandshakeShares,
  eeInput: Uint8Array<ArrayBuffer>,
  initiatorRequestsEncryption: boolean,
  responderRequestsEncryption: boolean,
): Promise<[KexSchedule, KexSchedule]> {
  const placeholder = (await drawRotationValue()).bytes;
  const schedule = (secret: Uint8Array<ArrayBuffer>) =>
    computeKexKeys(
      secret,
      shares.initiatorShare,
      shares.responderShare,
      eeInput,
      initiatorRequestsEncryption,
      responderRequestsEncryption,
    );
  return [
    await schedule(psk),
    await schedule(candidates.previous ?? placeholder),
  ];
}

// Reads the reply a responder makes to an abort holding a proof, within the
// per-message bound: a behind notice that verifies under this side's current
// verifier is a LocalCopyBehindError, and anything else, silence included, the
// generic failure.
async function failOnResponderReply(
  conn: MessageConnection,
  verifier: Uint8Array<ArrayBuffer>,
  shares: HandshakeShares,
): Promise<never> {
  let reply: unknown;
  try {
    reply = await conn.receive(handshakeReceiveTimeoutMs(conn));
  } catch {
    throw new AuthenticationError(GENERIC_FAILURE);
  }
  const parsed = KexAbortSchema.safeParse(reply);
  if (parsed.success && parsed.data.behindNotice !== undefined) {
    const { count, tag } = parsed.data.behindNotice;
    const received = decodeBase64Url(tag);
    if (
      received !== undefined &&
      bytesEqual(
        received,
        await behindNotice(verifier, "responder", count, shares),
      )
    )
      throw new LocalCopyBehindError();
  }
  throw new AuthenticationError(GENERIC_FAILURE);
}

// The abort an initiator sends when neither of the responder's tags verifies:
// its own proof, and a behind notice where the responder's proof matched this
// side's history. Throws the failure the run ends with.
async function initiatorFailsWithHistory(
  conn: MessageConnection,
  psk: Uint8Array<ArrayBuffer>,
  candidates: KexCandidates,
  responderProof: string,
  shares: HandshakeShares,
): Promise<never> {
  const peerProof = decodeBase64Url(responderProof);
  const matchedAt =
    peerProof === undefined
      ? undefined
      : await matchHistoryProof(
          candidates.history,
          peerProof,
          "responder",
          shares,
        );
  const verifier = await historyVerifierBytes(psk);
  const abort: KexAbort = {
    kexMsg: "abort",
    historyProof: toBase64Url(
      await historyProof(verifier, "initiator", shares),
    ),
  };
  if (matchedAt !== undefined) {
    abort.behindNotice = {
      count: matchedAt,
      tag: toBase64Url(
        await behindNotice(
          candidates.history[matchedAt - 1]!,
          "initiator",
          matchedAt,
          shares,
        ),
      ),
    };
  }
  await sendAbort(conn, abort);
  if (matchedAt !== undefined) throw new PartnerCopyBehindError(matchedAt);
  return failOnResponderReply(conn, verifier, shares);
}

// A responder's answer to an abort in place of message 3. An abort holding a
// proof is answered, with a behind notice where the proof matched this side's
// history; then the run ends on what the two showed, or the generic failure.
async function responderFailsOnAbort(
  conn: MessageConnection,
  abort: KexAbort,
  verifier: Uint8Array<ArrayBuffer>,
  candidates: KexCandidates,
  shares: HandshakeShares,
): Promise<never> {
  if (abort.historyProof === undefined)
    throw new AuthenticationError(GENERIC_FAILURE);
  const peerProof = decodeBase64Url(abort.historyProof);
  const matchedAt =
    peerProof === undefined
      ? undefined
      : await matchHistoryProof(
          candidates.history,
          peerProof,
          "initiator",
          shares,
        );
  const reply: KexAbort = { kexMsg: "abort" };
  if (matchedAt !== undefined) {
    reply.behindNotice = {
      count: matchedAt,
      tag: toBase64Url(
        await behindNotice(
          candidates.history[matchedAt - 1]!,
          "responder",
          matchedAt,
          shares,
        ),
      ),
    };
  }
  await sendAbort(conn, reply);
  if (matchedAt !== undefined) throw new PartnerCopyBehindError(matchedAt);
  if (abort.behindNotice !== undefined) {
    const { count, tag } = abort.behindNotice;
    const received = decodeBase64Url(tag);
    if (
      received !== undefined &&
      bytesEqual(
        received,
        await behindNotice(verifier, "initiator", count, shares),
      )
    )
      throw new LocalCopyBehindError();
  }
  throw new AuthenticationError(GENERIC_FAILURE);
}

// --- Protocol ----------------------------------------------------------------

/**
 * Executes a 3-message authenticated P-256 key exchange over an established
 * connection. Message flow, wire encoding, and construction:
 * docs/spec/PROTOCOL.md ("P-256 authenticated key exchange").
 *
 * The connection's inbound queue buffers any frame that arrives early, so a
 * fast peer cannot race ahead of a receive.
 *
 * `psk` is the raw 32-byte pre-shared secret; a caller holding a base64url
 * token decodes it to bytes first (a wrong length is a caller error, thrown
 * before any network activity).
 *
 * `handshakeRole` is assigned out of band by the caller, not negotiated
 * in-band: two peers both passing `"initiator"` reject each other and two
 * `"responder"`s deadlock on receive -- neither yields a false session.
 *
 * @throws {AuthenticationError} (a `"security"`-kind ConnectionError),
 *   message `"key exchange authentication failed"`, on any authentication
 *   failure.
 * @throws {Error} `"key exchange handshake timed out"` if a peer does not
 *   respond within 30 seconds, plus two inbound poll intervals on a polling
 *   transport -- a transport fault, not a security
 *   classification.
 * @throws {Error} if `psk` is not 32 bytes. Because `runKex` is async this
 *   is a rejected promise, not a synchronous throw.
 * @throws {ConnectionError} unchanged if the connection terminates for any
 *   other reason (a transport refusal, a dropped link, a local
 *   {@link MessageConnection.close} during the handshake) -- masked neither
 *   as a timeout nor as an authentication failure.
 *
 * @param requestEncryption  This party's request for the additional
 *   application-encryption layer. Sent on this party's handshake message and
 *   bound into the transcript; the negotiated decision is returned as
 *   {@link KexResult.applyEncryption}.
 * @param candidates  This side's previous secret, if it holds one, and its
 *   rotation history. With no secret in common, a peer whose proof matches
 *   the history fails as {@link PartnerCopyBehindError}, and a behind notice
 *   from the peer that verifies fails this side as
 *   {@link LocalCopyBehindError}; both are {@link AuthenticationError}s.
 */
export async function runKex(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  psk: Uint8Array<ArrayBuffer>,
  requestEncryption: boolean,
  candidates: KexCandidates = { history: [] },
): Promise<KexResult> {
  if (
    psk.length !== PSK_LEN ||
    (candidates.previous !== undefined &&
      candidates.previous.length !== PSK_LEN)
  ) {
    throw new InternalConsistencyError(
      `runKex: each secret must be ${PSK_LEN} bytes`,
    );
  }

  const { privateKey: mySecret, publicKey: myPublic } =
    await generateEphemeral();

  if (handshakeRole === "initiator") {
    await conn.send({
      kexMsg: "1",
      e: toBase64Url(myPublic),
      reqEnc: requestEncryption,
    } satisfies KexMsg1);

    // Message 2: receive responder's ephemeral + confirmation.
    // Every failure path below sends an abort so the responder stops waiting
    // immediately rather than blocking until the handshake timeout.
    const msg2 = KexMsg2Schema.safeParse(await receiveHandshake(conn));
    if (!msg2.success) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const peerPublic = decodeBase64Url(msg2.data.e);
    const peerKey =
      peerPublic === undefined ? undefined : await importPeerShare(peerPublic);
    if (peerPublic === undefined || peerKey === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const agreed = await deriveKeyAgreement(
      mySecret,
      peerKey,
      myPublic,
      peerPublic,
    );
    if (agreed === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const shares: HandshakeShares = {
      initiatorShare: myPublic,
      responderShare: peerPublic,
      historyInput: agreed.historyInput,
    };
    // We are the initiator, so our flag is the initiator flag and the
    // responder's (msg2.reqEnc) is the responder flag. Binding both into the
    // transcript means a tampered responder flag yields a responder tag we
    // will reject below.
    const schedules = await computeBothSchedules(
      psk,
      candidates,
      shares,
      agreed.ee,
      requestEncryption,
      msg2.data.reqEnc,
    );

    // Trial verification: every own schedule against both received tags, each
    // expected tag made with the byte of the field it is compared at, all
    // four compared whatever matches, then the first match in the order
    // current-own then previous-own, each against the responder's current tag
    // first. bytesEqual is total, so a tag that does not decode to 32 bytes
    // simply fails to match.
    const receivedTags = [msg2.data.confirm, msg2.data.previousConfirm].map(
      (tag) => decodeBase64Url(tag) ?? EMPTY,
    );
    const matches: boolean[][] = [];
    for (const schedule of schedules) {
      const row: boolean[] = [];
      for (const [peer, tag] of receivedTags.entries()) {
        row.push(
          bytesEqual(
            tag,
            await responderConfirmTag(
              schedule.confirmKey,
              schedule.handshakeHash,
              peer === 1,
            ),
          ),
        );
      }
      matches.push(row);
    }
    const ownChoices: number[] =
      candidates.previous === undefined ? [0] : [0, 1];
    let chosen: { own: number; peer: number } | undefined;
    for (const own of ownChoices) {
      for (const peer of [0, 1]) {
        if (chosen === undefined && matches[own]![peer]!)
          chosen = { own, peer };
      }
    }
    if (chosen === undefined)
      return initiatorFailsWithHistory(
        conn,
        psk,
        candidates,
        msg2.data.historyProof,
        shares,
      );
    const { sessionKey, confirmKey, handshakeHash } = schedules[chosen.own]!;
    const usedPrevious = chosen.own === 1;

    // Drawn and sent only now: the initiator holds key confirmation once the
    // responder's tag verifies, and sends no keying material before it.
    const initiatorValue = await drawRotationValue();
    const wrapped = await wrapRotationValue(
      sessionKey,
      "initiator",
      initiatorValue,
    );
    const initiatorConfirm = await initiatorConfirmTag(
      confirmKey,
      handshakeHash,
      usedPrevious,
      wrapped,
    );
    await conn.send({
      kexMsg: "3",
      confirm: toBase64Url(initiatorConfirm),
      initiatorValue: toBase64Url(wrapped),
      usedPrevious,
    } satisfies KexMsg3);

    return {
      sessionKey,
      keyAgreementOutput: agreed.ka,
      initiatorValue: initiatorValue.bytes,
      applyEncryption: requestEncryption || msg2.data.reqEnc,
      localUsedPrevious: usedPrevious,
      partnerUsedPrevious: chosen.peer === 1,
    };
  } else {
    // Message 1: receive initiator's ephemeral public key.
    // Every failure path below sends an abort so the initiator stops waiting.
    const msg1 = KexMsg1Schema.safeParse(await receiveHandshake(conn));
    if (!msg1.success) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const peerPublic = decodeBase64Url(msg1.data.e);
    const peerKey =
      peerPublic === undefined ? undefined : await importPeerShare(peerPublic);
    if (peerPublic === undefined || peerKey === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const agreed = await deriveKeyAgreement(
      mySecret,
      peerKey,
      peerPublic,
      myPublic,
    );
    if (agreed === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const shares: HandshakeShares = {
      initiatorShare: peerPublic,
      responderShare: myPublic,
      historyInput: agreed.historyInput,
    };
    // peerPublic is the initiator's e; myPublic is the responder's e. The
    // initiator's flag (msg1.reqEnc) is the initiator flag and ours is the
    // responder flag; both are bound into the transcript before the tags are
    // computed, so the confirms we send below already commit to both flags.
    // Both schedules and the proof are computed on every run, so the work and
    // message 2's shape do not depend on whether a previous secret is held.
    const schedules = await computeBothSchedules(
      psk,
      candidates,
      shares,
      agreed.ee,
      msg1.data.reqEnc,
      requestEncryption,
    );
    const verifier = await historyVerifierBytes(psk);
    const proof = await historyProof(verifier, "responder", shares);

    await conn.send({
      kexMsg: "2",
      e: toBase64Url(myPublic),
      confirm: toBase64Url(
        await responderConfirmTag(
          schedules[0].confirmKey,
          schedules[0].handshakeHash,
          false,
        ),
      ),
      previousConfirm: toBase64Url(
        await responderConfirmTag(
          schedules[1].confirmKey,
          schedules[1].handshakeHash,
          true,
        ),
      ),
      historyProof: toBase64Url(proof),
      reqEnc: requestEncryption,
    } satisfies KexMsg2);

    // Message 3: receive and verify the initiator's confirmation (or abort).
    // An abort holding a proof is answered (responderFailsOnAbort); a plain
    // abort folds into the same generic failure as a malformed or wrong msg3.
    // Every other failure sends an abort: the initiator has wrapped the
    // connection and waits for terms message 2, so it reads the cleartext
    // abort as a `security` failure of the AEAD layer at once.
    const msg3 = z
      .union([KexMsg3Schema, KexAbortSchema])
      .safeParse(await receiveHandshake(conn));
    if (msg3.success && msg3.data.kexMsg === "abort") {
      return responderFailsOnAbort(
        conn,
        msg3.data,
        verifier,
        candidates,
        shares,
      );
    }
    if (!msg3.success || msg3.data.kexMsg !== "3") {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const { usedPrevious } = msg3.data;
    const wrapped = decodeBase64Url(msg3.data.initiatorValue);
    const receivedConfirm = decodeBase64Url(msg3.data.confirm);
    if (wrapped === undefined || receivedConfirm === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    // Both expected tags are computed and compared whatever matches; the
    // previous schedule completes only where a previous secret is held. No
    // explicit tag length check: bytesEqual is total.
    const tagMatches: boolean[] = [];
    for (const schedule of schedules) {
      tagMatches.push(
        bytesEqual(
          receivedConfirm,
          await initiatorConfirmTag(
            schedule.confirmKey,
            schedule.handshakeHash,
            usedPrevious,
            wrapped,
          ),
        ),
      );
    }
    const completedOwn = tagMatches[0]
      ? 0
      : tagMatches[1] && candidates.previous !== undefined
        ? 1
        : undefined;
    if (completedOwn === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }
    const { sessionKey } = schedules[completedOwn];
    // A consistency check rather than a second defense: the tag already covers
    // the wrapped bytes, so only a holder of the pre-shared secret that wrapped
    // under another key reaches a failure here.
    const initiatorValue = await unwrapRotationValue(
      sessionKey,
      "initiator",
      wrapped,
    );
    if (initiatorValue === undefined) {
      await sendAbort(conn);
      throw new AuthenticationError(GENERIC_FAILURE);
    }

    return {
      sessionKey,
      keyAgreementOutput: agreed.ka,
      initiatorValue,
      applyEncryption: msg1.data.reqEnc || requestEncryption,
      localUsedPrevious: completedOwn === 1,
      partnerUsedPrevious: usedPrevious,
    };
  }
}
