import {
  annotate,
  annotationKey,
  annotationOf,
  findInCauseChain,
} from "./failureAnnotation";
import type { AnnotationReadOptions } from "./failureAnnotation";

/**
 * Classifies a terminal {@link ConnectionError} so a consumer can decide how to
 * respond:
 * - `transport`: the link failed after the transport's own retries were
 *   exhausted (peer unreachable, dropped, inactivity timeout). Retrying the
 *   whole exchange is reasonable.
 * - `security`: an authentication/replay/ordering check failed. Must not be
 *   silently retried; report it loudly as possible tampering. The
 *   authentication subset is the `AuthenticationError` subclass, which the
 *   CLI's error->exit boundary maps to 77 (EX_NOPERM).
 * - `usage`: the connection was misconfigured or used incorrectly (e.g. a send
 *   after close, a path shared by another session). The caller must fix
 *   something before retrying. The CLI's error->exit boundary maps this kind
 *   to 64 (EX_USAGE) alongside `UsageError`, as it does a `transport` wrap
 *   whose cause is either. `transport`, `closed`, and the other `security`
 *   failures take 69.
 * - `protocol`: the peer violated the message protocol (e.g. sent out of turn).
 *   A retry meets the same partner, so the CLI's error->exit boundary maps
 *   this kind to 76 (EX_PROTOCOL).
 * - `closed`: a parked operation was cancelled by a local
 *   `MessageConnection.close` (e.g. a signal-driven shutdown). Nothing
 *   went wrong; it is distinct from `usage` (not a programming error) and from
 *   `transport` (not a peer-timeout diagnostic). A clean *remote* close stays
 *   `transport`; a future consumer needing to act on it separately should add
 *   a dedicated kind (e.g. `peer-closed`). See docs/COMMUNICATION.md ("Error
 *   handling").
 */
export type ConnectionErrorKind =
  "transport" | "security" | "usage" | "protocol" | "closed";

/** A terminal connection failure, tagged with a {@link ConnectionErrorKind}. */
export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind;

  constructor(
    message: string,
    kind: ConnectionErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionError";
    this.kind = kind;
  }
}

/**
 * What a transport's `MessageConnection.close` rejects with when it tore
 * down without the peer confirming the last frames it was handed: the partner
 * may or may not have them. Always kind `transport`. A transport subclasses it
 * to give its own message; a wrapping connection passes it through its own
 * close().
 */
export class DeliveryUnconfirmedError extends ConnectionError {
  constructor(message: string) {
    super(message, "transport");
    this.name = "DeliveryUnconfirmedError";
  }
}

/**
 * Extracts a human-readable message from an arbitrary thrown value. The single
 * shared rule for turning an `unknown` error into display text: an `Error`'s
 * `message`, falling back to `String(err)` when that message is empty (so an
 * `Error` with no message yields `"Error"` rather than a blank string), and
 * `String(err)` for any non-`Error` value (so `null`/`undefined` become
 * `"null"`/`"undefined"` rather than throwing on a `.message` dereference).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || String(err) : String(err);
}

/**
 * Wraps an arbitrary thrown value as a {@link ConnectionError}, passing an
 * existing {@link ConnectionError} through unchanged. Shared by the bridges so
 * every transport classifies a raw transport failure the same way.
 */
export function asConnectionError(
  err: unknown,
  kind: ConnectionErrorKind,
): ConnectionError {
  if (err instanceof ConnectionError) return err;
  return new ConnectionError(errorMessage(err), kind, { cause: err });
}

/**
 * The refusal raised when the two parties' agreed terms name different
 * algorithms at the run boundary (`resolveCountOnlyRun`).
 *
 * A {@link ConnectionError} of kind `protocol`, not {@link UsageError}: this
 * party's own algorithm is its own config, so a divergence means the
 * partner proceeded past the terms-exchange compatibility abort -- a
 * protocol violation, not a local misconfiguration (CLI exit 76, not 64).
 * The message names only the fixed algorithm literals, never partner text.
 */
