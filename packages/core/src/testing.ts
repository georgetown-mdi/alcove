import logLibrary from "loglevel";

import type { AssociationTable } from "./types";
import type { ExchangeResult, PreparedExchange } from "./exchange.js";
import { getDefaultLinkageTerms } from "./defaults/builtInLinkageTerms.js";
import { StandardizedDataset } from "./standardization.js";

export {
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
  consentRepresentationProbes,
} from "./consent/linkageTermConsentCoverage.js";

export {
  BEL,
  ESC,
  HOSTILE_IDENTITY,
  PRINTABLE_ASCII,
  RLO,
  hostileSource,
  hostileTerms,
  hostileVariants,
} from "./consent/displayEscapingFixtures.js";

export {
  boundIdentityOf,
  certificateOnlyLoadCases,
} from "./records/signingIdentityDocuments.js";

export {
  COMMAND_LINE_EXPORT_LINKAGE_TERMS,
  COMMAND_LINE_EXPORT_OWN_TURN_URL,
  COMMAND_LINE_EXPORT_RELAY_CASES,
  COMMAND_LINE_EXPORT_RELAY_REGISTRAR,
} from "./config/commandLineExportRelayDocuments.js";

// The key-schedule core, so the browser cross-implementation suite can run the
// checked-in known-answer vectors through the browser build the way the Node
// suite runs them through the Node build. It stays out of the main entry point:
// callers conduct a handshake with runKex, never by composing the schedule.
export { computeKexKeys } from "./kex.js";

