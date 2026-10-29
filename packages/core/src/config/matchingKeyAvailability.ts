import type { Algorithm } from "../types.js";
import type { LinkageStrategy, Output } from "./linkageTermsSchema.js";

/**
 * Why this party's terms leave no matched key to name, or `undefined` when
 * the result can name one: a count-only (`psi-c`) run writes no result, the
 * `single-pass` sender is handed the resolved table without the rounds behind
 * it (refused for either role, since the role is decided at the terms
 * exchange), and a party whose own terms expect no output writes no result.
 */
export type MatchingKeyUnavailableReason =
  "count-only" | "single-pass" | "no-output";

/**
 * The first {@link MatchingKeyUnavailableReason} these terms give, in the
 * order count-only, single-pass, no output, or `undefined` when a result
 * naming the matched key can be written. The one predicate behind the config
 * key's parse refusal, the CLI flag's refusal, and the web app's control.
 */
export function matchingKeyUnavailableReason(terms: {
  algorithm: Algorithm;
  linkageStrategy: LinkageStrategy;
  output: Output;
}): MatchingKeyUnavailableReason | undefined {
  if (terms.algorithm === "psi-c") return "count-only";
  if (terms.linkageStrategy === "single-pass") return "single-pass";
  if (!terms.output.expectsOutput) return "no-output";
  return undefined;
}

/**
 * The refusal of `include_matching_key: true` on terms that give this party no
 * matched key to name, keyed by {@link MatchingKeyUnavailableReason}.
 */
export const MATCHING_KEY_CONFIG_REFUSALS: Record<
  MatchingKeyUnavailableReason,
  string
> = {
  "count-only":
    'include_matching_key is set on a count-only ("psi-c") exchange, which ' +
    "writes no result file. Remove include_matching_key, or set the " +
    'algorithm to "psi".',
  "single-pass":
    "include_matching_key is set on a single-pass exchange, where the party " +
    "that sends its records first is not told which key matched. Remove " +
    "include_matching_key, or agree on the cascade linkage strategy with your " +
    "partner.",
  "no-output":
    "include_matching_key is set, but by your linkage terms you receive no " +
    "result, so this exchange writes no result file for you. Remove " +
    "include_matching_key.",
};