export class AlgorithmDivergenceError extends ConnectionError {
  constructor(message: string) {
    super(message, "protocol");
    this.name = "AlgorithmDivergenceError";
  }
}

/**
 * The refusal raised when a party asserts a payload disclosure the agreed
 * terms declare no column for (`resolveDirectionDisclosesPayload`).
 *
 * A {@link ConnectionError} of kind `protocol`, not {@link UsageError}: the
 * assertion is held against a pair of documents both parties agreed, so the
 * contradiction is a process disclosing against the terms it agreed under --
 * the classification `assertNoPayloadReceived` gives the same pair
 * when the column arrives (CLI exit 76, not 64). The constructor takes no
 * argument and holds the message itself, so no call site can compose a value
 * read off either agreed document into what the operator is shown.
 */
export class PayloadDisclosureDivergenceError extends ConnectionError {
  constructor() {
    super(
      "one party's run is set to send payload columns, but the receiving " +
        "party's linkage terms declare an empty payload.receive. No " +
        "association table or payload was sent. To send those columns, " +
        "declare them in the sender's payload.send and the receiver's " +
        "payload.receive, or remove the receiver's payload.receive so the " +
        "next run sets it from the sender's columns. To send none, set the " +
        "sender's input metadata to send no column (is_payload: false, or " +
        "role ignored).",
      "protocol",
    );
    this.name = "PayloadDisclosureDivergenceError";
  }
}

/**
 * The refusal raised when a partner presents a `deduplicate` its
 * invitation did not declare
 * (`assertPresentedDeduplicateMatchesInvitation`).
 *
 * A {@link ConnectionError} of kind `protocol`, not {@link UsageError}:
 * the contradiction is between two documents the partner authored (CLI
 * exit 76, not 64). Has `alcoveRecoveryHintEmitted` so the CLI's
 * hint-walker suppresses the generic "retry without re-inviting" advisory
 * -- this refusal is terminal against the held invitation and would
 * otherwise loop an unattended recurring exchange.
 */
export class InvitationTermDivergenceError extends ConnectionError {
  readonly alcoveRecoveryHintEmitted = true;

  constructor(message: string) {
    super(message, "protocol");
    this.name = "InvitationTermDivergenceError";
  }
}

/**
 * Whether `error` or any link in its `cause` chain satisfies `predicate`,
 * read by {@link findInCauseChain}.
 *
 * The single shared rule for asking "is this failure, anywhere under
 * whatever wrapped it, an X?" -- a class or a message fragment. Asking it of
 * the chain rather than of the value handed over keeps the answer right
 * wherever the wrapping happens: a re-raise that replaces the message and
 * keeps the original as its `cause` stays matched. A plain object interposed
 * in the chain does not truncate it; a predicate that cares narrows with its
 * own `instanceof`.
 */
export function causeChainSome(
  error: unknown,
  predicate: (link: object) => boolean,
): boolean {
  return (
    findInCauseChain(error, (link) => predicate(link) || undefined) === true
  );
}

const STATES_OWN_NEXT_STEP = annotationKey<true>("states its own next step");

/**
 * `error`, annotated as stating its own next step, so a front end adds no
 * generic advisory or fixed next step beneath it ({@link statesItsOwnNextStep}).
 */
export function markStatesItsOwnNextStep<E extends object>(error: E): E {
  return annotate(error, STATES_OWN_NEXT_STEP, true);
}

/**
 * Whether `error` states its own next step: annotated by
 * {@link markStatesItsOwnNextStep}, or holding the `alcoveRecoveryHintEmitted:
 * true` property the error classes and raise sites in this package set. Read
 * along the `cause` chain, so a wrap of such an error still states the step,
 * unless `options.ownOnly` asks for `error` itself.
 */
