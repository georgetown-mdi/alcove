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
};