// The cross-party host-key fingerprint comparison, so each app's test tree can
// hold the warning it composes to that app's own display budget. It stays out
// of the main entry point: runExchange calls it and hands the result to the
// caller, who never composes the notice.
export { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";

// The wire pieces the known-answer vector generators under test/vectors build
// their documents from. Those generators are plain Node scripts, so they read
// the built package rather than this source tree, and each of these encodes or
// decodes one layer of the protocol below what a caller ever composes: a caller
// runs an exchange, not a table encoding or a terms envelope.
export {
  decodeFixedWidthIndexTable,
  decodeInt32LE,
  decodeRaggedIndexTable,
  decodeSinglePassReply,
  encodeInt32LE,
  encodeSinglePassReply,
  getSortedDistinctValueIndices,
  linkViaPSI,
} from "./psi/link.js";
export { FAN_OUT_CANDIDATES_PER_ELEMENT } from "./fanOutFunctions.js";
// The single-pass link a sweep of scripts/single-pass-bench.mjs runs on each
// side, which also reads the built package.
export { linkViaSinglePassPSI } from "./psi/link.js";
export { StandardizedKeyIterable } from "./standardization.js";
export {
  PROTOCOL_VERSION,
  TERMS_ENVELOPE_FIELDS,
  exchangeTerms,
  sendAbort,
} from "./protocolSetup.js";

// The framing bytes of the file-sync message envelope, the AEAD envelope's
// version marker, and the terminal-frame drain and connection-close budgets, so
// a suite can build a frame byte for byte, drive a foreign version through the
// reader, and hold a teardown ceiling above those budgets. They stay out of the
// main entry point: a caller sends a message and the connection frames it.
export {
  CONNECTION_CLOSE_TIMEOUT_MS,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
} from "./connection/fileSyncConnection.js";
export {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_HEADER_BYTES,
  MESSAGE_TYPE_BINARY,
} from "./connection/fileSyncFraming.js";
export { AEAD_ENVELOPE_VERSION } from "./connection/encryptedMessageConnection.js";

// The connected in-memory MessageConnection pair a suite drives a protocol
// round over. It stays out of the main entry point: a caller opens a connection
// over a transport, and only a test needs a pair with no transport under it.
export { createMessagePipe } from "./connection/messageConnection.js";

// The first-round refusals over the partner's stated receive ceiling, so each
// front end's suite can hold its alert to the refusal's text. They stay out of
// the main entry point: a caller meets the refusal, not its composition.
export {
  ROUND_ONE_SET_UNCOUNTED_FOR_PARTNER_MESSAGE,
  roundOneSetOverPartnerCeilingMessage,
} from "./exchange/firstRoundCapacity.js";

// The sender-side WebRTC frame check's arithmetic, so each WebRTC transport's
// suite can hold its own receive path to the charge the check weighs. It stays
// out of the main entry point: a caller meets the part size, not the
// arithmetic.
export {
  binaryPackByteStringLength,
  webrtcFrameReceiveCharge,
} from "./connection/webrtcOutboundBound.js";

// The header each part of a PSI set begins with, and the byte bound a set's
// first part is held to, so each WebRTC transport's suite can join the parts a
// round sent back into the set and drive a first part at that bound's edge.
export {
  PSI_SET_PART_HEADER_BYTES,
  psiSetByteBound,
} from "./psi/psiSetParts.js";

// The input bounds a suite drives at their edge: the invitation decode's host,
// path, and whole-token limits, and the CSV line ceiling. They stay out of the
// main entry point: core's own parse enforces each, and a caller meets the
// refusal rather than the number.
export {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
  MAX_RAW_INVITATION_LENGTH,
} from "./config/invitation.js";
export { CSV_LINE_BYTE_CEILING } from "./file.js";

// The marker a control character is replaced by, and the one the error-chain
// walk appends where the depth bound cut. They stay out of the main entry
// point: sanitizeForDisplay and sanitizeErrorForDisplay write both, and a
// caller reads the rendered text.
export { CAUSE_DEPTH_ELISION_MARKER } from "./utils/sanitizeErrorForDisplay.js";
export { controlCharacterMarker } from "./utils/sanitizeForDisplay.js";

// Product names only the apps' test suites name outside this package. One
// that gains a production caller there moves to the main entry point.
export {
  InvitationTermDivergenceError,
  PartnerProtocolRefusalError,
  ProtocolRefusalError,
  StandardizationTermsError,
  UnknownStandardizationFunctionError,
} from "./errors.js";
export { FAILURE_CAUSE_KINDS } from "./failureCause.js";
export { PSIParticipant } from "./psi/participant.js";
export type { AssociationTable } from "./types.js";
export type { FrameStructureRefusal } from "./connection/binaryPackBounds.js";
export { canonicalBytes } from "./utils/canonical.js";
export type { CanonicalValue } from "./utils/canonical.js";
export { firstPartyNote } from "./utils/sanitizeForDisplay.js";
export { operatorSuppliedSpans } from "./utils/operatorSuppliedText.js";
export {
  partnerOriginTextList,
  PARTNER_LABELLED_VALUE_BUDGET,
} from "./utils/partnerOriginText.js";
export { DEFAULT_LINKAGE_KEY_SET_NAME } from "./defaults/builtInLinkageTerms.js";
export { DEDUPLICATE_IMPLEMENTED_BY_STRATEGY } from "./linkageTermsPolicy.js";
export {
  MAX_PAYLOAD_ENTRIES,
  NAME_SHAPE_MESSAGE,
} from "./config/linkageTermsSchema.js";
export { validateCompatibility } from "./linkageTermsNegotiation.js";
export type { EndpointSourceConnectionConfig } from "./config/endpointProducer.js";
export { verifyCertificateSelfSignature } from "./records/signingIdentity.js";
export type { P256PrivateJwk } from "./records/signingIdentity.js";
export {
  STANDARDIZATION_FUNCTION_NAMES,
  StandardizedDataset,
  buildKeyStrings,
  buildStandardizedDataset,
} from "./standardization.js";
export {
  pipelineAlwaysDrops,
  validateStandardizationAgainstTerms,
} from "./linkageSatisfiability.js";
export { TRANSFORM_FUNCTION_GLOSSARY } from "./consent/invitationSummary.js";
export {
  ACCEPTOR_DEDUPLICATE_CONTROL_FACTS,
  SELF_AUTHORED_EXCHANGE_FACTS,
} from "./consent/consentFacts.js";
export type { ConsentFact } from "./consent/consentFacts.js";
export { CsvRowParseError } from "./file.js";
export { INFER_DATE_SCAN_CAP } from "./utils/date.js";
export {
  computeHostKeyFingerprint,
  keyTypeFromBlob,
} from "./utils/sshHostKey.js";
export {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  matchedPairCount,
} from "./exchange.js";
export type { RunExchangeOptions } from "./exchange.js";
export {
  assertLocalCertificateAuthorizesAgreedIdentity,
  assertSigningModeImplemented,
} from "./exchange/signingChecks.js";
export type { ResolvedRunShape } from "./pairTableProjection.js";
export { AGREED_TERMS_VERSION } from "./records/agreedTerms.js";
export {
  buildExchangeRecord,
  computeTermsHash,
  verifyRecordCommitments,
} from "./records/exchangeRecord.js";
export type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "./records/exchangeRecord.js";
export {
  deriveReceiptBinder,
  signReceiptContent,
  verifyReceiptSignature,
} from "./records/signedReceipt.js";
export type { ReceiptContent } from "./records/signedReceipt.js";
export type { SignedReceiptPartyReport } from "./records/signedReceiptVerification.js";
export { preparePayload, toCommittedPayload } from "./payloadExchange.js";
export type { PartnerPayload } from "./payloadExchange.js";
export { runKex } from "./kex.js";
export { RENDEZVOUS_ROLES } from "./rendezvous.js";
export { relayRegistrarAuthorization } from "./relayRegistrarProof.js";

/** @internal */
export function sortAssociationTable(
  value: AssociationTable,
  reverse?: boolean,
): AssociationTable {
  return reverse
    ? value[1]
        .map((x, i) => ({ x: x, y: value[0][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[1].push(v.x);
            acc[0].push(v.y);
            return acc;
          },
          [[], []] as [Array<number>, Array<number>],
        )
    : value[0]
        .map((x, i) => ({ x: x, y: value[1][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[0].push(v.x);
            acc[1].push(v.y);
            return acc;
          },
          [[], []] as [Array<number>, Array<number>],
        );
}

/**
 * The smallest complete {@link PreparedExchange}: empty metadata, the
 * built-in default linkage terms, an empty {@link StandardizedDataset}, no
 * raw rows, and a zero row count. `overrides` replaces whichever fields a
 * test's own collaborators actually read; everything else stays the minimal
 * literal. Stays out of the main entry point: it stands in for a real
 * `prepareForExchange` result in a test whose mocked collaborators never
 * reach past the fields `overrides` sets.
 */
export function minimalPreparedExchange(
  overrides: Partial<PreparedExchange> = {},
): PreparedExchange {
  return {
    metadata: [],
    linkageTerms: getDefaultLinkageTerms("Minimal prepared-exchange fixture"),
    dataset: new StandardizedDataset([], []),
    rawRows: [],
    rowCount: 0,
    ...overrides,
  } satisfies PreparedExchange;
}

/**
 * The smallest complete {@link ExchangeResult}: no association table, no
 * intersection count, no entity-cluster summary, the built-in default linkage
 * terms standing in for the partner's, a one-to-one resolved matching (neither
 * party deduplicating), a receiver role, an empty partner payload, and no
 * unbuilt record owed.
 * `overrides` replaces whichever fields a test's own assertions read. Stays out
 * of the main entry point for the same reason as
 * {@link minimalPreparedExchange}: it stands in for a real `runExchange` result
 * in a test whose mocked collaborators never reach past the fields `overrides`
 * sets.
 */
export function minimalExchangeResult(
  overrides: Partial<ExchangeResult> = {},
): ExchangeResult {
  return {
    associationTable: undefined,
    intersectionCount: undefined,
    partnerTerms: getDefaultLinkageTerms("Minimal exchange-result fixture"),
    matching: {
      localDeduplicate: false,
      partnerDeduplicate: false,
      cardinality: "one-to-one",
    },
    resolvedRole: "receiver",
    partnerPayload: { columns: [], rowIndices: [], rows: [] },
    recordOwedButUnbuilt: false,
    ...overrides,
  } satisfies ExchangeResult;
}

/** @internal */
export type LogEntry = { level: string; message: string };

const captures: Array<{
  filter: (level: string) => boolean;
  logs: LogEntry[];
}> = [];
let interceptorInstalled = false;

/** Installs the loglevel `methodFactory` interceptor that backs
 * `withCapturedLogs`, idempotently. `withCapturedLogs` calls this on its
 * first use, so a standalone caller needs it only to close the
 * creation-order gap noted on `withCapturedLogs`: call it from test setup
 * before any named logger is constructed. loglevel binds a logger's
 * methods from the factory live at `getLogger` time, so installing here
 * first is what lets a later-created logger bind to capture regardless of
 * creation order. */
export function installCapturedLogsInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;
  // Snapshot the current factory here, not at module load, so any third-party
  // wrappers installed before the interceptor is materialized are included.
  const rootFactory = logLibrary.methodFactory;
  logLibrary.methodFactory = (methodName, level, loggerName) => {
    const original = rootFactory(methodName, level, loggerName);
    return (...args: unknown[]) => {
      const levelName = methodName.toUpperCase();
      const message = args.join(" ");
      // Suppress from normal output only when every active capture claims this
      // message; if any capture's filter does not match, the message passes through
      // so that concurrent captures cannot affect each other's observable output.
      let allMatch = captures.length > 0;
      for (const entry of captures) {
        if (entry.filter(levelName)) {
          entry.logs.push({ level: levelName, message });
        } else {
          allMatch = false;
        }
      }
      if (!allMatch) original(...args);
    };
  };
  logLibrary.setLevel(logLibrary.getLevel());
}

/** Intercepts log output during `fn` and returns it alongside the function
 * result. By default only `WARN` messages are captured; pass `levelFilter`
 * to change which levels are collected. A message is suppressed from
 * normal output only when every concurrent capture's filter claims it;
 * otherwise it passes through unchanged, so concurrent calls do not affect
 * each other's observable output. If `fn` rejects, captured logs are
 * discarded and the rejection propagates.
 *
 * Limitations: messages below loglevel's current threshold never reach
 * `methodFactory` (loglevel assigns `noop` directly) and are not captured.
 * A `getLoggerForVerbosity` logger never sets a level more verbose than
 * the current root, so a `.debug()` line at `verbose: 1` is captured only
 * once the root itself is raised (e.g. `logLibrary.setLevel("trace")`)
 * before the logger is constructed -- driven in capturedLogs.test.ts. A
 * named logger created before {@link installCapturedLogsInterceptor} runs
 * bypasses capture; call it from test setup, ahead of any logger, to
 * close that gap (the CLI integration suite does). A diagnostic sink
 * installed via `setDiagnosticSink` (the CLI's stderr / `--log-file`
 * routing) is consulted downstream of this interceptor, so while one is
 * active, output routes to it and is not captured here -- do not pair
 * `withCapturedLogs` with a command handler that installs a sink; call the
 * underlying function directly instead, as the integration suite does. */
export function withCapturedLogs<T>(
  fn: () => Promise<T>,
  levelFilter?: (level: string) => boolean,
): Promise<[T, LogEntry[]]>;
export function withCapturedLogs<T>(
  fn: () => T,
  levelFilter?: (level: string) => boolean,
): [T, LogEntry[]];
export function withCapturedLogs<T>(
  fn: () => T | Promise<T>,
  levelFilter?: (level: string) => boolean,
): [T, LogEntry[]] | Promise<[T, LogEntry[]]> {
  installCapturedLogsInterceptor();
  const logs: LogEntry[] = [];
  const entry = {
    filter: levelFilter ?? ((level: string) => level === "WARN"),
    logs,
  };
  captures.push(entry);

  const cleanup = () => {
    const idx = captures.indexOf(entry);
    if (idx !== -1) captures.splice(idx, 1);
  };

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then((r): [T, LogEntry[]] => [r, logs]).finally(cleanup);
    }
    cleanup();
    return [result, logs];
  } catch (e) {
    cleanup();
    throw e;
  }
}
