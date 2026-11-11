// One representative cause of each kind in the failure-cause catalog, which
// the CLI's suite and the console's suite both drive through their remedy
// functions, so the same cause is checked to state core's sentence in both.
// Keyed on every kind, so a kind core adds fails to compile here until it has
// a sample. Test-only, published on `@alcove/core/testing` for the apps' suites.

import type { FailureCauseKind, FailureCauseOfKind } from "./failureCause.js";

/** One representative failure cause per {@link FailureCauseKind}. */
export const REPRESENTATIVE_FAILURE_CAUSES: {
  readonly [K in FailureCauseKind]: FailureCauseOfKind<K>;
} = {
  "partner-never-arrived": {
    kind: "partner-never-arrived",
    channel: "filedrop",
    waitedMs: 90_000,
  },
  "folder-missing": {
    kind: "folder-missing",
    path: "/data/drop",
    code: "ENOENT",
  },
  "relay-registrar-unreachable": {
    kind: "relay-registrar-unreachable",
    host: "relay.example.org",
    port: 8443,
    failure: "no-connection",
    code: "ECONNREFUSED",
  },
  "partner-stopped-responding": {
    kind: "partner-stopped-responding",
    silentMs: 120_000,
  },
  "set-over-limit": {
    kind: "set-over-limit",
    stage: "after-terms",
    limit: "partner-ceiling",
    valueCount: 9_000_000,
    limitValues: 8_388_608,
    scope: "first-key",
  },
  "single-pass-over-limit": {
    kind: "single-pass-over-limit",
    limit: "value-slots",
    local: { effectiveKeyCount: 3, recordCount: 400_000 },
    partner: { effectiveKeyCount: 3, recordCount: 2_000_000 },
    limitSlots: 3_000_000,
    partnerFansOut: true,
  },
  "matches-over-limit": {
    kind: "matches-over-limit",
    list: "resolved",
    matchCount: 9_000_000,
    limitMatches: 8_388_607,
  },
  "shared-secret-unusable": {
    kind: "shared-secret-unusable",
    problem: "expired",
    expires: "2026-07-08T19:32:00.000Z",
    stage: "before-handshake",
  },
  "partner-stopped-at-matching": { kind: "partner-stopped-at-matching" },
  "message-write-unconfirmed": {
    kind: "message-write-unconfirmed",
    failure: "sequence-spent",
    seq: 4,
  },
  "shared-name-at-entry": { kind: "shared-name-at-entry" },
};