export function statesItsOwnNextStep(
  error: unknown,
  options: AnnotationReadOptions = {},
): boolean {
  const states = (link: object): true | undefined =>
    annotationOf(link, STATES_OWN_NEXT_STEP, { ownOnly: true }) === true ||
    (link as { alcoveRecoveryHintEmitted?: unknown })
      .alcoveRecoveryHintEmitted === true
      ? true
      : undefined;
  return findInCauseChain(error, states, options) === true;
}

/**
 * Thrown by {@link FileSyncConnection} when the caller has supplied an
 * invalid configuration or attempted an operation that violates usage
 * constraints: wrong directory state, stale handshake files, multiple
 * concurrent sessions sharing a path, or a send timeout. This is the
 * public API contract for the 64-vs-69 exit-code split: callers outside
 * `packages/core`, the CLI included, check `instanceof UsageError` to
 * distinguish a configuration problem from a transport failure and exit
 * with 64 (EX_USAGE) rather than 69 (EX_UNAVAILABLE). Future throw sites
 * added to `synchronize()` or `send()` should throw this class rather
 * than a plain `Error` with `{ cause: "usage" }`.
 *
 * `options.cause` is forwarded to `Error`, so a refusal whose detail does
 * not fit the display boundary's per-link cap can hold that detail as a
 * `cause` link of its own rather than spending the budget its operative
 * sentence and recovery step need (see `sanitizeErrorForDisplay`).
 */
export class UsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UsageError";
  }
}

/**
 * The refusal for accepted linkage terms that mirror to a document the terms
 * schema rejects, whatever the accepting party sets.
 */
export class AcceptedTermsShapeError extends UsageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcceptedTermsShapeError";
  }
}

/**
 * Options a bounded-transport refusal takes beyond its summary message.
 *
 * @see {@link FrameSizeExceededError}
 * @see {@link DirectoryListingBoundsError}
 * @see {@link TransportOperationStalledError}
 */
interface TransportRefusalOptions {
  /**
   * Ordered detail fragments, each rendered as a capped cause link of its
   * own: one per party that chose the bytes in it, holding its own
   * first-party label so no bare value renders unexplained. A path, a
   * filename, or any other value a partner, a server, or an unbounded
   * config chose belongs here rather than in the summary -- the display
   * boundary caps each link independently, so a fragment on a link of its
   * own can only ever spend its own budget.
   */
  details?: readonly string[];
}

// Folds ordered detail fragments into a cause chain, each fragment a capped
// link of its own: the display boundary caps every link separately, so a value
// one party chose can only ever spend the budget of the link it sits alone on.
// The fragments go AHEAD of `tail` -- an existing cause to preserve, like the
// transport error a connect rejected with -- so the renderer's depth bound
// reaches every labeled detail before an opaque terminal cause.
export function chainDetailCauses(
  details: readonly [string, ...string[]],
): Error;
export function chainDetailCauses(
  details: readonly string[],
  tail: unknown,
): unknown;
export function chainDetailCauses(
  details: readonly string[],
  tail?: unknown,
): unknown {
  return details.reduceRight<unknown>(
    (cause, detail) =>
      new Error(detail, cause === undefined ? undefined : { cause }),
    tail,
  );
}

// A refusal's class-uniform recovery step ahead of its ordered detail
// fragments: the step FIRST so the renderer's depth bound reaches it before any
// detail and before whatever the caller chains behind them.
function refusalCauseChain(
  recoveryStep: string,
  details: readonly string[],
): Error {
  return chainDetailCauses([recoveryStep, ...details]);
}

