import { getFips } from "node:crypto";
import path from "node:path";

import {
  EncryptedMessageConnection,
  annotate,
  annotationKey,
  annotationOf,
  getLogger,
  describeExchangeStages,
  InternalConsistencyError,
  runExchange,
  runsSinglePassLink,
  SINGLE_PASS_STAGE_IDS,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
  describeResolvedMatching,
  describeResolvedRunShape,
  authenticateConnection,
  supportedVersions,
  deriveAbortToken,
  OperatorConfigError,
  PeerAbortError,
  ReceiptVerificationError,
  causeChainSome,
  ConnectionError,
  isPeerWaitTimeout,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  payloadReceiveFilledNotice,
  redactAndDisplayPartyIdentity,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  allowedRelaysLeaveOutInvitationRelay,
  runEnrollsAtInvitationRegistrar,
  selectRunRelay,
  NEW_INVITATION_REMEDY,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
  classifyFailure,
  isPartnerNextSecretStoreFailure,
  isTrustBoundaryFailure,
  releasableTermsRotation,
} from "@alcove/core";
import type {
  Authentication,
  ConnectionConfig,
  HandshakeRole,
  MessageConnection,
  PayloadReceiveFillAnswer,
  PreparedExchange,
  ExchangeBootstrapResult,
  ExchangeStageDefinition,
  SigningIdentity,
  ReleasableTermsRotation,
  HandshakeSecretKind,
  RotationHistoryEntry,
  TermsChange,
} from "@alcove/core";

import {
  AUTHENTICATION_FAILED_EXIT_CODE,
  INTERRUPTED_EXIT_CODE,
  TERMINATED_EXIT_CODE,
  type ErrorPhase,
} from "@alcove/cli-contract";

import { LocalFSClient } from "./connection/localFSClient";
import { raiseInactivityLimit } from "./connection/timeoutGuidance";
import {
  keyFileNotSavedRemedy,
  keyFileSavedConfigNotWrittenRemedy,
  markArrivalWait,
  markKeyFileSavedConfigNotWritten,
  type ArrivalWait,
  type KeyFileSavedConfigNotWritten,
  type OnlineSetupConfiguration,
} from "./failureRemedy";
import { markTermsRefusalRun } from "./termsRefusalRemedy";
import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { dialedBrokerAuthority } from "./connection/webrtc/brokerClient";
import { openWebRtcWithRelayFallback } from "./connection/webrtc/relayFallback";
import { webSocketRelayDialsFor } from "./connection/webrtc/websocketRelayDial";
import { FinalFrameUnconfirmedError } from "./connection/webrtc/webrtcMessageConnection";
import { persistPartnerFingerprint } from "./config";
import {
  enrollAtInvitationRelay,
  reportInvitationRelayEnrollment,
} from "./invitationRelayEnrollment";
import { describeExchangeOutcome, zeroMatchWarning } from "./exchangeOutcome";
import {
  clearRotationInFlight,
  dropPreviousSecret,
  markRotationInFlight,
  rotationWriteContents,
  saveKeyFile,
  type KeyFile,
} from "./keyFile";
import { loadCliPsiBackend } from "./psiBackend";
import {
  createPsiProgressDisplay,
  terminalPsiStatusLine,
  type PsiProgressDisplay,
} from "./psiProgressDisplay";
import { checkPartnerRoundMemory, readMemory } from "./psiMemoryBudget";
import {
  createPsiEngine,
  offerExitAtOnceWhilePsiWorkersStop,
  psiEngineRunsInWorker,
  stopPsiWorkersBeforeExit,
  type PsiWorkerExitWaitOptions,
} from "./psiWorkerHost";
import { writeExchangeRecord } from "./recordFile";
import { runArtifactFolder } from "./resultFile";
import {
  closeWithinCeiling,
  teardownCeilingNotice,
  transportTeardownCeilingMs,
  type TeardownOutcome,
} from "./transportTeardown";
import { exitCodeForError, fixedNextStep, withExitCode } from "./util/exit";
import { noteSignalOwnsExit } from "./util/exitGate";
import { runBeforeEachLogLine } from "./util/logging";
import { logRuntimeEnv } from "./util/runtimeEnv";
import {
  openEventStream,
  reportPersistenceLoss,
  type EventStreamEmitter,
} from "./eventStream";

import {
  BOTH_SWEPT_GUIDANCE,
  partnerCertificatePinnedNotice,
  TERMINATED_RECORD_UNBUILT_WARNING,
  UNNAMED_PARTNER_ACCOUNTING_NOTE,
} from "./run/notices";
import { writeExchangeOutputs, type ExchangeOutcome } from "./run/outputs";
import {
  emitRunMetrics,
  prepareTransport,
  type PreparedTransport,
} from "./run/prepare";

export {
  checkRunMemoryBudget,
  emitPrepareRefusal,
  preflightRun,
  warnUndeclaredColumns,
  WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
} from "./run/prepare";

/**
 * CLI-layer extension of {@link Authentication} that co-locates the path where
 * the rotated shared secret is persisted after each successful key exchange.
 * Passed to {@link runProtocol} on its own `auth` parameter, separate from the
 * connection config (the shared secret is a channel-agnostic partner-trust
 * concern, not embedded in the connection).
 *
 * `sharedSecret` is narrowed from optional in {@link Authentication} to required
 * here: every authenticated exchange must supply a valid token before the
 * connection is opened.
 */
export interface AuthPersist extends Authentication {
  sharedSecret: string;
  keyFilePath: string;
  /** Save the rotated secret with an exclusive create, refusing a key file
   * already at {@link keyFilePath}: the online `invite` and `accept` hold no
   * key file before the handshake, so one found there is not theirs. */
  saveKeyFileExclusively?: boolean;
  /** The caller registers the rotated secret's relay key at a relay registrar
   * after the run, so the rotation write records that registration as pending
   * (`relayRegistrationPendingSince`) until the registrar confirms it. */
  relayRegistrationFollows?: boolean;
  /** The caller wrote the key file just before the run, from an invitation,
   * so it cannot be an older copy than the partner's. */
  keyFileWrittenThisRun?: boolean;
  /** The key file's previous secret, which the handshake also offers. */
  previousSharedSecret?: string;
  /** The `expires` {@link previousSharedSecret} had as the current secret. */
  previousExpires?: string;
  /** The key file's rotation history, newest first. */
  rotationHistory?: ReadonlyArray<RotationHistoryEntry>;
}

/**
 * The signing inputs for the certificate-backed signed-receipt step, resolved by
 * the exchange command from the `signing` config block. Passed to
 * {@link runProtocol} on its own `signing` parameter; `null` (the default) skips
 * the signing step so the unsigned-record path is unaffected. The signing step
 * runs only on the authenticated path (the only one that holds a session key), so
 * a non-null value is meaningful only with a non-null `auth`.
 */
export interface SigningPersist {
  /** This party's long-lived signing identity (private key + certificate). */
  identity: SigningIdentity;
  /** The pinned partner certificate fingerprint (`signing.partner_fingerprint`);
   * absent means this run is a first authenticated contact, which adopts the
   * certificate the partner presents at the terms exchange and records its
   * fingerprint into {@link configPath}. */
  partnerFingerprint?: string;
  /** The configuration file this exchange was given, and the only file a
   * freshly adopted partner fingerprint is written into. */
  configPath: string;
}

/**
 * The connection configs {@link runProtocol} can run. `Extract` names the
 * channels explicitly rather than aliasing {@link ConnectionConfig}, so a new
 * channel is rejected here until run/prepare.ts dispatches it (the allowlist
 * convention in CONTRIBUTING.md). Authentication is a separate `auth`
 * parameter, not part of this connection union.
 */
export type ProtocolConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" | "webrtc" }
>;

/**
 * CLI-only, non-persistable runtime wiring for one invocation: the file-sync
 * transport's entry-sweep controls (threaded straight to the
 * {@link FileSyncConnection} constructor), the machine-interface stream, and
 * the caller's pre-terminal hook. The sweep controls are not part of
 * {@link ProtocolConnectionConfig} / FileSyncOptions / the Zod config schema,
 * since anything there is persistable to alcove.yaml. The CLI command layer
 * resolves these from argv and passes them here, separate from config
 * construction (applyConnectionOverrides).
 */
export interface FileSyncRuntimeOptions {
  /** `--sweep-exchange-files`: clear protocol files at entry (see FILE_SYNC.md). */
  sweepExchangeFiles?: boolean;
  /** `--force-retain-sweep`: permit the sweep to wipe a retain-mode transcript. */
  forceRetainSweep?: boolean;
  /**
   * `--event-stream`: emit the opt-in NDJSON machine-interface stream on fd 3
   * (see eventStream.ts and docs/spec/CLI_EVENTS.md). Unset (the default)
   * constructs no emitter, so the run is byte-identical to one without the
   * flag; `true` opens the stream here, before any exchange work, so the
   * fail-closed fd-3 preflight fires first. An already-open
   * {@link EventStreamEmitter} is a caller that opened the stream itself
   * (openEventStream ran its preflight), since it also reports its own
   * persistence losses on the one channel the terminal event travels on.
   */
  eventStream?: boolean | EventStreamEmitter;
  /**
   * The caller's own post-exchange persistence, run inside this frame once
   * the output stage has completed (result CSV and every audit artifact,
   * each loss already reported) and before the metrics and terminal events --
   * the placement lets it report what it loses on the same terminal event,
   * since the stream contract requires that event last
   * (docs/spec/CLI_EVENTS.md) and a supervisor keys off it.
   *
   * Invoked only on the fully-completed path: a failed exchange throws
   * before the output stage, and a signal-interrupted run returns without a
   * terminal event, so a hook that ran is proof the exchange succeeded and
   * must not be re-run. May be synchronous or async; it is awaited before
   * the terminal events are emitted.
   *
   * A failure from the hook is non-fatal, like {@link OnlineSetup.writeConfig}:
   * the exchange already completed and cannot be undone by
   * a local write, so it is logged at error level and reported as a
   * persistence loss on both machine channels rather than shown as a clean
   * success.
   *
   * The hook states what became of its own writes on
   * {@link OutputCompleteResult}. A hook that catches its own failure and
   * reports it returns `persisted: false`, which is the only way that loss
   * reaches what the run afterwards tells the operator about its files: a
   * caught failure throws nothing for this frame to see.
   */
  onOutputComplete?: (
    context: OutputCompleteContext,
  ) => OutputCompleteResult | Promise<OutputCompleteResult>;
  /**
   * The caller's post-exchange step that writes nothing to this party's disk
   * (the relay key registration), run after {@link onOutputComplete} on the
   * same fully-completed path and before the terminal events. It reports its
   * own failures; the frame never reports it as a local persistence loss, and
   * a run whose result failed leaves it to the caller.
   */
  onRemoteFollowUp?: () => void | Promise<void>;
}

/** What a {@link FileSyncRuntimeOptions.onOutputComplete} hook reports back. */
export interface OutputCompleteResult {
  /**
   * Whether everything this hook owed disk reached it. A hook with nothing to
   * write for this run returns true; one that caught a write failure and
   * reported it as a persistence loss returns false, so the run no longer
   * claims every file it writes is on disk (`teardownCeilingNotice`).
   */
  persisted: boolean;
}

/** What {@link FileSyncRuntimeOptions.onOutputComplete} is handed. */
export interface OutputCompleteContext {
  /**
   * The zero-setup `--save` bootstrap outcome, decided by the terms exchange
   * before this call, so the save itself runs inside this hook rather than
   * after {@link runProtocol} returns. Defined whenever a boolean
   * `saveIntent` was passed (including `false`, which holds the partner's
   * intent); `undefined` on every authenticated exchange, which runs no
   * bootstrap. Do not collapse a `false` saveIntent to `undefined` -- that
   * would silently suppress the no-save notices.
   *
   * The only route the bootstrap outcome takes out of {@link runProtocol} --
   * {@link RunProtocolResult} holds none of it -- so the established shared
   * secret reaches only the caller that provisions from it.
   */
  bootstrap?: ExchangeBootstrapResult;
}

/** The value {@link runProtocol} resolves with. */
export interface RunProtocolResult {
  /**
   * `interrupted` when a SIGINT or SIGTERM cut the run short: the signal
   * handler owns the exit and nothing past the point the signal arrived is
   * known to have happened, so a caller writes no summary of its own.
   * `completed` when the exchange ran through its output stage.
   */
  outcome: "completed" | "interrupted";
  /**
   * The error thrown or rejected by {@link OnlineSetup.writeConfig}, when the
   * configuration step failed but the run otherwise resolved. The step is
   * non-fatal, so its failure does not stop the exchange; this field reports
   * it so the online invite/accept callers avoid claiming the configuration
   * was saved. Already logged at error level by {@link runProtocol}.
   * `undefined` when no online setup was passed or its step succeeded. A
   * signal-interrupted run keeps whatever value was already recorded. When
   * the step failed and the exchange then also failed, `runProtocol` rejects
   * with the exchange error and this field is never observed.
   */
  configWriteError?: unknown;
}

/**
 * Per-stage wall-clock timing for the machine-interface stream. `open` marks the
 * START of a stage; a stage COMPLETES when the next one opens or when the
 * exchange finishes, at which point its duration is emitted as a stageEnd
 * event. Only completed stages are reported, so a stageEnd is always a whole
 * stage's time -- a run that aborts mid-stage emits none for the in-flight one.
 */
function createStageTimer(
  emit: (fn: (e: EventStreamEmitter) => void) => void,
): {
  open: (id: string) => void;
  close: () => void;
} {
  let current: { id: string; startedAt: number } | undefined;
  return {
    open: (id) => {
      current = { id, startedAt: Date.now() };
    },
    close: () => {
      if (current === undefined) return;
      const { id, startedAt } = current;
      // Clamp against a wall-clock adjustment so a duration is never negative.
      const durationMs = Math.max(0, Date.now() - startedAt);
      emit((e) => e.stageEnd(id, durationMs));
      current = undefined;
    },
  };
}

// The single-pass stages core does not enumerate, since which of them a party
// passes through follows the role the handshake resolves. Listed in the order
// either role passes them, so the `stages` event names every id a `stage`
// event can hold.
const SINGLE_PASS_STAGE_DEFINITIONS: ExchangeStageDefinition[] = [
  {
    id: SINGLE_PASS_STAGE_IDS.encryptingOwnData,
    label: "Encrypting my data",
  },
  {
    id: SINGLE_PASS_STAGE_IDS.encryptingPartnerData,
    label: "Doubly-encrypting partner's data",
  },
  {
    id: SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
    label: "Identifying shared elements",
  },
];

