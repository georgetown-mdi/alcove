import { getLogger } from "./utils/logger.js";
import {
  assertCountOnlyTransmitsNoColumn,
  assertDeclaredPayloadColumnsPresent,
  inferMetadata,
  isDisclosedToPartner,
  linkageDateOfBirthColumn,
  undeclaredColumnNames,
} from "./config/metadata.js";
import {
  assertBothSidedDeduplicateImplemented,
  assertCountOnlyTermsShape,
  assertDeduplicateImplemented,
  candidateSetIsImplementedForStrategy,
  COUNT_ONLY_SHAPE_REFUSALS,
  resolvedMatchingFromTerms,
} from "./linkageTermsPolicy.js";
import { getDefaultLinkageTerms } from "./defaults/builtInLinkageTerms.js";
import { quoteTermsValue } from "./config/compatibilityMessage.js";
import {
  DEFAULT_DATE_INPUT_FORMAT,
  getDefaultStandardization,
} from "./defaults/builtInStandardization.js";
import {
  buildStandardizedDataset,
  declaredEffectiveKeyCount,
  declaredKeyWidth,
  localFanOutFactor,
  StandardizedKeyIterable,
} from "./standardization.js";
import {
  assertFanOutImplemented,
  assertLinkageTermsSatisfiable,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
} from "./linkageSatisfiability.js";
import { columnValues, inferDateFormatWithCounts } from "./utils/date.js";
import {
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
  sanitizeErrorForDisplay,
} from "./utils/sanitizeErrorForDisplay.js";
import { rawDecodeErrorDescription } from "./utils/describeDecodeError.js";
import { snakeizeKey } from "./utils/camelizeKeys.js";
import type { CSVRow } from "./file.js";
import { PSIParticipant } from "./psi/participant.js";
import { PARTNER_SET_OVER_CAPACITY_ABORT_REASON } from "./partnerAbortFrame.js";
import type { PsiProgressReporter } from "./psi/participant.js";
import type { PsiEngine, PsiEngineMode } from "./psi/psiEngine.js";
import {
  exchangeTerms,
  exchangeBootstrapSecret,
  reportsCountToSender,
  resolveRole,
  sendAbort,
} from "./protocolSetup.js";
import type { TermsChange } from "./protocolSetup.js";
import { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";
import {
  linkViaCountOnlyPSI,
  linkViaPSI,
  linkViaSinglePassPSI,
  withholdsSenderAssociationTable,
} from "./psi/link.js";
import type { LinkageCardinality } from "./psi/link.js";
import type { EntityClusterSummary } from "./psi/entityClosure.js";
import type { ResolvedRunShape } from "./pairTableProjection.js";
import type { ResolvedMatching } from "./linkageTermsPolicy.js";
import { InProcessPsiEngine } from "./psi/psiEngine.js";
import {
  MAX_PSI_DECODE_ELEMENTS,
  partyFansOut,
  psiElementBounds,
  SINGLE_PASS_LOCAL_REMEDY,
  singlePassDatasetExceedsCap,
} from "./connection/frameSize.js";
import {
  preparePayload,
  exchangePayloads,
  toCommittedPayload,
  assertDisclosedNamesCarriable,
  assertNoPayloadReceived,
  assertPayloadMatchesAgreedSend,
  termsStatingDeclaredPayloadSend,
} from "./payloadExchange.js";
import type { PayloadWireMessage } from "./payloadExchange.js";
import {
  payloadReceiveFill,
  termsResolvingChangedPayloadReceive,
} from "./config/recurringTerms.js";
import { computeTermsHash } from "./records/exchangeRecord.js";
import {
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
} from "./records/signedReceipt.js";
import {
  InternalConsistencyError,
  OperatorConfigError,
  RoundCapacityError,
  UsageError,
  AlgorithmDivergenceError,
} from "./errors.js";
import type { Metadata, OwnColumnSelection } from "./config/metadata.js";
import type { Standardization } from "./config/standardizationSchema.js";
import { safeParseLinkageTerms } from "./config/linkageTermsSchema.js";
import type { LinkageTerms } from "./config/linkageTermsSchema.js";
import type { StandardizedDataset } from "./standardization.js";
import type {
  HandshakeRole,
  AssociationTable,
  PsiRole,
  Prettify,
  Algorithm,
} from "./types.js";
import { connectionEndReader } from "./connection/messageConnection.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";
import type { PartnerPayload } from "./payloadExchange.js";
import type { BuiltExchangeRecord } from "./records/exchangeRecord.js";
import type { SigningIdentity } from "./records/signingIdentity.js";
import type { SigningConfig } from "./config/signing.js";
import {
  assertCertificateModeNamesLocalParty,
  assertCertificateModePinsPartner,
  assertReceiptBindingsOrAbort,
  assertSigningModeImplemented,
  resolvePartnerCertificateOrAbort,
} from "./exchange/signingChecks.js";
import { assertFirstRoundWithinPartnerCeiling } from "./exchange/firstRoundCapacity.js";
import { carryingExchangeRecord } from "./exchange/failureRecords.js";
import {
  assertPresentedDeduplicateOrAbort,
  resolvePayloadDisclosureOrAbort,
} from "./exchange/termsRefusals.js";
import { buildOwedExchangeRecord } from "./exchange/owedRecord.js";
import type {
  DualSignedRecord,
  ReceiptContent,
} from "./records/signedReceipt.js";

export {
  assertPresentedDeduplicateMatchesInvitation,
  resolveBothDirectionsDisclosePayload,
  resolveDirectionDisclosesPayload,
} from "./exchange/termsRefusals.js";
export type { PayloadDisclosureDirections } from "./exchange/termsRefusals.js";

/**
 * The subset of an exchange specification that governs data preparation.
 * Connection-agnostic, so both the CLI and the web application can pass their
 * respective config objects (only the shared fields are consumed). The
 * `connection` and `authentication` blocks are excluded: both are connection /
 * partner-trust concerns, not data-preparation inputs.
 */
export type ExchangeDataSpec = Prettify<
  Omit<ExchangeSpec, "connection" | "authentication" | "linkageTerms"> &
    Partial<Pick<ExchangeSpec, "linkageTerms">>
>;

/**
 * The result of {@link prepareForExchange}: everything needed to run the PSI
 * protocol, derived from the raw CSV rows and the exchange parameters.
 */
export interface PreparedExchange {
  metadata: Metadata;
  linkageTerms: LinkageTerms;
  /**
   * Optional self-facing retention/disposition pointer, held in the local
   * exchange config (NOT the agreed linkage terms): where this party files its
   * copy of the result and under what retention schedule. Threaded into the
   * self-attested record at the end of the exchange; never sent to the partner
   * and never folded into the agreed-terms hash.
   */
  retentionDisposition?: string;
  /**
   * The `deduplicate` an accepted invitation declared for the partner's
   * side. When set, {@link runExchange} refuses a partner terms value that
   * contradicts it, before any key or payload moves
   * ({@link assertPresentedDeduplicateMatchesInvitation}). Set by the
   * caller, not {@link prepareForExchange}. Undefined when no invitation
   * was accepted, where the two parties' own configs may legitimately
   * differ.
   */
  expectedPartnerDeduplicate?: boolean;
  /**
   * Which of this party's own input columns its result file holds beside
   * the partner's values, passed through from the local config's
   * `include_own_columns` to {@link buildOutputTable}. Undefined writes the
   * result the partner's values alone compose. Nothing about the exchange
   * itself reads it: no frame, no consent display, and no commitment
   * changes with it.
   */
  includeOwnColumns?: OwnColumnSelection;
  dataset: StandardizedDataset;
  /**
   * This party's own `signing` block, taken from the exchange spec so the
   * run boundary can hold the certificate-mode refusals the prepare step
   * cannot settle -- whether the run will sign in band is decided by the
   * signing identity and session key {@link runExchange} is given, which
   * {@link prepareForExchange} never sees. Set by
   * {@link prepareForExchange}; a {@link PreparedExchange} assembled without
   * going through it leaves those refusals unheld.
   */
  signing?: SigningConfig;
  /**
   * The input columns the metadata does not declare, in header order: none
   * of them indexes a record or is sent, and one is matched on only when a
   * standardization transform names it as its input
   * ({@link undeclaredColumnNames}). Set by {@link prepareForExchange} for a
   * front end to show before the run connects
   * (`describeUndeclaredColumns`), and written into this party's own result
   * under `include_own_columns: all` when {@link metadataInferred} is set
   * ({@link undeclaredColumnsForOwnResult}). Absent on a
   * {@link PreparedExchange} assembled without it, which then shows nothing
   * and writes only the declared columns.
   */
  undeclaredColumns?: Array<string>;
  /**
   * Whether {@link metadata} was inferred from the input's header because
   * the exchange spec holds no `metadata` block. Set by
   * {@link prepareForExchange}; absent reads as an authored block. Decides
   * whether `include_own_columns: all` writes the undeclared columns: an
   * authored block that leaves a column out keeps it out of the result.
   */
  metadataInferred?: boolean;
  /**
   * The original parsed CSV rows, retained for payload extraction after
   * linkage. Held in memory from ingestion through the end of
   * {@link runExchange}, roughly doubling peak memory versus holding only
   * the standardized dataset.
   */
  rawRows: Array<CSVRow>;
  rowCount: number;
}

/**
 * Refuse a linkage-terms `algorithm` this build has no run path for, before
 * any matched identifier is revealed. Allowlists `psi` (reveals matched
 * identifiers) and `psi-c` (count only, {@link linkViaCountOnlyPSI}); any
 * other value -- including one adopted verbatim from a partner's invitation
 * -- is refused so the self-attested record never attests a disclosure the
 * run did not make. Plain {@link UsageError}, not `OperatorConfigError`:
 * the accept path adopts the algorithm from the partner's invitation, so
 * the fault is not provably this operator's own config.
 */
export function assertAlgorithmImplemented(algorithm: Algorithm): void {
  if (algorithm === "psi") return;
  if (algorithm === "psi-c") return;
  throw new UsageError(
    "the linkage terms name an algorithm this version of Alcove does not " +
      'run. Set linkage_terms.algorithm to "psi", which reveals matched ' +
      'identifiers, or "psi-c", which reveals only the count, or ask your ' +
      "partner for terms that name one of them.",
  );
}

/**
 * Refuse linkage terms that a run holding them, beside this party's own
 * `metadata` and `standardization`, would refuse before it sends anything.
 * Run where terms enter or leave a party's document without a run to check
 * them -- an offline invitation minted from it, a terms update made from it,
 * and a partner's terms update applied to it -- so neither party consents to
 * terms whose first run is refused.
 *
 * A `payload.send` that differs from what the metadata transmits is not
 * refused here: the run, the invitation, and the terms update each state the
 * transmitted columns in its place.
 *
 * The metadata and standardization checks run only where the document holds
 * an explicit block: without one the run infers it from the input file, which
 * none of these callers reads.
 *
 * @throws {UsageError} naming the rule the terms break.
 */
export function assertTermsRunnable(
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
 * Resolve whether this exchange runs the count-only (`psi-c`) path, from
 * both parties' agreed terms, and refuse a count-only exchange outside the
 * shape docs/spec/PROTOCOL.md (PSI-C) admits.
 *
 * Symmetric: each party calls it with its own terms plus the partner's, so
 * a refusal aborts both parties at the same point rather than desyncing
 * the lockstep round -- the same shape as {@link resolveLinkageCardinality}.
 * A pair naming different algorithms is refused as an
 * {@link AlgorithmDivergenceError} rather than resolved to either value.
 */
export function resolveCountOnlyRun(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): boolean {
  assertAlgorithmImplemented(localTerms.algorithm);
  assertAlgorithmImplemented(partnerTerms.algorithm);
  if (localTerms.algorithm !== partnerTerms.algorithm)
    throw new AlgorithmDivergenceError(
      `your linkage terms use algorithm "${localTerms.algorithm}" and your ` +
        `partner's use "${partnerTerms.algorithm}". Agree on one algorithm ` +
        "with your partner and run again.",
    );
  assertCountOnlyTermsShape(localTerms);
  assertCountOnlyTermsShape(partnerTerms);
  return localTerms.algorithm === "psi-c";
}

/**
 * Requires an association table to hold well-formed matched pairs, before
 * {@link runExchange} consumes it: halves of equal length, a local
 * half in ascending order, no pair repeated, and a local row repeated only
 * where the given `cardinality` admits it. The payload, the result file,
 * and the attested result size all depend on this shape.
 *
 * @internal exported for the association-table invariant test.
 */
export function assertMatchedPairsWellFormed(
  associationTable: AssociationTable,
  cardinality: LinkageCardinality,
): void {
  const [matchedRows, partnerRows] = associationTable;
  if (matchedRows.length !== partnerRows.length)
    throw new InternalConsistencyError(
      "the association table's halves have different lengths: " +
        `${matchedRows.length} vs ${partnerRows.length}. Each entry is one ` +
        "matched pair, so the two halves are read together.",
    );
  const localRowMayRepeat =
    cardinality === "one-to-many" || cardinality === "many-to-many";
  let runStart = 0;
  const runPartnerRows = new Set<number>();
  for (let i = 1; i < matchedRows.length; ++i) {
    if (matchedRows[i] > matchedRows[i - 1]) {
      runStart = i;
      runPartnerRows.clear();
      continue;
    }
    if (matchedRows[i] < matchedRows[i - 1])
      throw new InternalConsistencyError(
        "the association table's local half is not in ascending order.",
      );
    if (!localRowMayRepeat)
      throw new InternalConsistencyError(
        "the association table repeats a local row index, which the " +
          `"${cardinality}" cardinality this exchange resolved does not ` +
          "produce.",
      );
    if (runStart === i - 1) runPartnerRows.add(partnerRows[runStart]);
    if (runPartnerRows.has(partnerRows[i]))
      throw new InternalConsistencyError(
        "the association table repeats a matched pair.",
      );
    runPartnerRows.add(partnerRows[i]);
  }
}

/**
 * The result size a record attests for a matched table: its pair count.
 * Under `one-to-one` this equals both parties' matched-record counts; under
 * a deduplicating cardinality they diverge, and the pair count is the
 * figure both parties derive identically from the single exchanged table
 * (docs/spec/EXCHANGE_RECORD.md, Result size under a deduplicating
 * cardinality).
 */
export function matchedPairCount(associationTable: AssociationTable): number {
  return associationTable[0].length;
}

/**
 * Refuse agreed terms that declare a per-record candidate width
 * ({@link partyFansOut}) under a combination with no resolution for one,
 * before anything goes on the wire: a `linkage_strategy` off the
 * candidate-set allowlist, or the count-only algorithm
 * (docs/spec/PROTOCOL.md, The combinations that stay unsupported).
 *
 * The numeric reading of what `assertFanOutImplemented` refuses structurally,
 * kept beside it so a width the derivation produces and the producer list does
 * not cannot slip past both. A {@link UsageError}: the width is a function of
 * terms the accept path adopts wholesale.
 */
function assertDeclaredWidthMatchesStrategy(
  terms: LinkageTerms,
  effectiveKeyCount: number,
): void {
  const countOnly = terms.algorithm === "psi-c";
  if (!countOnly && candidateSetIsImplementedForStrategy(terms.linkageStrategy))
    return;
  const keyCount = terms.linkageKeys.length;
  if (!partyFansOut(keyCount, { effectiveKeyCount })) return;
  if (countOnly) throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS.candidateSet);
  throw new UsageError(
    "these linkage terms declare " +
      `${effectiveKeyCount} candidate value slot(s) per record across ` +
      `${keyCount} linkage key(s), but their linkage_strategy matches one ` +
      "value per record. Remove the expanding step, the fuzzy comparison or " +
      "the swapped key order from the key's elements, or agree terms " +
      "whose linkage_strategy matches several candidates.",
  );
}

const MAX_QUOTED_TERMS_VALUE_LENGTH = 40;

function quotedTermsValue(
  terms: unknown,
  path: ReadonlyArray<PropertyKey>,
): string | undefined {
  let value: unknown = terms;
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value !== "string") return undefined;
  const redacted = redactPrivateKeyMaterial(value);
  const codePoints = Array.from(redacted);
  return quoteTermsValue(
    codePoints.length > MAX_QUOTED_TERMS_VALUE_LENGTH
      ? `${codePoints.slice(0, MAX_QUOTED_TERMS_VALUE_LENGTH).join("")}...`
      : redacted,
  );
}