/**
 * The family of local-configuration faults whose message is composed
 * solely of the local operator's own content, so it is both actionable to
 * that operator and safe to show to them verbatim. Raised from the
 * pre-exchange boundaries -- {@link prepareForExchange} and the CLI's
 * pre-mint invite validation -- before any credential, terms, or data are
 * sent, and from the local certificate/terms gate the terms exchange and
 * the receipt swap both apply, mid-exchange: a consumer keying on this
 * class must not infer phase from membership. The CLI's
 * `classifyTerminalError` reads the class alone for its `config` category,
 * so a member raised at any point before the output stage lands there; the
 * web's `exchangeLifecycle`/`classifyExchangeFailure` additionally
 * requires its `prepare` phase.
 *
 * This base type is the membership rule for the web's actionable "config"
 * alert, which renders the error's message: the web classifies a
 * prepare-phase failure as `config` only when it is an
 * `OperatorConfigError`, not any {@link UsageError}. The distinction is
 * security-relevant: a sibling prepare-time `UsageError` whose message can
 * embed partner-influenced text must stay a plain `UsageError`, so its
 * message is swallowed by the generic alert rather than echoed into the
 * operator's own UI. Membership is a structural property of the type, not
 * of which check happened to fire, so each member is responsible for
 * holding only local content in its message.
 *
 * That per-member responsibility is enforced by a check, not a promise
 * made here: `apps/cli/test/unit/operatorConfigErrorSites.test.ts`
 * enumerates every construction site of this type and its subclasses,
 * records what each message interpolates and why that value is local, and
 * fails on a site or an interpolation it does not account for. Its reach
 * is syntactic and bounded to what it scans: `packages/core/src`,
 * `apps/cli/src`, and `apps/web/src`, for classes written as
 * `class X extends <member>` and constructions written as
 * `new <Identifier>(...)`, so a member or a construction reached through a
 * factory, an alias, or a variable is outside it.
 *
 * Extend it from -- or raise it directly in -- any check that fails closed on
 * the operator's own configuration and whose message names only local content.
 * What that content rule excludes is text another party authored, so a refusal
 * built from fixed prose over counts alone has nothing to exclude, whichever
 * document the counts were read off. {@link StandardizationTermsError} is a
 * member by subclass; a check whose refusal meets the contract without needing
 * a narrower type raises the base class directly. The payload-SEND disclosure
 * check (`assertPayloadSendDisclosed`) is not a member: on the accept side its
 * `payload.send` names are adopted from the partner's invitation, and the check
 * cannot tell its role at the throw site, so it stays out and its message stays
 * swallowed.
 *
 * Being a {@link UsageError} subclass, the CLI's `instanceof UsageError`
 * check still classifies every member as a configuration error (exit 64,
 * EX_USAGE).
 */
export class OperatorConfigError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "OperatorConfigError";
  }
}

/**
 * Why a {@link RoundSetLimitError} refused a set: `"over-set-maximum"`, more
 * values than any receiver admits (`MAX_PSI_DECODE_ELEMENTS`);
 * `"over-partner-ceiling"`, more than the partner stated on the terms exchange
 * that it can receive; `"uncounted"`, the first-round check could not count
 * the set, the failure being the error's `cause`.
 */
export type RoundSetLimitReason =
  "over-set-maximum" | "over-partner-ceiling" | "uncounted";

/**
 * A set of this party's own too large to send, refused before it is built:
 * before contact, a first round over the protocol's per-set maximum or one
 * whose values could not be counted; after the terms exchange, a first round
 * over the partner's stated receive ceiling or one that could not be counted;
 * in any round, a set over either bound, with the partner sent an abort in its
 * place (docs/spec/PROTOCOL.md, "The receive ceiling"). `reason` states which.
 * The message names the count, the bound, and the remedy, and is composed only
 * from counts and fixed constants. Holds `alcoveRecoveryHintEmitted`: a retry
 * refuses identically, so the CLI's generic retry advisory is suppressed.
 */
export class RoundSetLimitError extends UsageError {
  readonly alcoveRecoveryHintEmitted = true;
  readonly reason: RoundSetLimitReason;

  constructor(
    message: string,
    reason: RoundSetLimitReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RoundSetLimitError";
    this.reason = reason;
  }
}

/**
 * Where a {@link RoundCapacityError} was raised: `"terms-exchange"`, before any
 * PSI set moves, or `"set-first-part"`, at the first part of a partner's set
 * inside a round, after this party may have sent sets of its own -- its sets of
 * earlier rounds, and a sender's setup for the same round.
 */