// What linkViaSinglePassPSI passes to onStage as its last call: the end of the
// round rather than a stage, so the last stage's timing runs to the end of the
// exchange and no unlisted id reaches the stream. The web seat skips it too.
const SINGLE_PASS_END_MARKER = "done";

/**
 * The run's exchange stage: announce the PSI stages, then run the two-party
 * exchange over the negotiated transport, reporting each stage transition,
 * warning and confirmation as it arrives. Returns what the exchange produced,
 * which the output stage then writes.
 *
 * `onRunPhase` fires once the stage list is out and the exchange proper is
 * about to begin, so the caller can classify every failure from that point on
 * as a run fault rather than a preparation one.
 */
async function runExchangeStage(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  mc: MessageConnection;
  role: HandshakeRole;
  prepared: PreparedExchange;
  psiLibrary: Awaited<ReturnType<typeof loadCliPsiBackend>>["library"];
  verbosity: number;
  saveIntent: boolean | undefined;
  signing: SigningPersist | null;
  recordPayloadReceiveFill:
    ((columns: string[]) => void | Promise<void>) | undefined;
  payloadReceiveFillNotice: ((columns: string[]) => void) | undefined;
  onPayloadReceiveFill:
    ((columns: string[]) => Promise<PayloadReceiveFillAnswer>) | undefined;
  onTermsChange: ((change: TermsChange) => Promise<void>) | undefined;
  onTermsExchanged: (() => Promise<void>) | undefined;
  writeRecord: boolean;
  allowMemoryShortfall: boolean;
  stageTimer: { open: (id: string) => void; close: () => void };
  psiProgress: PsiProgressDisplay;
  onRunPhase: () => void;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
}): Promise<ExchangeOutcome> {
  const {
    build,
    run,
    mc,
    role,
    prepared,
    psiLibrary,
    verbosity,
    saveIntent,
    signing,
    recordPayloadReceiveFill,
    payloadReceiveFillNotice,
    onPayloadReceiveFill,
    onTermsChange,
    onTermsExchanged,
    writeRecord,
    allowMemoryShortfall,
    stageTimer,
    psiProgress,
    onRunPhase,
    log,
    emit,
  } = params;
  const stageDefinitions = [
    ...describeExchangeStages(prepared),
    ...(runsSinglePassLink(prepared.linkageTerms)
      ? SINGLE_PASS_STAGE_DEFINITIONS
      : []),
  ];
  const stageLabels = Object.fromEntries(
    stageDefinitions.map(({ id, label }) => [id, label]),
  );
  // Emit the full stage list once, before the first transition, mirroring the
  // web's onStages. The PSI exchange proper is about to begin, so any failure
  // from here on is a "run" fault (until output, marked below).
  emit((e) => e.stages(stageDefinitions));
  onRunPhase();
  return runExchange(
    // Every authenticated run reaches here with `secure`, the AEAD
    // decorator over mc, since authenticateRun refuses a handshake that
    // negotiated the wrap off; PSI frames are encrypted on the wire. Only
    // the no-auth zero-setup path (which runs the --save bootstrap) runs
    // over the bare mc, under transport security only.
    run.secure ?? mc,
    role,
    prepared,
    {
      psiLibrary,
      // Run the PSI masking in a worker thread so a long round keeps the
      // event-loop-owning thread responsive for the SFTP heartbeat and the
      // liveness timers. Falls back to in-process when
      // the bundled worker is absent (dev / tests); see createPsiEngine.
      psiEngineFactory: (role, id, mode) =>
        createPsiEngine(psiLibrary, role, id, mode),
      verbosity,
      saveIntent,
      // Signed-receipt inputs, threaded only when a signing config was
      // passed (the exchange command resolves it from the `signing`
      // block). The step is gated inside runExchange on both the
      // identity and the session key being present; sessionKeyForReceipt
      // is set only on the authenticated path, and a signing config on
      // the no-auth path was already rejected above, so these three
      // travel together. Signing null leaves all three undefined and the
      // step skipped.
      signingIdentity: signing?.identity,
      partnerFingerprint: signing?.partnerFingerprint,
      sessionKey: signing !== null ? run.sessionKeyForReceipt : undefined,
      // Set by authenticateRun on the authenticated path only.
      rotation: run.rotation,
      negotiatedProtocolVersion: run.negotiatedProtocolVersion,
      // Record the adopted pin into the configuration this exchange was
      // given, at the moment of adoption and before anything is disclosed, so
      // a run that pins and then fails mid-round does not re-pin blind on the
      // next attempt; a throw here stops the run rather than leaving the
      // operator believing the pin was saved. The fingerprint is a digest
      // this party derived, and still takes the display escape every other
      // value on these sinks takes.
      onPartnerCertificatePinned:
        signing === null
          ? undefined
          : (fingerprint: string) => {
              persistPartnerFingerprint(signing.configPath, fingerprint);
              const message = partnerCertificatePinnedNotice(
                fingerprint,
                signing.configPath,
              );
              log.warn(
                redactAndSanitizeForDisplay(message, {
                  maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
                }),
              );
              emit((e) => e.warning("partnerCertificatePinned", message));
            },
      // Record the receive list this run fills from the partner's declared send
      // set, before any key or payload moves, and say which columns were taken:
      // an unattended run leaves the line in its log. A throw stops the run.
      onPayloadReceiveFilled:
        recordPayloadReceiveFill === undefined
          ? undefined
          : async (columns: string[]) => {
              await recordPayloadReceiveFill(columns);
              if (payloadReceiveFillNotice !== undefined) {
                payloadReceiveFillNotice(columns);
                return;
              }
              log.info(
                sanitizeForDisplay(payloadReceiveFilledNotice(columns), {
                  maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
                }),
              );
            },
      ...(onPayloadReceiveFill !== undefined ? { onPayloadReceiveFill } : {}),
      ...(onTermsChange !== undefined ? { onTermsChange } : {}),
      ...(onTermsExchanged !== undefined ? { onTermsExchanged } : {}),
      // Advertise the observed SFTP host key for cross-party
      // reconciliation only when the exchange runs over the
      // authenticated, AEAD-wrapped channel (`secure` set): the value is
      // unforgeable only because it rides that channel, so advertising
      // it on the unencrypted no-auth path -- where an active MITM could
      // rewrite it to suppress the divergence -- would defeat the check.
      // observedHostKey is itself undefined for a file-drop or the
      // no-pin path, and there is no file-sync connection at all on
      // webrtc, so this is also a no-op there.
      observedHostKey:
        run.secure !== undefined ? build.fileSync?.observedHostKey : undefined,
      // Each crypto operation's element count and duration, rendered as the
      // phase's live progress. Counts and durations only -- no value from
      // either party's data reaches the display.
      onPsiProgress: (progress) => psiProgress.report(progress),
      onStage: (id: string) => {
        if (id === SINGLE_PASS_END_MARKER) return;
        const label = stageLabels[id] ?? id;
        // The label derives from linkage-key names the partner may have
        // authored, so it goes through the display-boundary escape before
        // reaching the terminal, like this file's other stderr sites. The
        // emitter applies the same escape before the pair reaches fd 3.
        log.info(
          redactAndSanitizeForDisplay(
            label.charAt(0).toLowerCase() + label.slice(1),
          ),
        );
        // Close the previous stage's timing before entering this one, then
        // start the clock for the new stage. The emitter sanitizes the id.
        stageTimer.close();
        stageTimer.open(id);
        emit((e) => e.stage(id, label));
      },
      onWarning: (msg: string) => {
        // Terms-exchange warnings can embed partner-authored column
        // names, so the text goes through the display-boundary escape
        // here and inside the emitter alike. Redaction leads the escape:
        // escaping first can truncate a whole key block into a dangling
        // marker at the display cap, which the prefixer's pass then
        // fails closed on for the rest of the argument. A warning is a
        // COMPOSITION, so the cap is the composed-warning budget the
        // fd-3 event applies rather than the per-value default: both
        // sinks show the same text, and stderr must not show less of it
        // than the machine channel relays.
        log.warn(
          "terms exchange:",
          redactAndSanitizeForDisplay(msg, {
            maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
          }),
        );
        emit((e) => e.warning("termsExchange", msg));
      },
      // A host-key divergence is a security signal, not a terms warning,
      // so it gets its own un-prefixed warn line. The message is
      // complete and composed raw (reconcileHostKeyFingerprints redacts
      // and fits both parties' server-controlled values), so this line
      // and the emitter each escape it once. It also rides
      // the machine-interface warning event: a supervisor that discards
      // stderr on success (an unattended CLI run under cron, say) must
      // still see the one control that catches a one-sided SFTP
      // interception. Non-fatal: the exchange still completes and the
      // operator disambiguates a rekey from an interception out-of-band.
      onHostKeyDivergence: (msg: string) => {
        log.warn(
          redactAndSanitizeForDisplay(msg, {
            maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
          }),
        );
        emit((e) => e.warning("hostKeyDivergence", msg));
      },
      // A present-but-malformed partner host-key advertisement is
      // dropped by the fail-soft parse, so reconciliation is silently
      // skipped for it. Log that drop at debug -- low enough that a
      // benign version-skew does not warn on every exchange -- so an
      // operator can tell a non-conforming partner from one that simply
      // observed no host key (which logs nothing here). The dropped
      // value is not included: it is unusable and partner-controlled, so
      // echoing it into a log would be an injection risk.
      onPartnerHostKeyMalformed: () =>
        log.debug(
          "partner advertised a malformed SFTP host key in the terms " +
            "exchange; it was dropped per the fail-soft contract and " +
            "cross-party host-key reconciliation was skipped for it",
        ),
      // The partner's round, weighed against this process's memory once the
      // terms say how large it can be, as the pre-contact check weighs this
      // party's own input.
      checkPartnerRoundCapacity: (partnerRoundValues) => {
        checkPartnerRoundMemory({
          partnerRoundValues,
          allowShortfall: allowMemoryShortfall,
          readings: readMemory(psiEngineRunsInWorker()),
          onShortfallWarning: (message) => {
            log.warn(message);
            emit((e) => e.warning("memoryShortfall", message));
          },
        });
      },
      onProtocolConfirmed: (partnerTerms, resolvedRole, runShape) => {
        // identity is partner-controlled free text with no consistency
        // check (a mutually-distrusting party sets it), so escape it
        // before it reaches the operator's terminal/logs. A partner that
        // supplied none is reported as unnamed rather than as an empty
        // line.
        //
        // On a run that files a record, that absence has a consequence
        // the marker alone does not: the record this exchange writes
        // will hold no partnerIdentity, so an accounting of disclosures
        // that cites it has to take the recipient from the operator's
        // own notes. Warn rather than inform for that one case, and
        // state the consequence in the same line. It also rides the
        // machine-interface warning event, for the same
        // unattended-supervisor reason as SIGNING_WITHOUT_RECORD_WARNING.
        const line = [
          "terms agreed, partner identity:",
          redactAndDisplayPartyIdentity(partnerTerms.identity),
        ] as const;
        if (writeRecord && partnerTerms.identity === undefined) {
          log.warn(...line, UNNAMED_PARTNER_ACCOUNTING_NOTE);
          emit((e) =>
            e.warning("unnamedPartnerRecord", UNNAMED_PARTNER_ACCOUNTING_NOTE),
          );
        } else log.info(...line);
        log.info("role:", resolvedRole);
        // Each party's deduplicate value comes from its own document, so the
        // pair -- and the cardinality it resolves to -- exists only now. Stated
        // on the info line beside the role rather than on the warning channel
        // below: it is what every run proceeds on, not an exception to it.
        log.info(describeResolvedMatching(runShape));

        // What the agreed terms actually resolved to, named here because
        // nothing earlier states it: the consent surfaces show each
        // party's DECLARED deduplicate, and the cardinality the pair
        // resolves to -- which decides whose duplicates match and how
        // many rows the result holds -- is decided only now. Both
        // notices take the warning channel rather than the info line
        // beside the role, since the machine-interface warning event is
        // the only sink a supervisor that discards stderr (or a console
        // seat watching the run) reads at all. Composed by core so the
        // CLI and browser seats cannot drift; both strings are
        // first-party prose over integers core formats itself, so
        // neither includes partner-authored text in the sinks.
        const { cardinalityNotice, pairTableAdvisory } =
          describeResolvedRunShape(runShape);
        for (const [source, notice] of [
          ["resolvedCardinality", cardinalityNotice],
          ["pairTableAdvisory", pairTableAdvisory],
        ] as const) {
          if (notice === undefined) continue;
          log.warn(notice);
          emit((e) => e.warning(source, notice));
        }
      },
    },
    // A run that ended without its store drops the next secret's inputs here.
  ).finally(() => run.rotation?.release());
}

/**
 * The run's transport-open stage: dial the webrtc rendezvous, or open, sync and
 * start the file-sync connection, and report the handshake role the rendezvous
 * settled. Marks the lifecycle as it goes so the cleanup knows what to close.
 *
 * A signal arriving mid-open is checked for after every await: the handler's
 * cleanup found nothing to close at the time, so this closes what has since
 * opened and throws rather than exchanging over it.
 */