/**
 * Refuse linkage terms the partner's parser would reject on receipt, before
 * any connection is opened: the partner reads them with `parseLinkageTerms`
 * (protocolSetup.ts), and this applies the same schema through its
 * non-throwing form. Terms built in code rather than read from a file reach
 * this function without having met that schema anywhere else.
 *
 * An {@link OperatorConfigError}: the refusal quotes a value from the terms,
 * and an acceptor's adopted terms already passed this schema when derived
 * from the invitation, so only a document this party wrote can fail here.
 */
function assertTermsPassPartnerParse(linkageTerms: LinkageTerms): void {
  const parsed = safeParseLinkageTerms(linkageTerms);
  if (parsed.success) return;
  const [first, ...rest] = parsed.error.issues;
  const pathAsWritten = first.path.map((segment) =>
    typeof segment === "string" ? snakeizeKey(segment) : segment,
  );
  const reason = redactPrivateKeyMaterial(
    rawDecodeErrorDescription({
      issues: [{ ...first, path: pathAsWritten }, ...rest],
    }),
  );
  const value = quotedTermsValue(linkageTerms, first.path);
  const valueClause = value === undefined ? "" : ` (the value is ${value})`;
  throw new OperatorConfigError(
    "your partner would refuse these linkage terms: " +
      reason +
      valueClause +
      ". Correct that setting in the linkage terms and run again.",
  );
}

// The abort reason a caller that could not record the payload receive list the
// first run filled sends; its own failure, like the unrecorded pin's
// (exchange/signingChecks.ts).
const PAYLOAD_RECEIVE_UNRECORDED_ABORT_REASON =
  "a party could not record the payload columns it receives";

/**
 * The abort reason a party sends when its operator declines the payload
 * columns the partner's terms declare it sends, on a run that holds no list of
 * the columns it receives ({@link RunExchangeOptions.onPayloadReceiveFill}).
 */
export const PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON =
  "the partner has not accepted the payload columns you send";

// The abort reason a party sends when asking about the payload columns failed
// rather than being answered; its own failure, like the unrecorded fill's.
const PAYLOAD_RECEIVE_UNCONFIRMED_ABORT_REASON =
  "a party could not confirm the payload columns it receives";

/**
 * The answer to {@link RunExchangeOptions.onPayloadReceiveFill}: the columns
 * are taken, or declined with the error the run then ends on.
 */
export type PayloadReceiveFillAnswer =
  { accepted: true } | { accepted: false; refusal: Error };

/**
 * Resolve what the two parties' agreed `deduplicate` settings gave this
 * run: the cardinality {@link runExchange} passes to the linkage
 * strategies, beside the two values it was resolved from. The label is read
 * from the calling party's own side, so the two parties hold mirror labels
 * for one procedure (docs/spec/PROTOCOL.md, Deduplicating cardinalities):
 * `(true, false)` gives the declaring party `many-to-one`; `(true, true)`
 * gives `many-to-many`, which {@link assertBothSidedDeduplicateImplemented}
 * requires a matching strategy for. A refusal is symmetric and aborts both
 * parties at this point.
 *
 * The refusals are this function's own; the derivation beneath them is
 * {@link resolvedMatchingFromTerms}, which the self-attested record reads
 * too, so a record cannot name a cardinality its run did not resolve to.
 */
export function resolveLinkageCardinality(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): ResolvedMatching {
  assertDeduplicateImplemented(localTerms);
  assertDeduplicateImplemented(partnerTerms);
  assertBothSidedDeduplicateImplemented(localTerms, partnerTerms);
  return resolvedMatchingFromTerms(localTerms, partnerTerms);
}

/**
 * The metadata and linkage terms an exchange resolves from its spec: the
 * config's own where it holds them, else the ones derived from this
 * run's input columns. The single definition {@link prepareForExchange}
 * itself uses, exported so a front end that must inspect either before
 * preparing -- the outbound-payload confirmation -- resolves them exactly
 * as the run does.
 *
 * `sanitizedColumnPositions` are the 1-based positions the read that produced
 * `columnNames` removed bidi control characters from. A caller holding that
 * read's own positions passes them, so a header the removal emptied is refused
 * naming it rather than the header-row causes; one handed a column list passes
 * an empty list, saying so at the call site.
 *
 * Also resolves the input columns the metadata does not declare
 * ({@link undeclaredColumnNames}), which the run does not send, and refuses
 * metadata that declares a sent column the input does not hold
 * ({@link assertDeclaredPayloadColumnsPresent}).
 */
export function resolveExchangeInputs(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string | undefined,
  columnNames: Array<string>,
  sanitizedColumnPositions: ReadonlyArray<number>,
): {
  metadata: Metadata;
  metadataInferred: boolean;
  linkageTerms: LinkageTerms;
  undeclaredColumns: Array<string>;
} {
  const metadataInferred = exchangeDataSpec.metadata === undefined;
  const metadata =
    exchangeDataSpec.metadata ??
    inferMetadata(columnNames, sanitizedColumnPositions);
  assertDeclaredPayloadColumnsPresent(metadata, columnNames);
  return {
    metadata,
    metadataInferred,
    linkageTerms:
      exchangeDataSpec.linkageTerms ??
      getDefaultLinkageTerms(identity, metadata),
    undeclaredColumns: undeclaredColumnNames(columnNames, metadata),
  };
}

/**
 * The undeclared input columns `include_own_columns: all` writes into this
 * party's own result, passed to {@link buildOutputTable}: every one of
 * {@link PreparedExchange.undeclaredColumns} when the metadata was inferred,
 * and none when the operator authored a `metadata` block, whose omissions
 * stay out of the result.
 */
export function undeclaredColumnsForOwnResult(
  prepared: Pick<PreparedExchange, "metadataInferred" | "undeclaredColumns">,
): Array<string> {
  return prepared.metadataInferred === true
    ? (prepared.undeclaredColumns ?? [])
    : [];
}

