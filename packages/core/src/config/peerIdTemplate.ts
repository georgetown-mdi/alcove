// The `peer_id` template grammar: literal text plus fields Alcove fills in when
// a file-sync connection opens, so each run's id can differ while keeping the
// text the operator wrote. Spec: docs/spec/FILE_SYNC.md, Per-run peer id.

import { randomBytes, toHex } from "../utils/crypto.js";

/**
 * A `peer_id` field letter: `Y` the four-digit UTC year, `m` `d` `H` `M` `S`
 * the two-digit UTC month, day, hour, minute and second, and `K`
 * {@link PEER_ID_RANDOM_HEX_LENGTH} random lowercase hex characters.
 */
export type PeerIdField = "Y" | "m" | "d" | "H" | "M" | "S" | "K";

/** The number of hex characters the random field `%K` expands to: 64 bits. */
export const PEER_ID_RANDOM_HEX_LENGTH = 16;

// Every field expands to exactly this many ASCII characters, so a template's
// longest expansion is also its only length.
const FIELD_WIDTH: Readonly<Record<PeerIdField, number>> = {
  Y: 4,
  m: 2,
  d: 2,
  H: 2,
  M: 2,
  S: 2,
  K: PEER_ID_RANDOM_HEX_LENGTH,
};

const isField = (letter: string): letter is PeerIdField =>
  Object.hasOwn(FIELD_WIDTH, letter);

/** One piece of a parsed `peer_id`: literal text, or a field Alcove fills in. */
export type PeerIdPart = { literal: string } | { field: PeerIdField };

/** A parsed `peer_id`, or the reason it does not parse, in words for the
 * operator. */
export type PeerIdParse =
  { ok: true; parts: Array<PeerIdPart> } | { ok: false; problem: string };

const FIELD_LIST =
  "%Y, %m, %d, %H, %M and %S (the UTC date and time), %K (16 random hex " +
  "characters), or %% for a literal '%'";

/**
 * Parse a `peer_id`. `%%` is a literal `%`; any other `%` must start one of
 * the fields {@link PeerIdField} names. A value with no `%` is one literal.
 */
export function parsePeerIdTemplate(peerId: string): PeerIdParse {
  const parts: Array<PeerIdPart> = [];
  let literal = "";
  for (let i = 0; i < peerId.length; i += 1) {
    const char = peerId[i];
    if (char !== "%") {
      literal += char;
      continue;
    }
    const letter = peerId[i + 1];
    if (letter === undefined)
      return {
        ok: false,
        problem:
          "peer_id ends with a single '%'. Write %% for a literal '%', or " +
          `use one of ${FIELD_LIST}.`,
      };
    i += 1;
    if (letter === "%") {
      literal += "%";
      continue;
    }
    if (!isField(letter))
      return {
        ok: false,
        problem:
          `peer_id has the field '%${String.fromCodePoint(peerId.codePointAt(i)!)}', ` +
          `which Alcove does not fill in. Use ${FIELD_LIST}.`,
      };
    if (literal !== "") parts.push({ literal });
    literal = "";
    parts.push({ field: letter });
  }
  if (literal !== "") parts.push({ literal });
  return { ok: true, parts };
}

/** The UTF-8 byte length of every expansion of a parsed `peer_id`. */
export function peerIdTemplateBytes(parts: ReadonlyArray<PeerIdPart>): number {
  const encoder = new TextEncoder();
  return parts.reduce(
    (total, part) =>
      total +
      ("field" in part
        ? FIELD_WIDTH[part.field]
        : encoder.encode(part.literal).length),
    0,
  );
}

/** The id a parsed `peer_id` with no field always expands to, or undefined
 * when it holds a field. */
export function fixedPeerId(
  parts: ReadonlyArray<PeerIdPart>,
): string | undefined {
  let id = "";
  for (const part of parts) {
    if ("field" in part) return undefined;
    id += part.literal;
  }
  return id;
}

/** The clock and random source an expansion reads. */
export interface PeerIdFieldSource {
  /** Milliseconds since the epoch, read once per expansion. */
  nowMs: () => number;
  /** {@link PEER_ID_RANDOM_HEX_LENGTH} lowercase hex characters. */
  randomHex: () => string;
}

/** The system clock and the platform's cryptographic random source. */
export const SYSTEM_PEER_ID_FIELD_SOURCE: PeerIdFieldSource = {
  nowMs: () => Date.now(),
  randomHex: () => toHex(randomBytes(PEER_ID_RANDOM_HEX_LENGTH / 2)),
};

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

const RANDOM_HEX = new RegExp(`^[0-9a-f]{${PEER_ID_RANDOM_HEX_LENGTH}}$`);

/**
 * Fill in a parsed `peer_id`'s fields from `source`: the date and time in UTC,
 * whatever the process time zone, and each `%K` a fresh random value.
 *
 * @throws {RangeError} when the clock reads a year outside 0000-9999, which a
 *   four-digit `%Y` cannot hold, or the random source returns anything but
 *   {@link PEER_ID_RANDOM_HEX_LENGTH} lowercase hex characters: either would
 *   break the length the configuration was checked at.
 */
export function expandPeerIdTemplate(
  parts: ReadonlyArray<PeerIdPart>,
  source: PeerIdFieldSource,
): string {
  const now = new Date(source.nowMs());
  const year = now.getUTCFullYear();
  if (!(year >= 0 && year <= 9999))
    throw new RangeError(
      `the system clock reads the year ${year}, which peer_id's %Y cannot ` +
        "write in four digits",
    );
  const values: Record<Exclude<PeerIdField, "K">, string> = {
    Y: pad(year, 4),
    m: pad(now.getUTCMonth() + 1, 2),
    d: pad(now.getUTCDate(), 2),
    H: pad(now.getUTCHours(), 2),
    M: pad(now.getUTCMinutes(), 2),
    S: pad(now.getUTCSeconds(), 2),
  };
  return parts
    .map((part) => {
      if ("literal" in part) return part.literal;
      if (part.field !== "K") return values[part.field];
      const hex = source.randomHex();
      if (!RANDOM_HEX.test(hex))
        throw new RangeError(
          `the random source returned ${hex.length} characters, not ` +
            `${PEER_ID_RANDOM_HEX_LENGTH} lowercase hex characters`,
        );
      return hex;
    })
    .join("");
}

/**
 * Whether `id` is an expansion of a parsed `peer_id`: each literal exactly,
 * each date or time field as digits of its width and `%K` as lowercase hex of
 * its width. Linear in `id`, which may come from a partner's file name. The
 * entry scan uses it to tell this party's earlier run from a partner.
 */
export function matchesPeerIdTemplate(
  parts: ReadonlyArray<PeerIdPart>,
  id: string,
): boolean {
  let at = 0;
  for (const part of parts) {
    if ("literal" in part) {
      if (!id.startsWith(part.literal, at)) return false;
      at += part.literal.length;
      continue;
    }
    const width = FIELD_WIDTH[part.field];
    const piece = id.slice(at, at + width);
    if (piece.length !== width) return false;
    const pattern = part.field === "K" ? /^[0-9a-f]*$/ : /^[0-9]*$/;
    if (!pattern.test(piece)) return false;
    at += width;
  }
  return at === id.length;
}