async function openRunTransport(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  connection: ProtocolConnectionConfig;
  interrupted: AbortController;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
  onSignalingRegistered?: () => void;
}): Promise<HandshakeRole> {
  const {
    build,
    run,
    connection,
    interrupted,
    log,
    emit,
    onSignalingRegistered,
  } = params;
  let role: HandshakeRole;
  if (connection.channel === "webrtc") {
    // Resolved by the prepare block for exactly this channel; the check is
    // what licenses treating the dial as present.
    if (build.webRtcDial === undefined)
      throw new InternalConsistencyError(
        "the webrtc rendezvous was not resolved",
      );
    // Once per run, before the first connection attempt: the attempts after
    // it reuse the key this enrolls, which only a rotation changes. werift
    // allocates on the first TURN url alone; the registrar is contacted when
    // that url is one the invitation names, or when the run dials the
    // invitation's WebSocket relay under the derived id.
    const invitationRegistrar = connection.invitationRelay?.registrar;
    const enrolls = runEnrollsAtInvitationRegistrar(connection);
    const allocatingTurn = selectRunRelay(connection).turn?.[0];
    if (
      invitationRegistrar !== undefined &&
      allowedRelaysLeaveOutInvitationRelay(connection)
    )
      log.info(
        "the relay registrar that your partner's invitation names was not " +
          "contacted, because connection.allowed_relays leaves out the relay " +
          "it names",
      );
    else if (
      invitationRegistrar !== undefined &&
      !enrolls &&
      allocatingTurn !== undefined
    )
      log.info(
        "the relay registrar that your partner's invitation names was not " +
          "contacted, because " +
          ((connection.invitationRelay?.turn ?? []).includes(allocatingTurn.url)
            ? "this run presents your own turn entry's credential to the " +
              "relay it allocates on, at"
            : "this run allocates its relay on a relay the invitation did " +
              "not name, at"),
        redactAndSanitizeForDisplay(allocatingTurn.url),
      );
    else if (
      invitationRegistrar !== undefined &&
      !enrolls &&
      (selectRunRelay(connection).websocket ?? []).some(
        (relay) =>
          relay.url === connection.invitationRelay?.websocket &&
          relay.exchangeId !== undefined,
      )
    )
      log.info(
        "the relay registrar that your partner's invitation names was not " +
          "contacted, because this run allocates on no TURN relay, and " +
          "proves to the invitation's WebSocket relay under the exchange id " +
          "your partner enrolled there",
      );
    if (invitationRegistrar !== undefined && enrolls) {
      const enrollment = await enrollAtInvitationRelay(
        invitationRegistrar,
        build.webRtcDial.options.sharedSecret,
        { signal: interrupted.signal },
      );
      reportInvitationRelayEnrollment(invitationRegistrar, enrollment, {
        log,
        emit,
      });
      if (run.signalReceived !== undefined)
        throw new Error(
          `interrupted by ${run.signalReceived} before the rendezvous`,
        );
    }
    log.info(
      "connecting through the coordination server at",
      // dialedBrokerAuthority (see its doc) is what the socket actually
      // dials, not the configured `host` text.
      //
      // The broker host is partner-controlled on an endpoint-seeded config, so
      // escape it before it reaches the operator's terminal, as the file-sync
      // locators below are. The rendezvous ids are NOT logged: they are derived
      // from the shared secret, and anything that reaches the terminal reaches
      // a --log-file too.
      redactAndSanitizeForDisplay(
        dialedBrokerAuthority(build.webRtcDial.options.location),
      ),
    );
    // The rendezvous is this channel's open: it registers with the broker,
    // negotiates, and resolves only once the data channel is up. Its own
    // budgets bound it (rendezvous, channel-open), so a partner that never
    // arrives fails here rather than hanging. The interrupt signal ends it
    // early: the transport fails the negotiation and tears down the broker
    // socket and peer connection on an abort, so Ctrl-C during a
    // rendezvous does not wait out that budget. The post-dial guard below
    // still stands, for the window between the dial settling and the
    // transport being assigned.
    const dialed = await openWebRtcWithRelayFallback(
      {
        ...build.webRtcDial.options,
        signal: interrupted.signal,
        onRegistered: onSignalingRegistered,
      },
      await webSocketRelayDialsFor(
        connection,
        build.webRtcDial.options.sharedSecret,
        build.webRtcDial.options.role,
      ),
    );
    build.transport = dialed;
    run.opened = true;

    // A signal that arrived while the rendezvous was in flight already
    // ran doCleanup, which found no transport to close because there was
    // none yet. Close the one that has just opened and short-circuit, so
    // the channel and broker socket are not left standing -- the twin of
    // the post-open guard on the file-sync side.
    if (run.signalReceived !== undefined) {
      try {
        await dialed.close();
      } catch (err) {
        log.debug(
          "post-rendezvous signal close failed:",
          sanitizeErrorForDisplay(err),
        );
      }
      throw new Error(`interrupted by ${run.signalReceived} during rendezvous`);
    }
    // Fixed by the connection's role rather than negotiated at the transport:
    // the two parties already had to disagree about which end they are to find
    // each other at all, so the handshake inherits that instead of running a
    // second tiebreaker.
    role = build.webRtcDial.handshakeRole;
  } else {
    if (connection.channel === "filedrop") {
      log.info(
        "opening local path",
        // The filedrop path is partner-seeded on an offline-accept config (it
        // comes from the invitation's filedrop endpoint, charset-unconstrained),
        // so escape it before it reaches the operator's terminal -- the filedrop
        // twin of the SFTP host below. A split config has no single `path`; show
        // the inbound directory it reads the peer's files from instead.
        redactAndSanitizeForDisplay(
          connection.path ?? connection.inboundPath ?? "",
        ),
      );
    } else if (connection.channel === "sftp") {
      log.info(
        "opening connection to",
        // The SFTP host is partner-controlled on an offline-accept-seeded config
        // (it comes from the invitation endpoint, charset-unconstrained), so
        // escape it before it reaches the operator's terminal.
        redactAndSanitizeForDisplay(connection.server.host),
        "with options",
        connection.options,
      );
    }
    // The prepare block builds the connection and its bridge together on
    // every file-sync channel; the check is what licenses the rest of the
    // block treating them as present.
    if (build.fileSync === undefined || build.transport === undefined)
      throw new InternalConsistencyError(
        "the file-sync transport was not constructed",
      );
    const fileSyncConn = build.fileSync;
    await fileSyncConn.open(connection);
    run.opened = true;

    // If a signal fired while `conn.open()` was awaiting, the signal
    // handler already ran doCleanup, including a conn.close() that
    // no-op'd because `connected` was still false at that moment. Now
    // that open() has resolved, close the freshly-opened connection
    // explicitly and short-circuit so the catch's signalReceived branch
    // resolves runProtocol cleanly -- otherwise the connection stays open
    // until process termination, harmless in production but a state leak
    // in tests that mock process.exit.
    if (run.signalReceived !== undefined) {
      try {
        await fileSyncConn.close();
      } catch (err) {
        log.debug(
          "post-open signal close failed:",
          sanitizeErrorForDisplay(err),
        );
      }
      throw new Error(
        `interrupted by ${run.signalReceived} during connection open`,
      );
    }

    log.info("synchronizing");
    await fileSyncConn.synchronize();

    // If a signal fired during the synchronize() round-trip, doCleanup
    // already ran (closing the connection and removing our hello/lock
    // files). Bail out before start() so the poller is not launched
    // against a closed transport -- otherwise conn.start() would
    // schedule polls that fail against the closed client, producing
    // spurious error logs while the signal handler is already exiting.
    // The corresponding check after open() handles the open/synchronize
    // window; this one handles synchronize/start.
    if (run.signalReceived !== undefined) {
      throw new Error(
        `interrupted by ${run.signalReceived} during synchronization`,
      );
    }

    const rendezvousRole = fileSyncConn.handshakeRole;
    // Invariant: synchronize() throws on all failure paths, so role is always
    // defined when synchronize() returns normally.
    if (rendezvousRole === undefined)
      throw new InternalConsistencyError(
        "connection did not establish a handshake role after synchronization",
      );
    role = rendezvousRole;

    log.info("starting polling");
    // conn.start() must precede authenticateConnection: the key exchange
    // awaits mc.receive(), which is fed by the bridge's data listener; that
    // listener only sees inbound frames once the polling loop is running.
    fileSyncConn.start();
    run.started = true;
  }

  // Report the negotiated handshake role by what this party does next, not
  // as "arrived first/second": under lockless rendezvous (retain mode,
  // and so a split inbound/outbound directory) the role is a
  // deterministic lexicographic tiebreaker on the two hello filenames,
  // not wall-clock arrival order -- the party whose peer id sorts lower is
  // always the responder regardless of who connected first. Describing
  // send/wait behavior is accurate under both rendezvous modes and is the
  // operationally useful fact (which side acts next).
  if (role === "responder") {
    log.info("waiting for your partner's first message");
  } else {
    log.info("sending your partner the first message");
  }
  return role;
}

/** What {@link authenticateRun} states ahead of the key file it could not mark. */
const ROTATION_MARK_PREAMBLE =
  "the key exchange did not start because it could not be recorded in the " +
  "key file at ";

/** What {@link authenticateRun} states behind that key file and the failure. */
const ROTATION_MARK_REMEDY =
  " The shared secret is unchanged, though the key file may still record " +
  "this attempt; fix the key file's location or permissions and run the " +
  "exchange again.";

/**
 * Remove the rotation-in-flight marker after a run whose recorded outcome
 * leaves nothing for the next run to report: a key exchange that failed
 * closed, whose failure is what the operator reads, or a responder's run that
 * ended at the terms exchange with neither side able to have stored the next
 * secret ({@link rotationStanding}). Every other run, a crash among them,
 * leaves the marker. A write failure is logged rather than
 * thrown, so it cannot replace the run's own failure.
 */
function clearRotationInFlightMarker(
  keyFilePath: string,
  sharedSecret: string,
  log: ReturnType<typeof getLogger>,
): void {
  try {
    clearRotationInFlight(keyFilePath, sharedSecret);
  } catch (err) {
    log.warn(
      `the key file at ${redactAndRenderOperatorSuppliedText(
        operatorSuppliedText(keyFilePath),
      )} still records this key exchange as in flight, because removing ` +
        `that record failed: ${sanitizeErrorForDisplay(err)}`,
    );
  }
}

/**
 * Where a run's rotation left the two parties, read from how far it got in the
 * store order (docs/spec/PROTOCOL.md, "The rotation at the terms exchange"):
 * - `unchanged`: neither side can have stored the next secret.
 * - `partner-may-lead`: this side, the responder, holds the secret the run
 *   authenticated with, and the initiator may hold the next one.
 * - `partner-may-lag`: this side, the initiator, stored the next secret, and
 *   the responder may not have.
 * - `both-stored`: both sides hold the next secret.
 */
type RotationStanding =
  "unchanged" | "partner-may-lead" | "partner-may-lag" | "both-stored";

/**
 * The {@link RotationStanding} of `run`. The initiator stores first, so before
 * its own store the responder cannot have stored; one whose store failed sent
 * the abort that keeps the responder from storing. The responder stores only
 * on reading `proceed`, which shows the initiator stored.
 */
function rotationStanding(run: RunLifecycle): RotationStanding {
  if (run.handshakeRole === "responder") {
    if (run.tokenRotated) return "both-stored";
    return run.partnerMayHoldNextSecret || run.rotationStoreBegan
      ? "partner-may-lead"
      : "unchanged";
  }
  return run.tokenRotated ? "partner-may-lag" : "unchanged";
}

/**
 * The {@link KeyFileSavedConfigNotWritten} state of an online setup's run that
 * saved its rotated key file at `keyPath` and has not started its
 * configuration step, or whose step failed, else `undefined`.
 */
function keyFileSavedConfigNotWritten(
  run: RunLifecycle,
  keyPath: string | undefined,
  onlineSetup: OnlineSetup | undefined,
): KeyFileSavedConfigNotWritten | undefined {
  if (onlineSetup === undefined || keyPath === undefined || !run.tokenRotated)
    return undefined;
  const stepFailed = run.configWriteError !== undefined;
  if (run.configWriteStarted && !stepFailed) return undefined;
  return {
    configPath: onlineSetup.configPath,
    kept: onlineSetup.kept,
    keyPath,
    configWriteFailed: stepFailed && !onlineSetup.kept,
  };
}

/**
 * The rotation line printed beneath a failure, for a run whose standing is
 * `standing`, or `undefined` where there is nothing to state: a run that
 * rotated nobody leaves the existing secret valid on both sides. Where the
 * failure's own next step rules out a retry (`retryRuledOut`), the line states
 * the token state without prescribing one.
 */
function rotationLineAfterFailure(
  standing: RotationStanding,
  retryRuledOut: boolean,
): string | undefined {
  const saved =
    "The shared secret was already rotated and saved before this error.";
  const behind =
    "This side had not saved the next shared secret when this error " +
    "occurred, and your partner may already have saved it";
  switch (standing) {
    case "unchanged":
      return undefined;
    case "partner-may-lead":
      return retryRuledOut
        ? `${behind}, so the next run may need a new invitation from your ` +
            "partner."
        : `${behind}. Retry the exchange with the existing key file; if ` +
            "authentication fails on retry, ask your partner for a new " +
            "invitation.";
    case "partner-may-lag":
    case "both-stored":
      // No line beneath a step that rules out a retry: a responder's partner
      // stored too, and an initiator does not track the responder's first
      // frame after `proceed`, which shows the responder stored, so a line
      // would name a new invitation a retry may not need.
      if (retryRuledOut) return undefined;
      return standing === "partner-may-lag"
        ? `${saved} Retry the exchange with the same key file; if ` +
            "authentication fails on retry, ask your partner for a new " +
            "invitation."
        : `${saved} Your partner saved it too, so retry the exchange with ` +
            "the same key file.";
  }
}

/**
 * What {@link authenticateRun} states ahead of the key file it could not save
 * as the responder, which stores after the initiator did.
 */
const ROTATED_TOKEN_SAVE_PREAMBLE =
  "authentication succeeded and the shared token was rotated, but the " +
  "updated token could not be saved to ";

/**
 * What {@link authenticateRun} states behind that key file and the failure:
 * the initiator kept the secret this run used, so the next run heals.
 */
const ROTATED_TOKEN_SAVE_REMEDY =
  " Your partner saved the new token and kept the one this run used, so " +
  "the next run can use that one. Fix the key file's location or " +
  "permissions, then run the same command again; if authentication fails " +
  "on that run or it never meets your partner, ask your partner for a new " +
  "invitation.";

/** {@link ROTATED_TOKEN_SAVE_REMEDY} where the next run cannot heal. */
const ROTATED_TOKEN_SAVE_REMEDY_NO_HEAL = ` Your partner may already hold the rotated token. ${NEW_INVITATION_REMEDY}`;

const NO_HEAL_SAVE_FAILURE = annotationKey<true>("no-heal save failure");

/**
 * `failure`, marked as a rotated-secret save failure after which the two
 * sides hold different secrets and the remedy is a new invitation.
 */
export function markNoHealSaveFailure<E extends object>(failure: E): E {
  return annotate(failure, NO_HEAL_SAVE_FAILURE, true);
}

/**
 * Whether `err`, or any link in its `cause` chain, is a rotated-secret save
 * failure that {@link markNoHealSaveFailure} marked: a retry of the same
 * command cannot recover it.
 */
export function isNoHealSaveFailure(err: unknown): boolean {
  return annotationOf(err, NO_HEAL_SAVE_FAILURE) === true;
}

/**
 * Whether the next run with the same partner can heal a run cut between the
 * two stores. Over SFTP and a shared folder the two sides meet whatever secret
 * each holds; over WebRTC each derives its rendezvous id from its current
 * secret, so they do not meet. A cut run that cannot heal exits 77.
 */
function nextRunCanHeal(channel: ProtocolConnectionConfig["channel"]): boolean {
  return channel === "sftp" || channel === "filedrop";
}