/**
 * Prepare a local dataset for a PSI exchange.
 *
 * Given raw CSV rows and exchange parameters, this function:
 * - Infers column metadata when not provided explicitly.
 * - Builds default linkage terms when not provided explicitly.
 * - Infers the date-of-birth input format when standardization is absent.
 * - Builds a default standardization pipeline when not provided explicitly.
 * - Constructs a {@link StandardizedDataset} ready for key-iterable creation.
 * - Fails closed when an explicit (authoritative) standardization contradicts
 *   the linkage terms.
 * - Fails closed when the input cannot satisfy every linkage key the agreed terms
 *   declare (see {@link assertLinkageTermsSatisfiable}).
 *
 * Call this before the exchange's connection is opened. After the handshake role
 * and PSI role are resolved, {@link runExchange} builds the key iterables and
 * runs the protocol.
 *
 * @param exchangeDataSpec  Exchange parameters, loaded from a config if
 *                possible.
 * @param identity An identity string used to create default linkage terms, if
 *                necessary.
 * @param rawRows Parsed CSV rows as plain string maps.
 * @param columnNames Column names from the CSV header (used when `metadata` is
 *                absent from `params`).
 * @param sanitizedColumnPositions The 1-based positions the read that produced
 *                `columnNames` removed bidi control characters from, so a header
 *                the removal emptied is refused naming the removal rather than
 *                the header-row causes. Defaults to none for a caller handed a
 *                column list rather than a read of its own, which then states
 *                those causes.
 */
export function prepareForExchange(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string | undefined,
  rawRows: Array<CSVRow>,
  columnNames: Array<string>,
  sanitizedColumnPositions: ReadonlyArray<number> = [],
): PreparedExchange {
  const log = getLogger("exchange");

  const { metadata, metadataInferred, linkageTerms, undeclaredColumns } =
    resolveExchangeInputs(
      exchangeDataSpec,
      identity,
      columnNames,
      sanitizedColumnPositions,
    );

  // Fail closed on an algorithm with no run path before any credential,
  // terms, or data are sent. Refused again at the run boundary (runExchange)
  // so the refusal holds for a PreparedExchange built without this
  // function. See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // The local prepare step of the count-only shape refusal; the other is
  // the agreed-terms run boundary (resolveCountOnlyRun). Both run over
  // metadata resolved above, so the transmit rule is never asked of an
  // unresolved block. A no-op on every `psi` exchange. See
  // assertCountOnlyTermsShape and assertCountOnlyTransmitsNoColumn.
  assertCountOnlyTermsShape(linkageTerms);
  assertCountOnlyTransmitsNoColumn(linkageTerms.algorithm, metadata);

  // Fail closed on a deduplicating term the agreed strategy cannot match,
  // before any credential, terms, or data are sent. Refused again from
  // both parties' agreed terms in runExchange (resolveLinkageCardinality).
  // See assertDeduplicateImplemented.
  assertDeduplicateImplemented(linkageTerms);

  // Fail closed on a signing mode with no run path: only certificate mode
  // signs a receipt, so a session-derived block would otherwise run to
  // completion and leave the operator the unsigned record they did not
  // ask for. See assertSigningModeImplemented.
  assertSigningModeImplemented(exchangeDataSpec.signing?.mode);

  // Fail closed when certificate mode names no party: a certificate is
  // trusted by the identity its holder used in the agreed terms, so the
  // signature swap refuses an unnamed side after the payloads have
  // crossed. See assertCertificateModeNamesLocalParty.
  assertCertificateModeNamesLocalParty(exchangeDataSpec.signing, linkageTerms);

  // Reject a disclosed column whose name is too long to carry, before the
  // frame is sent. Refused again at the run boundary (runExchange), so the
  // refusal holds for a PreparedExchange built without this function. See
  // assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(metadata, linkageTerms.output);

  // The effective key count the agreed terms declare: the sum over their
  // keys of the width each key's elements declare. Sizes the pre-flight
  // gate below.
  const effectiveKeyCount = declaredEffectiveKeyCount(linkageTerms);

  let dateInputFormat: string | undefined;
  if (exchangeDataSpec.standardization === undefined) {
    const dobCol = linkageDateOfBirthColumn(metadata);
    if (dobCol !== undefined) {
      const inference = inferDateFormatWithCounts(
        columnValues(rawRows, dobCol.name),
      );
      dateInputFormat = inference.format;
      if (inference.format !== undefined)
        log.info(
          `inferred date of birth format: ${inference.format}` +
            (inference.unparsed > 0
              ? ` (${inference.unparsed} of ${inference.scanned} sampled values do not parse and are dropped)`
              : ""),
        );
      else if (inference.scanned > 0)
        log.warn(
          `could not infer the date of birth format: no candidate format ` +
            `parses most of the ${inference.scanned} sampled values, so they ` +
            `are parsed as ${DEFAULT_DATE_INPUT_FORMAT}. Set the parse_date ` +
            `input_format in a standardization to choose the format.`,
        );
    }
  }

  const standardization =
    exchangeDataSpec.standardization ??
    getDefaultStandardization(metadata, linkageTerms, { dateInputFormat });

  // Fail closed on an authoritative config whose standardization contradicts its
  // linkage terms (see assertStandardizationMatchesTerms for the full rationale
  // and the exit-64 / web-display contract). Gated on an authored
  // standardization: the terms-only path (undefined) reconstructs one from the
  // terms via getDefaultStandardization above and so cannot contradict them, and
  // is not gated. The same shared assert runs at the `alcove invite`
  // mint boundary, so `invite` never discloses a token this exchange would refuse.
  if (exchangeDataSpec.standardization !== undefined)
    assertStandardizationMatchesTerms(
      exchangeDataSpec.standardization,
      linkageTerms,
    );

  // Fail closed when this input cannot satisfy every linkage key the agreed
  // terms declare -- a key whose fields the columns cannot produce, a key whose
  // own declared cleaning drops every record, or terms declaring no key at all.
  // Such a run would match fewer keys than both parties consented to while its
  // record still names every declared field, so the shortfall is resolved with
  // the partner out of band instead. Fires before any credential, terms, or
  // data are sent. Graded over the AUTHORED standardization rather than the
  // resolved default just below, so a front end grading the same spec earlier
  // cannot disagree with this gate; ordered behind the standardization/terms
  // contradiction above, so an authored transform whose output names no
  // declared field is reported as that rather than as the unsatisfied field it
  // leaves behind. See assertLinkageTermsSatisfiable.
  assertLinkageTermsSatisfiable(
    columnNames,
    linkageTerms,
    exchangeDataSpec.standardization,
    metadata,
  );

  // Fail closed on a transform that fans one value out into several match
  // candidates under a strategy that matches one value per record: the splitting
  // record's candidate set has no round to enter there, and the run would abort
  // once it reached one. Run over the RESOLVED standardization (authored or
  // default, which declares no fan-out) plus the terms' element transforms, so
  // both authoring paths are covered; the terms half is refused again at the
  // run boundary. See assertFanOutImplemented.
  assertFanOutImplemented(linkageTerms, standardization);

  // Behind every refusal above, whose guidance is specific to its own fault;
  // this one names whatever else the partner's parse would reject. Checked in
  // the form the terms exchange sends them, payload send set stated.
  assertTermsPassPartnerParse(
    termsStatingDeclaredPayloadSend(linkageTerms, metadata),
  );

  // Pre-flight the single-pass dataset ceiling: a coarse, ONE-PARTY lower
  // bound. It sees only this party's own row count, never the partner's or
  // either side's distinct-value counts (not computed locally or exchanged),
  // so it cannot replace the authoritative, symmetric two-party check in
  // linkViaSinglePassPSI, which runs once both record counts are exchanged.
  // Applies to either role: the ceiling is symmetric (a receiver holds both
  // encrypted sets resident, bounded exactly as the sender's), so this
  // party's own count predicts an abort regardless of which side it plays.
  //
  // Ordered behind the fan-out refusal above, so a fan-out a strategy cannot
  // match is refused for that rather than for size. An OperatorConfigError
  // naming only this party's own counts and a fixed constant -- no
  // partner-authored content, so the accept path never echoes invitation
  // text through it.
  //
  // Sanitize the key names for display: on the accept side these come from the
  // partner's invitation (charset-unconstrained), and the operator already
  // reviewed the same escaped form when agreeing to the terms (displayInvitation).
  log.info(
    "will link using keys:",
    linkageTerms.linkageKeys
      .map((k) => redactAndSanitizeForDisplay(k.name))
      .join(", "),
  );

  const dataset = buildStandardizedDataset(
    standardization,
    rawRows,
    metadata,
    linkageTerms,
  );

  // The count this party declares, which is what the ceiling weighs and what the
  // partner reads: its rows times the factor its own cleaning fans them out by.
  // The dataset is what reports that factor, so a fan-out on a field no linkage
  // key reads declares nothing.
  const declaredRecordCount =
    rawRows.length * localFanOutFactor(dataset.declaresFanOut);

  if (
    linkageTerms.linkageStrategy === "single-pass" &&
    singlePassDatasetExceedsCap(effectiveKeyCount, declaredRecordCount)
  ) {
    throw new OperatorConfigError(
      `this dataset is too large for single-pass linkage: ` +
        `${declaredRecordCount} declared record(s) across ` +
        `${linkageTerms.linkageKeys.length} linkage key(s) exceed the ` +
        `single-pass limit. ${SINGLE_PASS_LOCAL_REMEDY}` +
        (partyFansOut(linkageTerms.linkageKeys.length, { effectiveKeyCount }) ||
        dataset.declaresFanOut
          ? " Removing a step that splits values or expands a key also " +
            "lowers the count."
          : ""),
    );
  }

  return {
    metadata,
    linkageTerms,
    // A self-facing operator note, passed through untouched from the local
    // config to the record builder; absent when the config omits it.
    retentionDisposition: exchangeDataSpec.retentionDisposition,
    // A local output-composition setting, passed through untouched from the
    // local config to the result formatter; absent when the config omits it.
    includeOwnColumns: exchangeDataSpec.includeOwnColumns,
    // The invitation commitment expectedPartnerDeduplicate (the partner's
    // declared cardinality side) is NOT threaded here, unlike
    // retentionDisposition above. The caller sets it on the returned
    // PreparedExchange after this returns: the accept path's source is the
    // invitation token, not this dataSpec. See
    // PreparedExchange.expectedPartnerDeduplicate. (It rides ExchangeDataSpec
    // only so the exchange command can read it off the parsed config.)
    // Passed on so the run boundary can hold the certificate-mode refusals
    // this step cannot settle: whether the run signs in band is decided by
    // what runExchange is given, not by the config alone.
    signing: exchangeDataSpec.signing,
    undeclaredColumns,
    metadataInferred,
    dataset,
    rawRows,
    rowCount: rawRows.length,
  };
}

// --- Exchange execution ------------------------------------------------------

export const CONFIRMING_PROTOCOL_STAGE_ID = "confirming protocol";

/**
 * A single named step in the post-connection exchange protocol, as returned
 * by {@link describeExchangeStages}. The `id` values match those emitted by
 * the `onStage` callback in {@link runExchange}.
 */
export interface ExchangeStageDefinition {
  id: string;
  label: string;
}

/**
 * Returns the ordered list of protocol stages that {@link runExchange} will
 * pass to its `onStage` callback. Use this before opening a connection to
 * build a progress indicator; the stage `id` values match the strings emitted
 * during execution.
 *
 * Stages: one "confirming protocol" step (terms exchange + role resolution).
 * For the cascade strategy, one "stage N / K" step per linkage key follows, since
 * each key is a separate on-wire PSI round. Single-pass runs every key in one
 * exchange and then replays them locally in-memory, so it emits no per-key stage
 * (the replay is instant); its only enumerated step is confirming protocol, and
 * the encrypt/match stages it emits pass through the caller's onStage unlabeled.
 * Their ids -- which of them a party emits depends on the role the handshake
 * resolves, so no list can enumerate them here -- are `SINGLE_PASS_STAGE_IDS`
 * in psi/link.ts, for a caller that labels them.
 */
