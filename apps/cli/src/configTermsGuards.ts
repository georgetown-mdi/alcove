import {
  assertAlgorithmImplemented,
  assertCountOnlyTransmitsNoColumn,
  assertDeduplicateImplemented,
  assertFanOutImplemented,
  assertPayloadSendDisclosed,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
} from "@alcove/core";
import type { LinkageTerms, Metadata, Standardization } from "@alcove/core";

/**
 * Refuse linkage terms that an `alcove exchange` run from a configuration
 * holding them, beside that configuration's own `metadata` and
 * `standardization`, would refuse before it sends anything. Run where terms
 * leave or enter a configuration without an exchange to check them -- an
 * offline invitation minted from the configuration, a terms update made from
 * it, and a terms update applied to it -- so neither party consents to terms
 * whose first run is refused.
 *
 * A `payload.send` that differs from what the metadata transmits is not
 * refused here: the run states the transmitted columns in its place.
 *
 * The metadata and standardization checks run only where the configuration
 * holds an explicit block: without one the run infers it from the input file,
 * which none of these commands reads.
 *
 * @throws {UsageError} naming the rule the terms break.
 */
export function assertConfigTermsRunnable(
  terms: LinkageTerms,
  local: { metadata?: Metadata; standardization?: Standardization },
): void {
  const { metadata, standardization } = local;
  assertCountOnlyTransmitsNoColumn(terms.algorithm, metadata);
  if (standardization !== undefined)
    assertStandardizationMatchesTerms(standardization, terms);
  assertAlgorithmImplemented(terms.algorithm);
  assertDeduplicateImplemented(terms);
  assertFanOutImplemented(terms, standardization);
  // A step whose compile throws aborts the run only once the pipeline is
  // built, after the partner has agreed to the terms naming it.
  assertTransformsCompile(terms, standardization);
}

/**
 * {@link assertConfigTermsRunnable}, for terms that leave the configuration
 * in a document the partner consents to -- an offline invitation or a terms
 * update -- and also refusing a `payload.send` that differs from what the
 * metadata transmits: the document states `payload.send` as written, so the
 * partner would consent to columns the run does not send.
 *
 * @throws {UsageError} naming the rule the terms break.
 */
export function assertConfigTermsSendable(
  terms: LinkageTerms,
  local: { metadata?: Metadata; standardization?: Standardization },
): void {
  assertConfigTermsRunnable(terms, local);
  if (local.metadata !== undefined)
    assertPayloadSendDisclosed(terms.payload, local.metadata, terms.output);
}