/**
 * What {@link authenticateRun} states ahead of the key file it could not save
 * as the initiator, which stores first, so its partner stored nothing.
 */
const FIRST_STORE_SAVE_PREAMBLE =
  "authentication succeeded, but the next shared secret could not be saved to ";

/**
 * What {@link authenticateRun} states behind that key file and the failure. A
 * directory flush that fails after the rename leaves the next secret in this
 * side's key file beside the secret the run used, which the next run heals
 * where the channel allows it ({@link nextRunCanHeal}); the
 * authentication-failure fallback, and over WebRTC the next run's no-show
 * remedy, cover a state it cannot.
 */
const FIRST_STORE_SAVE_REMEDY =
  " Your partner did not save it. Fix the key file's location or " +
  "permissions, then run the same command again; if authentication fails on " +
  "that run, ask your partner for a new invitation.";

/**
 * What an initiator states ahead of its key file when the partner's abort
 * says it could not save the next shared secret this side had saved.
 */
const PARTNER_SAVE_FAILURE_PREAMBLE =
  "Your partner could not save the new shared secret, so the exchange " +
  "stopped. This side had already saved it to ";

/**
 * What follows that key file: this side kept the secret the run used, so the
 * next run heals.
 */
const PARTNER_SAVE_FAILURE_REMEDY =
  ", and kept the secret this run used, so the next run can use that one. " +
  "Run the exchange again once your partner has fixed what stopped their " +
  "save. If authentication then fails, or the run never meets your " +
  "partner, you and your partner hold different secrets. " +
  `${NEW_INVITATION_REMEDY} It is ` +
  'described under "Out-of-sync tokens" in docs/CLI.md.';

/** {@link PARTNER_SAVE_FAILURE_REMEDY} where the next run cannot heal. */
const PARTNER_SAVE_FAILURE_REMEDY_NO_HEAL =
  ", so you and your partner now hold different secrets, and running the " +
  `exchange again cannot reconnect you. ${NEW_INVITATION_REMEDY} It is ` +
  'described under "Out-of-sync tokens" in docs/CLI.md.';

/**
 * The failure an initiator reports in place of the partner's abort stating
 * that it could not save the next shared secret
 * ({@link isPartnerNextSecretStoreFailure}), where this side saved it: as the
 * responder's own failed save, exit 69 where the next run heals, since this
 * side kept the secret the run used, and exit 77 where it cannot. `undefined`
 * for every other failure, and where this side saved nothing, which report as
 * themselves.
 */
function partnerSaveFailure(
  err: unknown,
  run: RunLifecycle,
  keyFilePath: string | undefined,
  nextRunHeals: boolean,
): Error | undefined {
  if (
    run.handshakeRole !== "initiator" ||
    !run.tokenRotated ||
    keyFilePath === undefined ||
    !isPartnerNextSecretStoreFailure(err)
  )
    return undefined;
  const message = messageWithOperatorText`${PARTNER_SAVE_FAILURE_PREAMBLE}${operatorSuppliedText(
    keyFilePath,
  )}${nextRunHeals ? PARTNER_SAVE_FAILURE_REMEDY : PARTNER_SAVE_FAILURE_REMEDY_NO_HEAL}`;
  const failure = keepOperatorSuppliedText(new Error(message.text), message);
  return markStatesItsOwnNextStep(
    nextRunHeals
      ? failure
      : markNoHealSaveFailure(
          withExitCode(failure, AUTHENTICATION_FAILED_EXIT_CODE),
        ),
  );
}

/**
 * The warning both sides of a heal run state, so that it cannot hide a copy
 * of the exchange running elsewhere: the side that completed the handshake
 * under its previous secret was ahead, and the side whose partner did was
 * behind. `undefined` for a handshake both completed under the current secret.
 */
export function rotationHealWarning(secretUsed: {
  local: HandshakeSecretKind;
  partner: HandshakeSecretKind;
}): string | undefined {
  if (secretUsed.local === "previous")
    return (
      "The last run stopped before your partner saved the new shared " +
      "secret, so this run uses the one before it, and both sides save a " +
      "new secret. If neither of you had a run stop partway, ask your " +
      "partner whether they ran this exchange from another copy."
    );
  if (secretUsed.partner === "previous")
    return (
      "Your partner still had the shared secret from before your last run " +
      "stopped, so this run uses it, and both sides save a new secret. If " +
      "no run of yours stopped partway, check whether this exchange also " +
      "runs from another copy."
    );
  return undefined;
}

/**
 * Drop the previous secret the initiator kept, once the responder's first
 * frame after the terms exchange shows it stored the next one. A failure
 * ends the run (core then sends the partner its fixed abort): both sides hold
 * the next secret as their current one, so the next run works as usual on
 * every channel, WebRTC included, and the failure exits 69.
 */
function dropStoredPreviousSecret(
  keyFilePath: string,
  storedSecret: string,
): void {
  try {
    dropPreviousSecret(keyFilePath, storedSecret);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = messageWithOperatorText`${PREVIOUS_DROP_PREAMBLE}${operatorSuppliedText(
      keyFilePath,
    )}: ${reason}${PREVIOUS_DROP_REMEDY}`;
    throw markStatesItsOwnNextStep(
      keepOperatorSuppliedText(new Error(message.text), message),
    );
  }
}

/**
 * Run the online setup's configuration step once this side's terms exchange
 * and the checks after it have passed and its rotated key is saved, before any
 * linkage key or payload row moves. A failure is non-fatal, since the data
 * exchange must not be aborted by a failure to persist recoverable setup: it
 * is logged, reported as a persistence loss, and recorded on the run.
 */
async function runConfigWrite(params: {
  writeConfig: () => void | Promise<void>;
  run: RunLifecycle;
  log: ReturnType<typeof getLogger>;
  eventStream: EventStreamEmitter | undefined;
}): Promise<void> {
  const { writeConfig, run, log, eventStream } = params;
  // A signal that arrived while the terms exchange was finishing has already
  // stated the step for a run that wrote no configuration.
  if (run.signalReceived !== undefined) return;
  run.configWriteStarted = true;
  try {
    await writeConfig();
  } catch (writeErr) {
    // The caller distinguishes a failure from success by the presence of this
    // value, so a falsy throw (`undefined`, `null`, `0`, `""`, `false`, `NaN`)
    // is coerced to an Error: `undefined` is the success sentinel.
    run.configWriteError = writeErr
      ? writeErr
      : new Error(
          "writing the configuration threw a falsy value: " + String(writeErr),
        );
    log.error(
      "writing the configuration after the terms exchange failed; the " +
        "rotated key is saved and the exchange will continue: " +
        sanitizeErrorForDisplay(writeErr),
    );
    // A supervisor that discards stderr on a run that completes would
    // otherwise have nothing to tell it the setup is half provisioned.
    // Reported on both machine channels at the loss itself.
    reportPersistenceLoss(
      "writing the configuration after the terms exchange did not " +
        "complete; the exchange continued and the rotated key is saved",
      eventStream,
    );
  }
}

/** What a failed drop of the previous secret states ahead of the key file. */
const PREVIOUS_DROP_PREAMBLE =
  "both sides saved the new shared secret, but removing the secret before " +
  "it failed in ";

/** What follows that key file and the failure. */
const PREVIOUS_DROP_REMEDY =
  ". The exchange stopped. Fix the key file's location or permissions, " +
  "then run the same command again.";

/**
 * The run's authentication stage: run the key exchange, set the rotation the
 * terms exchange makes -- the rotated-token save -- wrap the transport in the
 * negotiated AEAD layer, and arm the cross-party abort marker. Runs only on
 * the authenticated path; the unauthenticated one has no acceptance step at
 * all.
 *
 * The rotated-token save and the flag recording it are one synchronous step, so
 * a signal handler reading the lifecycle sees both the pre-save state or both
 * the post-save state, never one of each.
 */
async function authenticateRun(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  mc: MessageConnection;
  auth: AuthPersist;
  role: HandshakeRole;
  log: ReturnType<typeof getLogger>;
  eventStream: EventStreamEmitter | undefined;
  /** {@link nextRunCanHeal} for the run's channel, and a key file that was
   * there before the run. */
  nextRunHeals: boolean;
}): Promise<void> {
  const { build, run, mc, auth, role, log, eventStream, nextRunHeals } = params;
  log.info("authenticating");
  // Discard the (possibly whitespace-padded) keyFilePath from auth;
  // saveKeyFile below uses trimmedKeyFilePath, which was captured and
  // trimmed during pre-flight without mutating the caller-supplied
  // auth object.
  const {
    keyFilePath: _ignored,
    keyFileWrittenThisRun: _written,
    saveKeyFileExclusively,
    relayRegistrationFollows,
    previousSharedSecret,
    previousExpires,
    rotationHistory,
    ...authParams
  } = auth;
  // trimmedKeyFilePath is set whenever auth is set; they are populated
  // together in the pre-flight branch above.
  const keyFilePath = build.trimmedKeyFilePath!;
  // Before the key exchange can rotate anything, and only as the responder:
  // the initiator stores first, so only a responder can be left behind by a
  // run that stops partway. A marker an earlier run left stays until a
  // recorded outcome supersedes it. A failed write stops the run here, with
  // the secret unchanged.
  try {
    if (role === "responder")
      markRotationInFlight(keyFilePath, auth.sharedSecret, Date.now());
  } catch (err) {
    const message = messageWithOperatorText`${ROTATION_MARK_PREAMBLE}${operatorSuppliedText(
      keyFilePath,
    )}: ${err instanceof Error ? err.message : String(err)}${ROTATION_MARK_REMEDY}`;
    throw markStatesItsOwnNextStep(
      keepOperatorSuppliedText(new Error(message.text), message),
    );
  }
  // Set synchronously before the await, so a signal arriving during the key
  // exchange reads this run's role in the store order.
  run.authStarted = true;
  run.handshakeRole = role;
  // sessionKey (32 bytes, both parties derive the same value) keys the
  // per-direction AEAD encryption set up below, so every PSI frame
  // after this point is opaque on the wire to a file-sync admin and to
  // the webrtc coordination server. nextSecretInputs is what the terms
  // exchange derives the next shared secret from, which it hands the save
  // below to persist to disk. requestEncryption is what this party asks
  // for; applyEncryption is the negotiated OR both parties agree on,
  // gating the EncryptedMessageConnection wrap below.
  //
  // Every channel asks for it. A file-sync admin can read every frame,
  // and the coordination server controls the webrtc signaling it relays,
  // so DTLS alone does not keep content from it; it cannot complete this
  // handshake. See docs/spec/CHANNEL_SECURITY.md.
  const requestEncryption = true;
  // The FIPS variant image's OpenSSL configuration sets fips=yes as the
  // default property, which getFips() reports (docs/notes/fips-provider-
  // surface.md); under it the hello offers approved key-exchange suites only.
  // A capability probe would not do: a FIPS provider build may still carry an
  // unapproved primitive.
  const {
    nextSecretInputs,
    sessionKey,
    applyEncryption,
    secretUsed,
    negotiated,
  } = await authenticateConnection(
    mc,
    authParams,
    role,
    requestEncryption,
    {
      ...(previousSharedSecret !== undefined && {
        previous: {
          sharedSecret: previousSharedSecret,
          ...(previousExpires !== undefined && { expires: previousExpires }),
        },
      }),
      history: rotationHistory ?? [],
    },
    supportedVersions({ approvedKexSuitesOnly: getFips() === 1 }),
  ).catch((err: unknown) => {
    if (isTrustBoundaryFailure(classifyFailure(err)))
      clearRotationInFlightMarker(keyFilePath, auth.sharedSecret, log);
    throw err;
  });
  run.negotiatedProtocolVersion = negotiated.protocol;
  const heal = rotationHealWarning(secretUsed);
  if (heal !== undefined) {
    log.warn(heal);
    eventStream?.warning("rotationHeal", heal);
  }
  // Capture the session key for the signed-receipt step (it derives the replay
  // binder from it); only the authenticated path reaches here, so the no-auth
  // path leaves it undefined and runExchange's signing step stays skipped.
  run.sessionKeyForReceipt = sessionKey;
  // The save runs inside the terms exchange at this side's point in the store
  // order: the initiator's before it sends `proceed`, the responder's on
  // reading it. The initiator's store keeps the secret its handshake used as
  // the previous secret, which it drops once the responder's first frame
  // after the terms exchange shows the responder stored too.
  let storedSecret: string | undefined;
  run.rotation = releasableTermsRotation({
    inputs: nextSecretInputs,
    store: (nextSecret) => saveNextSecret(nextSecret),
    partnerMayHoldNextSecret: (mayHold) => {
      run.partnerMayHoldNextSecret = mayHold;
    },
    ...(role === "initiator" && {
      partnerStored: () => {
        if (storedSecret !== undefined)
          dropStoredPreviousSecret(keyFilePath, storedSecret);
      },
    }),
  });
  async function saveNextSecret(rotatedSecret: string): Promise<void> {
    // rotationWriteContents stamps `expires` = now + tokenMaxAgeDays days
    // when the operator set a max-age policy, computed here at the
    // moment of rotation rather than at config-parse time. Built before
    // the try/catch below so its input-validation guard (a non-positive
    // or non-integer tokenMaxAgeDays, reachable only by a caller
    // bypassing the config schema) propagates as the UsageError it is
    // (exit 64) rather than being caught and re-wrapped as a
    // "could not be saved" failure.
    const rotatedAt = Date.now();
    const rotatedKeyFile: KeyFile = {
      ...(await rotationWriteContents({
        rotatedSecret,
        tokenMaxAgeDays: auth.tokenMaxAgeDays,
        now: rotatedAt,
        role,
        usedPrevious: secretUsed.local === "previous",
        atRunStart: {
          sharedSecret: auth.sharedSecret,
          expires: auth.expires,
          previousSharedSecret,
          previousExpires,
          rotationHistory,
        },
      })),
      ...(relayRegistrationFollows === true && {
        relayRegistrationPendingSince: new Date(rotatedAt).toISOString(),
      }),
    };
    try {
      // saveKeyFile is synchronous; the assignment below runs in the same
      // microtask tick, so no signal can interleave between them. A
      // signal handler that reads tokenRotated sees either both pre-save
      // state (false) or both post-save state (true). Maintain this: do
      // not insert an await between saveKeyFile and the assignment.
      run.rotationStoreBegan = true;
      saveKeyFile(keyFilePath, rotatedKeyFile, {
        exclusive: saveKeyFileExclusively === true,
      });
      run.tokenRotated = true;
      storedSecret = rotatedSecret;
    } catch (err) {
      // Marked as stating its own next step, so runProtocol prints no rotation
      // line beneath it. An initiator's failed store aborts before the
      // responder's, so a retry recovers (exit 69). A responder stores after
      // an initiator that kept the secret this run used: exit 69 where the
      // next run heals, else 77, since a retry cannot reconnect the two. An
      // online invite or accept responder (saved exclusively) has no key file
      // after a failed save, and a re-run bootstrap healing from none is
      // unmeasured, so it takes the 77 path on every channel.
      const reason = err instanceof Error ? err.message : String(err);
      const responderCannotHeal = role === "responder" && !nextRunHeals;
      const [preamble, remedy] =
        role === "initiator"
          ? [FIRST_STORE_SAVE_PREAMBLE, FIRST_STORE_SAVE_REMEDY]
          : [
              ROTATED_TOKEN_SAVE_PREAMBLE,
              responderCannotHeal
                ? ROTATED_TOKEN_SAVE_REMEDY_NO_HEAL
                : ROTATED_TOKEN_SAVE_REMEDY,
            ];
      const message = messageWithOperatorText`${preamble}${operatorSuppliedText(
        keyFilePath,
      )}: ${reason}${remedy}`;
      const failure = keepOperatorSuppliedText(
        new Error(message.text),
        message,
      );
      throw markStatesItsOwnNextStep(
        responderCannotHeal
          ? markNoHealSaveFailure(
              withExitCode(failure, AUTHENTICATION_FAILED_EXIT_CODE),
            )
          : failure,
      );
    }
  }

  // Wrap mc in the AEAD decorator and run the PSI exchange through `secure`
  // so every frame is encrypted on the wire. applyEncryption is the
  // transcript-bound OR of both parties' requests and this party requests it
  // on every channel, so a handshake that completes without it is refused
  // rather than run bare.
  //
  // create() derives the two per-direction keys via HKDF and registers
  // no listeners on mc, so a signal arriving before it resolves needs
  // no listener juggling: doCleanup closes mc/conn directly, latches
  // cleaned, and leaves the decorator create() later assigns to
  // `secure` unclosed but harmless (mc is already closed, and the
  // decorator holds only CryptoKey objects). The signalReceived check
  // below mirrors the post-open and post-synchronize guards, bailing
  // before runExchange so the encrypted stream never starts against an
  // already-closed mc.
  if (!applyEncryption) {
    throw new ConnectionError(
      "the key exchange completed without the application-layer encryption " +
        "this side requested",
      "usage",
    );
  }
  run.secure = await EncryptedMessageConnection.create(
    mc,
    sessionKey,
    role,
    negotiated.envelope,
  );
  if (run.signalReceived !== undefined) {
    throw new Error(
      `interrupted by ${run.signalReceived} during channel encryption setup`,
    );
  }

  // Arm the authenticated cross-party abort marker now that the session
  // key is in hand (the only path that holds one): derive this party's
  // token -- written into <myId>-abort-<n>.json on a terminal organic fault
  // so a waiting peer fails fast instead of waiting out its full
  // inactivity timeout -- and the peer's, verified against an incoming
  // <peerId>-abort-<n>.json. Placed after the signal guard so an interrupt
  // during setup bails before arming.
  //
  // Armed unconditionally, including retain mode: the fast-fail
  // benefits a waiting peer either way, and the marker doubles as an
  // audit record. A retain-mode fault leaves the marker on disk (the
  // entry-time sweep is delete-mode only), but a retain fault already
  // leaves a non-clean directory, so this adds no incremental cleanup
  // burden.
  //
  // File-sync only, with no webrtc counterpart: the fast-fail it buys
  // is what a live channel already gives for free, since a dying party
  // drops the data channel and the peer learns of it from connection
  // state rather than an absence.
  if (build.fileSync !== undefined) {
    const peerRole = role === "initiator" ? "responder" : "initiator";
    const [selfAbortToken, peerAbortToken] = await Promise.all([
      deriveAbortToken(sessionKey, role),
      deriveAbortToken(sessionKey, peerRole),
    ]);
    build.fileSync.armAbort(selfAbortToken, peerAbortToken);
  }
}