export function describeExchangeStages(
  prepared: PreparedExchange,
): ExchangeStageDefinition[] {
  const confirming: ExchangeStageDefinition = {
    id: CONFIRMING_PROTOCOL_STAGE_ID,
    label: "Confirming protocol",
  };
  if (prepared.linkageTerms.linkageStrategy === "single-pass")
    return [confirming];
  const keyCount = prepared.linkageTerms.linkageKeys.length;
  return [
    confirming,
    ...Array.from({ length: keyCount }, (_, i) => ({
      id: `stage ${i + 1} / ${keyCount}`,
      label: `Linking key ${i + 1} / ${keyCount}`,
    })),
  ];
}

/**
 * Outcome of the zero-setup `--save` shared-secret bootstrap, present on
 * {@link ExchangeResult.bootstrap} only when {@link RunExchangeOptions.saveIntent}
 * was provided (i.e. a zero-setup exchange). `partnerSaveIntent` reports whether
 * the partner also advertised `--save`; `sharedSecret` is the persistent secret
 * established in-band, present only when both parties saved -- the initiator
 * generated it and the responder received it, so both hold the same value.
 */
export interface ExchangeBootstrapResult {
  partnerSaveIntent: boolean;
  sharedSecret?: string;
}

/** The result returned by {@link runExchange} on successful completion. */
export interface ExchangeResult {
  /**
   * The matched association table, or `undefined` when this party's agreed terms
   * give it no output (`output.expectsOutput` is false) -- a one-sided exchange
   * in which this party is the PSI sender / helper. This is the privacy gate: a
   * party not entitled to the result does not receive the result table from the
   * exchange, so neither front end can write it. The table is still computed
   * inside {@link runExchange} (the sender needs it to extract its own outgoing
   * payload) and is withheld only here, at the return. A both-output exchange, and
   * the receiver of a one-sided exchange, get the table. The withholding
   * predicate is exactly the one that gates the audit record's committed
   * association table, so the returned result and the record stay one rule: a
   * helper neither receives the table nor binds it in its record.
   */
  associationTable: AssociationTable | undefined;
  /**
   * The size of the intersection, and the whole result of a count-only
   * (`psi-c`) exchange: present exactly when this party ran one AND its agreed
   * terms entitle it to output. `undefined` on every `psi` exchange, whose
   * result is the association table above.
   *
   * Distinguishes a count-only receiver from the withheld-helper shape:
   * `associationTable` stays undefined for BOTH parties on a count-only run
   * (there is no pairing for either to hold), so this field alone tells a
   * count-only helper (receives nothing) from a count-only receiver.
   *
   * Presence follows this party's OWN entitlement, not the both-entitled gate
   * the record's result size takes: a one-sided run's receiver holds a count
   * its own record omits (docs/spec/EXCHANGE_RECORD.md, Count-only records).
   * The sender's copy, when present, is the receiver's report, not a figure it
   * computed itself (docs/spec/PROTOCOL.md, PSI-C).
   */
  intersectionCount: number | undefined;
  /**
   * The entity-cluster diagnostic over the table above: how many clusters the
   * closure grouped this party's result into, over how many records of each
   * party, and the distribution of their shapes with the distinct matched
   * values each formed on (docs/spec/PROTOCOL.md, Choosing linkage keys under
   * closure).
   *
   * Present on a `many-to-many` run this party holds the table of and the
   * rounds behind it. The key is absent under every other cardinality, whose
   * clusters follow from the table's own shape; under the same withholding
   * gate the table takes -- a party that receives no table receives no summary
   * of it either; and on the `single-pass` SENDER, which is handed the
   * resolved table and holds neither the rounds nor the blocks a cluster's
   * value count is read from.
   *
   * Every field is a count over this party's own table and its own rounds'
   * blocks. Nothing here names a record, a row index, or a linkage-key value,
   * and nothing in it rests on a quantity the partner declared, so it discloses
   * nothing beyond the pairs the result file already holds.
   * `describeEntityClusters` (entityClusterReport.ts) is the sentence both
   * front ends render from it.
   */
  entityClusters?: EntityClusterSummary;
  /** Linkage terms received from the partner during the handshake. */
  partnerTerms: LinkageTerms;
  /**
   * What the two parties' agreed `deduplicate` values resolved to for this
   * party: its own declared value, the value the partner presented at the
   * terms exchange, and the cardinality the pair gives this party
   * ({@link resolveLinkageCardinality}).
   *
   * The same triple the self-attested record holds, so a completion surface
   * states what the run resolved to without re-deriving it from the two
   * terms documents and without waiting for the record to be built -- a run
   * whose record build failed still reports it.
   */
  matching: ResolvedMatching;
  /** The PSI role assigned to this party (sender or receiver). */
  resolvedRole: PsiRole;
  /** Payload data received from the partner after linkage. */
  partnerPayload: PartnerPayload;
  /**
   * Outcome of the zero-setup `--save` bootstrap. The discriminant is whether
   * {@link RunExchangeOptions.saveIntent} was a boolean, not whether this party
   * passed `--save`: a `false` saveIntent still yields a defined result (with
   * `partnerSaveIntent` set and `sharedSecret` undefined), because a non-saving
   * party must still learn the partner's intent to emit the right notice.
   * `undefined` only when `saveIntent` itself was `undefined` -- every
   * recurring/authenticated exchange, where the bootstrap flow is not entered at
   * all.
   */
  bootstrap?: ExchangeBootstrapResult;
  /**
   * The self-attested audit record of this exchange (Phase 1 of exchange
   * receipts) together with its private verification keys, produced as a pair. The
   * `record` holds commitments to the data exchanged plus a non-secret summary
   * and is safe to retain or share; the `keys` hold only the per-commitment salts
   * -- not a snapshot of the committed data -- so they are not a second copy of the
   * matched data, but remain private (a salt plus the record's commitment can open
   * a low-entropy committed value). The caller (CLI or web) persists both. See
   * {@link buildExchangeRecord}.
   *
   * A single optional field rather than two independent ones so the record and
   * its keys can never be present apart. Absent only if building the record
   * threw after the exchange already disclosed, in which case the caller skips
   * persisting -- the record is a secondary audit artifact, so its failure is
   * non-fatal and never discards the exchange result. {@link recordOwedButUnbuilt}
   * states that loss.
   *
   * This is the returning half of the record's delivery. A run that terminates
   * after its payload exchange never reaches this field, and hands the same pair
   * to the caller on its thrown error instead; see
   * {@link exchangeRecordFromFailure}.
   */
  audit?: BuiltExchangeRecord;
  /**
   * Whether this run owed a self-attested record that could not be built, so
   * {@link audit} is absent for a disclosure that occurred.
   *
   * The completed path's half of the answer {@link exchangeRecordOwedButUnbuilt}
   * gives the terminated one, and it is here for the same reason: the failed
   * build warns on the operator log, which an unattended run discards, so a
   * caller reporting the loss on a machine interface reads it from the run.
   *
   * False on every run whose record built. A result exists only past this party's
   * payload send, which is where the record starts being owed
   * (docs/spec/PROTOCOL.md, Self-attested record), so a completed run owing no
   * record does not arise.
   */
  recordOwedButUnbuilt: boolean;
  /**
   * The dual-signed record (Phase 2 of exchange receipts): the mutually-verifiable
   * receipt content plus both parties' certificates and signatures. Present only
   * when a {@link RunExchangeOptions.signingIdentity} and
   * {@link RunExchangeOptions.sessionKey} were supplied AND the signature exchange
   * completed; the caller persists it. Absent on the unsigned path (no signing
   * identity) -- the self-attested record path is unaffected. On a failed signature
   * exchange {@link runExchange} throws (a security {@link ConnectionError}), so a
   * partner signature received without completing the local swap is never returned
   * as a valid artifact.
   */
  signedReceipt?: DualSignedRecord;
}

/**
 * Whether a count-only (`psi-c`) tally this party holds arrived as the PARTNER's
 * report rather than as a figure this party computed. The receiver alone computes
 * the count; the sender's copy, when its terms entitle it to one, travels over the
 * count-report leg and is the receiver's word, which Alcove does not check against
 * a run of its own (docs/spec/PROTOCOL.md, PSI-C -- "The sender's knowledge of the
 * count is trust-contingent"). False for every party that computed its own count,
 * and false for a run that produced no count at all.
 *
 * Both front ends read this one predicate rather than each restating the role
 * rule: it decides whether the seat's completion copy holds the
 * trust-contingent caveat, and a second reading that disagreed would caveat a
 * locally computed count or present a reported one as this party's own
 * finding.
 */
export function countIsPartnerReported(
  result: Pick<ExchangeResult, "intersectionCount" | "resolvedRole">,
): boolean {
  return (
    result.intersectionCount !== undefined && result.resolvedRole === "sender"
  );
}

