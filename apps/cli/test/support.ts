// The helpers the CLI suites share: a bounded poll, a prepared exchange over
// first-name terms, and the invitation token encoding below its schema check.

import {
  prepareForExchange,
  type ExchangeDataSpec,
  type LinkageTerms,
  type PreparedExchange,
} from "@alcove/core";

// --- Polling -------------------------------------------------------------------

/** How long {@link waitFor} polls, how often, and what its failure names. */
export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly what?: string;
}

/**
 * Poll `predicate` until it holds, failing with `what` if it does not within
 * `timeoutMs`, so a case waits on the state it needs rather than a fixed delay.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 60_000,
    intervalMs = 20,
    what = "condition",
  }: WaitForOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline)
      throw new Error(`waitFor: ${what} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- Prepared exchanges ----------------------------------------------------------

/**
 * Linkage terms matching on a single first-name key, less the identity. The
 * built-in key templates all require SSN or a date of birth, so an explicit
 * first-name key is what gives two parties over a one-column dataset valid,
 * matching terms.
 */
export const firstNameTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

/**
 * `identity`'s exchange over {@link firstNameTerms} and `rows` of a single
 * `first_name` column. The default is one row two parties share, so their
 * exchange computes a real intersection and reaches the output stage.
 */
export function preparedFor(
  identity: string,
  rows: Array<Record<string, string>> = [{ first_name: "Bob" }],
): PreparedExchange {
  const spec: ExchangeDataSpec = {
    linkageTerms: { ...firstNameTerms, identity },
  };
  return prepareForExchange(spec, identity, rows, ["first_name"]);
}

// --- Invitation tokens ---------------------------------------------------------------

/**
 * Builds a raw invitation token over `token`'s JSON without the production
 * encoder, whose schema check would refuse the malformed or hostile tokens a
 * decode test needs: the base64url payload followed by the first four bytes of
 * its SHA-256. Mirrors `encodeRawInvitation` in core's test support module
 * (packages/core/test/utils/support.ts): this suite reaches core only through
 * the built `@alcove/core`, and that module imports core's sources.
 */
export async function encodeRawInvitation(token: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const base64Url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  return base64Url(bytes) + base64Url(new Uint8Array(hash).slice(0, 4));
}