/**
 * How far one run got: the flags its stages set as they advance, which the
 * cleanup and the error path both read to decide what to close, what to warn
 * about, and how to classify a failure. Held in one object so a stage that
 * sets a flag and the teardown that reads it are looking at the same value.
 */
interface RunLifecycle {
  /** The transport is open, so cleanup has a connection to close. */
  opened: boolean;
  /** The file-sync poller is running, so cleanup has polling to stop. */
  started: boolean;
  /**
   * The AEAD decorator over the transport, present only when the handshake
   * negotiated encryption. Its close() delegates to the transport's.
   */
  secure: EncryptedMessageConnection | undefined;
  /**
   * The session key from the authenticated key exchange, which the
   * signed-receipt step derives its replay binder from.
   */
  sessionKeyForReceipt: Uint8Array<ArrayBuffer> | undefined;
  /**
   * The protocol version the key exchange negotiated, which the terms
   * exchange checks the partner's stated version against. Unset on the
   * no-auth path, which checks against this build's own version.
   */
  negotiatedProtocolVersion: number | undefined;
  /** Set immediately before the key exchange is awaited. */
  authStarted: boolean;
  /** This side's role in the key exchange, set with {@link authStarted}. */
  handshakeRole: HandshakeRole | undefined;
  /**
   * Set as a responder sends its value at the terms exchange, after which the
   * initiator may store the next secret, and cleared where the initiator's
   * abort shows it stored nothing (`TermsRotation.partnerMayHoldNextSecret`).
   */
  partnerMayHoldNextSecret: boolean;
  /** Set immediately before this side's rotated-token save begins. */
  rotationStoreBegan: boolean;
  /** Set only after this side's own rotated-token save succeeded. */
  tokenRotated: boolean;
  /**
   * The rotation the terms exchange makes, set once the key exchange
   * completes: its inputs and the key-file save it awaits at this side's point
   * in the store order. Undefined on the unauthenticated path. Its inputs are
   * released once the save has run or the exchange has ended without it.
   */
  rotation: ReleasableTermsRotation | undefined;
  /**
   * Set once the two-party exchange returned, so a failure in the local
   * output stage that follows writes no cross-party abort marker.
   */
  exchangeComplete: boolean;
  /**
   * Set once the output stage returned with every local artifact a run owes --
   * the result file, the exchange record, the receipt, and whatever the
   * caller's own post-exchange step writes -- on disk. A run that entered the
   * stage and failed inside it, and one that lost an artifact non-fatally,
   * each wrote some or none of them, so nothing told to the operator about
   * what is on disk keys on the stage being reached.
   */
  outputsWritten: boolean;
  /**
   * Set synchronously at the top of a signal handler, before any await, so an
   * in-flight failure caused by signal-driven cleanup is told apart from an
   * organic one and the exit code is left to the handler.
   */
  signalReceived: NodeJS.Signals | undefined;
  /**
   * A failure from the online setup's configuration step. Non-fatal, so it
   * does not stop the exchange; it is reported on the resolved result instead.
   */
  configWriteError: unknown;
  /**
   * Set as the online setup's configuration step starts. A rotated run that
   * ended before the terms exchange and the checks after it passed never
   * starts it.
   */
  configWriteStarted: boolean;
}

/**
 * The run's cleanup stage: seal the abort decision, then close every transport
 * layer this run opened, innermost first. Each close is idempotent and its
 * failure is caught, so cleanup runs to completion whether the exchange
 * finished, failed, or was interrupted mid-open.
 *
 * Reads the {@link RunLifecycle} itself rather than a copy of its flags, so an
 * open that completes while an earlier layer's close is still being awaited
 * counts as opened for the layers below it.
 *
 * The three layer closes share one ceiling, `ceilingMs`: they are one
 * obligation, the transport's, and this is the channel-independent point at
 * which a finished run stops waiting on it (see
 * {@link transportTeardownCeilingMs}). Nothing local is inside it -- the
 * result, the record and the receipt are already on disk by the time cleanup
 * runs -- so reaching the ceiling costs the close, never an artifact.
 */