export interface RunExchangeOptions {
  /** The loaded PSI WASM/native library instance. */
  psiLibrary: PSILibrary;
  /**
   * Builds the crypto engine for the PSI participant, given its resolved role, id,
   * and the disclosure mode the agreed algorithm resolved to. When omitted, the
   * masking runs in-process on the calling thread (the default, and what the browser
   * uses). The CLI supplies a factory that spawns a `worker_threads` worker so the
   * masking runs off the event-loop-owning thread, keeping it responsive for the SFTP
   * heartbeat and timers; the returned engine is disposed when the PSI phase ends.
   *
   * The mode is passed rather than assumed: it is generated into the engine's key
   * material, so an engine built for the other mode refuses the match this run needs
   * instead of quietly producing the other disclosure.
   */
  psiEngineFactory?: (
    role: "starter" | "joiner",
    id: string,
    mode: PsiEngineMode,
  ) => PsiEngine;
  /**
   * Called at the start of each protocol stage. The `id` values match those
   * returned by {@link describeExchangeStages}.
   */
  onStage?: (id: string) => void;
  /**
   * Called as each PSI crypto operation starts, moves, and settles, with the
   * element count it covers, how many of them it has finished while it runs,
   * and how long it ran once it settles. A front end renders a live progress
   * display from it: the operations are the ones a long round spends its
   * minutes inside, and one over a large set reports its processed count
   * between the chunks the engine splits it into. A count-only round's match
   * never splits the partner's response: it reports between the setup slices
   * a memory budget splits it into, and nothing between its start and finish
   * when it runs as one call.
   *
   * Every figure is a count or a duration, never a value from either party's
   * data, and none of it goes on the wire.
   */
  onPsiProgress?: PsiProgressReporter;
  /** Called for each non-fatal warning produced during terms exchange. */
  onWarning?: (msg: string) => void;
  /**
   * Called once after the confirming-protocol stage completes, before the first
   * PSI key stage begins. Useful for reporting partner identity and resolved
   * role without waiting for the full exchange to finish.
   *
   * `runShape` holds what the agreed terms resolved to at this same point --
   * the matching cardinality, the two record counts its derived pair table
   * grows with, and the entitlements deciding which party holds that table and
   * what the other one reads of the match -- so a front end can name the run's
   * cardinality and project that table before the first round. Nothing here
   * refuses or warns on either: the pair-table advisory is a front end's
   * discretion (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling
   * of its own), and {@link describeResolvedRunShape} is the shared composition
   * each seat renders.
   */
  onProtocolConfirmed?: (
    partnerTerms: LinkageTerms,
    resolvedRole: PsiRole,
    runShape: ResolvedRunShape,
  ) => void;
  /**
   * This party's check of its own capacity against the partner's round, called
   * once on a cascade or count-only exchange after the terms exchange and
   * before any PSI set moves, with an upper bound on the values a conforming
   * partner's set for one linkage key holds ({@link partnerRoundValues}). A
   * throw refuses the run and propagates; a {@link RoundCapacityError} also
   * sends the partner {@link PARTNER_SET_OVER_CAPACITY_ABORT_REASON}. The
   * command-line application weighs the memory a round of that size needs
   * here.
   */
  checkPartnerRoundCapacity?: (
    partnerRoundValues: number,
  ) => void | Promise<void>;
  /**
   * Zero-setup `--save` intent for this party. `undefined` (the default) keeps
   * this exchange out of the bootstrap flow entirely: no `save` field is put on
   * the wire and {@link ExchangeResult.bootstrap} is `undefined`, so the
   * recurring/authenticated path is byte-for-byte unchanged. A `boolean` opts
   * in: the intent is advertised on the terms exchange, the partner's intent is
   * read back, and -- only when both parties opt in -- the initiator transmits a
   * fresh shared secret in-band (see {@link exchangeBootstrapSecret}).
   */
  saveIntent?: boolean;
  /**
   * This party's observed SFTP host key (fingerprint + key type), advertised in
   * the post-handshake terms exchange so the two parties can reconcile their
   * independent views of the server's identity. Pass it ONLY on the
   * authenticated path -- the value is unforgeable only because it rides the
   * AEAD-wrapped terms exchange, so a caller threading it over an unauthenticated
   * channel would defeat the check. `undefined` (the default) advertises
   * nothing, which is correct for any channel that observes no host key (a
   * file-drop or proxy path) and for the web/WebRTC caller. The partner's
   * advertised value is reconciled against this one; a divergence is reported via
   * {@link onHostKeyDivergence}.
   */
  observedHostKey?: PresentedHostKey;
  /**
   * Called once, after the terms exchange, when the two parties' advertised SFTP
   * host-key fingerprints diverge (see {@link reconcileHostKeyFingerprints}). The
   * argument is a complete warning naming both observed values, composed raw:
   * the caller escapes it once where it shows it.
   * Not called when the fingerprints match, when either party observed no host
   * key, or when {@link observedHostKey} was not supplied. The divergence is
   * non-fatal -- the exchange continues -- so a caller reports it as a warning
   * rather than aborting.
   */
  onHostKeyDivergence?: (message: string) => void;
  /**
   * Called once, after the terms exchange, when the partner's host-key
   * advertisement was present on the wire but failed the fail-soft validation
   * (present-but-malformed; see `exchangeTerms`'s `partnerHostKeyMalformed`). Not
   * called when the partner advertised a well-formed key or none at all, so a
   * benign no-host-key partner (a file-drop or proxy path) stays quiet. The
   * malformed value is dropped either way and reconciliation is skipped for it
   * -- this is a diagnostic-only signal, so a caller logs it at a low level (the
   * CLI logs it at debug) rather than warning or aborting. The dropped bytes are
   * not shown: they are unusable, and echoing partner-controlled content into a
   * log is an injection risk.
   */
  onPartnerHostKeyMalformed?: () => void;
  /**
   * This party's long-lived signing identity, from `signing.identity_file`. When
   * present (together with {@link sessionKey}), the signing step runs at the
   * conclusion of the exchange: both parties sign the same canonical receipt
   * content and swap signatures, yielding {@link ExchangeResult.signedReceipt}.
   * Absent (the default) skips the step entirely, so the unsigned-record path --
   * the web app (which holds no signing identity) and a CLI exchange without a
   * signing identity -- runs {@link runExchange} unchanged. The CLI threads it
   * only on the authenticated path, the only one that holds a session key.
   */
  signingIdentity?: SigningIdentity;
  /**
   * The pinned partner certificate fingerprint (`signing.partner_fingerprint`),
   * consulted only when {@link signingIdentity} is present. The terms exchange
   * holds the certificate the partner presents there to this pin, and the
   * signature swap verifies the presented certificate against the value that
   * resolved to. Absent, the terms exchange adopts the partner's presented
   * fingerprint as a first authenticated contact and reports it through
   * {@link onPartnerCertificatePinned}. Field-shape-validated by the config
   * schema.
   */
  partnerFingerprint?: string;
  /**
   * Called once, at the terms exchange, when this run adopts the partner's
   * presented certificate fingerprint because {@link partnerFingerprint} names
   * none -- a first authenticated contact. The argument is the adopted
   * fingerprint, an unpadded base64url SHA-256 digest this party derived from
   * the presented certificate, so it holds no partner-authored text. A caller
   * records it here rather than after the run, so a run that pins and then
   * fails mid-round does not re-pin blind on the next attempt; a throw stops
   * the run before the bootstrap frame and before any linkage key or payload
   * row moves. Not called when a pin was already on file, and not called on
   * any run that does not sign in band.
   */
  onPartnerCertificatePinned?: (fingerprint: string) => void;
  /**
   * Called once, at the terms exchange, before the partner's certificate is
   * pinned and before any linkage key or payload row moves, when this party
   * holds no list of the columns it receives -- its terms leave
   * `payload.receive` unset -- and the partner's terms declare at least one
   * column it sends this party: the argument is those column names, which
   * {@link onPayloadReceiveFilled} would then record. An accepted answer takes
   * them. A decline sends the partner
   * {@link PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON} and the run ends on its
   * `refusal`; a throw sends a fixed abort naming this party's own failure and
   * propagates. Either records neither the pin nor the
   * fill. Refusals held after it still apply. Asked whether or not
   * {@link onPayloadReceiveFilled} is set; that recorder without this
   * confirmation fills silently. The names are the partner's and reach the
   * callback raw. Omitted, the columns are taken without asking.
   */
  onPayloadReceiveFill?: (
    columns: string[],
  ) => Promise<PayloadReceiveFillAnswer>;
  /**
   * Called once, after the terms exchange's refusals have all passed, when
   * this party's terms leave `payload.receive` unset and the partner can send
   * it payload ({@link payloadReceiveFill}): the argument is the column names
   * the partner's terms declare in `payload.send`, which this run takes on as
   * its receive list. The caller records them as `payload.receive` in
   * the configuration it runs from, so the next run compares them strictly. A
   * throw, or a rejected promise, stops the run before the bootstrap frame and
   * before any linkage key or payload row moves. The names are the partner's
   * and reach the callback raw. Omitted by a one-off run, whose unset list
   * accepts whatever the partner sends.
   */
  onPayloadReceiveFilled?: (columns: string[]) => void | Promise<void>;
  /**
   * Called at the terms exchange, before this party's decision is sent and so
   * before any linkage key or payload row moves, when the partner's terms
   * differ from this party's in a way taking them on resolves: the columns
   * the partner sends against the columns this party receives, the
   * partner's `deduplicate` against {@link PreparedExchange.expectedPartnerDeduplicate},
   * or, on the responder, any other agreed term. Resolving takes on
   * {@link TermsChange.adoptedTerms}, with this party's send set stated from
   * its metadata as always, and continues the run under them where the change
   * is {@link TermsChange.continuable}; the caller records them in the
   * configuration it runs from before resolving. A throw ends the exchange
   * and sends the partner `TERMS_CHANGE_NOT_ACCEPTED_REASON`. The partner's
   * values reach the callback raw. Omitted, every difference is refused as a
   * `TermsChangeRefusedError` naming it.
   */
  onTermsChange?: (change: TermsChange) => Promise<void>;
  /**
   * The 32-byte session key from the authenticated key exchange, needed to derive
   * the per-exchange replay binder that the signed receipt commits to. Present only
   * on the authenticated path (the CLI discards it otherwise; the web has no key
   * exchange). Required for the signing step: {@link signingIdentity} without it
   * leaves the step un-runnable, so the caller threads them together or not at all.
   */
  sessionKey?: Uint8Array<ArrayBuffer>;
  verbosity?: number;
}

export { PARTNER_SET_OVER_CAPACITY_ABORT_REASON };

/**
 * An upper bound on the values a conforming partner's set for one linkage key
 * holds: its declared record count, which includes its own fan-out, times the
 * widest key's declared width ({@link declaredKeyWidth}), held to
 * {@link MAX_PSI_DECODE_ELEMENTS}, over which no sender sends a set. Every
 * input is authenticated session state.
 *
 * The declared width in either PSI role: a sender's key read holds a row to
 * the declared width times its local fan-out factor, and `split_on` has no
 * per-element cap, so a sender whose agreed or local cleaning fans out can
 * realize up to the declared width per declared record. Its local cleaning is
 * not in the agreed terms, so no sender partner is weighed narrower.
 */
export function partnerRoundValues(
  partnerRecordCount: number,
  linkageTerms: Pick<LinkageTerms, "linkageKeys">,
): number {
  const widest = Math.max(
    0,
    ...linkageTerms.linkageKeys.map((key, keyIndex) =>
      declaredKeyWidth(key, keyIndex),
    ),
  );
  return Math.min(partnerRecordCount * widest, MAX_PSI_DECODE_ELEMENTS);
}

// Hold the partner's round to the caller's capacity check, before any PSI set
// moves. A capacity refusal sends the partner a fixed abort reason before it
// propagates; any other failure propagates unchanged.
async function assertPartnerRoundWithinCapacity(
  conn: MessageConnection,
  roundValues: number,
  check: RunExchangeOptions["checkPartnerRoundCapacity"],
): Promise<void> {
  if (check === undefined) return;
  try {
    await check(roundValues);
  } catch (err) {
    if (err instanceof RoundCapacityError)
      await sendAbort(conn, [PARTNER_SET_OVER_CAPACITY_ABORT_REASON]);
    throw err;
  }
}

/**
 * Execute the PSI exchange protocol over an already-open connection.
 *
 * This function handles everything after the connection is established (and,
 * for the CLI, after synchronization): it exchanges linkage terms with the
 * partner, resolves the PSI role, and runs the multi-key PSI protocol.
 *
 * Connection setup and (for the CLI) synchronization remain the caller's
 * responsibility because they are transport-specific.
 *
 * @param conn           An open, ready-to-use connection.
 * @param handshakeRole  This party's role in the handshake ("initiator" or
 *                       "responder"), known after connection / synchronization.
 * @param prepared       Output of {@link prepareForExchange}.
 * @param options        PSI library instance, callbacks, and verbosity level.
 */