export type RoundCapacityStage = "terms-exchange" | "set-first-part";

/**
 * A partner's PSI set for a linkage key that can hold more values than this
 * party can process, with the partner sent an abort: this party's own capacity
 * limit, not a fault in anything the partner sent. It is refused after the
 * terms exchange and before any set moves, from the partner's authenticated
 * record count (`checkPartnerRoundCapacity` in exchange.ts), or at the first
 * part of a partner's set over this party's receive ceiling (`receivePsiSet`);
 * `stage` states which. The message names the count, this party's limit, and
 * the remedy, and is composed only from counts and fixed text. Holds
 * `alcoveRecoveryHintEmitted`: a retry against the same partner input refuses
 * identically, so the CLI's generic retry advisory is suppressed.
 */
export class RoundCapacityError extends UsageError {
  readonly alcoveRecoveryHintEmitted = true;
  readonly stage: RoundCapacityStage;

  constructor(
    message: string,
    stage: RoundCapacityStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RoundCapacityError";
    this.stage = stage;
  }
}

/**
 * Whether `error` refuses a PSI set of this party's own as too large to send:
 * a {@link RoundSetLimitError}, which refuses identically on every retry and
 * at every window.
 */
export function isSetTooLargeError(
  error: unknown,
): error is RoundSetLimitError {
  return error instanceof RoundSetLimitError;
}

/**
 * The refusal raised, before any credential, terms, or data are sent, when
 * this party's input cannot fully satisfy the linkage terms the two
 * parties agreed to -- a declared key whose fields the columns cannot
 * produce, a key whose own declared cleaning drops every record, or terms
 * declaring no key at all. One grading decides it
 * (`decideLinkageTermsVerdict`) and one boundary enforces it
 * ({@link prepareForExchange}); a front end that grades earlier gives
 * advance notice of this same refusal rather than holding a threshold of
 * its own.
 *
 * Not a transport fault: it fires before anything is sent, and a caller
 * that retries the same input refuses identically, so a UI offering a
 * retry would loop an unattended run on a deterministic local fault. It is
 * a distinct type rather than a plain {@link UsageError} so a caller
 * keeping per-failure bookkeeping can branch on it deterministically (the
 * web's managed re-run records it in the benign input tier), while the
 * CLI's `instanceof UsageError` check still classifies it as a
 * configuration error (exit 64, EX_USAGE).
 *
 * Not an {@link OperatorConfigError}: the field and key names it
 * enumerates are the agreed terms' own, adopted from the partner's
 * invitation on every accept path, so its message is not composed solely
 * of local content and stays out of the message-rendering contract that
 * base type holds. The names ride capped cause links of their own, so a
 * renderer walking the chain spends their budget on them alone and
 * reaches the summary and its remedy first.
 */
export class LinkageTermsUnsatisfiableError extends UsageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinkageTermsUnsatisfiableError";
  }
}

/**
 * The specific {@link OperatorConfigError} for an authored ("authoritative")
 * standardization that contradicts its own linkage terms -- a transform
 * output naming no declared linkage field, or an unknown standardization
 * function (see `validateStandardizationAgainstTerms`). Thrown only by
 * {@link prepareForExchange}, and only for an authored standardization;
 * its message interpolates that standardization's transform outputs and
 * step functions. On the web the only party that reaches this throw is
 * the inviter, with its own authored standardization (local content): the
 * acceptor's standardization is derived from its adopted terms via
 * `getDefaultStandardization`, whose outputs are exactly those terms'
 * field names, so it is consistent with them by construction and does not
 * reach this throw (pinned in linkageSatisfiability.test.ts). Adopted,
 * partner-origin field names therefore never appear here -- every message
 * this type holds is the authoring party's own local content. See
 * {@link OperatorConfigError} for why the web keys its actionable
 * "config" alert on that base type rather than on any prepare-phase
 * {@link UsageError}.
 */
