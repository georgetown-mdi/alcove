import { z } from "zod";

import { enc, fromBase64Url, toBase64Url } from "./utils/crypto.js";
import { parseBoundedJson } from "./utils/boundedJson.js";
import {
  PartnerProtocolRefusalError,
  type OlderVersionSide,
} from "./errors.js";

// The version hello each party sends at the key exchange, and the selection
// both make from the two. Wire shape, what the transcript binds, the selection
// rule and the refusal: docs/spec/PROTOCOL.md ("The version hello").

// The exchange-protocol version this build writes at the terms exchange and
// offers in its hello. Bumping it is a change to the hello's offer, made
// against docs/spec/PROTOCOL.md ("Protocol-version reconcile at the terms
// exchange"); scripts/check-protocol-version-bump.mjs reads this literal.
/** @internal exported for the protocol-version tests. */
export const PROTOCOL_VERSION = 1;

// The encrypted-channel envelope version: byte 0 of each AEAD envelope, and on
// file-sync byte 0 of each message file after a party's first.
/** @internal exported for the envelope-version tests. */
export const ENVELOPE_VERSION = 1;

/** The layers a hello states versions for, in the order the spec lists them. */
export const VERSION_LAYERS = ["kex", "protocol", "envelope"] as const;

/** One layer a hello states versions for. */
export type VersionLayer = (typeof VERSION_LAYERS)[number];

/** Per layer, the integer versions a build offers. */
export type SupportedVersions = Readonly<
  Record<VersionLayer, readonly number[]>
>;

/** Per layer, the version both parties selected. */
export type NegotiatedVersions = Readonly<Record<VersionLayer, number>>;

// A hello is a short JSON object; this bounds the decoded bytes, which the
// prologue length-prefixes in two bytes.
const HELLO_MAX_BYTES = 1024;
const HELLO_MAX_VERSIONS_PER_LAYER = 32;
const MAX_VERSION = 0x7fffffff;

const versionList = z
  .array(z.number().int().min(1).max(MAX_VERSION))
  .min(1)
  .max(HELLO_MAX_VERSIONS_PER_LAYER);

// Not `.strict()`: a member this build does not know is accepted, and the
// transcript still binds it, because the prologue takes the bytes received.
const HelloSchema: z.ZodType<SupportedVersions> = z.object({
  kex: versionList,
  protocol: versionList,
  envelope: versionList,
});

/**
 * The hello this party sends: the UTF-8 JSON of `supported`, one member per
 * layer. These exact bytes enter the transcript on both sides.
 *
 * @internal exported for the key exchange and its tests.
 */
export function encodeHello(
  supported: SupportedVersions,
): Uint8Array<ArrayBuffer> {
  return enc.encode(
    JSON.stringify({
      kex: supported.kex,
      protocol: supported.protocol,
      envelope: supported.envelope,
    }),
  );
}

/** A hello as received: the decoded bytes, and the versions read from them. */
export interface ReceivedHello {
  bytes: Uint8Array<ArrayBuffer>;
  versions: SupportedVersions;
}

/**
 * Reads a partner's hello from its wire form, a base64url string. Undefined on
 * any malformation, which the key exchange fails as its generic
 * authentication failure.
 *
 * @internal exported for the key exchange and its tests.
 */
export function readHello(wire: string): ReceivedHello | undefined {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(wire);
  } catch {
    return undefined;
  }
  if (bytes.length === 0 || bytes.length > HELLO_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = parseBoundedJson(bytes);
  } catch {
    return undefined;
  }
  const parsed = HelloSchema.safeParse(value);
  return parsed.success ? { bytes, versions: parsed.data } : undefined;
}

/** The wire form of a hello's bytes. @internal */
export function helloWire(bytes: Uint8Array<ArrayBuffer>): string {
  return toBase64Url(bytes);
}

/**
 * The Noise prologue: each hello's bytes as received, initiator first, each
 * behind its length as two big-endian bytes, so the pair parses one way.
 *
 * @internal exported for the key exchange and its tests.
 */
export function helloPrologue(
  initiatorHello: Uint8Array<ArrayBuffer>,
  responderHello: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + initiatorHello.length + responderHello.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, initiatorHello.length);
  out.set(initiatorHello, 2);
  view.setUint16(2 + initiatorHello.length, responderHello.length);
  out.set(responderHello, 4 + initiatorHello.length);
  return out;
}

/** The outcome of {@link selectVersions}. */
export type VersionSelection =
  | { ok: true; negotiated: NegotiatedVersions }
  | { ok: false; olderVersion: OlderVersionSide };

/**
 * The highest version both sides offer in each layer. The result does not
 * depend on which side is `local`, so both parties select the same versions.
 * With no common version in a layer, names which side's offer lies wholly
 * below the other's, or `"unknown"` where neither does.
 */
export function selectVersions(
  local: SupportedVersions,
  partner: SupportedVersions,
): VersionSelection {
  const negotiated: Partial<Record<VersionLayer, number>> = {};
  for (const layer of VERSION_LAYERS) {
    const common = local[layer].filter((v) => partner[layer].includes(v));
    if (common.length === 0)
      return {
        ok: false,
        olderVersion: olderSide(local[layer], partner[layer]),
      };
    negotiated[layer] = Math.max(...common);
  }
  return { ok: true, negotiated: negotiated as NegotiatedVersions };
}

function olderSide(
  local: readonly number[],
  partner: readonly number[],
): OlderVersionSide {
  if (Math.max(...partner) < Math.min(...local)) return "partner";
  if (Math.max(...local) < Math.min(...partner)) return "this-party";
  return "unknown";
}

/**
 * The refusal both parties report when a layer has no version in common. It
 * must stay a fixed literal holding nothing the partner authored.
 */
export const NO_COMMON_VERSION_MESSAGE =
  "the partner is running an Alcove version this one cannot exchange with; " +
  "the party on the older version must update";

/** The error {@link NO_COMMON_VERSION_MESSAGE} is thrown as. @internal */
export function noCommonVersionError(
  olderVersion: OlderVersionSide,
): PartnerProtocolRefusalError {
  return new PartnerProtocolRefusalError(NO_COMMON_VERSION_MESSAGE, {
    olderVersion,
  });
}