async function closeRunLayers(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  log: ReturnType<typeof getLogger>;
  ceilingMs: number;
}): Promise<TeardownOutcome> {
  const { build, run, log, ceilingMs } = params;
  // Seal the abort decision before the first layer-close drives the real
  // conn.close() cascade (secure.close() -> mc.close() -> conn.close()):
  // on the clean-completion, signal, and echo paths no writeAbortMarker()
  // ran, so without this seal conn.close() would wait out its fallback
  // grace and block teardown for the full window. A catch-path
  // writeAbortMarker() (if it ran) already pre-empted this. Synchronous
  // and side-effect free, so hoisting it here is safe, and a no-op on the
  // unauthenticated path and on webrtc, neither of which has a marker.
  build.fileSync?.sealAbort();
  if (run.started) log.info("stopping polling");
  if (run.opened) log.info("closing connection");
  // A finished exchange whose last message the partner never confirmed is
  // the one close failure the operator acts on: the partner's run may have
  // ended without it. Any other close failure stays a debug line. The
  // encrypted layer passes the transport's rejection on, so the transport's
  // own close can report the same delivery a second time.
  let unconfirmedReported = false;
  const reportCloseFailure = (label: string, err: unknown): void => {
    if (
      err instanceof FinalFrameUnconfirmedError &&
      run.exchangeComplete &&
      !unconfirmedReported
    ) {
      unconfirmedReported = true;
      log.warn(sanitizeErrorForDisplay(err));
    } else log.debug(label, sanitizeErrorForDisplay(err));
  };
  return closeWithinCeiling(ceilingMs, async () => {
    // When the AEAD decorator was built (encryption negotiated), close it:
    // its close() delegates to mc.close(), detaching the bridge's
    // data/error listeners and closing the underlying FileSyncConnection.
    // `secure` is undefined on the no-auth path, when applyEncryption was
    // negotiated false, and in the window where a signal arrived between
    // authenticateConnection returning and create resolving -- in each case
    // mc.close() below closes the transport directly. All idempotent.
    if (run.secure !== undefined) {
      await run.secure.close().catch((err: unknown) => {
        reportCloseFailure("secure.close() during cleanup:", err);
      });
    }
    // Closing the transport detaches the file-sync bridge's data/error
    // listeners and closes the underlying FileSyncConnection -- stopping
    // the poller, sweeping the responsible files, and ending the client --
    // or, on webrtc, flushes the outbound queue and tears the data channel,
    // peer connection and broker socket down. All idempotent, so this is
    // safe even when open() never ran. Undefined only when the webrtc
    // rendezvous never produced a connection.
    await build.transport?.close().catch((err: unknown) => {
      reportCloseFailure("transport close during cleanup:", err);
    });
    // If an earlier transport failure already terminated the bridge, its
    // close() returns immediately without re-closing fileSync (that earlier
    // close was fire-and-forget, hence unawaited). Close fileSync directly
    // to guarantee the poller is stopped, the responsible files are swept,
    // and the client is ended before doCleanup returns. Idempotent, so in
    // the normal path this is a near no-op after the bridge already closed
    // it.
    await build.fileSync?.close().catch((err: unknown) => {
      // When the connection was open, a close failure is user-visible: the
      // transport may not have terminated cleanly (e.g. SSH session timeout).
      // close() is idempotent and does not throw on an unopened instance, so
      // the else branch is only a defensive fallback for an unexpected error.
      if (run.opened) {
        log.warn(
          "failed to close connection during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      } else {
        log.debug(
          "fileSync.close() during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      }
    });
  });
}

/**
 * The end-of-run transport counters, one line each and only when non-zero: the
 * sessions lost and re-established mid-exchange, the dialing retries, and the
 * connection-per-poll boundaries where the session was released, forced closed,
 * held, or skipped. All are this party's own integers, never partner-controlled.
 */
function logTransportCounters(
  client: LocalFSClient | SSH2SFTPClientAdapter | undefined,
  log: ReturnType<typeof getLogger>,
): void {
  // The end-of-run summary at normal verbosity: --event-stream reports the
  // two counts only as one machine metric, and the SFTP adapter's per-drop
  // WARN flags each recovery burst, not the run. Two lines rather than one
  // total because a dial retried until it gave up never connected, and
  // reporting it as a re-establishment would read as a flaky link where the
  // server or directory was never reachable. Both are zero on a clean run.
  const midExchangeLosses = client?.midExchangeReconnectCount ?? 0;
  const connectRetries = client?.connectRetryCount ?? 0;
  if (midExchangeLosses > 0)
    log.info(
      `the connection was lost and re-established ${midExchangeLosses} ` +
        `time${midExchangeLosses === 1 ? "" : "s"} during this exchange`,
    );
  if (connectRetries > 0)
    log.info(
      `connecting was retried ${connectRetries} ` +
        `time${connectRetries === 1 ? "" : "s"} during this exchange ` +
        `(not a lost connection)`,
    );
  // Connection-per-poll's per-cycle outcomes, each its own line on its own
  // count: their inline WARNs are paced or absent, so this is the only
  // place the true totals are stated for an unattended run. Not folded
  // into the reconnect line above: that line counts SESSIONS LOST, these
  // count BOUNDARIES, and the two overlap without either containing the
  // other, so folding any of them in would double-count. See
  // docs/notes/connection-per-poll-sftp.md for the full boundary model.
  // All are 0 outside connection-per-poll, so the guards stay quiet.
  const heldBoundaries = client?.heldBoundaryCount ?? 0;
  const heldStretches = client?.heldBoundaryStretchCount ?? 0;
  const perCycleOutcomes: {
    count: number;
    line: (count: number) => string;
  }[] = [
    {
      count: client?.releasedBoundaryCount ?? 0,
      line: (count) =>
        `the connection-per-poll release closed the SFTP session at ` +
        `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
        `this exchange, each re-dialed at the start of the next poll cycle`,
    },
    {
      count: client?.forcedReleaseCount ?? 0,
      line: (count) =>
        `the connection did not close when released at ${count} idle ` +
        `${count === 1 ? "boundary" : "boundaries"} during this exchange, ` +
        `so it was closed from this side`,
    },
    {
      count: client?.declinedReleaseCount ?? 0,
      line: (count) =>
        `the connection-per-poll release did not close the session at ` +
        `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
        `this exchange (not a dropped session): another step on this ` +
        `connection did not finish in the time the release waits, so ` +
        `the session stayed live across ` +
        `${count === 1 ? "that idle gap" : "those idle gaps"}`,
    },
    {
      count: client?.declinedCycleRedialCount ?? 0,
      line: (count) =>
        `the connection-per-poll re-dial skipped ${count} poll ` +
        `${count === 1 ? "cycle" : "cycles"} during this exchange (not a ` +
        `dropped session): another step on this connection did not finish ` +
        `in the time the re-dial waits, so ` +
        `${count === 1 ? "that cycle" : "those cycles"} had no session`,
    },
    {
      // The stretch sub-count tells one operation holding twenty
      // boundaries apart from twenty operations each holding one -- a mode
      // that has stopped delivering per-cycle sessions vs. one that is
      // working -- so it is stated only when it says something the
      // boundary count does not.
      count: heldBoundaries,
      line: (count) => {
        const summary =
          `the connection-per-poll release held the SFTP session at ` +
          `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
          `this exchange (not a dropped session): an operation this side ` +
          `had issued was still unsettled, so the session stayed live ` +
          `across ${count === 1 ? "that idle gap" : "those idle gaps"}`;
        return heldStretches < count
          ? `${summary}, in ${heldStretches} unbroken ` +
              `${heldStretches === 1 ? "stretch" : "stretches"}`
          : summary;
      },
    },
  ];
  for (const { count, line } of perCycleOutcomes)
    if (count > 0) log.info(line(count));
}

/**
 * What an online `alcove invite` or `alcove accept` passes {@link runProtocol}:
 * the configuration it writes or keeps, and the step that writes it.
 */
export interface OnlineSetup extends OnlineSetupConfiguration {
  /**
   * Writes the configuration, or refreshes the one kept. Called at most once,
   * after the terms exchange and the checks after it have passed, and before
   * any linkage key or payload row moves.
   */
  readonly writeConfig: () => void | Promise<void>;
}

/**
 * The one argument {@link runProtocol} takes. Every field it needs is named
 * here rather than passed by position, so a caller supplying only some of the
 * optional inputs states which ones it means.
 */
export interface RunProtocolOptions {
  /** The transport this exchange runs over. */
  connection: ProtocolConnectionConfig;
  /**
   * The shared secret and its key file, or `null` to run unauthenticated.
   * There is no `undefined` state: every caller states which it means.
   */
  auth: AuthPersist | null;
  /** This party's standardized dataset and the terms it was prepared under. */
  prepared: PreparedExchange;
  /**
   * Where to write the result CSV; `undefined` writes it to stdout. There is
   * no omitted state: every caller states which it means.
   */
  output: string | undefined;
  /**
   * The field delimiter this party's result CSV is written with -- the one its
   * input was read by. Omit it to write commas.
   */
  csvDelimiter?: string;
  /** The `-v` count, forwarded to the transport's own diagnostics. */
  verbosity: number;
  /** The name of the logger this run's diagnostics are written through. */
  loggerName: string;
  /**
   * The `--log-file` path this run's diagnostics were redirected to (the value
   * the caller handed `configureLogging`), or `undefined` when they go to
   * stderr. Read only by the PSI progress display, which draws its live line on
   * a terminal whose diagnostics it shares and nowhere else.
   */
  logFile?: string;
  /** Whether to write the exchange record, in the run's folder; omit to skip
   * recording. */
  writeRecord?: boolean;
  /** This party's zero-setup `--save` intent. Meaningful only with `auth: null`. */
  saveIntent?: boolean;
  /**
   * The online invite or accept's configuration and the step that writes it.
   * Meaningful only on the authenticated path.
   */
  onlineSetup?: OnlineSetup;
  /** The file-sync entry-sweep controls, event stream, and output hook. */
  fileSyncRuntime?: FileSyncRuntimeOptions;
  /** The signed-receipt inputs; omit or pass `null` to skip signing. */
  signing?: SigningPersist | null;
  /**
   * Records the `payload.receive` a run fills from the partner's declared
   * send set, where the terms leave it unset (`onPayloadReceiveFilled` in
   * `@alcove/core`): the caller writes it into the configuration the run
   * governs. Called at the terms exchange, before any key or payload moves; a
   * throw stops the run. Omit it on a run with no configuration to record
   * into, which then accepts whatever the partner sends.
   */
  recordPayloadReceiveFill?: (columns: string[]) => void | Promise<void>;
  /**
   * Reports the fill once `recordPayloadReceiveFill` has recorded it, in
   * place of the info-level {@link payloadReceiveFilledNotice} logged when
   * this is omitted.
   */
  payloadReceiveFillNotice?: (columns: string[]) => void;
  /**
   * Asks whether to take the payload columns the partner's terms declare it
   * sends, on a run holding no list of the columns it receives
   * (`onPayloadReceiveFill` in `@alcove/core`): accepting takes them, and
   * `recordPayloadReceiveFill` then records them; a decline ends the run on
   * its refusal. Called before any key or payload moves. Omit it on an
   * unattended run, which takes them without asking.
   */
  onPayloadReceiveFill?: (
    columns: string[],
  ) => Promise<PayloadReceiveFillAnswer>;
  /**
   * Settles partner terms that differ from this party's at the terms
   * exchange (`onTermsChange` in `@alcove/core`): resolving takes them on and
   * continues the run, a throw refuses. Called before any key or payload
   * moves. Omit it on a run with no configuration to record into, which then
   * refuses every difference.
   */
  onTermsChange?: (change: TermsChange) => Promise<void>;
  /**
   * Whether a caller's own {@link preflightRun} call already emitted
   * {@link SIGNING_WITHOUT_RECORD_WARNING} for this run
   * ({@link PreflightRunResult.signingWithoutRecordWarned}), so
   * `runProtocol`'s own pass does not repeat it. Omit when the caller did not
   * run `preflightRun`.
   */
  signingWithoutRecordWarned?: boolean;
  /**
   * Whether the caller already emitted {@link undeclaredColumnsNotice} for
   * this run, through {@link preflightRun}
   * ({@link PreflightRunResult.undeclaredColumnsWarned}) or its own
   * {@link warnUndeclaredColumns} call, so `runProtocol`'s own pass does not
   * repeat it. Omit when the caller did neither.
   */
  undeclaredColumnsWarned?: boolean;
  /**
   * `--allow-memory-shortfall`: warn rather than refuse a run whose PSI round
   * needs more memory than the process has ({@link checkRunMemoryBudget}).
   */
  allowMemoryShortfall?: boolean;
  /**
   * Whether the caller already ran {@link checkRunMemoryBudget} for this run,
   * through {@link preflightRun}
   * ({@link PreflightRunResult.memoryBudgetReported}) or its own call, so
   * `runProtocol`'s own pass does not repeat it. Omit when the caller did
   * neither.
   */
  memoryBudgetReported?: boolean;
  /**
   * Writes the line a completed run ends with ({@link describeExchangeOutcome}):
   * a command passes its unfiltered writer so the line reaches the operator at
   * every `--log-level` but `silent`. Omit it to log the line at info level.
   */
  writeOutcomeLine?: (line: string) => void;
  /**
   * Which flag bounds this run's wait for the partner, named in the remedy a
   * no-show failure is shown with ({@link markArrivalWait}). Omit it for a run
   * bounded by `--peer-timeout`.
   */
  arrivalWait?: ArrivalWait;
  /**
   * Called once, on a webrtc connection, when the coordination server first
   * accepts this party's registration; never on the file-sync channels. An
   * online invite prints its invitation here.
   */
  onSignalingRegistered?: () => void;
}

/**
 * Runs the PSI protocol over an SFTP, file-drop, or WebRTC connection and
 * writes results to output. Authentication is supplied on the separate
 * {@link RunProtocolOptions.auth} field, not embedded in `connection`.
 *
 * When `auth` is an {@link AuthPersist}, `keyFilePath` must be a non-empty,
 * non-whitespace string, checked before any credential is presented so a
 * whitespace-only path cannot silently create a file named " " in the
 * current directory. `sharedSecret` is validated by
 * {@link authenticateConnection} after the connection opens; `keyFilePath` is
 * checked only for non-emptiness, and an invalid path is caught with a plain
 * OS error at the key-file write step.
 *
 * When `auth` is `null` the exchange runs without authentication -- the path
 * for callers (e.g. zero-setup) that explicitly accept transport-layer
 * security only. The parameter has no `undefined` state: every caller passes
 * `AuthPersist` to authenticate or `null` to opt out.
 *
 * When `writeRecord` is true, the self-attested exchange record and its
 * private verification keys are written in the run's folder after the results
 * (non-fatal on failure; see {@link writeExchangeRecord}); omit it to skip
 * recording. A record that was asked for and could not be produced never
 * fails the exchange but is reported: a `warning` event on the
 * machine-interface stream and `PERSISTENCE_LOSS_EXIT_CODE`, so an
 * unattended run is not treated as a clean success or retried as a
 * transport failure.
 *
 * `saveIntent` holds this party's zero-setup `--save` intent for the
 * exchange's in-band bootstrap (see {@link runExchange}). Omit it on every
 * authenticated path; pass a boolean only from the
 * zero-setup command, whose `onOutputComplete` hook then reads
 * {@link OutputCompleteContext.bootstrap} to provision the saved
 * config/key. Meaningful only with `auth: null`.
 *
 * `onlineSetup` is the online invite/accept's configuration step: its
 * {@link OnlineSetup.writeConfig} is invoked at most once, on the
 * authenticated path only, once this side's terms exchange and the checks
 * after it have passed -- so after the rotated token is saved to the key file
 * -- and before any linkage key or payload row moves, so a run whose exchange
 * fails after that still leaves both the rotated key and the configuration on
 * disk. A run that ends before then, refused or failed, never reaches it
 * (protocol.test.ts, "the configuration step runs after the terms exchange,
 * not at the key-file save"), nor does one a signal reached first. It may be
 * synchronous or async; a returned promise settles before the exchange
 * continues. A failure is non-fatal -- the data exchange must not be aborted
 * by a failure to persist recoverable config -- and is logged at error level,
 * reported as a persistence loss (`warning` event and
 * `PERSISTENCE_LOSS_EXIT_CODE`), and returned on
 * {@link RunProtocolResult.configWriteError}. A run that saved its rotated key
 * file and stopped before the step, or after it failed to write the
 * configuration, states the step for that state
 * ({@link keyFileSavedConfigNotWrittenRemedy}): on the error it rejects with,
 * which the command boundary renders, or from the signal handler on an
 * interrupt. A run that stopped before saving its key file, where its partner
 * may have saved the next secret, states {@link keyFileNotSavedRemedy}. Omit
 * it on the no-auth path and from every other caller; passing it with
 * `auth: null` is rejected up front, since an unauthenticated exchange has no
 * acceptance step.
 *
 * `fileSyncRuntime` holds the CLI-only, non-persistable file-sync
 * entry-sweep controls (`--sweep-exchange-files` / `--force-retain-sweep`)
 * passed straight to the {@link FileSyncConnection} constructor, bypassing
 * config construction so they can never be persisted to alcove.yaml.
 * Defaults to `{}` (no sweep) and is inert on any non-file-sync transport.
 * Also holds the run's machine-interface stream and the caller's
 * pre-terminal {@link FileSyncRuntimeOptions.onOutputComplete} hook.
 *
 * `signing` holds the signed-receipt inputs (this party's signing identity,
 * the pinned partner fingerprint, and where to write the signed
 * receipt). Pass `null` (the default) to skip signing. Runs only on the
 * authenticated path, the only one holding the session key the receipt
 * binder needs; a non-null `signing` on the unauthenticated (`auth: null`)
 * path is rejected up front. A non-null `signing` without `writeRecord` is
 * permitted and warned about ({@link SIGNING_WITHOUT_RECORD_WARNING}), not
 * refused.
 */
export async function runProtocol(
  options: RunProtocolOptions,
): Promise<RunProtocolResult> {
  const {
    connection,
    auth,
    prepared,
    output,
    csvDelimiter,
    verbosity,
    loggerName,
    logFile,
    writeRecord = false,
    saveIntent,
    onlineSetup,
    fileSyncRuntime = {},
    signing = null,
    recordPayloadReceiveFill,
    payloadReceiveFillNotice,
    onPayloadReceiveFill,
    onTermsChange,
    signingWithoutRecordWarned = false,
    undeclaredColumnsWarned = false,
    allowMemoryShortfall = false,
    memoryBudgetReported = false,
    arrivalWait = "exchange",
    onSignalingRegistered,
  } = options;
  const log = getLogger(loggerName);
  const writeOutcomeLine =
    options.writeOutcomeLine ?? ((line: string) => log.info(line));

  // The opt-in machine-interface emitter (fd-3 NDJSON), constructed only under
  // --event-stream; undefined otherwise, so no line is ever written to fd 3
  // and `emit` below is a no-op. Fails closed and loud FIRST, before any
  // other exchange work: if the flag was given but fd 3 is not wired, this
  // throws a UsageError (exit 64) here rather than dropping events or
  // crashing on the first write. A caller that opened the stream itself
  // passes the emitter instead, having taken the same preflight at its own
  // construction (openEventStream).
  const eventStream =
    typeof fileSyncRuntime.eventStream === "object"
      ? fileSyncRuntime.eventStream
      : openEventStream(fileSyncRuntime.eventStream);

  // Best-effort: a failure to probe the runtime warns and is swallowed, never
  // aborting the exchange.
  logRuntimeEnv(log);
  const emit = (fn: (e: EventStreamEmitter) => void): void => {
    if (eventStream !== undefined) fn(eventStream);
  };
  // The lifecycle phase a terminal event is classified against, advancing with
  // the run: everything through the handshake is "prepare", the PSI exchange
  // is "run", and local result/record generation after is "output". One
  // terminal event fires per run, from exactly one of the two catch
  // boundaries below.
  let terminalPhase: ErrorPhase = "prepare";

  // What the preparation stage builds, held in one object rather than five
  // hoisted bindings so that stage can fill it in place: a throw partway
  // through still leaves the terminal metrics event the client's counters, and
  // the cleanup below closes whatever was constructed. Each field stays
  // undefined until its stage assigns it, and the webrtc channel has no client
  // or file-sync connection to assign at all.
  const build: PreparedTransport = {};

  const stageTimer = createStageTimer(emit);

  // The PSI phase's progress display: a live line on the terminal while one
  // crypto operation runs, and one logged line per operation that completes.
  // Closed by doCleanup -- an interrupt included -- so no half-drawn line is
  // left on the terminal the run's last message goes to.
  const psiProgress = createPsiProgressDisplay({
    statusLine: terminalPsiStatusLine({ verbosity, logFile }),
    clearBeforeLogLine: runBeforeEachLogLine,
    milestone: (line) => log.info(line),
  });

  // The one operational-counter summary, emitted immediately before each
  // terminal event so the terminal event stays last on the stream. recordsProcessed
  // is this party's own input row count; the retry/reconnect counts are read from
  // the transport client's existing loops -- all this party's own integers, never
  // partner-controlled. A `--log-file` that lost lines is reported beside it,
  // for the same reason: the terminal event must stay last.
  const emitMetrics = (): void =>
    emitRunMetrics(eventStream, prepared.rowCount, build.client);
  // The prepare block. Its throw sites -- channel/caller-contract guards, the
  // shared-secret readiness check, the key-file-path preflight, and
  // client/connection/bridge construction -- all run before the main try
  // below; this catch and the main try's catch are the two disjoint
  // terminal-error-emission sites (phase "prepare" here), so exactly one
  // terminal event fires per run. A run preflightRun refuses emits from there
  // and never reaches this function.
  try {
    await prepareTransport(build, {
      connection,
      prepared,
      output,
      auth,
      saveIntent,
      onlineSetup,
      signing,
      writeRecord,
      signingWithoutRecordWarned,
      undeclaredColumnsWarned,
      allowMemoryShortfall,
      memoryBudgetReported,
      verbosity,
      logFile,
      fileSyncRuntime,
      log,
      emit,
    });
  } catch (err) {
    emitMetrics();
    emit((e) => e.error(err, "prepare"));
    throw err;
  }

  // SIGINT/SIGTERM handlers and the finally block share this closure so that
  // stop/cleanup/close run at most once, guarded by `cleaned`. Signal
  // handlers deregister only after cleanup completes, so a signal arriving
  // mid-cleanup still hits a handler (which returns via the guard and calls
  // process.exit) rather than Node's default immediate termination. All
  // three are function declarations so they can reference each other freely.
  //
  // No conn.on("error", ...) listener is installed at this layer: synchronous
  // transport failures (open/synchronize) throw directly, and asynchronous
  // poll() errors are observed by the permanent data/error listeners the
  // fromEventConnection bridge attaches for the connection's whole lifetime,
  // appearing at the protocol layer's awaited receive() calls.
  let cleaned = false;
  const run: RunLifecycle = {
    opened: false,
    started: false,
    secure: undefined,
    sessionKeyForReceipt: undefined,
    negotiatedProtocolVersion: undefined,
    authStarted: false,
    handshakeRole: undefined,
    partnerMayHoldNextSecret: false,
    rotationStoreBegan: false,
    tokenRotated: false,
    rotation: undefined,
    exchangeComplete: false,
    outputsWritten: false,
    signalReceived: undefined,
    configWriteError: undefined,
    configWriteStarted: false,
  };
  // Cancels work still in flight when a signal arrives, which doCleanup
  // cannot reach: it closes what the run already holds, and a webrtc
  // rendezvous holds its broker socket and half-negotiated peer connection
  // inside the dial until that dial settles. Without this, an interrupt
  // would leave both standing for the rest of the rendezvous budget.
  // Aborted only from a signal handler; ordinary teardown is doCleanup's own
  // closes.
  const interrupted = new AbortController();
  async function doCleanup() {
    if (cleaned) return;
    cleaned = true;
    psiProgress.close();
    // The handlers come off in the finally: the guard above makes cleanup
    // single-entry, so a close that throws past its own per-layer catch would
    // otherwise leave a finished run's SIGINT and SIGTERM handlers installed
    // with nothing left to remove them, and they accumulate where a caller
    // drives runProtocol in-process.
    try {
      const teardown = await closeRunLayers({
        build,
        run,
        log,
        ceilingMs: transportTeardownCeilingMs(connection.channel),
      });
      // The one bounded obligation reached its bound. Cleanup runs after the
      // terminal event, so this goes to the operator log alone -- at error
      // level, the one level an unattended run is certain to keep -- and never
      // to the machine-interface stream, which a consumer may stop reading at
      // the terminal event. It changes no exit code: the teardown is
      // housekeeping, and a supervisor that saw the status move would retry a
      // run that already disclosed.
      if (!teardown.finished)
        log.error(
          teardownCeilingNotice(teardown, {
            channel: connection.channel,
            retainFiles:
              connection.channel !== "webrtc" &&
              connection.options?.retainFiles === true,
            outputsWritten: run.outputsWritten,
          }),
        );
      logTransportCounters(build.client, log);
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      // Undo our own contribution to the max-listeners threshold rather than
      // decrementing from whatever it is now: if another module (or a
      // parallel runProtocol) mutated the threshold in between, decrementing
      // from the current value would walk the baseline off by +/-2 each
      // cleanup cycle. Restoring the captured value verbatim leaves any
      // external adjustment intact and undoes only our own +2.
      if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners);
    }
  }
  // The try/catch/finally in each handler ensures process.exit always runs,
  // and that a rejection from doCleanup (an uncaught throw added later)
  // never appears as an unhandled promise rejection, which
  // process.on("SIGINT") would otherwise silently discard.
  // SIGINT and SIGTERM share one helper, reading the same state the catch
  // block reads (keyFileSavedConfigNotWritten, then rotationStanding); a run
  // that rotated nobody states nothing.
  function logRotationStateOnInterrupt(reason: string): void {
    const setup = keyFileSavedConfigNotWritten(
      run,
      build.trimmedKeyFilePath,
      onlineSetup,
    );
    if (setup !== undefined) {
      log.warn(
        keyFileSavedConfigNotWrittenRemedy(setup, { kind: "interrupted" }),
      );
      return;
    }
    const saved = `The shared secret was already rotated and saved before ${reason}.`;
    switch (rotationStanding(run)) {
      case "unchanged":
        return;
      case "partner-may-lead":
        if (onlineSetup !== undefined) {
          log.warn(keyFileNotSavedRemedy({ kind: "interrupted" }));
          return;
        }
        log.warn(
          `This side had not saved the next shared secret when ${reason}, ` +
            "and your partner may already have saved it. Retry the exchange " +
            "with the existing key file; if authentication fails on retry, " +
            "ask your partner for a new invitation.",
        );
        return;
      case "partner-may-lag":
        log.warn(
          `${saved} Retry with the same key file; if authentication fails ` +
            "on retry, ask your partner for a new invitation.",
        );
        return;
      case "both-stored":
        log.warn(
          `${saved} Your partner saved it too, so retry with the same key file.`,
        );
        return;
    }
  }
  const psiWorkerExitWait: PsiWorkerExitWaitOptions = {
    announce: (line) => log.info(line),
    exitAtOnce: (signal) =>
      process.exit(
        signal === "SIGINT" ? INTERRUPTED_EXIT_CODE : TERMINATED_EXIT_CODE,
      ),
  };
  async function onSigint(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    run.signalReceived = "SIGINT";
    // This handler ends the process, at 130 below. The catch returns normally
    // on a signal, so the command promise settles while the teardown here is
    // still running, and nothing else may exit on that settlement.
    noteSignalOwnsExit();
    // Synchronous too, and before the cleanup it cannot substitute for: an
    // in-flight rendezvous tears itself down on this rather than on doCleanup.
    interrupted.abort();
    // Before the first line of the interrupt: the live progress line holds the
    // cursor mid-row, so dropping it here is what puts the lines below on rows
    // of their own. doCleanup closes it again, idempotently.
    psiProgress.close();
    try {
      log.info("caught SIGINT, exiting");
      offerExitAtOnceWhilePsiWorkersStop(psiWorkerExitWait);
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug("onSigint cleanup threw:", sanitizeErrorForDisplay(cleanupErr));
    } finally {
      // Exiting while the PSI worker is inside a native masking call aborts
      // the process instead of exiting 130.
      await stopPsiWorkersBeforeExit(psiWorkerExitWait);
      // 128 + 2 (SIGINT): conventional exit code for a process interrupted
      // by SIGINT, distinguishable from a clean exit (0) or an error (69).
      process.exit(INTERRUPTED_EXIT_CODE);
    }
  }
  async function onSigterm(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    run.signalReceived = "SIGTERM";
    // As in onSigint: the exit at 143 below is this handler's, and the
    // command promise settles before it is reached.
    noteSignalOwnsExit();
    interrupted.abort();
    // The live line is dropped before the first interrupt line, as in onSigint.
    psiProgress.close();
    try {
      log.info("caught SIGTERM, exiting");
      offerExitAtOnceWhilePsiWorkersStop(psiWorkerExitWait);
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "onSigterm cleanup threw:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    } finally {
      await stopPsiWorkersBeforeExit(psiWorkerExitWait);
      // 128 + 15 (SIGTERM): conventional exit code for a process terminated by
      // SIGTERM, distinguishable from a clean exit (0) or an error exit (69).
      process.exit(TERMINATED_EXIT_CODE);
    }
  }

  // Each runProtocol call adds two process-level listeners (SIGINT +
  // SIGTERM). Increment the max-listener threshold for this call's
  // duration so concurrent invocations (e.g. two-party integration tests)
  // do not trigger MaxListenersExceededWarning; doCleanup restores the
  // captured baseline so a concurrent module adjusting the threshold
  // separately is not disturbed. 0 means "unlimited"; left unchanged then.
  const prevMaxListeners = process.getMaxListeners();
  const maxListenersIncremented = prevMaxListeners !== 0;
  if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners + 2);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const nextRunHeals =
    nextRunCanHeal(connection.channel) && auth?.saveKeyFileExclusively !== true;
  try {
    const role = await openRunTransport({
      build,
      run,
      connection,
      interrupted,
      log,
      emit,
      onSignalingRegistered,
    });

    // Set by the prepare block on the file-sync channels and by the rendezvous
    // above on webrtc; either way the exchange has a transport to run over.
    if (build.transport === undefined)
      throw new InternalConsistencyError(
        "no transport was established for this exchange",
      );
    const mc = build.transport;

    if (auth) {
      await authenticateRun({
        build,
        run,
        mc,
        auth,
        role,
        log,
        eventStream,
        nextRunHeals,
      });
    }

    // Select the PSI crypto backend: the CLI runs under Node, so it prefers the
    // native addon and falls back to WASM when no prebuild ships for this
    // platform.
    const { library: psiLibrary, backend: psiBackend } =
      await loadCliPsiBackend({
        onNativeUnavailable: ({ error }) => {
          if (error) {
            // A prebuild for this platform loaded far enough to fail -- an ABI or
            // libc mismatch (e.g. ERR_DLOPEN_FAILED from a glibc-linked addon on
            // musl, or a host glibc older than the prebuild requires). The native
            // accelerator is silently off when we expected it on, so warn; the
            // ordinary "no prebuild ships for this platform" case stays at debug.
            log.warn(
              "native PSI addon failed to load, using WASM:",
              sanitizeErrorForDisplay(error),
            );
          } else {
            log.debug(
              "native PSI addon unavailable (no prebuild for this platform), using WASM",
            );
          }
        },
      });
    log.debug(`PSI crypto backend: ${psiBackend}`);

    const outcome = await runExchangeStage({
      build,
      run,
      mc,
      role,
      prepared,
      psiLibrary,
      verbosity,
      saveIntent,
      signing,
      recordPayloadReceiveFill,
      payloadReceiveFillNotice,
      onPayloadReceiveFill,
      onTermsChange,
      onTermsExchanged:
        auth && onlineSetup !== undefined
          ? () =>
              runConfigWrite({
                writeConfig: onlineSetup.writeConfig,
                run,
                log,
                eventStream,
              })
          : undefined,
      writeRecord,
      allowMemoryShortfall,
      stageTimer,
      psiProgress,
      onRunPhase: () => {
        terminalPhase = "run";
      },
      log,
      emit,
    });

    // The two-party exchange is complete: runExchange has returned, so this
    // side has received everything and already sent the peer its terminal
    // payload (durable before runExchange resolved). Mark it so the
    // catch's abort-marker gate excludes a failure in the purely-local
    // output stage below: a fault there must not write a cross-party
    // abort marker telling a peer whose exchange succeeded to fail fast --
    // at worst an exit-76 PeerAbortError while its results sit readable on
    // disk. (sealAbort does not help here: it resolves the decision for
    // close(), but writeAbortMarker writes regardless, and the gate keys
    // on abortArmed, still true.)
    run.exchangeComplete = true;
    // The last PSI stage completed when runExchange returned; emit its duration
    // before the terminal event. The output stage below is local I/O, not a named
    // protocol stage, so it is not timed here.
    stageTimer.close();
    // From here on any failure is a purely-local "output"-stage fault (result CSV
    // or audit record), never a run fault: the exchange already succeeded and the
    // operator must not re-run it, so the catch classifies it as "output".
    terminalPhase = "output";

    const { entityClusters, matching } = outcome;
    const delivered = await writeExchangeOutputs({
      outcome,
      prepared,
      output,
      csvDelimiter,
      writeRecord,
      signing,
      loggerName,
      log,
      eventStream,
      onOutputComplete: fileSyncRuntime.onOutputComplete,
      onRemoteFollowUp: fileSyncRuntime.onRemoteFollowUp,
    });
    run.outputsWritten = delivered.everyArtifactOnDisk;

    // configWriteError is set only when the configuration step failed but
    // the exchange above still succeeded (a step failure followed by an
    // exchange failure rethrows from the catch below instead).
    //
    // The single success terminal event: the exchange completed and the
    // local output stage finished, so exactly one terminal event has now
    // fired. resultWritten is false for a helper whose agreed terms give
    // it no output table and for a count-only exchange, true when a
    // result CSV was produced. The count rides the same event so the two
    // resultWritten:false outcomes stay distinguishable to a supervisor
    // reading only fd 3, and it states the same trust posture (partner-
    // vs. self-reported) the human line does. What the agreed deduplicate
    // pair resolved to rides it for the same reason: the line stating it
    // is an info line, unread on fd 3 alone or at a quieter log level. The
    // entity-cluster summary the output stage logged above rides it on that
    // same footing.
    // The metrics summary precedes it so the terminal event stays last.
    //
    // Both are emitted before cleanup: every local artifact the run owes was
    // written above, or its loss reported there, so the outcome is decided,
    // and a consumer of this stream learns it without waiting on a close that
    // may run to its ceiling. The transport is torn down after, and what that
    // costs goes to the operator log alone.
    emitMetrics();
    const { result } = delivered;
    emit((e) =>
      e.result(
        matching,
        result.kind === "count"
          ? {
              intersectionCount: result.intersectionCount,
              reportedByPartner: result.reportedByPartner,
            }
          : undefined,
        entityClusters,
        result.kind === "file" || result.kind === "stdout"
          ? {
              matchedRows: result.matchedRows,
              ...(result.kind === "file" && { resultPath: result.path }),
            }
          : undefined,
      ),
    );
    // A close that throws past its own per-layer catch is logged at debug, as
    // the failure path below does with it: the run's result, record and
    // receipt are on disk and its outcome is already on the stream, so a
    // teardown fault must not become the run's own. The finally below
    // re-enters doCleanup and returns at its guard.
    try {
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "cleanup threw after the run completed:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    }
    const noMatch = zeroMatchWarning(delivered.result);
    if (noMatch !== undefined) log.warn(noMatch);
    writeOutcomeLine(
      describeExchangeOutcome({
        result: delivered.result,
        record: delivered.record,
        rotatedKeyFilePath:
          run.tokenRotated && build.trimmedKeyFilePath !== undefined
            ? path.resolve(build.trimmedKeyFilePath)
            : undefined,
      }),
    );
    return {
      outcome: "completed",
      configWriteError: run.configWriteError,
    };
  } catch (err) {
    // What the run reports and exits on. The partner's abort stays `err` for
    // what reads the abort itself: the echo gate and the disclosed record.
    const reported =
      partnerSaveFailure(err, run, build.trimmedKeyFilePath, nextRunHeals) ??
      err;
    // A run whose key file was there before it started may hold an older copy.
    markArrivalWait(err, arrivalWait, {
      fromKeyFile:
        auth !== null &&
        auth.saveKeyFileExclusively !== true &&
        auth.keyFileWrittenThisRun !== true,
    });
    // Only the online invite and accept pass an online setup.
    markTermsRefusalRun(
      err,
      auth === null
        ? "quick-exchange"
        : onlineSetup === undefined
          ? "configured"
          : "online-invitation",
    );
    // The rotation line below states what the store order leaves the two
    // parties holding (rotationStanding), at error level because the
    // exchange is failing. A new invitation is named only where the two may
    // now hold different secrets; a run that rotated nobody states nothing.
    // An error marked as stating its own next step (statesItsOwnNextStep)
    // already states the step for its fault, so the line is skipped rather
    // than printed beneath a step it contradicts. Marked wherever that
    // holds: the saveKeyFile-failure path, authenticateConnection's own
    // validation errors and the terms exchange's expiry refusal (see
    // auth.ts and protocolSetup.ts), and core's terminal transport
    // refusals. For an unmarked internal fault or partner refusal the
    // command boundary shows its fixed step (fixedNextStep), which rules
    // out a retry, so the line states the token state without prescribing
    // one. An authentication failure (exit 77) rules out a retry too, but no
    // fixed step prints beneath it, so its line states the step.

    // Walks the `cause` chain for a PeerAbortError, so the echo gate below
    // still recognizes one even behind a future wrap. The critical
    // barrier is actually the sticky first-error latch in the bridge and
    // AEAD layers (a later admin-induced error cannot supersede the
    // PeerAbortError that reaches here); this cause-walk is cheap
    // insurance.
    const errIsPeerAbort = (e: unknown): boolean =>
      causeChainSome(e, (link) => link instanceof PeerAbortError);

    // Missing-receipt observability: this side configured a signed receipt
    // but the exchange failed before runExchange returned (exchangeComplete
    // false), not with a receipt verification error (a distinct security
    // event already reported by that error's own kind/message), and not with
    // this party's own local certificate/terms refusal (a config fault this
    // party's operator caused). A partner presenting no signing certificate,
    // or one this build cannot read, is refused at the terms exchange as a
    // receipt verification error, so what is left here is a run whose signed
    // path had no complaint of its own: the swap is the last step of
    // runExchange, and this side parks on that receive until the peer
    // timeout, a drop otherwise indistinguishable from generic peer-silence.
    // Walks the `cause` chain for a ReceiptVerificationError, so a future wrap
    // of the security failure cannot downgrade it to this softer warn.
    const isReceiptVerificationFailure = (e: unknown): boolean =>
      causeChainSome(e, (link) => link instanceof ReceiptVerificationError);
    // Class-exact, not the UsageError superclass OperatorConfigError itself
    // extends: a different usage fault mid-exchange still warrants the
    // advisory, so only this exact class is excluded. Walks the `cause` chain
    // for the same forward-compatibility reason as
    // isReceiptVerificationFailure above.
    const isLocalConfigRefusal = (e: unknown): boolean =>
      causeChainSome(e, (link) => link.constructor === OperatorConfigError);
    if (
      signing !== null &&
      !run.exchangeComplete &&
      !isReceiptVerificationFailure(err) &&
      !isLocalConfigRefusal(err)
    )
      log.warn(
        "A signed receipt was configured for this exchange, but no receipt " +
          "reached this side before the exchange ended and the receipt swap " +
          "did not complete. A partner that presents no signing certificate " +
          "is refused earlier, at the authenticated setup step, so check the " +
          "transport and the peer's own logs rather than the partner's " +
          "signing configuration. If the peer was still working when the " +
          `exchange ended, ${raiseInactivityLimit(false)}.`,
      );

    // The disclosure a terminated run already made outlives the failure that
    // stopped it: a run past its own payload send has handed this party's payload
    // to the transport, so core hands the self-attested record of that
    // disclosure back on the error rather than discarding it
    // (docs/spec/PROTOCOL.md, Self-attested record). It is written here on the
    // same terms a completed run's is -- same destination, same owner-only pair
    // -- because it is the same kind of artifact; what marks it as a terminated
    // run's is the record's own outcome field, which travels with the file
    // wherever it is copied.
    // Skipped under --no-record, like every other record write.
    const disclosedRecord = exchangeRecordFromFailure(err);
    if (writeRecord) {
      // Reported on the stream but NOT as a persistence loss: that class is
      // a completed run's lost local write, and its exit code exists to
      // tell a supervisor not to re-run. This run failed and keeps its own
      // exit code, which a persistence-loss stamp would overwrite with the
      // opposite advice. Both losses take that same disposition: a record
      // that could not be written, and one core could not build for a
      // disclosure it made -- which core warns about on the operator log, a
      // channel an unattended run discards, so the stream states it too.
      // The completed path reports the same pair through missingArtifacts
      // above.
      if (disclosedRecord !== undefined) {
        const written = writeExchangeRecord(
          runArtifactFolder(output),
          disclosedRecord.record,
          disclosedRecord.keys,
          loggerName,
          disclosedRecord.agreedTerms,
        );
        if (written.kind === "failed")
          emit((e) => e.warning("terminatedRunRecord", written.message));
      } else if (exchangeRecordOwedButUnbuilt(err)) {
        emit((e) =>
          e.warning("terminatedRunRecord", TERMINATED_RECORD_UNBUILT_WARNING),
        );
      }
    }

    // Core tags the rendezvous peer-wait and key-exchange handshake timeouts
    // (see markPeerWaitTimeout), so every fact this inference rests on is local
    // to the run in hand. The tag is also what excludes the sweep's own "may be
    // partially swept" failure: that error is raised from inside the same
    // synchronize() call, so "failed during synchronization" does not
    // distinguish the two, but it is not a peer-wait timeout and is never
    // tagged.
    //
    // Emitted before the rotation line below rather than instead of it. A
    // peer-wait or key-exchange timeout comes before either side can store,
    // so no rotation line follows it today; the order puts the specific
    // likely cause first if one does.
    if (
      connection.channel !== "webrtc" &&
      fileSyncRuntime.sweepExchangeFiles === true &&
      connection.options?.retainFiles !== true &&
      isPeerWaitTimeout(err)
    )
      log.error(BOTH_SWEPT_GUIDANCE);

    const hintAlreadyEmitted = statesItsOwnNextStep(reported);
    const authenticationFailed =
      exitCodeForError(reported) === AUTHENTICATION_FAILED_EXIT_CODE;
    const retryRuledOut =
      hintAlreadyEmitted ||
      authenticationFailed ||
      fixedNextStep(reported) !== undefined;
    run.rotation?.release();
    const standing = rotationStanding(run);
    // A responder that wrote its marker and then reached the terms exchange,
    // where the run ended with neither side able to have stored, has nothing
    // for the next run to report.
    if (
      standing === "unchanged" &&
      run.handshakeRole === "responder" &&
      run.rotation !== undefined &&
      auth !== null &&
      build.trimmedKeyFilePath !== undefined
    )
      clearRotationInFlightMarker(
        build.trimmedKeyFilePath,
        auth.sharedSecret,
        log,
      );
    // An online setup that saved its key file and wrote no configuration
    // gets the step for that state instead of a rotation line: the
    // command boundary renders it beneath this error, and on a signal the
    // handler has already stated it.
    const setup = keyFileSavedConfigNotWritten(
      run,
      build.trimmedKeyFilePath,
      onlineSetup,
    );
    if (setup !== undefined) markKeyFileSavedConfigNotWritten(reported, setup);
    else if (!hintAlreadyEmitted) {
      const rotationLine =
        standing === "unchanged" && run.authStarted && authenticationFailed
          ? "Authentication failed, and a retry with this key file fails " +
            `the same way. ${NEW_INVITATION_REMEDY} ` +
            "If the SFTP server's host key is not the pinned one, " +
            "confirm the server's key with its administrator and pin " +
            "that key instead."
          : standing === "partner-may-lead" && onlineSetup !== undefined
            ? keyFileNotSavedRemedy({
                kind: "failed",
                errorStatesItsStep: retryRuledOut,
              })
            : rotationLineAfterFailure(standing, retryRuledOut);
      if (rotationLine !== undefined) log.error(rotationLine);
    }
    // If a signal handler is mid-cleanup, it owns the exit code (130/143).
    // Swallowing the error here resolves runProtocol normally so the CLI
    // handler does not race with its own process.exit(69). The signal
    // handler is still running asynchronously and will call process.exit
    // once its cleanup completes; the event loop stays alive until then
    // because the handler's awaited doCleanup is a pending Promise.
    //
    // The in-flight error may be caused by the signal-driven cleanup
    // itself (e.g. a poller rejecting because the connection was closed)
    // or it may be an unrelated protocol error that happened to coincide
    // with the signal. The two are not distinguishable here, so the error
    // is logged at error level rather than discarded silently: if it
    // holds diagnostic information about a real failure, the user sees
    // it even at a strict `--log-level=error` setting; if it is merely
    // cleanup noise, the surrounding "caught SIG..." context makes clear
    // the process is exiting on the signal regardless.
    // Authenticated cross-party abort marker: on a terminal organic fault
    // with the directory still writable, leave a signal so a waiting peer
    // fails fast instead of waiting out its full inactivity timeout. Gated to
    // fire only on a genuine fault: not on a signal interrupt (Ctrl-C
    // stays clean), and not on a PeerAbortError (the waiting party must
    // not echo a marker back). The await resolves the connection's abort
    // decision to "write", which a teardown close() parked on that
    // decision then awaits, so the marker lands before the shared
    // transport is ended. Best-effort -- a failed write leaves no marker
    // and the peer falls back to the hedge -- and placed before the
    // signalReceived early-return so a fault that coincides with a signal
    // still defers to the signal.
    //
    // Fires for every terminal post-arm fault, not only "pure" transport
    // faults: a post-arm UsageError (an over-cap inbound frame, a hostile
    // directory, a stalled server, a duplicate/malformed message) is just
    // as terminal and non-retryable, and a peer is waiting on it. Those
    // UsageErrors are peer- or environment-induced; the config-shaped
    // ones (token expiry, bilateral mode mismatch, not-clean directory)
    // are all detected pre-arm and never reach here armed. A failure in
    // the purely-local post-exchange output stage is excluded instead by
    // the exchangeComplete gate above.
    //
    // The marker holds no cause, so signalling on a UsageError discloses
    // nothing the peer's own view of the teardown would not: the local
    // party sees its specific error and exits 64, while the peer sees the
    // cause-free "peer aborted" and exits 76. The pre-arm/post-arm line is
    // principled: only post-arm does a session key (to authenticate the
    // marker) and a waiting post-handshake peer both exist.
    if (
      build.fileSync?.abortArmed === true &&
      !run.exchangeComplete &&
      run.signalReceived === undefined &&
      !errIsPeerAbort(err)
    ) {
      await build.fileSync.writeAbortMarker().catch(() => {
        /* best-effort; teardown proceeds regardless of write outcome */
      });
    }

    if (run.signalReceived !== undefined) {
      log.error(
        `error in flight when ${run.signalReceived} arrived: ` +
          sanitizeErrorForDisplay(reported),
      );
      // The run was cut short by a signal and the process is exiting.
      // Preserve configWriteError so a configuration-step failure recorded
      // before the signal is not silently dropped -- otherwise the caller
      // would treat the run as a clean config write.
      //
      // No terminal event is emitted here: a signal exits via the signal
      // handler's process.exit(130/143), which bypasses this catch, so a
      // supervisor reads "no terminal event plus exit 130/143" as the
      // interrupt (docs/spec/CLI_EVENTS.md). Both interrupt paths emit
      // nothing, so this in-flight-error subpath does not give an
      // inconsistent signal against the far more common clean interrupt.
      // test/unit/protocolInterruptEvents.test.ts drives a real interrupt
      // against a live fd-3 capture, holding that as a check rather than
      // prose.
      return {
        outcome: "interrupted",
        configWriteError: run.configWriteError,
      };
    }
    // The single failure terminal event for an organic (non-signal) fault,
    // classified against the phase the run reached: "output" once the exchange
    // completed, otherwise "run" or "prepare". Exactly one terminal event fires
    // per run, so this is the only error emission and it precedes the rethrow.
    // The metrics summary (with whatever counts the run accrued before the fault)
    // precedes it so the terminal event stays last on the stream.
    //
    // Both are emitted before cleanup, as on the success path above and after
    // the abort marker this catch may have written, so the fault reaches a
    // consumer without waiting on a close that may run to its ceiling. A close
    // that throws past its own per-layer catch is logged at debug, as the
    // interrupt paths do, rather than propagating: it must not displace the
    // original fault.
    emitMetrics();
    emit((e) => e.error(reported, terminalPhase));
    try {
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "cleanup threw during failure:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    }
    // The error is rethrown holding whatever exit code its own thrower
    // gave it, and nothing is stamped here: only the result-file write
    // above is the local write loss 73 names, while the rest of the
    // output stage -- core's refusal of a partner payload that does not
    // fit the association table -- is not. Those keep no code, and the
    // boundaries map their class to 76. The `output` category on the
    // terminal event stays the finer-grained discriminator for a
    // supervisor that reads fd 3, covering the whole stage either way.
    throw reported;
  } finally {
    await doCleanup();
  }
}