export class StandardizationTermsError extends OperatorConfigError {
  constructor(message: string) {
    super(message);
    this.name = "StandardizationTermsError";
  }
}

/**
 * The refusal for a standardization step naming a function this build does
 * not recognize, raised where the step is compiled rather than where a
 * configuration is validated: the agreed terms' linkage-key element
 * transforms (compiled as a key's fate is classified, before its first row
 * is read), a party's own standardization pipeline, and the public
 * `runPipeline` entry point. It is the compile-time counterpart of
 * {@link StandardizationTermsError}, which covers the same fault where an
 * authored standardization is validated against its own terms, before an
 * exchange runs.
 *
 * A {@link UsageError} subclass, so the CLI's error->exit boundary
 * classifies it as a configuration error (exit 64) rather than the 69
 * that invites an unattended supervisor to retry: an element the agreed
 * terms declare and this build cannot run is a fault in the terms,
 * deterministic in them, and every retry reaches the same refusal (see
 * docs/spec/CHANNEL_SECURITY.md).
 *
 * Not an {@link OperatorConfigError}, unlike its authored-config
 * counterpart: an element transform is adopted verbatim from the
 * partner's invitation on the accept path, so this refusal is not always
 * about the operator's own content, and its message stays swallowed by
 * the web's generic alert. The raise site narrows the offending name to a
 * literal this build recognizes before interpolating it, so no partner
 * free text reaches the message either way.
 */
export class UnknownStandardizationFunctionError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownStandardizationFunctionError";
  }
}

/**
 * The peer's hello advertised a `lockless_rendezvous` or `retain_files` setting
 * different from this party's. Both are bilateral with no negotiation
 * (docs/spec/FILE_SYNC.md, Bilateral configuration), so both parties fail fast and
 * the cleanup paths leave both hellos in place. It sets no
 * `alcoveRecoveryHintEmitted`: detection precedes the handshake, so there is no
 * advisory to suppress (pinned in errors.test.ts).
 */
export class BilateralModeMismatchError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "BilateralModeMismatchError";
  }
}

/**
 * An inbound file over {@link MAX_FRAME_SIZE_BYTES}, refused at the transport read
 * layer (the pre-`get()` size check and each adapter's per-read cap) before it is
 * held in memory. A {@link UsageError}, so the poller stops instead of re-reading
 * it. The class-wide next step takes a cause link of its own; call sites pass a
 * message with no terminal punctuation and every value someone else chose as a
 * `details` fragment (docs/spec/CHANNEL_SECURITY.md).
 */
export class FrameSizeExceededError extends UsageError {
  readonly alcoveRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Confirm the rendezvous directory is dedicated to a single exchange ` +
          `and contact your partner, who may be sending a malformed or ` +
          `oversized frame.`,
        options?.details ?? [],
      ),
    });
    this.name = "FrameSizeExceededError";
  }
}

/**
 * A directory listing over its entry-count or filename-length bound, refused while
 * the adapter enumerates it, before the listing is held in memory. The bounds live
 * where they are enforced, `apps/cli/src/connection/listingGuard.ts`. Classified,
 * tagged and composed as {@link FrameSizeExceededError} is; call sites pass the
 * directory path and the offending entry name as `details` fragments.
 */
export class DirectoryListingBoundsError extends UsageError {
  readonly alcoveRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Confirm the rendezvous directory is dedicated to a single exchange ` +
          `between exactly two parties and is not shared or contaminated; ` +
          `clear any foreign entries or use a fresh directory.`,
        options?.details ?? [],
      ),
    });
    this.name = "DirectoryListingBoundsError";
  }
}

/**
 * A server-driven transport operation that made no progress within its liveness
 * bound: a hung or progress-free `list()`, `get()` or `createExclusive()` on the
 * SFTP adapter, bounded in `apps/cli/src/connection/sftpLivenessGuard.ts`.
 * Classified, tagged and composed as {@link FrameSizeExceededError} is, but its
 * next step is a retry, since the server may recover. Call sites pass how the
 * operation stalled, its path, and any server message as `details` fragments.
 */
