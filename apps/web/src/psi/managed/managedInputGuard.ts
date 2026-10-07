/**
 * The platform-free half of the managed exchange's run-start input guard:
 * whether a read input's columns can back the standing terms, and which benign
 * failure kind a rejection records. Both run before any connection on every run
 * path, never with desync/attack framing (docs/MANAGED_EXCHANGE.md, "The input
 * file each run"). The file-reading half is {@link ./managedInputHandle.ts}.
 */

import { decideLinkageTermsVerdict } from "@alcove/core";

import { failedRun } from "./managedRunRotate";

import type { ExchangeSpec, LinkageField } from "@alcove/core";
import type { ManagedExchangeLastRun } from "./managedExchangeRecord";

/**
 * Why the run-start input could not back the standing terms; each is a benign
 * pre-run problem ({@link managedInputFailureKind}).
 */
type ManagedInputRejection =
  | {
      /** The file could not be read: missing, permission gone, no handle, or a
       * failed CSV parse. */
      reason: "acquire";
      /** The underlying acquisition error, for the caller to display and log. */
      cause: unknown;
    }
  | {
      /** The file cannot satisfy every linkage key the standing terms declare. */
      reason: "columns";
      /** The linkage fields the read columns cannot produce. */
      unsatisfied: Array<LinkageField>;
      /** Whether the read yielded exactly one column, the shape of a file using a
       * different delimiter, so the caller states that remedy rather than
       * renegotiating terms. */
      singleColumn: boolean;
    };

/**
 * Raised when the run-start input cannot back the standing terms, before any
 * connection. Its `message` is fixed, non-sensitive text; the
 * partner-influenced field names are in {@link rejection}, to be sanitized
 * before display.
 */
export class ManagedInputError extends Error {
  /** The discriminated benign cause. */
  readonly rejection: ManagedInputRejection;
  constructor(rejection: ManagedInputRejection) {
    super(
      rejection.reason === "acquire"
        ? "managed exchange input could not be read at run start"
        : "managed exchange input cannot satisfy the standing linkage terms",
      rejection.reason === "acquire" ? { cause: rejection.cause } : undefined,
    );
    this.name = "ManagedInputError";
    this.rejection = rejection;
  }
}

/**
 * The `lastRun` failure kind a rejection records: `"acquire"` is the retryable
 * `"input"` state, `"columns"` the `"terms-shortfall"` state, which the same
 * file repeats on every attempt. The bookkeeping stamp and the live launch's
 * classification both read this, so the next visit's tier matches what the
 * operator saw.
 */
export function managedInputFailureKind(
  rejection: ManagedInputRejection,
): "input" | "terms-shortfall" {
  return rejection.reason === "columns" ? "terms-shortfall" : "input";
}

/**
 * The `lastRun` bookkeeping a rejection records, including the one-column
 * reading: a later visit has only the record, and without it would send the
 * operator to renegotiate terms over a delimiter problem.
 */
export function managedInputLastRun(
  rejection: ManagedInputRejection,
  at: number,
): ManagedExchangeLastRun {
  const lastRun = failedRun(at, "failed", managedInputFailureKind(rejection));
  return rejection.reason === "columns" && rejection.singleColumn
    ? { ...lastRun, singleColumnInput: true }
    : lastRun;
}

/**
 * Grade a read input's `columns` against a record's standing terms through
 * core's {@link decideLinkageTermsVerdict}: refused unless the terms declare at
 * least one linkage key and the input satisfies every one, the same rule
 * `prepareForExchange` enforces later, so this is advance notice of that
 * decision, never a looser pre-check. Graded on column shape, so it can
 * over-accept a same-shaped wrong file but never block a conforming one.
 */
export function assessManagedInputColumns(
  exchangeFile: ExchangeSpec,
  columns: ReadonlyArray<string>,
): ManagedInputRejection | undefined {
  const verdict = decideLinkageTermsVerdict(
    [...columns],
    exchangeFile.linkageTerms,
    exchangeFile.standardization,
    exchangeFile.metadata,
  );
  if (verdict.fullySatisfied) return undefined;
  return {
    reason: "columns",
    unsatisfied: verdict.unsatisfiedFieldColumns.map(({ field }) => field),
    singleColumn: columns.length === 1,
  };
}