export async function runExchange(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  prepared: PreparedExchange,
  options: RunExchangeOptions,
): Promise<ExchangeResult> {
  const { dataset, rowCount, retentionDisposition } = prepared;
  // The terms this party sends, compares, and records the run under: the
  // payload send set is stated from the metadata, so the partner holds this
  // party to what it sends. See termsStatingDeclaredPayloadSend. Replaced by
  // the partner's terms where this party takes them on at the terms exchange.
  let linkageTerms = termsStatingDeclaredPayloadSend(
    prepared.linkageTerms,
    prepared.metadata,
  );

  // Last line of defense for the disclosure-integrity guarantee: refuse an
  // algorithm with no run path before anything goes on the wire, so the
  // self-attested record can never attest a disclosure the run did not make.
  // prepareForExchange refuses it at prepare time; this holds even for a
  // PreparedExchange constructed without going through it, and fires before the
  // terms exchange puts anything on the wire. The partner's half of the same
  // question is decided after the terms exchange, from the agreed pair
  // (resolveCountOnlyRun). See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // Refuse a count-only exchange whose input metadata would transmit a column
  // before anything goes on the wire, over the RESOLVED metadata a
  // PreparedExchange always holds -- the rule fails open on an unresolved
  // block, and this is the boundary that holds one. prepareForExchange refuses
  // it at prepare time; this holds for a PreparedExchange assembled without
  // going through it. See assertCountOnlyTransmitsNoColumn.
  assertCountOnlyTransmitsNoColumn(linkageTerms.algorithm, prepared.metadata);

  // Refuse a fan-out element transform under a strategy that matches one value
  // per record before the terms go on the wire, so a PreparedExchange built
  // without going through prepareForExchange cannot start a run that aborts at
  // its first splitting row. This reaches the terms half only: a PreparedExchange
  // retains the built dataset, not the standardization spec, so a fan-out
  // authored there and assembled outside prepareForExchange is refused when that
  // row's candidate set reaches the linkage strategy -- at the point of harm, but
  // after this party's terms have gone on the wire. See assertFanOutImplemented.
  assertFanOutImplemented(linkageTerms);

  // Refuse a disclosed column whose name is too long to carry before anything goes
  // on the wire. prepareForExchange refuses it at prepare time; this holds for a
  // PreparedExchange assembled without going through it, where the partner's parse
  // of the payload frame would otherwise be the first enforcement -- reached only
  // after this party has transmitted the name. See assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(prepared.metadata, linkageTerms.output);

  const { psiLibrary } = options;
  const onStage = options.onStage ?? (() => {});
  const onWarning = options.onWarning ?? (() => {});
  const onProtocolConfirmed = options.onProtocolConfirmed ?? (() => {});
  const verbosity = options.verbosity ?? 0;

  // What the signed-receipt step needs: a signing identity to sign with AND the
  // session key its binder derives from. Read as ONE predicate, here, so the
  // terms-time identity refusal below, the record build, and the swap itself all
  // gate on the same reading rather than on copies that could drift apart.
  const { signingIdentity, sessionKey } = options;
  const willSignReceipt =
    signingIdentity !== undefined && sessionKey !== undefined;

  // Fail closed when certificate mode pins no partner and this run cannot
  // establish one: a run that signs in band pins at the terms exchange, while
  // one that does not would reach a signature swap that rejects any
  // certificate against an absent pin, after the payloads had crossed. Held
  // here rather than at prepare time because only this boundary knows whether
  // the run signs in band. See assertCertificateModePinsPartner.
  assertCertificateModePinsPartner(prepared.signing, willSignReceipt);

  // Whether THIS party will disclose payload to a partner entitled to output:
  // true when its metadata transmits any column (isDisclosedToPartner, the single
  // source of truth preparePayload gathers on). Advertised on the terms exchange
  // so the partner can gate the single-pass association-table withholding on it --
  // payload disclosure is per-party-local and lazy, so the partner cannot infer it
  // and needs the explicit, authenticated signal (see the withhold gate below).
  const localDisclosesPayload = prepared.metadata.some(isDisclosedToPartner);

  // The per-key candidate widths the agreed terms declare, and their sum. Both
  // parties derive them from terms they have both agreed, so nothing about width
  // rides the wire and neither party reads the other's declaration.
  const keyWidths = linkageTerms.linkageKeys.map((key, keyIndex) =>
    declaredKeyWidth(key, keyIndex),
  );
  const effectiveKeyCount = declaredEffectiveKeyCount(linkageTerms);

  // This party's own cleaning fan-out, declared as the records it stands for
  // rather than as width: the count that rides the envelope, resolves the role,
  // and multiplies into every bound derived for this side.
  const localFactor = localFanOutFactor(prepared.dataset.declaresFanOut);
  const declaredRecordCount = rowCount * localFactor;

  // Refuse a declared width on a strategy that cannot match a candidate set,
  // before anything goes on the wire. See assertDeclaredWidthMatchesStrategy.
  assertDeclaredWidthMatchesStrategy(linkageTerms, effectiveKeyCount);

  const { onTermsChange } = options;

  // The most values one PSI set this party receives may hold, stated on the
  // terms exchange so the partner holds every set it sends here to it: the
  // connection's own ceiling where it states one (a browser party's), else the
  // protocol's per-set maximum.
  const localReceiveCeiling = Math.min(
    conn.inboundPsiSetElementCeiling?.() ?? MAX_PSI_DECODE_ELEMENTS,
    MAX_PSI_DECODE_ELEMENTS,
  );

  onStage(CONFIRMING_PROTOCOL_STAGE_ID);
  const {
    partnerTerms: partnerTermsAsSent,
    localTerms: agreedLocalTerms,
    warnings,
    partnerRecordCount,
    partnerReceiveCeiling,
    partnerSaveIntent,
    partnerDisclosesPayload,
    partnerHostKey,
    partnerHostKeyMalformed,
    partnerCertificate,
    partnerCertificateMalformed,
  } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
    declaredRecordCount,
    options.saveIntent,
    options.observedHostKey,
    localDisclosesPayload,
    // Presented only by a run that will sign: the same predicate the signing
    // step itself gates on, so a party holding no session key puts no
    // certificate on the wire.
    willSignReceipt ? signingIdentity.certificate : undefined,
    {
      // A run that can take a change on meets a changed partner `deduplicate`
      // as one it cannot continue under; without one, the invitation binding
      // below refuses it.
      expectedPartnerDeduplicate:
        onTermsChange === undefined
          ? undefined
          : prepared.expectedPartnerDeduplicate,
      onTermsChange:
        onTermsChange === undefined
          ? undefined
          : async (change) => {
              await onTermsChange(change);
              return termsStatingDeclaredPayloadSend(
                change.adoptedTerms,
                prepared.metadata,
              );
            },
    },
    localReceiveCeiling,
  );
  for (const warning of warnings) onWarning(warning);
  linkageTerms = agreedLocalTerms;
  // A partner that proceeded past a declared receive list other than the
  // columns this party sends has taken them on, as its own run records; both
  // parties hold the partner to them from here.
  const partnerTerms = termsResolvingChangedPayloadReceive(
    partnerTermsAsSent,
    linkageTerms,
  );

  // Hold the partner's presented `deduplicate` to what its invitation declared,
  // where this run came from accepting one: the term is per-party, so no
  // compatibility rule compares the two sides, and the value this party consented
  // to is the invitation's rather than whatever arrives here. Before the
  // cardinality is resolved from it, and before any key or payload moves. A no-op
  // on an exchange authored from configuration files, which states no
  // declaration. See assertPresentedDeduplicateMatchesInvitation.
  await assertPresentedDeduplicateOrAbort(conn, {
    expected: prepared.expectedPartnerDeduplicate,
    presented: partnerTerms.deduplicate,
  });

  // Offer a partner's first declared send set to a caller that confirms it
  // before anything is recorded: ahead of the pin below, so a decline leaves
  // the configuration as it was, and before any key or payload moves.
  const payloadReceiveFillColumns = payloadReceiveFill(
    linkageTerms,
    partnerTerms,
  );
  if (
    options.onPayloadReceiveFill !== undefined &&
    payloadReceiveFillColumns !== undefined &&
    payloadReceiveFillColumns.length > 0
  ) {
    let answer: PayloadReceiveFillAnswer;
    try {
      answer = await options.onPayloadReceiveFill(payloadReceiveFillColumns);
    } catch (err) {
      await sendAbort(conn, [PAYLOAD_RECEIVE_UNCONFIRMED_ABORT_REASON]);
      throw err;
    }
    if (!answer.accepted) {
      await sendAbort(conn, [PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON]);
      throw answer.refusal;
    }
  }

  // A run that will sign a receipt needs both parties named and its own
  // certificate bound to the name it agreed terms under. Both are decided the
  // moment the partner's terms arrive, so both are held here, at the same point
  // and for the same reason as the deduplicate check above: before the bootstrap
  // frame, before any linkage key, and before any payload row moves. The
  // signature swap holds the same pair again at the point of use. See
  // assertReceiptBindingsOrAbort.
  // The partner's certificate is resolved against the pin at the same point,
  // so the value the signature swap verifies against is settled before
  // anything is disclosed. See resolvePartnerCertificateOrAbort.
  let resolvedPartnerFingerprint: string | undefined;
  if (willSignReceipt) {
    const namedParties = await assertReceiptBindingsOrAbort(
      conn,
      linkageTerms,
      partnerTerms,
      signingIdentity.certificate,
    );
    resolvedPartnerFingerprint = await resolvePartnerCertificateOrAbort(conn, {
      partnerCertificate,
      partnerCertificateMalformed,
      pinnedFingerprint: options.partnerFingerprint,
      partnerAgreedIdentity: namedParties.partner,
      onPartnerCertificatePinned: options.onPartnerCertificatePinned,
    });
  }

  // Resolve the matching cardinality from both parties' agreed deduplicate
  // settings as the first step after the terms exchange: the resolution is
  // symmetric, so a refusal (a deduplicating term under a strategy that honors
  // none, or the both-sided pair under one that pairs no many-to-many) aborts
  // BOTH parties at this same point -- before the bootstrap frame and the PSI
  // rounds -- rather than desyncing the lockstep. See resolveLinkageCardinality.
  const matching = resolveLinkageCardinality(linkageTerms, partnerTerms);
  const { cardinality } = matching;

  // Resolve which disclosure this exchange runs from both parties' agreed terms, at
  // the same point and for the same reason as the cardinality above: the resolution
  // is symmetric, so a count-only exchange outside the specified shape aborts BOTH
  // parties here -- before the bootstrap frame and the PSI round -- rather than
  // starting a round one side would refuse. See resolveCountOnlyRun.
  const countOnly = resolveCountOnlyRun(linkageTerms, partnerTerms);

  // Resolve what each party discloses to the other, at the same point and for
  // the same reason as the cardinality above: the resolution is symmetric and
  // covers both directions, so a `payload.receive` either party declares present
  // and empty against the other's asserted disclosure refuses BOTH parties here
  // -- before the bootstrap frame, the PSI rounds, the association table and the
  // payload -- whichever seat role resolution goes on to give them. A direction
  // whose receiving party is entitled to no output resolves to no disclosure
  // instead: the send gate below transmits nothing that way, so a declaration
  // there contradicts nothing. An absent partner flag (a peer that advertised
  // none) is taken as "discloses payload", so it never blinds a helper that
  // needs its table. See resolveBothDirectionsDisclosePayload.
  const payloadDisclosure = await resolvePayloadDisclosureOrAbort(conn, {
    localDisclosesPayload,
    localTerms: linkageTerms,
    partnerDisclosesPayload: partnerDisclosesPayload ?? true,
    partnerTerms,
  });

  // Record the fill after every terms-time refusal, so a refused run records
  // nothing though the confirmation above may already have asked, and before
  // the bootstrap frame and any key or payload moves, so the caller has
  // recorded it before this run receives anything under it.
  if (
    options.onPayloadReceiveFilled !== undefined &&
    payloadReceiveFillColumns !== undefined
  ) {
    const columns = payloadReceiveFillColumns;
    try {
      await options.onPayloadReceiveFilled(columns);
    } catch (err) {
      // Best-effort abort before the throw, as the deduplicate refusal above
      // sends one: the failure is this party's own, so the reason is a fixed
      // literal naming no value.
      await sendAbort(conn, [PAYLOAD_RECEIVE_UNRECORDED_ABORT_REASON]);
      throw err;
    }
  }

  // Surface a present-but-malformed partner advertisement as a diagnostic. The
  // value was already dropped by the fail-soft parse (partnerHostKey is
  // undefined), so reconciliation below is a no-op for it; this signal lets the
  // caller distinguish a non-conforming peer from one that observed no host key.
  // A genuine absence leaves the flag false, so the benign no-host-key path
  // emits nothing.
  if (partnerHostKeyMalformed) options.onPartnerHostKeyMalformed?.();

  // Cross-party host-key reconciliation. Both parties advertised the host key
  // they observed on the terms exchange just above; compare them, and report a
  // divergence (no-op when either party observed none, or when the fingerprints
  // match -- see reconcileHostKeyFingerprints). It is advisory, like the save
  // intent, and never aborts the exchange.
  const hostKeyDivergence = reconcileHostKeyFingerprints(
    options.observedHostKey,
    partnerHostKey,
  );
  if (hostKeyDivergence !== undefined)
    options.onHostKeyDivergence?.(hostKeyDivergence);

  // Zero-setup `--save` bootstrap. Only build a result when the caller opted in
  // (saveIntent defined), so every other exchange returns bootstrap: undefined.
  // The shared secret is transmitted only when BOTH parties advertised intent;
  // both learned that from the terms exchange just above, so they agree on
  // whether this frame is sent. It rides directly after terms (before role
  // resolution) so the message ordering is fixed on both sides.
  let bootstrap: ExchangeBootstrapResult | undefined;
  if (options.saveIntent !== undefined) {
    const sharedSecret =
      options.saveIntent && partnerSaveIntent
        ? await exchangeBootstrapSecret(conn, handshakeRole)
        : undefined;
    bootstrap = { partnerSaveIntent, sharedSecret };
  }

  // Local computation: both parties' DECLARED record counts were already
  // exchanged above (partnerRecordCount), so the role follows without a
  // further message. It is the declared count on both sides, so a party whose own
  // cleaning fans out is weighed at the larger figure and trends toward SENDER,
  // in proportion to the work its fan-out actually costs -- away from the
  // single-pass receiver's sole-resolver seat, which is what leaves a count no
  // partner can check nothing to buy (docs/spec/PROTOCOL.md, Role resolution and
  // work minimization).
  const resolvedRole = resolveRole(
    handshakeRole,
    linkageTerms.output,
    partnerTerms.output,
    declaredRecordCount,
    partnerRecordCount,
  );
  const isReceiver = resolvedRole === "receiver";

  // Single-pass association-table withholding, derived from symmetric
  // authenticated session state so both parties reach the same verdict: when the
  // resolved SENDER is a non-receiving helper (expectsOutput false) disclosing no
  // payload, it needs nothing back, so the receiver suppresses its
  // association-table half entirely and the sender skips awaiting it -- keeping a
  // blind helper blind to its own membership. The verdict below is consulted on
  // the single-pass path alone (see withholdsSenderAssociationTable and link.ts);
  // the disclosure it reads is resolved for every strategy, since the refusal it
  // raises is about what the agreed terms admit rather than about a frame.
  const senderExpectsOutput = isReceiver
    ? partnerTerms.output.expectsOutput
    : linkageTerms.output.expectsOutput;

  // What the resolved SENDER discloses to the resolved receiver: the direction
  // of the pair resolved above that runs from the sender's seat.
  const senderDisclosesPayload = isReceiver
    ? payloadDisclosure.partnerToLocal
    : payloadDisclosure.localToPartner;

  const withholdSenderTable = withholdsSenderAssociationTable(
    senderExpectsOutput,
    senderDisclosesPayload,
  );

  // This is where a front end reads the run's resolved shape. It holds the two
  // entitlements as well as the cardinality because the copy composed from it
  // speaks about a result file and about what the partner reads, and neither
  // follows from the cardinality: this party's own entitlement is the same
  // predicate that decides whether it is handed an association table at all
  // (heldResult, below), and the partner reads nothing of the match where its own
  // half is the withheld one -- the single-pass blind-helper case above, which the
  // cascade never reaches.
  onProtocolConfirmed(partnerTerms, resolvedRole, {
    ...matching,
    localRecordCount: rowCount,
    localDeclaredRecordCount: declaredRecordCount,
    partnerRecordCount,
    localExpectsOutput: linkageTerms.output.expectsOutput,
    partnerAssociationTableWithheld:
      linkageTerms.linkageStrategy === "single-pass" &&
      isReceiver &&
      withholdSenderTable,
  });

  const linkageKeyIterables = linkageTerms.linkageKeys.map(
    (key, keyIndex) =>
      new StandardizedKeyIterable(key, dataset, rowCount, isReceiver, keyIndex),
  );

  // Per-message element-count caps for the PSI decode boundaries, from
  // authenticated session state only: the two exchanged record counts and the
  // effective key count both parties derive from the agreed terms. The receiver
  // (joiner) is the PSI sender's counterpart, so the sender's set is the
  // partner's when this party receives; both parties compute identical bounds.
  const singlePassBounds = {
    partnerRecordCount,
    keyWidths,
    localFanOutFactor: localFactor,
  };
  const localSize = {
    effectiveKeyCount,
    recordCount: declaredRecordCount,
  };
  const partnerSize = {
    effectiveKeyCount,
    recordCount: partnerRecordCount,
  };
  const elementBounds = psiElementBounds(
    isReceiver ? partnerSize : localSize,
    isReceiver ? localSize : partnerSize,
  );

  // A cascade or count-only round exchanges one key's sets at a time, sent in
  // parts, each held to the receive ceilings; the single-pass dataset ceiling
  // bounds the rest. This party's first round is held to the partner's stated
  // ceiling before this party builds a set; at the protocol's maximum, the
  // start-of-exchange check and each round's own refusal hold it already.
  const roundsSentInParts =
    linkageTerms.linkageStrategy !== "single-pass" || countOnly;
  if (roundsSentInParts) {
    await assertPartnerRoundWithinCapacity(
      conn,
      partnerRoundValues(partnerRecordCount, linkageTerms),
      options.checkPartnerRoundCapacity,
    );
    if (partnerReceiveCeiling < MAX_PSI_DECODE_ELEMENTS)
      await assertFirstRoundWithinPartnerCeiling(
        conn,
        { linkageTerms, dataset, rowCount },
        isReceiver,
        partnerReceiveCeiling,
        options.onPsiProgress,
      );
  }

  // Single-pass is allowlisted; any other value (including the default) runs the
  // cascade. No mismatch guard needed here -- validateCompatibility already
  // aborted upstream if the two parties' strategies differ. Single-pass takes the
  // exchanged bounds too: the partner's record count and both parties' effective
  // key counts derive the per-exchange frame cap, the abort-if-over-ceiling gate,
  // and the index-table layout, identically on both parties (see
  // linkViaSinglePassPSI and frameSize.ts).
  //
  // Build the crypto engine, then the participant, INSIDE the disposing try.
  // The engine psiEngineFactory returns is a worker (worker_threads in the CLI,
  // a Web Worker in the browser) that must be terminated on every exit path.
  // Evaluating the factory as a constructor argument would spawn that worker
  // BEFORE the PSIParticipant constructor runs, so a throw in the constructor
  // would orphan it; building the engine first and disposing it in the finally
  // when the participant never took ownership makes "the worker is never
  // orphaned" a structural guarantee. The default in-process engine is built
  // here too, from `library`, so the engine the finally disposes is always real
  // -- it holds the library's server or client objects (the secret key among
  // them) whether or not the participant took ownership.
  const psiRole = isReceiver ? "joiner" : "starter";
  const psiId = isReceiver ? "client" : "server";
  // The disclosure this round is built for, fixed once from the agreed
  // algorithm and generated into the engine's key material rather than
  // chosen when the result is read: a count-only engine refuses the
  // operations that would name a match, and an identifier-revealing one
  // refuses to report a cardinality, so a round cannot resolve to the
  // disclosure the other mode's terms agreed. It also rides the receiver's
  // request on the wire, where the partner's sender enforces agreement.
  const engineMode: PsiEngineMode = countOnly
    ? "count-only"
    : "identifier-revealing";
  const engine =
    options.psiEngineFactory?.(psiRole, psiId, engineMode) ??
    new InProcessPsiEngine(psiLibrary, psiRole, psiId, engineMode);

  let participant: PSIParticipant | undefined;
  let associationTable: AssociationTable | undefined;
  let intersectionCount: number | undefined;
  let entityClusters: EntityClusterSummary | undefined;
  try {
    participant = new PSIParticipant(
      psiId,
      psiLibrary,
      { role: psiRole, verbose: verbosity },
      elementBounds,
      engine,
      options.onPsiProgress,
      roundsSentInParts
        ? { local: localReceiveCeiling, partner: partnerReceiveCeiling }
        : undefined,
    );
    // A crypto step does not start once the connection has ended, since its
    // result has nowhere to go, and one in flight stops at its next chunk
    // boundary: terminating the CLI's worker inside a native backend call
    // aborts the process, so the worker stops itself between calls. The
    // operator is told of the loss when it happens rather than when the step
    // returns.
    participant.stopOperationsWhen(connectionEndReader(conn));
    const psiParticipant = participant; // narrowed for closure
    void conn.terminated?.().then((ended) => {
      const inFlight = psiParticipant.operationInFlight();
      const stopsAtChunk = psiParticipant.stopOperationInFlight();
      if (ended.kind !== "closed" && inFlight)
        getLogger("exchange").warn(
          `the connection to the exchange partner ended ` +
            `(${sanitizeErrorForDisplay(ended)}) while a PSI crypto step was ` +
            "running; the run stops with that error " +
            (stopsAtChunk
              ? "when the step's current chunk finishes."
              : "once the step finishes, which on a large input can take minutes."),
        );
    });
    if (countOnly)
      // One round over one key, resolving to the intersection size and nothing that
      // names a match. The count-report leg is part of the same call: both parties
      // derive whether it runs from the agreed entitlements, so the receiver never
      // sends a frame the sender will not read and the sender never awaits one the
      // receiver will not send. The reported figure is bounded by the smaller of the
      // two exchanged record counts, which is authenticated session state on both
      // sides -- an intersection cannot exceed either party's dataset.
      intersectionCount = await linkViaCountOnlyPSI(
        participant,
        conn,
        linkageKeyIterables,
        reportsCountToSender(
          linkageTerms.output.expectsOutput,
          partnerTerms.output.expectsOutput,
        ),
        Math.min(rowCount, partnerRecordCount),
        verbosity,
        onStage,
      );
    else
      associationTable =
        linkageTerms.linkageStrategy === "single-pass"
          ? await linkViaSinglePassPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              singlePassBounds,
              withholdSenderTable,
              verbosity,
              onStage,
              (summary) => {
                entityClusters = summary;
              },
            )
          : await linkViaPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              singlePassBounds,
              verbosity,
              onStage,
              (summary) => {
                entityClusters = summary;
              },
            );
  } finally {
    // Dispose the crypto engine once the PSI phase is done (or has thrown); the
    // participant is not used past this point. Disposing the participant frees its
    // engine -- the default in-process engine frees its library server/client objects
    // (the secret key among the WASM-heap state they hold), and a worker-backed engine
    // terminates its worker, so a ref'd worker handle can never hold the process open
    // at teardown. If the constructor threw before the participant took ownership,
    // dispose the engine directly -- whether psiEngineFactory spawned a worker or the
    // default in-process engine was built above, it is a live engine here and never
    // orphaned.
    if (participant !== undefined) participant.dispose();
    else engine.dispose();
    // Every round has been read as far as it ever will be, so each one states
    // the drop and wide-row totals its per-row lines stopped short of. Inside
    // the finally so a round that reached either sink before the PSI phase
    // threw still reports it, and after the disposal, which frees key material
    // and is not to be risked on a diagnostic line. closeRowReporting never
    // throws, so this teardown's own exception -- the failure the operator
    // needs -- is never at risk of being replaced by a diagnostic sink's.
    for (const round of linkageKeyIterables) round.closeRowReporting();
  }

  // One entry per matched PAIR, in this party's own ascending row order, is what
  // every reader below assumes of the table -- the payload's transmitted rows, the
  // result file, and the attested result size. The cardinality resolved above
  // decides which multiplicities those readings admit; see
  // assertMatchedPairsWellFormed for the shapes that would break them.
  if (associationTable !== undefined)
    assertMatchedPairsWellFormed(associationTable, cardinality);

  // Send-gate: transmit payload only to a partner entitled to the result. A party
  // with expectsOutput:false learns no matched records, so it has no use for
  // payload values and must not receive them -- transmitting to it is a one-sided
  // disclosure to a non-receiving helper (docs/notes/one-sided-disclosure.md). The
  // disclosed columns are gathered (and the payload built) only when the partner
  // will receive output; otherwise an empty message goes on the wire and is
  // recorded as such. The disclosure is closed at the source here, not merely
  // declared empty.
  //
  // A count-only run has no association table to attach payload values to, and
  // its terms declare no payload column in either direction, so it exchanges
  // the empty message -- committed explicitly as empty, never omitted
  // (docs/spec/EXCHANGE_RECORD.md, Count-only records).
  const localPayload: PayloadWireMessage =
    partnerTerms.output.expectsOutput && associationTable !== undefined
      ? preparePayload(prepared.rawRows, prepared.metadata, associationTable)
      : { hasData: false };

  // A party that receives no payload refuses one, fail-closed before the result
  // is returned: a count-only run, whose record's payload commitments are fixed
  // present-and-empty (docs/spec/EXCHANGE_RECORD.md, Count-only (psi-c)
  // records), and a no-output party, which the send gate above keeps a
  // conforming partner from sending any. A party that receives payload holds
  // the received columns to the partner's agreed `payload.send`.
  //
  // The refusal is caught by the region's guard below rather than thrown straight
  // through: this party's own payload has left it through the transport whatever
  // the partner sent back, so the record of that outbound disclosure is owed. The
  // throw also leaves the rest of the guarded region unrun, so no further frame
  // goes to a partner that broke the disclosure contract.
  const receivesNoPayload = countOnly || !linkageTerms.output.expectsOutput;
  // The partner sends one payload row per distinct record of its own this
  // party's table pairs, so at most one per pair.
  const partnerRowsMatched =
    associationTable === undefined ? 0 : associationTable[1].length;

  // resultSize (the intersection size) is bound only when both parties are
  // entitled to output; heldResult gates both the record's committed table and what
  // is returned to the caller, so it is one predicate. See the
  // ExchangeResult.associationTable JSDoc below for the disclosure rationale.
  const bothExpectOutput =
    linkageTerms.output.expectsOutput && partnerTerms.output.expectsOutput;
  const heldResult = linkageTerms.output.expectsOutput;

  // The intersection size this party can attest, whichever algorithm produced
  // it: the count is a count-only run's whole result, so it takes the
  // result-size field the matched table's length takes under `psi`, under the
  // same unchanged entitlement gate. A count-only run's record holds NO
  // association-table commitment on either side -- neither party holds a
  // pairing to commit to, whatever its entitlement -- and that absence is
  // normative rather than incidental (the commitment's presence is what marks a
  // party as having received the matched pairing). See
  // docs/spec/EXCHANGE_RECORD.md, Count-only records.
  const attestedResultSize = countOnly
    ? intersectionCount
    : associationTable === undefined
      ? undefined
      : matchedPairCount(associationTable);

  // The record-owed region, held by one enclosing guard. It opens at THIS
  // PARTY'S PAYLOAD SEND, the point exchangePayloads reports through the
  // callback below: from there the disclosure the record attests has occurred
  // whatever the rest of the run does (docs/spec/PROTOCOL.md, Self-attested
  // record). Every step inside the guard fails into this party's owed record by
  // construction, and every value the record commits to is fixed above it or,
  // for the partner's payload, by what arrived before the cut.
  let localPayloadSent = false;
  // What this party received: a run cut after its own send received no payload
  // at all, and the record commits to what was received
  // (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
  let partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  let partnerPayloadReceived = false;
  let signedReceipt: DualSignedRecord | undefined;
  let receiptBinder: string | undefined;
  // A holder rather than a bare `unknown`, so a thrown `undefined` is still
  // treated as a failure and cannot pass for a run that got through.
  let postDisclosureFailure: { error: unknown } | undefined;
  try {
    partnerPayload = await exchangePayloads(
      conn,
      handshakeRole,
      localPayload,
      partnerRowsMatched,
      (reportedPartnerPayload) => {
        localPayloadSent = true;
        // The responder's own send is the last frame of its exchange, so an
        // indeterminate rejection there terminates a run that already holds the
        // partner's payload; the step reports it because the throw discards its
        // return value. The record commits what had arrived
        // (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
        if (reportedPartnerPayload !== undefined) {
          partnerPayload = reportedPartnerPayload;
          partnerPayloadReceived = true;
        }
      },
    );
    partnerPayloadReceived = true;
    if (receivesNoPayload) assertNoPayloadReceived(partnerPayload);
    else
      assertPayloadMatchesAgreedSend(
        partnerPayload,
        partnerTerms.payload?.send,
        partnerRowsMatched,
      );
    // Signed-receipt step: at the conclusion of a disclosing exchange, both
    // parties sign the SAME canonical receipt content (the agreed-terms hash and
    // the two directional payload MACs, plus a session-derived binder) and swap
    // signatures over the live channel, producing one dual-signed record. Gated
    // on a signing identity AND a session key both being present, so the
    // unsigned-record path -- the web app (no signing identity) and a CLI
    // exchange without one -- runs this function unchanged. Placed after the
    // payload exchange so the receipt commits to the full result, payloads
    // included.
    //
    // A failure here is NOT swallowed: a fingerprint-pin or signature failure is
    // a security event that terminates the exchange (exchangeSignedReceipt
    // throws a security ConnectionError). The region's guard catches it only so
    // the record built below can state what became of the run and be handed back
    // on the throw -- the disclosure this party already made is what that record
    // attests, and it is owed whether or not the swap completes.
    if (willSignReceipt) {
      // Both parties fold in the INITIATOR's role, so both derive the same binder
      // with no extra messages; see deriveReceiptBinder. Derived before the record
      // is built, so both artifacts hold the one value.
      receiptBinder = await deriveReceiptBinder(sessionKey, "initiator");
      // The identity bindings again, at the point of use: a receipt cannot be
      // built from a pair either side of which named nobody, nor signed under a
      // certificate the partner will authorize against a name it is not bound to,
      // whatever route reached this step. The terms exchange holds the same pair
      // over the same three values, so a run reaching here through runExchange was
      // already refused there; this stands whether or not it was, and its abort
      // releases a partner parked on a receipt frame this party will never send.
      // See assertReceiptBindingsOrAbort.
      const namedParties = await assertReceiptBindingsOrAbort(
        conn,
        linkageTerms,
        partnerTerms,
        signingIdentity.certificate,
      );
      // The receipt content is built from the mutually-verifiable facts directly
      // -- the agreed-terms hash and session-keyed MACs of the two directional
      // payloads -- NOT from the salted record commitments (per-party salts are not
      // byte-identical across parties). It is therefore independent of the
      // non-fatal audit build below; a party that could not build its local record
      // can still sign a receipt. The binder it signs is the same value the record
      // holds, which is what pairs the two artifacts to this one run.
      const termsHash = await computeTermsHash(linkageTerms, partnerTerms);
      const content: ReceiptContent = await buildReceiptContent(
        handshakeRole,
        termsHash,
        toCommittedPayload(localPayload),
        toCommittedPayload(partnerPayload),
        receiptBinder,
        sessionKey,
      );
      signedReceipt = await exchangeSignedReceipt(conn, handshakeRole, {
        identity: signingIdentity,
        // The value the terms exchange resolved -- the pin on file, or the
        // fingerprint this run adopted there -- so one value governs the
        // terms-time comparison and this one.
        pinnedFingerprint: resolvedPartnerFingerprint,
        // The partner's agreed-terms identity (not the certificate's own), so the
        // pinned certificate must authorize the identity the partner used in the
        // agreed terms rather than a value it self-asserts in its certificate.
        partnerIdentity: namedParties.partner,
        content,
        // Retained in the receipt's unsigned envelope, so re-deriving the
        // agreed-terms hash later takes this party's own terms and nothing
        // else (docs/spec/EXCHANGE_RECORD.md, "Dual-signed record file").
        partnerTerms,
      });
    }
  } catch (error) {
    // Before this party's send reported the region has not opened, so the
    // failure owes no record and leaves with none. A send the transport
    // rejects as indeterminate does report, since the payload may have reached
    // the partner all the same.
    if (!localPayloadSent) throw error;
    postDisclosureFailure = { error };
  }

  const { audit, recordOwedButUnbuilt } = await buildOwedExchangeRecord({
    localTerms: linkageTerms,
    partnerTerms,
    postDisclosureFailure,
    rowCount,
    dataset,
    bothExpectOutput,
    attestedResultSize,
    retentionDisposition,
    heldResult,
    associationTable,
    localPayload,
    countOnly,
    partnerPayload,
    receiptBinder,
  });

  // The failure terminates the run, carrying the record of the disclosure that
  // already occurred so the caller can still persist it.
  if (postDisclosureFailure !== undefined)
    throw carryingExchangeRecord(
      postDisclosureFailure.error,
      audit,
      partnerPayloadReceived,
    );

  return {
    // Withheld (undefined) from a party whose agreed terms give it no output, so
    // a non-receiving helper does not get the result table to write; the receiver
    // and both-output parties get it as before. Same predicate as the record gate.
    associationTable: heldResult ? associationTable : undefined,
    // The count-only run's whole result, under the same entitlement gate the table
    // takes: a party whose agreed terms give it no output does not receive the count
    // either. In a one-sided count-only run that party is the PSI sender, and the
    // count-report leg is suppressed for it upstream (reportsCountToSender), so this
    // gate is the entitlement predicate applied once more at the boundary rather than
    // the only thing standing between a helper and a count.
    intersectionCount: heldResult ? intersectionCount : undefined,
    // Derived from the table above, so it goes out under that same entitlement
    // gate: a party handed no table is told nothing about how its pairs grouped.
    // The key is left off where there is no summary, so a result the caller
    // spreads or compares holds it only for the runs that composed one.
    ...(heldResult && entityClusters !== undefined ? { entityClusters } : {}),
    partnerTerms,
    matching,
    resolvedRole,
    partnerPayload,
    audit,
    recordOwedButUnbuilt,
    bootstrap,
    signedReceipt,
  };
}
