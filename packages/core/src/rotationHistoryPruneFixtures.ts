// The rotation-history writes every app that keeps a history is held to, and
// how many entries each keeps.
//
// The handshake counts rotations by an entry's position, so the command line's
// key file and the web app's managed record must prune a history alike. Core's
// suite and both apps' suites drive this one set through their own rotation
// write. Test-only, published on `@alcove/core/testing` for the apps' suites.
//
// Every history holds at most ROTATION_HISTORY_MAX_ENTRIES entries and every
// `expires` the "Z" form, as the stored schemas admit.

import type { RotationHistoryEntry } from "./rotationHistory.js";

/** One rotation write over a stored history. */
export interface RotationHistoryPruneFixture {
  readonly label: string;
  /** The instant of the write, UTC milliseconds. */
  readonly now: number;
  /**
   * The secret the write retires, whose entry goes at the head of the
   * history, with its own `expires` where it has one. Absent for a write that
   * adds no entry and only prunes.
   */
  readonly retired?: { readonly expires?: string };
  /** The stored history, newest first. */
  readonly history: ReadonlyArray<RotationHistoryEntry>;
  /**
   * How many entries the write keeps from the head of the retired entry
   * followed by `history`: a prune only ever keeps the newest entries.
   */
  readonly kept: number;
}

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const PAST = "2026-05-01T00:00:00.000Z";
const FUTURE = "2026-07-01T00:00:00.000Z";
const AT_NOW = "2026-06-01T00:00:00.000Z";
const JUST_AFTER = "2026-06-01T00:00:00.001Z";

function entry(n: number, expires?: string): RotationHistoryEntry {
  return {
    verifier: "A".repeat(40) + String(n).padStart(2, "0") + "A",
    ...(expires !== undefined && { expires }),
  };
}

function entries(
  count: number,
  expiresAt: (n: number) => string | undefined,
): RotationHistoryEntry[] {
  return Array.from({ length: count }, (_, n) => entry(n, expiresAt(n)));
}

/** The labelled rotation writes, each with the count of entries it keeps. */
export const rotationHistoryPruneFixtures: ReadonlyArray<RotationHistoryPruneFixture> =
  Object.freeze([
    {
      label: "an empty history, nothing retired",
      now: NOW,
      history: [],
      kept: 0,
    },
    {
      label: "a retired secret with no expires over an empty history",
      now: NOW,
      retired: {},
      history: [],
      kept: 1,
    },
    {
      label: "entries with no expires are all kept",
      now: NOW,
      history: entries(3, () => undefined),
      kept: 3,
    },
    {
      label: "expired entries at the oldest end are removed",
      now: NOW,
      history: [entry(0), entry(1, FUTURE), entry(2, PAST), entry(3, PAST)],
      kept: 2,
    },
    {
      label: "an expired entry newer than one in force keeps its place",
      now: NOW,
      history: [entry(0, FUTURE), entry(1, PAST), entry(2)],
      kept: 3,
    },
    {
      label: "an entry expiring at the write's instant is removed",
      now: NOW,
      history: [entry(0), entry(1, AT_NOW)],
      kept: 1,
    },
    {
      label: "an entry expiring a millisecond after the write is kept",
      now: NOW,
      history: [entry(0), entry(1, JUST_AFTER)],
      kept: 2,
    },
    {
      label: "an expires without fractional seconds",
      now: NOW,
      history: [
        entry(0, "2026-06-01T00:00:01Z"),
        entry(1, "2026-05-31T23:59:59Z"),
      ],
      kept: 1,
    },
    {
      label: "a history whose every entry has expired is emptied",
      now: NOW,
      history: entries(4, () => PAST),
      kept: 0,
    },
    {
      label: "a retired secret already expired leaves with the expired entries",
      now: NOW,
      retired: { expires: PAST },
      history: entries(2, () => PAST),
      kept: 0,
    },
    {
      label: "a retired secret already expired stays ahead of one in force",
      now: NOW,
      retired: { expires: PAST },
      history: [entry(0, FUTURE)],
      kept: 2,
    },
    {
      label: "a full history less its oldest entry once a secret is retired",
      now: NOW,
      retired: { expires: FUTURE },
      history: entries(64, () => undefined),
      kept: 64,
    },
    {
      label: "the cut to 64 comes before the expired entries are removed",
      now: NOW,
      retired: { expires: FUTURE },
      history: entries(64, (n) => (n === 62 ? PAST : undefined)),
      kept: 63,
    },
  ]);