export class TransportOperationStalledError extends UsageError {
  readonly alcoveRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Verify the transport endpoint is reachable and the peer is still ` +
          `running, then retry.`,
        options?.details ?? [],
      ),
    });
    this.name = "TransportOperationStalledError";
  }
}

/**
 * A failed check on this implementation's own state: two derivations of one
 * quantity disagreeing, an exhaustiveness branch reached, or a precondition its
 * own callers guarantee broken. Core and CLI guards throw it rather than a plain
 * `Error` (`scripts/check-internal-fault-throws.mjs`). The CLI exits 70, not 64 or
 * the retried 69, and supplies the next step beneath an untagged instance
 * (docs/spec/CLI_EVENTS.md, The internal-fault code).
 */
export class InternalConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalConsistencyError";
  }
}

/**
 * A refusal by the partner or the agreed terms: incompatible terms or protocol
 * version, a partner abort, or a frame or payload this party cannot read. A retry
 * reaches the same refusal; the CLI exits 76 (docs/CLI.md, Exit codes). A plain
 * `Error`, so the web's alerts and the event category treat it as one.
 */
export class ProtocolRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolRefusalError";
  }
}

/**
 * A publish torn by a session drop whose outcome the transport cannot determine:
 * the operation rejects, and whether the peer holds the file is unknown
 * (docs/spec/CHANNEL_SECURITY.md). {@link FileSyncMessageLoop}'s send path, which
 * must not reuse a name the peer may have consumed, tells it apart from a
 * determined failure. A plain `Error`, so the poll loop reschedules
 * (`fileSyncConnection.test.ts`); only an instance whose message states the
 * recovery sets `alcoveRecoveryHintEmitted`.
 */
export class TransportPublishIndeterminateError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "TransportPublishIndeterminateError";
  }
}

/**
 * Whether `error` or any link in its `cause` chain is a
 * {@link TransportPublishIndeterminateError}: a send's rejection reaches callers
 * wrapped by `MessageConnection.send` and by the message loop.
 */
export function isTransportPublishIndeterminate(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) => link instanceof TransportPublishIndeterminateError,
  );
}

/**
 * The abort reason an in-flight {@link FileSyncConnection} wait rejects with when
 * the connection closes mid-rendezvous or mid-send. A plain `Error`, so the CLI
 * exits 69 rather than the 64 of a misconfiguration; consumers should not catch it
 * by type. It states no next step.
 */
export class ConnectionClosedError extends Error {
  constructor(message = "connection closed during wait") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

/**
 * The peer terminated the exchange, signalled by a verified file-sync abort marker
 * or by its abort frame at a receive past the terms exchange
 * (`throwIfPartnerAbort`), so the waiting party fails fast. A `transport`
 * {@link ConnectionError}, so the {@link asConnectionError} wraps pass it through
 * and the catch's echo gate recognizes it; the CLI reads the class and exits 76.
 * Its message is fixed and contains no partner bytes.
 */
export class PeerAbortError extends ConnectionError {
  /**
   * The fixed reason a PSI round's abort stated
   * (`PSI_SET_TOO_LARGE_ABORT_REASON` and its siblings in
   * `packages/core/src/psi/psiBinaryFrame.ts`), as this build's own constant;
   * undefined for any other abort.
   */
  readonly partnerReason: string | undefined;

  constructor(options?: ErrorOptions, partnerReason?: string) {
    super(
      "Your partner stopped the exchange. Their run shows the reason; " +
        "contact them.",
      "transport",
      options,
    );
    this.name = "PeerAbortError";
    this.partnerReason = partnerReason;
    annotate(this, STATES_OWN_NEXT_STEP, true);
  }
}

/**
 * An authentication failure: the key exchange rejected the shared secret or
 * the peer, or the SFTP server presented a host key other than the pinned
 * one. A retry against the same secret or the same server reaches the same
 * refusal, so the CLI gives this class `EX_NOPERM` (77) rather than the
 * retryable 69 (see docs/CLI.md, Exit codes).
 *
 * A {@link ConnectionError} of kind `"security"`, so a consumer classifying
 * on the kind still treats it as a trust-boundary failure. Not every
 * `security`-kind failure is one: a tampered frame on an authenticated
 * channel, or a partner receipt that does not verify, is a plain
 * `ConnectionError`.
 */
export class AuthenticationError extends ConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "security", options);
    this.name = "AuthenticationError";
  }
}

const PEER_WAIT_TIMED_OUT = annotationKey<true>("peer wait timed out");

/**
 * Tags an error as "this party waited its full budget for the partner and
 * the partner never came": the rendezvous peer-wait timeouts and the
 * key-exchange handshake timeout. It is an annotation rather than a
 * subclass so it adds a machine-readable identity without changing
 * either error's message (both are pinned exactly by existing tests) or
 * its `instanceof` classification, which the CLI's 64-vs-69 exit-code
 * split reads.
 *
 * It is not {@link PeerAbortError}'s {@link statesItsOwnNextStep}, whose
 * meaning is the unrelated "suppress the CLI's generic advisory". A
 * tagged error asserts only the local fact that the wait expired, never
 * a reason for the partner's absence. A consumer that knows more about
 * the run (the CLI knows whether this run swept the shared folder at
 * entry) combines that with this tag to offer a likely cause; the tag
 * alone never holds one.
 *
 * Not applied to the joiner-sentinel timeout, which is a different
 * failure -- the partner did arrive and then stalled mid-arrival --
 * already holding its own specific diagnosis and next step.
 */
export function markPeerWaitTimeout<E extends object>(error: E): E {
  return annotate(error, PEER_WAIT_TIMED_OUT, true);
}

/**
 * Whether `error`, or anything in its `cause` chain, holds the
 * {@link markPeerWaitTimeout} tag.
 */
export function isPeerWaitTimeout(error: unknown): boolean {
  return annotationOf(error, PEER_WAIT_TIMED_OUT) === true;
}

const PSI_LIBRARY_FAILURE = annotationKey<true>("PSI library failure");

/**
 * Tags a failure the PSI library raised while it handled a frame, the one
 * failure the PSI frame boundary reports as the partner's frame failing to
 * decode (`decodePsiBinaryFrame`, `psi/psiBinaryFrame.ts`). Every other
 * failure crosses that boundary unchanged, so a fault on this party's machine,
 * a step stopped on connection loss, or a refusal the engine names keeps its
 * own message.
 *
 * An annotation rather than a subclass, on {@link markPeerWaitTimeout}'s
 * reasoning, and because the library throws errors of its own classes.
 * Returns what to throw: `error` itself, tagged, or, for a thrown value that
 * is not an object, an `Error` holding it as its `cause`.
 *
 * The PSI worker boundary carries an error as its message alone, so the tag
 * rides its reply as a field of its own and is re-applied to the rebuilt
 * error on the host side (`psi/psiWorkerEngine.ts`).
 */
export function markPsiLibraryFailure(error: unknown): object {
  const failure =
    typeof error === "object" && error !== null
      ? error
      : new Error("the PSI library failed", { cause: error });
  return annotate(failure, PSI_LIBRARY_FAILURE, true);
}

/**
 * Whether `error` itself holds the {@link markPsiLibraryFailure} tag. Read off
 * the value handed over rather than its `cause` chain, unlike
 * {@link isPeerWaitTimeout}: a wrapper holding a tagged cause has a message of
 * its own.
 */
export function isPsiLibraryFailure(error: unknown): boolean {
  return annotationOf(error, PSI_LIBRARY_FAILURE, { ownOnly: true }) === true;
}
