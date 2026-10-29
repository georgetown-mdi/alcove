import { isDeepStrictEqual } from "node:util";

import { ZodError } from "zod";

import {
  MAX_ERROR_CAUSE_DEPTH,
  NestingDepthExceededError,
  NodeCountExceededError,
  errorWithPartnerCauseLinks,
  getLogger,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@alcove/core";
import { INTERNAL_FAULT_EXIT_CODE } from "@alcove/cli-contract";

import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";

import {
  CONFIGURATION_CHANGED_SAVE_REFUSAL,
  JOB_FILE_NAMES,
} from "@jobContract/intentSchemas";
import {
  runArtifactNames,
  stampOfResultPath,
} from "@jobContract/runArtifactNames";
import { ownRelayInvitationLocator } from "@jobContract/signalingServer";
import { zeroSetupSftpCheck } from "@jobContract/jobCreateRefusal";

import {
  zeroSetupFiledropArgv,
  zeroSetupOptionsArgv,
  zeroSetupSftpArgv,
} from "./intentArgv";

import {
  PARTNER_CERTIFICATE_PINNED_SOURCE,
  PARTNER_PIN_UNRECORDABLE_FAILURE,
  partnerCertificatePinnedNotice,
  recordedPartnerFingerprint,
} from "./partnerPinNotice";
import {
  WorkingFolderFilesRefusedError,
  createWorkingFolderExchangeFiles,
  invitationIdOf,
  removeUnchangedWorkingFolderExchangeFiles,
  setWorkingFolderAllowedRelays,
  workingFolderExchangeFileDigests,
  workingFolderExchangeFilePaths,
  workingFolderExchangeFilesMatch,
  workingFolderExchangeFilesPresent,
} from "./workingFolderExchangeFiles";
import {
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
  composeWebrtcConfigDocument,
} from "./intentConfig";
import { latestRunStampIn, runArtifactPaths } from "./runArtifacts";
import { readJobFolderContents } from "./jobFolder";
import { resolveAuthoredSignalingServer } from "./signalingServer";

import { JobInputNotFoundError, jobInputFilePath } from "./workInputs";
import {
  createWorkdir,
  generateJobId,
  jobFileExists,
  readRecordSummary,
  removeWorkdir,
  resolveWorkdir,
  resolveWorkdirFile,
  workdirDirectoryExists,
  writeJobFile,
} from "./workdir";
import {
  jobRendezvousLegs,
  rendezvousHoldsDirectory,
  rendezvousStartupWarnings,
} from "./jobRendezvous";

import {
  CONFIGURATION_CHANGED_SINCE_OPENED_MESSAGE,
  CONFIGURATION_IN_USE_MESSAGE,
  ConfigurationHandBackRefusedError,
  handBackMountedConfiguration,
} from "./configHandBack";
import {
  buildSynthesizedWarningEvent,
  resolveCliBinaryPath,
  spawnExchangeJob,
  spawnZeroSetupJob,
} from "./cliDriver";
import {
  mountedConfigurationUnchanged,
  mountedInPlaceConfiguration,
  openMountedConfiguration,
  signingPathSettings,
} from "./configLoad";
import {
  namesSigningIdentity,
  resolveSigningIdentityPath,
  runSigningFingerprint,
  signingCertificatePath,
  signingIdentityDirectory,
  signingIdentityExists,
  signingIdentityPath,
  signingIdentityTargetExists,
} from "./signingIdentity";
import { relayCheckOffer, runRelayCheck } from "./relayCheck";
import { buildJobHandoff } from "./handoff";
import { checkedMountedKeyFilePath } from "./mountedKeyFile";
import { consoleOwnedCredentialField } from "./consoleOwnedFiles";
import { formatFirstIssue } from "./schemaIssueMessage";
import { probeSftpHostKey } from "./sftpProbe";
import { referencedCredentialPaths } from "./referencedCredentialFiles";
import { removeSftpCredentialFile } from "./sftpScratch";
import { runTermsProposalApply } from "./termsProposal";
import { validateAuthoredSftpServer } from "./sftpServer";
import { withConsolePayloadReceiveTakenNotice } from "./payloadReceiveTakenNotice";

import type {
  CliDriverHandle,
  CliDriverHandlers,
  CliRunControls,
  CliRunDiagnostics,
  JobTerminalState,
} from "./cliDriver";
import type {
  JobConfigurationHandBack,
  JobCreateIntent,
  JobExchangeIntent,
  JobInputFileReference,
  JobSigningIdentityLocation,
  JobSigningPaths,
  JobWebrtcExchangeIntent,
} from "@jobContract/intentSchemas";

import type { TermsProposalApplyResult } from "./termsProposal";

import type {
  ExchangeFileDigests,
  ExchangeFilePaths,
} from "./workingFolderExchangeFiles";
import type { ExchangeRecordOutcome, PartnerOriginText } from "@alcove/core";
import type {
  JobSftpServerEntry,
  SftpConnectionProjection,
} from "@jobContract/sftpConnection";
import type {
  LoadedConfigurationResponse,
  OpenedMountedConfiguration,
} from "./configLoad";
import type { RelayCheckOffer, RelayCheckResult } from "./relayCheck";
import type { AuthoredSignalingServer } from "./signalingServer";
import type { CapturedChildStop } from "./capturedCliChild";
import type { JobFolderView } from "@jobContract/jobFolderContents";
import type { JobHandoff } from "@jobContract/jobHandoff";
import type { RecordUnavailableReason } from "@jobContract/recordUnavailableReason";
import type { RelayEvent } from "@jobContract/relayEvent";
import type { RendezvousLeg } from "./jobRendezvous";
import type { RunArtifactPaths } from "./runArtifacts";
import type { SftpProbeResult } from "./sftpProbe";
import type { SignalingServerProjection } from "@jobContract/signalingServer";
import type { SigningFingerprintResult } from "./signingIdentity";

/**
 * Thrown by {@link JobManager.createJob} when an sftp intent arrives but no
 * SFTP connection is authored. The route maps it to a 400, mirroring
 * {@link JobRendezvousUnavailableError}.
 */
export class SftpUnavailableError extends Error {
  constructor() {
    super("an sftp intent arrived but no connection is authored");
    this.name = "SftpUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a webrtc intent arrives but no
 * coordination server is authored. The route maps it to a 400.
 */
export class SignalingServerUnavailableError extends Error {
  constructor() {
    super("a webrtc intent arrived but no coordination server is authored");
    this.name = "SignalingServerUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a webrtc intent names a
 * coordination server other than the one the console holds, or names none
 * while the console holds one: the invitation would send the partner to a
 * server this run does not dial. The route maps it to a 400 naming the
 * refusal.
 */
export class SignalingServerChangedError extends Error {
  constructor() {
    super("the webrtc intent names another coordination server");
    this.name = "SignalingServerChangedError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a webrtc run of the opened
 * configuration finds the working folder's `alcove.yaml` is not one it runs in
 * place: gone, one the console cannot open, or another channel. The route
 * maps it to a 400 naming the refusal.
 */
export class OpenedConfigurationNotRunnableError extends Error {
  constructor() {
    super("the working folder's alcove.yaml is not the opened one to run");
    this.name = "OpenedConfigurationNotRunnableError";
  }
}

/**
 * Thrown by {@link JobManager.authorSignalingServer} when a later `PUT` or a
 * `DELETE` of the coordination server took effect while this one read the
 * web app's published file: the later request decides the setting. The route
 * maps it to a 409.
 */
export class SignalingServerAuthoringSupersededError extends Error {
  constructor() {
    super("a later request replaced or cleared the coordination server");
    this.name = "SignalingServerAuthoringSupersededError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when an exchange already occupies
 * the single slot: a second create of either channel is refused with a 409
 * until the running exchange is deleted and its child's exit is observed.
 *
 * Holds {@link activeJobId}, the occupying exchange's id (not a secret; access
 * rides the loopback-only origin), so the route can emit it in the 409 body
 * and the browser can re-attach to the running exchange.
 */
export class ExchangeBusyError extends Error {
  constructor(readonly activeJobId: string) {
    super("an exchange is already active");
    this.name = "ExchangeBusyError";
  }
}

/** Thrown when a spawn is requested after {@link JobManager.shutdown}; a 503. */
export class ConsoleShuttingDownError extends Error {
  constructor() {
    super("the console is shutting down");
    this.name = "ConsoleShuttingDownError";
  }
}

/**
 * Thrown by {@link JobManager.probeSftpHostKey} when a probe child is already
 * running: the probe is single-flight, so a concurrent request is refused
 * with a 409. Independent of the exchange slot -- a probe authors nothing.
 */
export class SftpProbeBusyError extends Error {
  constructor() {
    super("a host-key probe is already running");
    this.name = "SftpProbeBusyError";
  }
}

/**
 * Thrown by {@link JobManager.checkRelay} when a relay check child is already
 * running: one check runs at a time, so a concurrent request is refused with
 * a 409.
 */
export class RelayCheckBusyError extends Error {
  constructor() {
    super("a relay check is already running");
    this.name = "RelayCheckBusyError";
  }
}

/**
 * Thrown by {@link JobManager.resolveSigningFingerprint} when a fingerprint
 * child is already running. Single-flight because two concurrent runs would
 * both create-or-load the same identity file, and the CLI's first-time create
 * is exclusive. Independent of the exchange slot: this authors an identity,
 * not a run.
 */
export class SigningFingerprintBusyError extends Error {
  constructor() {
    super("a signing fingerprint request is already running");
    this.name = "SigningFingerprintBusyError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent arrives but
 * this console cannot rendezvous one: no shared folder is resolved
 * (neither `JOB_RENDEZVOUS_DIR` nor its `JOB_DATA_ROOT` fallback is set), or
 * the split pair a second mount provisions is incoherent (see
 * `rendezvousSplitFaults`). The route maps it to a 400.
 */
export class JobRendezvousUnavailableError extends Error {
  constructor() {
    super("no shared folder is configured for a shared-folder exchange");
    this.name = "JobRendezvousUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent reaches a
 * split-provisioned console without retain mode. A separate outbound
 * directory requires `retain_files` -- core's connection schema and the CLI
 * both refuse the pair without it, and on a split console every filedrop
 * exchange has the pair. Mapped by the route to a 400 rather than reaching
 * core's compose as a 500.
 */
export class JobRendezvousRetainRequiredError extends Error {
  constructor() {
    super("separate inbound and outbound shared folders require retain mode");
    this.name = "JobRendezvousRetainRequiredError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent would sync the
 * folder this party's signing identity sits in: the run publishes everything in
 * the shared folder to the partner, and a long-lived private key there
 * lets whoever reads it sign receipts in this party's name with every partner.
 *
 * Raised only where a rendezvous leg IS or HOLDS the identity's directory,
 * positively established (see {@link rendezvousHoldsDirectory}), and an identity
 * file is there. The route maps it to a 400 naming the refusal, which is the one
 * create rejection whose body says which it is.
 */
export class JobSigningIdentityExposedError extends Error {
  constructor() {
    super(
      "a shared folder holds this party's signing identity, so the run would publish the private key",
    );
    this.name = "JobSigningIdentityExposedError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a credential file of the saved
 * SFTP connection is one of the console's own files
 * ({@link consoleOwnedCredentialField}). None of them is ever a credential,
 * so the run is refused rather than sending the file's contents to the server.
 * The route maps it to a 400 naming the refusal.
 */
export class JobSftpCredentialConsoleOwnedError extends Error {
  constructor() {
    super(
      "a credential file of the saved SFTP connection is one of the console's own files",
    );
    this.name = "JobSftpCredentialConsoleOwnedError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} for a signed run of the opened
 * configuration the operator did not convert, where that configuration states
 * a signing path of its own. The console signs only with its own identity and
 * writes the receipt only where it serves it, so running would replace the
 * operator's paths without their say. The browser withholds this run and
 * offers the conversion; this is the server's own check on it. The route maps
 * it to a 400 naming the refusal.
 */
export class MountedSigningPathsUnconvertedError extends Error {
  constructor() {
    super(
      "the opened configuration states signing paths of its own and was not converted to the console's",
    );
    this.name = "MountedSigningPathsUnconvertedError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} for a signed run in place whose file
 * signs with an identity file other than the one the intent's identity
 * location resolves to: that run signs as its file states, and the console
 * signs only with its own identity. The browser withholds this run; this is
 * the server's own check on it. The route maps it to a 400 naming the
 * refusal.
 */
export class MountedSigningIdentityMismatchError extends Error {
  constructor() {
    super(
      "the configuration run in place signs with an identity file other than the console's",
    );
    this.name = "MountedSigningIdentityMismatchError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when core refuses the configuration or
 * the hand-off composed from a schema-valid intent: a cross-field rule the
 * intent schema does not restate (a split sftp connection run without retain
 * mode), or a composed document past core's size bounds. The route maps it to a
 * 400 whose body is {@link JobIntentUncomposableError.detail}.
 */
export class JobIntentUncomposableError extends Error {
  /** The refusal as `<field>: <reason>`, `<field>` naming a field of the
   * composed configuration, or core's fixed message when it names none. */
  readonly detail: string;

  constructor(detail: string, options?: ErrorOptions) {
    super(
      `the intent could not be composed into a configuration: ${detail}`,
      options,
    );
    this.detail = detail;
    this.name = "JobIntentUncomposableError";
  }
}

/**
 * Run one composition step, turning core's refusal of what it composed into a
 * {@link JobIntentUncomposableError}: a schema issue described through the
 * shared formatter, or one of the key-rewrite size bounds. Any other throw
 * propagates unchanged.
 */
function composedFromIntent<TComposed>(compose: () => TComposed): TComposed {
  try {
    return compose();
  } catch (error) {
    if (error instanceof ZodError)
      throw new JobIntentUncomposableError(formatFirstIssue(error.issues), {
        cause: error,
      });
    if (
      error instanceof NodeCountExceededError ||
      error instanceof NestingDepthExceededError
    )
      throw new JobIntentUncomposableError(error.message, { cause: error });
    throw error;
  }
}

/**
 * A single buffered event with its monotonic id. The full event list is
 * retained for the job's lifetime so every SSE connect can replay from the
 * start (or from a Last-Event-ID offset).
 */
export interface BufferedEvent {
  id: number;
  event: RelayEvent;
}

/** The lifecycle status of a job. */
type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * The uniform view the status and download routes consume, built from the live
 * in-memory {@link JobRecord}. There is at most one exchange, held in memory only;
 * a restart forgets it, so there is no restored view.
 */
interface JobView {
  id: string;
  status: JobStatus;
  /** The reconciled terminal state, once the child has exited. */
  terminal: JobTerminalState | null;
  terminalEmitted: boolean;
  eventCount: number;
  resultAvailable: boolean;
  recordAvailable: boolean;
  recordCreatedAt?: string;
  /** What the available record says became of the run that wrote it, present
   * exactly when {@link recordAvailable} is true. A terminated run's record
   * attests the same disclosure a completed run's does but has no result file
   * behind its commitments. */
  recordOutcome?: ExchangeRecordOutcome;
  /** Whether the available record states that the certificate the partner
   * presented is not the pinned identity, present exactly when
   * {@link recordAvailable} is true. It states what the run observed about the
   * certificate, not why the run ended (docs/spec/EXCHANGE_RECORD.md, An observed
   * certificate mismatch is stated on its own). */
  recordCertificateMismatchObserved?: boolean;
  /** Why the pair is withheld, present exactly when {@link recordAvailable} is
   * false: distinguishes the console's definitive denial from a record on disk
   * this bundle cannot describe -- the same negative to a reader of the boolean
   * alone. */
  recordUnavailableReason?: RecordUnavailableReason;
  /** Whether this run's intent asked for a diagnostic log, whether or not the
   * CLI has opened the file yet. It is what separates a run that will never have
   * a log from one whose log has not appeared, so a client watching for the file
   * knows when to stop. */
  logRequested: boolean;
  /** Whether this run captured a diagnostic log and the file is on disk. */
  logAvailable: boolean;
  /** Whether this run's intent asked for a signed receipt (`certificate` mode),
   * whether or not the CLI wrote one. It separates a run that will never have a
   * receipt from one whose receipt has not appeared, exactly as
   * {@link logRequested} does for the log. */
  receiptRequested: boolean;
  /** Whether this run wrote a signed receipt and the file is on disk. */
  receiptAvailable: boolean;
  /** Whether the run reported that its transport close left this party's
   * protocol files in the shared exchange directory. False until the child's
   * exit is reconciled, since the report comes after the run's own terminal
   * event ({@link JobRecord.transportTeardownOverran}). */
  transportTeardownOverran: boolean;
  /** The five servable file paths (result, record, keys, log, receipt) inside the
   * workdir. The four run artifacts are this run's stamped names
   * ({@link runArtifactsOf}), each null until the workdir holds an artifact of
   * this run; `logPath` is null for a run that captured no log, and
   * `receiptPath` for one that signed nothing. */
  outputPath: string | null;
  recordPath: string | null;
  keysPath: string | null;
  logPath: string | null;
  receiptPath: string | null;
  /** The result file's own name, `alcove-results-<time>.csv`, the name its
   * download is offered under; null with {@link outputPath}. */
  resultFileName: string | null;
}

/**
 * The working folder's `alcove.yaml` and `.alcove.key` a webrtc run wrote when
 * it started, which every retry of its invitation runs over.
 */
export interface WorkingFolderPair {
  /** The invitation the pair belongs to ({@link invitationIdOf}). */
  invitation: string;
  /** The bytes written when the pair was created. */
  written: ExchangeFileDigests;
  /** The bytes when the pair was created, a retry set its allowed relays, or
   * the latest run over it ended; undefined where either file was gone then. */
  latest: ExchangeFileDigests | undefined;
}

/** A job record. Lives in server memory only; never persisted. */
export interface JobRecord {
  id: string;
  workdir: string;
  /**
   * The stamp this run's artifacts are found by ({@link runArtifactsOf}): the
   * one its `result` event named its result file with, or, for a run whose
   * event named none, the latest stamp in the workdir once the child has
   * exited. Null while neither is known, and after it for a run that left no
   * artifact.
   */
  runStamp: string | null;
  /** Whether {@link runStamp} is final, so the workdir is listed at most once
   * per run rather than on every status read. */
  runStampResolved: boolean;
  /**
   * The diagnostic log the CLI was pointed at with `--log-file`, or null when
   * this run was not a diagnostic one. Set at creation from the intent's
   * `diagnosticRun`, so a run that did not ask for a log has no log path to
   * serve at all rather than a path that happens to name no file.
   */
  logPath: string | null;
  /**
   * Whether this run signs receipts (`certificate` mode). Set at creation from
   * the intent's signing mode, so a run that asked for no receipt has no receipt
   * to serve at all rather than a stamped name that happens to name no file.
   */
  receiptRequested: boolean;
  /**
   * Whether this run's intent named a partner fingerprint, so the configuration
   * composed for it held a pin before the child started. A first contact is a
   * run that held none, which is what the console's own pin notice states
   * ({@link rewrittenPartnerPinNotice}).
   */
  partnerFingerprintPinnedAtCreation: boolean;
  /**
   * The configuration and key file the CLI was started with, or null for a
   * zero-setup run, which has neither. A webrtc run's are the working
   * folder's.
   */
  exchangeFiles: ExchangeFilePaths | null;
  /** For a webrtc run over the pair the console wrote, that pair; null for
   * every other run, a run of the opened configuration among them, whose
   * files the console never removes. */
  workingFolderPair: WorkingFolderPair | null;
  /** Whether the run's configuration is the working folder's `alcove.yaml`,
   * as every webrtc run's is, so what the CLI records in it stays there. */
  runsInWorkingFolder: boolean;
  status: JobStatus;
  events: Array<BufferedEvent>;
  /** True once a terminal event has been buffered; the SSE stream closes after it. */
  terminalEmitted: boolean;
  /**
   * Whether the run reported protocol files its transport close left in the
   * shared exchange directory ({@link CliRunDiagnostics.transportTeardownOverran}).
   *
   * Set when the child's exit is reconciled and only for a run that emitted its
   * own terminal event: the report reaches this console on the stderr tail after
   * that event, which for a synthesized terminal already rides its cause link.
   * A client learns it from the status body, since the run's own terminal has
   * closed the event stream by the time the report exists.
   */
  transportTeardownOverran: boolean;
  /** The reconciled terminal state, once the child has exited. */
  terminal: JobTerminalState | null;
  handle: CliDriverHandle | null;
  /** Registered SSE listeners, notified as events are appended. */
  listeners: Set<(entry: BufferedEvent) => void>;
  /** A cancellation escalation timer chain, cleared on exit. */
  cancelTimers: Array<NodeJS.Timeout>;
  /** The recurring-run hand-off (the portable, secret-free template plus its
   * metadata), composed at creation from this run's intent and resources. Served
   * verbatim by `GET /api/jobs/:jobId/handoff`. */
  handoff: JobHandoff;
  /**
   * For a run of the opened configuration, what applying the terms proposal
   * it may end on is checked against: the key file beside the configuration,
   * and the bytes the open read, undefined where the console held no open --
   * or, for a run in place, the bytes the file held when the run started.
   * Null on every other run, whose configuration is composed per run and so
   * has nothing on the mount to apply a proposal to.
   */
  termsProposalBasis: {
    keyPath: string;
    openedSource: string | undefined;
  } | null;
  /**
   * Where the run's terms proposal stands: `available` once its terminal
   * `error` event states it wrote one ({@link JobManager.applyTermsProposal}),
   * `applied` once the mounted configuration took it on, `none` otherwise.
   */
  termsProposal: "none" | "available" | "applied";
}

/**
 * The single-exchange slot. `starting` is claimed synchronously at the top of
 * {@link JobManager.createJob} (before any await) so two concurrent POSTs cannot
 * both pass the null check; it becomes `active` once the record exists. The
 * `deleted` flag makes the surface 404 immediately on DELETE while the slot stays
 * occupied until the child's exit is observed (see {@link JobManager.maybeFreeSlot}).
 *
 * `channel` is the occupying run's transport, held in both phases because a
 * filedrop run makes the rendezvous mount an exchange's own working folder for
 * its duration, which bears on what else may be written there
 * ({@link JobManager.resolveSigningFingerprint}).
 */
type ExchangeSlot = { channel: JobCreateIntent["channel"] } & (
  | { phase: "starting"; id: string }
  | { phase: "active"; record: JobRecord; deleted: boolean }
);

/**
 * The hard cap on buffered events: a safety check well above the CLI stream's
 * normal dozens-of-lines volume. On overflow the job is failed rather than
 * dropping events silently, so a supervisor never observes a truncated
 * history.
 */
const EVENT_BUFFER_CAP = 10000;

const log = getLogger("job-api");

/** The grace before SIGINT escalates to SIGTERM during cancellation. */
const CANCEL_SIGTERM_GRACE_MS = 5000;
/** The grace before SIGTERM escalates to SIGKILL during cancellation. */
const CANCEL_SIGKILL_GRACE_MS = 5000;

/**
 * Options for {@link JobManager}, so tests can inject a stub binary path and
 * shortened timers without touching the environment.
 */
interface JobManagerOptions {
  dataRoot: string;
  binaryPath?: string;
  eventBufferCap?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  /**
   * The resolved work-input directory (from {@link useJobInputDir}), which falls back
   * to the data root when `JOB_INPUT_DIR` is unset. Absent only when neither resolves;
   * an intent naming an `inputFile` then fails with {@link JobInputNotFoundError}.
   * Never derived from a request.
   */
  jobInputDir?: string;
  /**
   * The resolved shared folder (from {@link JobRendezvousProvisioning.dir})
   * a filedrop exchange reads and writes, which falls back to the data root when
   * `JOB_RENDEZVOUS_DIR` is unset. Absent only when neither resolves; a filedrop intent
   * then fails with {@link JobRendezvousUnavailableError}. On a split-provisioned
   * console it is the INBOUND (peer-written) leg. Never derived from a request.
   */
  jobRendezvousDir?: string;
  /**
   * The resolved outbound (self-written) rendezvous leg (from
   * {@link JobRendezvousProvisioning.outboundDir}), present only when
   * `JOB_RENDEZVOUS_OUTBOUND_DIR` names one. Its presence makes every filedrop
   * exchange this console runs a split one: the composed config has
   * `inbound_path`/`outbound_path` instead of a single `path`, and the
   * zero-setup argv gains `--outbound-path`. Never derived from a request.
   */
  jobRendezvousOutboundDir?: string;
  /**
   * Why a filedrop exchange cannot run as this console is provisioned (from
   * {@link JobRendezvousProvisioning.problem}) -- an incoherent split pair.
   * Present only in that state; a filedrop intent then fails with
   * {@link JobRendezvousUnavailableError}.
   */
  jobRendezvousProblem?: string;
  /**
   * The resolved secrets mount (from {@link useJobSecretsDir}) the operator
   * browses for an authored connection's file-reference credential -- no
   * data-root fallback, so absent when `JOB_SECRETS_DIR` is unset. Used only
   * to resolve a `mountRef` credential locator to its `@path` during
   * {@link authorSftpServer}; an unset mount refuses that authoring.
   */
  jobSecretsDir?: string;
  /**
   * The container-internal scratch directory a PASTED credential is materialized
   * to (from {@link setupSftpCredentialScratchDir} at boot). Absent when the boot
   * setup did not run (a disabled API, or a test that authors only file-reference
   * credentials); a raw-paste authoring then fails rather than composing an
   * inline value. Never a request value or the data root.
   */
  credentialScratchDir?: string;
  /**
   * Extra environment variables merged into every spawned child. Empty in
   * production; the manager tests use it to configure the stub CLI. Set only by
   * the server-side constructor, never derived from a request.
   */
  childEnv?: NodeJS.ProcessEnv;
}

/**
 * The single-exchange job manager and lifecycle. Owns the CLI driver, the event
 * buffer, cancellation escalation, and the shutdown hook that SIGTERMs the running
 * child so no orphaned CLI survives the server. At most one exchange occupies the
 * slot at a time; a second create is rejected until the current one is deleted.
 */
export class JobManager {
  private slot: ExchangeSlot | null = null;
  private readonly dataRoot: string;
  private readonly binaryPath: string;
  private readonly eventBufferCap: number;
  private readonly cancelSigtermGraceMs: number;
  private readonly cancelSigkillGraceMs: number;
  private readonly childEnv: NodeJS.ProcessEnv | undefined;
  private readonly jobInputDir: string | undefined;
  private readonly jobRendezvousDir: string | undefined;
  private readonly jobRendezvousOutboundDir: string | undefined;
  private readonly jobRendezvousProblem: string | undefined;
  private readonly jobSecretsDir: string | undefined;
  private readonly credentialScratchDir: string | undefined;
  /**
   * The in-app authored SFTP connection, held in memory (never persisted; a
   * restart forgets it). Set by {@link authorSftpServer} and cleared by
   * {@link clearAuthoredSftpServer}; deleting an exchange keeps it, since a
   * retry deletes the failed exchange before creating the next.
   */
  private authoredSftpServer: JobSftpServerEntry | undefined;
  /**
   * The non-blocking credential warnings for the authored connection (each
   * naming a field and a directory only), held alongside it and exposed in
   * the projection so both the PUT response and a later GET (console reload)
   * include them. Empty when no connection is authored or every credential
   * resolves safely.
   */
  private authoredCredentialWarnings: Array<string> = [];
  /**
   * The server-owned scratch file the authored connection's PASTED credential was
   * materialized to, when it arrived that way. Tracked so it is deleted with the
   * connection (clear, or a re-author that replaces it); absent
   * when the authored credential is a file reference the operator owns. A pasted
   * secret must not outlive the connection it belongs to.
   */
  private authoredMaterializedCredentialPath: string | undefined;
  /**
   * The coordination server a webrtc job dials, held in memory. Set by
   * {@link authorSignalingServer} and cleared by
   * {@link clearAuthoredSignalingServer}; deleting an exchange keeps it, since
   * it holds no credential and a retry deletes the failed exchange before
   * creating the next.
   */
  private authoredSignalingServer: AuthoredSignalingServer | undefined;
  /**
   * The working folder's pair the latest webrtc run wrote, kept after its
   * job is deleted so a retry of the same invitation runs over it. Held in
   * memory only: after a restart no pair in the folder is this console's.
   */
  private workingFolderPair: WorkingFolderPair | undefined;
  /** The advisories {@link authoredSignalingServer} was authored with. */
  private authoredSignalingWarnings: Array<string> = [];
  /** The ticket of the latest authoring or clearing request to arrive. */
  private signalingAuthoringLatestTicket = 0;
  /** The ticket of the latest request that changed the setting. A refused
   * `PUT` changes nothing, so it never makes an earlier `PUT` stale. */
  private signalingAuthoringCommittedTicket = 0;
  /**
   * Whether a host-key probe child is running. The probe is single-flight, so a
   * concurrent {@link probeSftpHostKey} is refused with {@link SftpProbeBusyError}.
   * Set synchronously at entry (before any await) so two concurrent calls cannot
   * both pass; cleared when the child settles. Independent of the exchange slot.
   */
  private probeInFlight = false;
  /**
   * Whether a relay check child is running. Claimed and cleared as
   * {@link probeInFlight} is, so a concurrent {@link checkRelay} is refused
   * with {@link RelayCheckBusyError}.
   */
  private relayCheckInFlight = false;
  /**
   * Whether a signing-fingerprint child is running. Claimed and cleared exactly as
   * {@link probeInFlight} is, and for the reason
   * {@link SigningFingerprintBusyError} states.
   */
  private fingerprintInFlight = false;
  /**
   * Whether an apply child is running ({@link applyTermsProposal}). Claimed
   * and cleared as {@link probeInFlight} is; independent of the exchange slot,
   * whose failed run holds it until deleted.
   */
  private termsApplyInFlight = false;
  /**
   * The captured CLI children running ({@link runStoppableChild}): the host-key
   * probe, the signing fingerprint, the terms apply, and the relay check.
   * {@link shutdown} aborts each one's `stop` and waits on its `settled`, which
   * resolves once the driver has observed the child's exit.
   */
  private readonly capturedChildren = new Set<{
    stop: AbortController;
    settled: Promise<void>;
  }>();
  private shuttingDown = false;
  /**
   * The configuration the operator last opened off the mount, as that open
   * read it: what a run of the opened configuration composes its hand-off
   * from, rather than a read of the mount at run start. Replaced by each open,
   * cleared by an open that finds no file or refuses one, and held in memory
   * only, so a restart forgets it.
   */
  private openedConfiguration: OpenedMountedConfiguration | undefined;
  /**
   * The text the console's own last save wrote into the mounted `alcove.yaml`
   * ({@link handBackOpenedConfiguration}), held in memory only. A save over a
   * file holding exactly that keeps the earlier `alcove.yaml.previous`.
   */
  private consoleWrittenConfiguration: string | undefined;
  /**
   * The shutdown in progress for each record whose child {@link shutdown}
   * signalled: the promise every shutdown call returns, settled from
   * {@link reconcileTerminal} once the child's exit is observed.
   */
  private readonly shutdownWaits = new WeakMap<
    JobRecord,
    { exited: Promise<void>; resolveExited: () => void }
  >();

  constructor(options: JobManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.binaryPath = options.binaryPath ?? resolveCliBinaryPath();
    this.eventBufferCap = options.eventBufferCap ?? EVENT_BUFFER_CAP;
    this.cancelSigtermGraceMs =
      options.cancelSigtermGraceMs ?? CANCEL_SIGTERM_GRACE_MS;
    this.cancelSigkillGraceMs =
      options.cancelSigkillGraceMs ?? CANCEL_SIGKILL_GRACE_MS;
    this.jobInputDir = options.jobInputDir;
    this.jobRendezvousDir = options.jobRendezvousDir;
    this.jobRendezvousOutboundDir = options.jobRendezvousOutboundDir;
    this.jobRendezvousProblem = options.jobRendezvousProblem;
    this.jobSecretsDir = options.jobSecretsDir;
    this.credentialScratchDir = options.credentialScratchDir;
    this.childEnv = options.childEnv;
  }

  /**
   * Create and start a job from a validated intent: generates the id, builds
   * the workdir, writes the composed config, key, and input CSV, and spawns
   * the CLI. The connection resource is resolved before the slot is claimed
   * (so an unconfigured target is rejected with nothing on disk), and the
   * slot itself is claimed with no await between the null check and the
   * assignment, so two concurrent POSTs cannot both pass. An `inputFile`
   * intent resolves its mounted path inside the try; the CLI reads it in
   * place, so nothing is copied into the workdir.
   */
  async createJob(intent: JobCreateIntent): Promise<string> {
    const id = generateJobId();

    // Claim the slot with no await between the null check and the assignment --
    // every check in between is synchronous -- so two concurrent POSTs cannot
    // both observe a free slot. The busy check runs first, so an occupied
    // console answers with the occupying exchange's id, which the caller
    // re-attaches to, whatever else this create would be refused for.
    if (this.slot !== null) throw new ExchangeBusyError(this.slotId()!);
    if (this.shuttingDown) throw new ConsoleShuttingDownError();

    let serverEntry: JobSftpServerEntry | undefined;
    if (intent.channel === "sftp") {
      if (this.authoredSftpServer === undefined)
        throw new SftpUnavailableError();
      serverEntry = this.authoredSftpServer;
    }
    let signalingServer: AuthoredSignalingServer | undefined;
    let pairToRunOver: WorkingFolderPair | undefined;
    let inPlace: OpenedMountedConfiguration | undefined;
    let inPlaceIdentityFile: string | undefined;
    // A run of the opened configuration runs the working folder's own files in
    // place, dialing the coordination server the file names, so it reads
    // neither the console's server nor a pair of the console's: it is refused
    // unless that file is still one the console runs.
    if (intent.channel === "webrtc" && intent.mountedConfigurationOpened) {
      const mounted = mountedInPlaceConfiguration(this.dataRoot);
      if (mounted === undefined)
        throw new OpenedConfigurationNotRunnableError();
      inPlace = { source: mounted.source, document: undefined };
      inPlaceIdentityFile = mounted.certificateIdentityFile;
    } else if (intent.channel === "webrtc") {
      const authored = this.authoredSignalingServer;
      if (authored === undefined && intent.signalingServer === undefined)
        throw new SignalingServerUnavailableError();
      if (
        authored === undefined ||
        intent.signalingServer === undefined ||
        !namesSignalingServer(intent.signalingServer, authored, intent.side)
      )
        throw new SignalingServerChangedError();
      signalingServer = authored;
      pairToRunOver = this.workingFolderPairToRunOver(intent);
    }
    if (intent.channel === "filedrop") {
      if (
        this.jobRendezvousDir === undefined ||
        this.jobRendezvousProblem !== undefined
      )
        throw new JobRendezvousUnavailableError();
      // Every filedrop exchange on a split-provisioned console has the
      // inbound/outbound pair, which core refuses without retain mode. Refused
      // here, before the slot is claimed, so the operator meets a 400 the console
      // can explain rather than a compose failure after a workdir exists.
      if (
        this.jobRendezvousOutboundDir !== undefined &&
        intent.options?.retainFiles !== true
      )
        throw new JobRendezvousRetainRequiredError();
    }

    // A run of the opened configuration continues the exchange under the key
    // file beside it. Checked after the busy check, so a create posted to
    // recover a lost attachment meets the rejection that re-attaches it, and
    // before the slot is claimed, so a refusal leaves the console free.
    const runsOpenedConfiguration =
      intent.mode !== "zeroSetup" && intent.mountedConfigurationOpened === true;
    const mountedKeyPath = runsOpenedConfiguration
      ? checkedMountedKeyFilePath(this.dataRoot)
      : undefined;
    // Captured before any await, so an open landing while the run writes its
    // documents affects only a later run. A run in place is of the file as
    // it stands, which its terms proposal is applied to.
    const opened = runsOpenedConfiguration
      ? (inPlace ?? this.openedConfiguration)
      : undefined;
    if (
      intent.mode !== "zeroSetup" &&
      intent.mountedConfigurationConverted !== true &&
      intent.signing?.mode === "certificate" &&
      opened?.document !== undefined &&
      signingPathSettings(opened.document).length > 0
    )
      throw new MountedSigningPathsUnconvertedError();
    // Resolved after the busy check for the reason the refusal below states,
    // and before the slot is claimed, so a location naming no path in the
    // secrets mount leaves the console free rather than mid-create.
    const identityPath = this.identityPathFor(intent);
    // A run in place signs with the identity its file names, which no
    // conversion replaces, so a run of a file signing with another identity is
    // refused whatever the intent says, unless that is the identity the console
    // shows.
    if (
      intent.mode !== "zeroSetup" &&
      inPlaceIdentityFile !== undefined &&
      !namesSigningIdentity(inPlaceIdentityFile, identityPath)
    )
      throw new MountedSigningIdentityMismatchError();
    // Refused rather than warned: the run would copy this party's long-lived
    // private key to the partner, and no wording recovers a disclosed key.
    // After the busy check, so a create posted to recover a lost attachment on
    // an occupied console meets the rejection that re-attaches it.
    if (
      intent.channel === "filedrop" &&
      this.runWouldPublishSigningIdentity(identityPath)
    )
      throw new JobSigningIdentityExposedError();
    if (
      serverEntry !== undefined &&
      consoleOwnedCredentialField(
        serverEntry,
        { folder: this.dataRoot, secrets: this.jobSecretsDir },
        [identityPath, signingIdentityPath(this.dataRoot)],
      ) !== undefined
    )
      throw new JobSftpCredentialConsoleOwnedError();
    this.slot = { phase: "starting", id, channel: intent.channel };

    let workdir: string | null = null;
    let pairCreated: WorkingFolderPair | undefined;
    try {
      // Resolve the mounted input before creating the workdir, inside the try so a
      // rejection frees the slot and leaves nothing on disk.
      const mountedInputPath =
        intent.inputFile !== undefined
          ? this.resolveWorkInputPath(intent.inputFile)
          : undefined;
      let workingFolderPair = pairToRunOver;
      if (pairToRunOver !== undefined && intent.channel === "webrtc")
        this.setPairAllowedRelays(pairToRunOver, intent.allowedRelays);
      if (
        intent.channel === "webrtc" &&
        !runsOpenedConfiguration &&
        workingFolderPair === undefined
      ) {
        pairCreated = this.createWorkingFolderPair(
          intent,
          signalingServer,
          identityPath,
        );
        workingFolderPair = pairCreated;
      }
      const created = await createWorkdir(this.dataRoot, id);
      workdir = created.workdir;
      const started = await this.startJobInWorkdir(
        intent,
        id,
        created.workdir,
        serverEntry,
        mountedInputPath,
        identityPath,
        mountedKeyPath,
        opened,
        workingFolderPair,
      );
      if (workingFolderPair !== undefined)
        this.workingFolderPair = workingFolderPair;
      return started;
    } catch (error) {
      // spawnExchangeJob is the final fallible step of startJobInWorkdir, so
      // this catch is reachable only before any child was spawned. A slot
      // record whose handle is already set would mean a live child; freeing
      // the slot here would strand it, so that state is asserted unreachable.
      const active = this.activeSlotRecord();
      if (active !== null && active.handle !== null)
        throw new Error(
          "createJob cleanup reached with a spawned child; refusing to free the slot",
        );
      this.slot = null;
      if (pairCreated !== undefined)
        this.removeUnchangedPair(pairCreated, "failed to start");
      if (workdir !== null)
        await removeWorkdir(workdir).catch((cleanupError: unknown) => {
          log.warn(
            "Could not remove the folder of an exchange that failed to start:",
            sanitizeErrorForDisplay(cleanupError),
          );
        });
      throw error;
    }
  }

  /**
   * The rendezvous mounts a filedrop job preflights and a credential `@path`
   * is excluded from, each paired with the leg it is. Routed through the
   * shared enumeration so the manager and the boot-time containment surfaces
   * cannot state different rules about which mounts this console has.
   */
  private rendezvousLegs(): Array<[string, RendezvousLeg]> {
    return jobRendezvousLegs(
      this.jobRendezvousDir,
      this.jobRendezvousOutboundDir,
    );
  }

  /**
   * The absolute path of the signing identity a request or an intent names: the
   * operator's configured location, or the console's default in the mounted data
   * root when it names none.
   *
   * A configured location resolves through its links
   * ({@link resolveSigningIdentityPath}), so the directory
   * {@link runWouldPublishSigningIdentity} compares is the one the key sits in
   * rather than the one a link to it sits in.
   *
   * @throws {SigningIdentityLocationError} when the location does not resolve in
   *   the secrets mount; the routes map it to a 400 naming the field.
   */
  private identityPathFor(intent: JobCreateIntent): string {
    return resolveSigningIdentityPath({
      dataRoot: this.dataRoot,
      secretsDir: this.jobSecretsDir,
      location:
        intent.mode !== "zeroSetup"
          ? intent.signing?.identityLocation
          : undefined,
    });
  }

  /**
   * Whether a filedrop run would publish this party's signing identity: an
   * identity file is at one of the paths below, and a rendezvous leg IS or HOLDS
   * the directory it sits in ({@link signingIdentityDirectory}) -- the layout in
   * which a key there is a key the partner reads. A leg mounted INSIDE that
   * directory and a leg beside it both hold nothing of it.
   *
   * Two paths are read, not one: the identity this run loads (`identityPath`),
   * and the console's default in the data root, which a run that configured a
   * location of its own leaves behind rather than moves. A key at either is a
   * key the sync copies, and the file is what the partner reads whether or not
   * this run is the one that loads it.
   *
   * A `certificate` run with no identity file publishes none either: the CLI
   * loads this party's identity from the path the console names and refuses the
   * run when nothing is there (`resolveSigningPersist` in `apps/cli`), so no run
   * creates the key it would go on to sync.
   *
   * Both halves are read per request rather than at boot: the mounts can be
   * re-pointed under a running console, and the identity is created between one
   * run and the next.
   *
   * A hold the comparison could not establish -- an unreadable path component,
   * or one host directory bound in at two container paths outside the ancestor
   * chain -- counts as no hold: a refusal is owed a positive finding, and the
   * console says what it cannot see beside the signing control instead.
   */
  private runWouldPublishSigningIdentity(identityPath: string): boolean {
    return [identityPath, signingIdentityPath(this.dataRoot)].some(
      (candidate) =>
        signingIdentityExists(candidate) &&
        this.rendezvousHoldsIdentityDirectory(candidate),
    );
  }

  /**
   * Whether a rendezvous leg IS or HOLDS the directory the given signing identity
   * sits in, positively established. An unestablished hold is false: a refusal is
   * owed a positive finding.
   */
  private rendezvousHoldsIdentityDirectory(identityPath: string): boolean {
    const verdict = rendezvousHoldsDirectory(
      this.rendezvousLegs().map(([dir]) => dir),
      signingIdentityDirectory(identityPath),
    );
    return verdict.holds && !verdict.uncertain;
  }

  /**
   * Whether creating the identity now would write the private key into a folder
   * a live filedrop exchange is syncing to the partner: the slot holds a filedrop
   * run, no identity file is there yet, and a leg holds the directory one would
   * be created in.
   *
   * Asked of the path the create would land at, which is the console's default
   * in the data root: a configured location is read and never created
   * ({@link resolveSigningFingerprint}, apart from the file-removed exception
   * it documents), so no other path is ever written.
   *
   * Reading an identity already there is not this case -- the key is on disk
   * whatever this request does -- so only the create is refused, and only while
   * that run occupies the slot. With no run in the slot, or an sftp run in it,
   * the create proceeds: the console's default is that the key is created on
   * demand in the mounted working directory, and the create-time refusal is what
   * stops the run that would publish it.
   */
  private mintWouldLandInSyncedFolder(identityPath: string): boolean {
    return (
      this.slot?.channel === "filedrop" &&
      !signingIdentityExists(identityPath) &&
      this.rendezvousHoldsIdentityDirectory(identityPath)
    );
  }

  /**
   * The active record the slot holds (in either deleted state), else null. Read
   * through a method so the create-failure catch sees the record even where
   * control-flow narrowing would otherwise hide the slot's `active` phase.
   */
  private activeSlotRecord(): JobRecord | null {
    return this.slot !== null && this.slot.phase === "active"
      ? this.slot.record
      : null;
  }

  /**
   * The working folder's pair a webrtc create runs over, or undefined where
   * neither name is taken and the create writes a new pair. Only a retry of
   * the invitation whose run wrote the pair runs over it, and only while its
   * content is what this console recorded: the configuration's bytes as the
   * latest run over it left them, and a key file with either those bytes or
   * the invitation's original secret. Anything else at either name refuses.
   *
   * @throws {WorkingFolderFilesRefusedError} when either name is taken and
   *   this is not that retry.
   */
  private workingFolderPairToRunOver(
    intent: JobWebrtcExchangeIntent,
  ): WorkingFolderPair | undefined {
    if (!workingFolderExchangeFilesPresent(this.dataRoot)) return undefined;
    const pair = this.workingFolderPair;
    const heldByConsoleExchange =
      pair?.latest !== undefined &&
      workingFolderExchangeFilesMatch(
        this.dataRoot,
        pair.latest,
        pair.invitation,
      );
    if (
      heldByConsoleExchange &&
      intent.sharedSecret !== undefined &&
      invitationIdOf(intent.sharedSecret) === pair.invitation
    )
      return pair;
    throw new WorkingFolderFilesRefusedError("present", heldByConsoleExchange);
  }

  /**
   * Write the allowed relays a run over the console's pair commits into the
   * pair's `alcove.yaml` ({@link setWorkingFolderAllowedRelays}), so the run
   * uses the list its review showed, and record the bytes written as the
   * pair's latest.
   */
  private setPairAllowedRelays(
    pair: WorkingFolderPair,
    allowedRelays: ReadonlyArray<string> | undefined,
  ): void {
    if (pair.latest === undefined)
      throw new Error("a run reached the console's pair with no content held");
    const config = setWorkingFolderAllowedRelays(
      this.dataRoot,
      pair.latest.config,
      allowedRelays,
    );
    if (config !== undefined) pair.latest = { ...pair.latest, config };
  }

  /**
   * Compose a webrtc run's configuration and key file and write them into the
   * working folder, where `alcove invite` writes them, never over anything
   * already at either name.
   *
   * @throws {WorkingFolderFilesRefusedError} when either name is taken or the
   *   folder cannot be written.
   */
  private createWorkingFolderPair(
    intent: JobWebrtcExchangeIntent,
    signalingServer: AuthoredSignalingServer | undefined,
    identityPath: string,
  ): WorkingFolderPair {
    if (signalingServer === undefined || intent.sharedSecret === undefined)
      throw new Error(
        "a webrtc run reached its files without a server or a secret",
      );
    const config = composedFromIntent(() =>
      composeWebrtcConfigDocument(
        intent,
        signalingServer,
        this.signingPathsFor(identityPath),
      ),
    );
    const written = createWorkingFolderExchangeFiles(this.dataRoot, {
      config,
      key: composeKeyFileDocument(intent),
    });
    return {
      invitation: invitationIdOf(intent.sharedSecret),
      written,
      latest: written,
    };
  }

  /**
   * Remove the working folder's pair `pair` describes where both files still
   * have the bytes written when it was created, which a run that never
   * reached its partner leaves. Anything else is left in place, and the log
   * says so.
   */
  private removeUnchangedPair(pair: WorkingFolderPair, outcome: string): void {
    let removed: boolean;
    try {
      removed = removeUnchangedWorkingFolderExchangeFiles(
        this.dataRoot,
        pair.written,
      );
    } catch (error) {
      log.warn(
        `Could not remove alcove.yaml and .alcove.key from the working folder after an exchange ${outcome}:`,
        sanitizeErrorForDisplay(error),
      );
      return;
    }
    if (removed) {
      if (this.workingFolderPair === pair) this.workingFolderPair = undefined;
    } else if (workingFolderExchangeFilesPresent(this.dataRoot))
      log.info(
        `Left alcove.yaml and .alcove.key in the working folder after an exchange ${outcome}: they changed since the exchange started.`,
      );
  }

  /**
   * Resolve an `inputFile` reference to the mounted path the CLI reads in place,
   * before any filesystem work: an unset directory, or a name that resolves to no
   * regular file, is {@link JobInputNotFoundError} -- mapped by the route to a 400.
   * The mounted directory is the operator's own read-only data.
   */
  private resolveWorkInputPath(inputFile: JobInputFileReference): string {
    if (this.jobInputDir === undefined) throw new JobInputNotFoundError();
    return jobInputFilePath(this.jobInputDir, inputFile.name);
  }

  /**
   * Validate and hold an in-app authored SFTP connection in console
   * memory until it is cleared, replaced, an SFTP invitation is opened, or the
   * console restarts, via {@link validateAuthoredSftpServer}. A validation failure
   * throws before the slot is touched, so a rejected body never replaces a
   * previously authored connection. A `mountRef` credential locator is
   * resolved against the secrets mount here, and a `raw` (pasted) credential
   * is materialized to the server-owned scratch file. Returns the
   * credential-free projection of the now-effective connection.
   */
  authorSftpServer(rawBody: unknown): SftpConnectionProjection {
    const result = validateAuthoredSftpServer(
      rawBody,
      this.dataRoot,
      this.rendezvousLegs().map(([dir]) => dir),
      this.jobSecretsDir,
      this.credentialScratchDir,
    );
    // Adopt only after validation succeeds: drop the prior connection's
    // materialized secret (if any) so a re-author never orphans a scratch file.
    this.discardMaterializedCredential();
    this.authoredSftpServer = result.entry;
    this.authoredCredentialWarnings = result.credentialWarnings;
    this.authoredMaterializedCredentialPath = result.materializedCredentialPath;
    return this.sftpProjection()!;
  }

  /**
   * Validate and hold the coordination server a webrtc job dials, resolving
   * a web app's address through the server it publishes
   * ({@link resolveAuthoredSignalingServer}). A refused body leaves the
   * setting as it was, as does a body whose read a later request overtook.
   * Returns the now-effective projection.
   *
   * @throws {SignalingServerAuthoringSupersededError} when a later `PUT` or
   *   `DELETE` took effect during the read.
   */
  async authorSignalingServer(
    rawBody: unknown,
  ): Promise<SignalingServerProjection> {
    const ticket = ++this.signalingAuthoringLatestTicket;
    const { server, warnings } = await resolveAuthoredSignalingServer(rawBody);
    if (this.signalingAuthoringCommittedTicket > ticket)
      throw new SignalingServerAuthoringSupersededError();
    this.signalingAuthoringCommittedTicket = ticket;
    this.authoredSignalingServer = server;
    this.authoredSignalingWarnings = warnings;
    return this.signalingServerProjection()!;
  }

  /** Forget the authored coordination server. Idempotent. */
  clearAuthoredSignalingServer(): void {
    this.signalingAuthoringLatestTicket++;
    this.signalingAuthoringCommittedTicket =
      this.signalingAuthoringLatestTicket;
    this.authoredSignalingServer = undefined;
    this.authoredSignalingWarnings = [];
  }

  /** The projection of the authored coordination server for `GET
   * /api/jobs/webrtc`, or null when none is authored. */
  signalingServerProjection(): SignalingServerProjection | null {
    const server = this.authoredSignalingServer;
    if (server === undefined) return null;
    return {
      host: server.host,
      ...(server.port !== undefined ? { port: server.port } : {}),
      path: server.path,
      secure: server.secure,
      ...(server.webAppOrigin !== undefined
        ? { webAppOrigin: server.webAppOrigin }
        : {}),
      ...(server.invitationRelay !== undefined
        ? { invitationRelay: server.invitationRelay }
        : {}),
      ...(server.ownRelay !== undefined ? { ownRelay: server.ownRelay } : {}),
      warnings: this.authoredSignalingWarnings,
    };
  }

  /** Forget the in-app authored SFTP connection and its warnings, deleting any
   * materialized pasted credential. Idempotent. */
  clearAuthoredSftpServer(): void {
    this.discardMaterializedCredential();
    this.authoredSftpServer = undefined;
    this.authoredCredentialWarnings = [];
  }

  /** Delete the authored connection's materialized pasted credential, if it holds
   * one. A no-op for a file-reference credential (the operator's own file is never
   * touched). */
  private discardMaterializedCredential(): void {
    if (this.authoredMaterializedCredentialPath !== undefined) {
      removeSftpCredentialFile(this.authoredMaterializedCredentialPath);
      this.authoredMaterializedCredentialPath = undefined;
    }
  }

  /** The credential and signing-identity files the authored connection and
   * the opened configuration reference, which the input listing leaves out
   * ({@link referencedCredentialPaths}). */
  referencedCredentialPaths(): Set<string> {
    return referencedCredentialPaths(
      this.dataRoot,
      this.authoredSftpServer,
      this.openedConfiguration?.document,
    );
  }

  /**
   * The credential-free projection of the authored SFTP connection for
   * `GET /api/jobs/sftp`, or null when none is authored. Explicitly mapped
   * field-by-field (never a spread) so only the locator fields {host, port, and
   * whichever remote-directory form the entry holds}, the warnings, and the
   * direct-run refusal token can ever cross the response boundary.
   */
  sftpProjection(): SftpConnectionProjection | null {
    const entry = this.authoredSftpServer;
    if (entry === undefined) return null;
    const projection: SftpConnectionProjection = { host: entry.host };
    if (entry.port !== undefined) projection.port = entry.port;
    if (entry.path !== undefined) projection.path = entry.path;
    if (entry.inboundPath !== undefined)
      projection.inboundPath = entry.inboundPath;
    if (entry.outboundPath !== undefined)
      projection.outboundPath = entry.outboundPath;
    projection.credentialWarnings = this.authoredCredentialWarnings;
    const { refusal } = zeroSetupSftpCheck(entry);
    if (refusal !== undefined) projection.zeroSetupRefusal = refusal;
    return projection;
  }

  /**
   * Read the host-key fingerprint an SFTP server at `host[:port]` presents,
   * by spawning the CLI's `probe-host-key` subcommand. Stateless: touches no
   * authored connection and records nothing -- the console offers the
   * observation beside the paste field for comparison, never trusting it.
   * Single-flight: the flag is claimed synchronously (no await before the
   * assignment), so a concurrent probe is {@link SftpProbeBusyError} (a 409).
   */
  async probeSftpHostKey(args: {
    host: string;
    port?: number;
  }): Promise<SftpProbeResult> {
    if (this.shuttingDown) throw new ConsoleShuttingDownError();
    if (this.probeInFlight) throw new SftpProbeBusyError();
    this.probeInFlight = true;
    try {
      return await this.runStoppableChild((stop) =>
        probeSftpHostKey({
          host: args.host,
          ...(args.port !== undefined ? { port: args.port } : {}),
          binaryPath: this.binaryPath,
          ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
          stop,
        }),
      );
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * Run one captured CLI child's driver, handing it the stop {@link shutdown}
   * aborts, and hold it in {@link capturedChildren} until the driver settles,
   * so shutdown waits on the child's exit. A driver that returns without
   * spawning settles at once and does not delay shutdown.
   */
  private async runStoppableChild<TResult>(
    start: (stop: CapturedChildStop) => Promise<TResult>,
  ): Promise<TResult> {
    const stop = new AbortController();
    const run = start({
      signal: stop.signal,
      sigkillGraceMs: this.cancelSigkillGraceMs,
    });
    const child = {
      stop,
      settled: run.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.capturedChildren.add(child);
    try {
      return await run;
    } finally {
      this.capturedChildren.delete(child);
    }
  }

  /**
   * What a relay check of the working folder's `alcove.yaml` and `.alcove.key`
   * would contact, or why there is nothing to check ({@link relayCheckOffer}).
   * Reads the folder and contacts nothing.
   */
  relayCheckOffer(): RelayCheckOffer {
    return relayCheckOffer(this.dataRoot);
  }

  /**
   * Run the CLI's `doctor relay` over the working folder's pair, when the
   * `alcove.yaml` there is the one `configurationDigest` names
   * ({@link relayCheckOffer}). `exchange-running` while the slot holds an
   * exchange whose child has not exited, so the check never reads a pair a
   * run is rotating. One check at a time: the flag is claimed synchronously,
   * so a concurrent check is {@link RelayCheckBusyError} (a 409).
   */
  async checkRelay(args: {
    configurationDigest: string;
  }): Promise<
    | RelayCheckResult
    | { kind: "exchange-running" }
    | { kind: "configuration-changed" }
    | Extract<RelayCheckOffer, { kind: "unavailable" }>
  > {
    if (this.shuttingDown) throw new ConsoleShuttingDownError();
    if (this.relayCheckInFlight) throw new RelayCheckBusyError();
    const running = this.activeSlotRecord();
    if (
      this.slot?.phase === "starting" ||
      (running !== null && running.terminal === null)
    )
      return { kind: "exchange-running" };
    const offer = relayCheckOffer(this.dataRoot);
    if (offer.kind === "unavailable") return offer;
    if (offer.configurationDigest !== args.configurationDigest)
      return { kind: "configuration-changed" };
    this.relayCheckInFlight = true;
    try {
      return await this.runStoppableChild((stop) =>
        runRelayCheck({
          dataRoot: this.dataRoot,
          binaryPath: this.binaryPath,
          ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
          stop,
        }),
      );
    } finally {
      this.relayCheckInFlight = false;
    }
  }

  /**
   * The absolute path a `certificate`-mode job's composed `signing` block
   * names: the long-lived identity file at the location this run resolved
   * ({@link identityPathFor}).
   */
  private signingPathsFor(identityPath: string): JobSigningPaths {
    return { identityFile: identityPath };
  }

  /**
   * Create-or-reuse this party's signing identity and return its
   * fingerprint, by spawning the CLI's `fingerprint` subcommand against the
   * mounted identity file.
   *
   * `identityLabel` is the operator's `linkage_terms.identity`, bound into a
   * new identity and ignored (with the CLI's own warning) when one already
   * exists; `exportCertificate` additionally writes the public certificate to
   * a second fixed name in the same mount. The manager owns both paths, so no
   * request value is ever a path.
   *
   * Single-flight: the flag is claimed synchronously, so a concurrent
   * request is {@link SigningFingerprintBusyError} (a 409) rather than a
   * second child racing the same file.
   *
   * Creating the identity is answered `syncing` -- no child runs -- while a
   * filedrop exchange occupies the exchange slot and its rendezvous holds the
   * directory the key would be written into
   * ({@link mintWouldLandInSyncedFolder}); the run's own create-time refusal
   * cannot see a key that did not exist when it started.
   *
   * `identityLocation` is the operator's own location, or absent for the
   * console's default. Creation happens at the DEFAULT only: a location the
   * operator picked is one the console reads, so nothing there is answered
   * `absent` rather than minted. The console writes nowhere but the data root
   * except through the window below, and the operator's own mount is where they
   * keep a key they minted themselves, read-only if they chose.
   *
   * Whether anything is there is asked of what the picked path names at its END
   * ({@link signingIdentityTargetExists}): a link with nothing at its end is a
   * name the child would create THROUGH, so it is answered `absent` and no child
   * runs. That check and the child's load are two steps, so a file removed
   * between them is created by the child at the picked path -- the one write
   * into the operator's own mount, closed by mounting it read-only.
   *
   * @throws {SigningIdentityLocationError} when `identityLocation` does not
   *   resolve in the secrets mount.
   */
  async resolveSigningFingerprint(args: {
    identityLabel: string;
    exportCertificate: boolean;
    identityLocation?: JobSigningIdentityLocation;
  }): Promise<SigningFingerprintResult> {
    if (this.shuttingDown) throw new ConsoleShuttingDownError();
    if (this.fingerprintInFlight) throw new SigningFingerprintBusyError();
    const identityPath = resolveSigningIdentityPath({
      dataRoot: this.dataRoot,
      secretsDir: this.jobSecretsDir,
      location: args.identityLocation,
    });
    if (args.identityLocation !== undefined) {
      if (!signingIdentityTargetExists(identityPath)) return { kind: "absent" };
    } else if (this.mintWouldLandInSyncedFolder(identityPath))
      return { kind: "syncing" };
    this.fingerprintInFlight = true;
    try {
      return await this.runStoppableChild((stop) =>
        runSigningFingerprint({
          binaryPath: this.binaryPath,
          dataRoot: this.dataRoot,
          identityPath,
          identityLabel: args.identityLabel,
          ...(args.exportCertificate
            ? { exportPath: signingCertificatePath(this.dataRoot) }
            : {}),
          ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
          stop,
        }),
      );
    } finally {
      this.fingerprintInFlight = false;
    }
  }

  private async startJobInWorkdir(
    intent: JobCreateIntent,
    id: string,
    workdir: string,
    serverEntry: JobSftpServerEntry | undefined,
    mountedInputPath: string | undefined,
    identityPath: string,
    mountedKeyPath: string | undefined,
    opened: OpenedMountedConfiguration | undefined,
    workingFolderPair: WorkingFolderPair | undefined,
  ): Promise<string> {
    // Exchange composes a config document into the workdir, and a key file
    // beside it unless the run uses the one beside the opened configuration;
    // zero-setup writes NEITHER -- its connection rides argv and it has no
    // shared secret, so the workdir holds only input (when inline) and the run's
    // own artifacts. A webrtc run writes neither there: it runs on the
    // working folder's pair, the console's or the one the operator opened.
    const runsInWorkingFolder = intent.channel === "webrtc";
    let exchangeDocuments: ExchangeFilePaths | undefined;
    if (runsInWorkingFolder)
      exchangeDocuments = workingFolderExchangeFilePaths(this.dataRoot);
    else if (intent.mode !== "zeroSetup")
      exchangeDocuments = await this.writeExchangeDocuments(
        intent,
        workdir,
        serverEntry,
        identityPath,
        mountedKeyPath,
      );

    const inputPath = await this.writeJobInput(
      intent,
      workdir,
      mountedInputPath,
    );
    const logPath =
      intent.diagnosticRun === true
        ? workdirArtifactPath(workdir, JOB_FILE_NAMES.log)
        : null;
    // Only a certificate-mode exchange writes one. A zero-setup run composes no
    // config at all, so it has no signing block and never signs.
    const receiptRequested =
      intent.mode !== "zeroSetup" && intent.signing?.mode === "certificate";

    // The hand-off's merge base is the document the operator opened, as the
    // open read it, so a run authored here from scratch takes no held setting
    // from a configuration sitting in the mount that nobody read, and a file
    // changed since the open is reported rather than exported.
    const runsOpenedConfiguration =
      intent.mode !== "zeroSetup" && intent.mountedConfigurationOpened === true;
    const mountedDocument = opened?.document;
    const openedConfigurationNotice =
      runsOpenedConfiguration && !runsInWorkingFolder
        ? openedConfigurationWarning(this.dataRoot, opened)
        : undefined;
    const handoff = composedFromIntent(() =>
      buildJobHandoff(intent, serverEntry, {
        credentialPasted: this.authoredMaterializedCredentialPath !== undefined,
        filedropSplit: this.jobRendezvousOutboundDir !== undefined,
        keyFileBesideConfiguration: mountedKeyPath !== undefined,
        ...(mountedDocument !== undefined
          ? {
              mountedDocument,
              mountedDocumentConverted:
                intent.mode !== "zeroSetup" &&
                intent.mountedConfigurationConverted === true,
            }
          : {}),
      }),
    );

    const record: JobRecord = {
      id,
      workdir,
      runStamp: null,
      runStampResolved: false,
      logPath,
      receiptRequested,
      partnerFingerprintPinnedAtCreation:
        intent.mode !== "zeroSetup" &&
        intent.signing?.partnerFingerprint !== undefined,
      exchangeFiles: exchangeDocuments ?? null,
      workingFolderPair: workingFolderPair ?? null,
      runsInWorkingFolder,
      status: "running",
      events: [],
      terminalEmitted: false,
      transportTeardownOverran: false,
      terminal: null,
      handle: null,
      listeners: new Set(),
      cancelTimers: [],
      handoff,
      termsProposalBasis:
        mountedKeyPath !== undefined
          ? { keyPath: mountedKeyPath, openedSource: opened?.source }
          : null,
      termsProposal: "none",
    };
    this.slot = {
      phase: "active",
      record,
      deleted: false,
      channel: intent.channel,
    };

    // One value for the preflight's recovery copy and for what the child is told
    // to do, so the notice cannot send the operator to a control this very launch
    // already has.
    const sweepExchangeFiles = intent.sweepExchangeFiles === true;

    if (openedConfigurationNotice !== undefined)
      this.appendEvent(
        record,
        buildSynthesizedWarningEvent(
          "relayOpenedConfigurationChanged",
          openedConfigurationNotice,
        ),
      );

    // Each leg preflights independently and names itself, so a split console's
    // two mounts raise their own notices rather than one set the operator cannot
    // attribute to a folder.
    if (intent.channel === "filedrop" && this.jobRendezvousDir !== undefined)
      for (const [dir, leg] of this.rendezvousLegs())
        for (const message of rendezvousStartupWarnings(
          dir,
          leg,
          this.jobInputDir,
          this.dataRoot,
          workdir,
          sweepExchangeFiles,
        ))
          this.appendEvent(
            record,
            buildSynthesizedWarningEvent("relayRendezvousPreflight", message),
          );

    const handlers: CliDriverHandlers = {
      onEvent: (event) => this.appendEvent(record, event),
      onDegraded: (source, message) =>
        this.appendEvent(
          record,
          buildSynthesizedWarningEvent(source, message, { degraded: true }),
        ),
      onTerminal: (state, diagnostics) =>
        this.reconcileTerminal(record, state, diagnostics),
    };

    if (this.shuttingDown) throw new ConsoleShuttingDownError();
    record.handle = this.spawnForMode(intent, {
      exchangeDocuments,
      serverEntry,
      inputPath,
      workdir,
      eventStream: intent.eventStream ?? true,
      runControls: {
        sweepExchangeFiles,
        logFilePath: logPath ?? undefined,
      },
      handlers,
    });

    return id;
  }

  /**
   * Compose and write the exchange mode's config and key files into the workdir,
   * returning their paths. The connection block is drawn only from the server-side
   * resources ({@link composeDocumentByChannel}); the key file holds the shared
   * secret. Given `mountedKeyPath`, no key file is written: the run reads the one
   * beside the opened configuration, and the CLI writes its rotated secret back
   * there. Not reached on the zero-setup path, which writes neither.
   */
  private async writeExchangeDocuments(
    intent: WorkdirComposedExchangeIntent,
    workdir: string,
    serverEntry: JobSftpServerEntry | undefined,
    identityPath: string,
    mountedKeyPath: string | undefined,
  ): Promise<ExchangeFilePaths> {
    const configDocument = composedFromIntent(() =>
      composeDocumentByChannel(
        intent,
        this.jobRendezvousDir,
        this.jobRendezvousOutboundDir,
        serverEntry,
        this.signingPathsFor(identityPath),
      ),
    );
    const configPath = await writeJobFile(
      workdir,
      JOB_FILE_NAMES.config,
      configDocument,
    );
    const keyPath =
      mountedKeyPath ??
      (await writeJobFile(
        workdir,
        JOB_FILE_NAMES.key,
        composeKeyFileDocument(intent),
      ));
    return { configPath, keyPath };
  }

  /**
   * Spawn the CLI for the intent's mode: an exchange run driven by the
   * composed config and key files, or a zero-setup run driven by the literal
   * positional `$0` form (URL plus, for sftp, `--server-*` flags), with no
   * `--config-file`, no `--key-file`, and never `--save`. The zero-setup
   * connection argv is built here from the same server-side resources the
   * exchange config draws on, so a missing one is a caller bug reported as a
   * hard error, not a silent fallback.
   */
  private spawnForMode(
    intent: JobCreateIntent,
    args: {
      exchangeDocuments: { configPath: string; keyPath: string } | undefined;
      serverEntry: JobSftpServerEntry | undefined;
      inputPath: string;
      workdir: string;
      eventStream: boolean;
      runControls: CliRunControls;
      handlers: CliDriverHandlers;
    },
  ): CliDriverHandle {
    const extraEnv = this.childEnv;
    if (intent.mode === "zeroSetup")
      return spawnZeroSetupJob({
        binaryPath: this.binaryPath,
        connectionArgs: this.zeroSetupConnectionArgs(intent, args.serverEntry),
        optionArgs: zeroSetupOptionsArgv(intent.options),
        inputPath: args.inputPath,
        workdir: args.workdir,
        eventStream: args.eventStream,
        runControls: args.runControls,
        ...(intent.identity !== undefined ? { identity: intent.identity } : {}),
        ...(intent.linkageStrategy !== undefined
          ? { linkageStrategy: intent.linkageStrategy }
          : {}),
        ...(intent.deduplicate !== undefined
          ? { deduplicate: intent.deduplicate }
          : {}),
        ...(intent.csvDelimiter !== undefined
          ? { csvDelimiter: intent.csvDelimiter }
          : {}),
        ...(extraEnv !== undefined ? { extraEnv } : {}),
        handlers: args.handlers,
      });

    if (args.exchangeDocuments === undefined)
      throw new Error("exchange job reached spawn with no composed documents");
    return spawnExchangeJob({
      binaryPath: this.binaryPath,
      configPath: args.exchangeDocuments.configPath,
      keyPath: args.exchangeDocuments.keyPath,
      inputPath: args.inputPath,
      workdir: args.workdir,
      eventStream: args.eventStream,
      runControls: args.runControls,
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      handlers: args.handlers,
    });
  }

  /**
   * The connection portion of a zero-setup CLI argv for the intent's channel: the
   * `sftp://` URL and `--server-*` flags from the authored connection, or the
   * `file://` rendezvous locator. Each arm requires the resource `createJob`
   * already resolved, so a missing one is a caller bug reported as a hard error.
   */
  private zeroSetupConnectionArgs(
    intent: JobCreateIntent,
    serverEntry: JobSftpServerEntry | undefined,
  ): Array<string> {
    if (intent.channel === "sftp") {
      if (serverEntry === undefined)
        throw new Error("sftp zero-setup job reached spawn without a server");
      return zeroSetupSftpArgv(serverEntry);
    }
    if (this.jobRendezvousDir === undefined)
      throw new Error(
        "filedrop zero-setup job reached spawn without a shared folder",
      );
    return zeroSetupFiledropArgv(
      this.jobRendezvousDir,
      this.jobRendezvousOutboundDir,
    );
  }

  /**
   * Resolve the path the CLI reads its input from. A `mountedInputPath` points the
   * CLI at the operator-mounted file in place (nothing is copied into the workdir);
   * otherwise the inline `inputCsv` content is written to the fixed workdir name.
   */
  private async writeJobInput(
    intent: JobCreateIntent,
    workdir: string,
    mountedInputPath: string | undefined,
  ): Promise<string> {
    if (mountedInputPath !== undefined) return mountedInputPath;
    if (intent.inputCsv !== undefined)
      return writeJobFile(workdir, JOB_FILE_NAMES.input, intent.inputCsv);
    // The exactly-one-of intent schema guarantees one input source; refuse a
    // caller that bypassed it rather than spawning the CLI on an empty input.
    throw new Error("job intent has neither inputCsv nor inputFile");
  }

  /**
   * Open the configuration mounted in the working folder for `GET
   * /api/jobs/config`, keeping it as opened for the run that follows.
   *
   * @throws {ConfigurationLoadRefusedError} when the file is not a
   *   configuration the console can open; nothing is then kept as opened.
   */
  openMountedConfiguration(): LoadedConfigurationResponse {
    this.openedConfiguration = undefined;
    const { response, opened } = openMountedConfiguration(
      this.dataRoot,
      this.jobSecretsDir,
    );
    this.openedConfiguration = opened;
    return response;
  }

  /**
   * Write the operator's edits into the opened configuration's file
   * ({@link handBackMountedConfiguration}), only while that file holds the
   * bytes this console opened or last wrote, so a save never replaces what a
   * run or another editor wrote since, such as a partner's recorded
   * fingerprint; and never while a run is using the file. Returns whether the
   * file was written: a hand-back of the configuration the file already
   * states writes nothing. A signed save of a file run in place that names no
   * identity file writes the path `signing.identityLocation` resolves to.
   *
   * @throws {ConfigurationHandBackRefusedError} when the file changed since,
   *   or a run is using it, or the write is refused.
   * @throws {ConfigurationLoadRefusedError} when the mount no longer holds a
   *   configuration this hand-back applies to.
   * @throws {SigningIdentityLocationError} when that location does not resolve
   *   in the secrets mount.
   */
  handBackOpenedConfiguration(handBack: JobConfigurationHandBack): {
    written: boolean;
  } {
    const running = this.activeSlotRecord();
    if (
      (this.slot?.phase === "starting" && this.slot.channel === "webrtc") ||
      (running !== null &&
        running.runsInWorkingFolder &&
        running.terminal === null)
    )
      throw new ConfigurationHandBackRefusedError(CONFIGURATION_IN_USE_MESSAGE);
    const opened = this.openedConfiguration;
    if (
      opened === undefined ||
      !mountedConfigurationUnchanged(this.dataRoot, opened.source)
    )
      throw new ConfigurationHandBackRefusedError(
        CONFIGURATION_CHANGED_SINCE_OPENED_MESSAGE,
        CONFIGURATION_CHANGED_SAVE_REFUSAL,
      );
    const written = handBackMountedConfiguration(
      this.dataRoot,
      handBack,
      this.consoleWrittenConfiguration,
      () =>
        resolveSigningIdentityPath({
          dataRoot: this.dataRoot,
          secretsDir: this.jobSecretsDir,
          location: handBack.signing.identityLocation,
        }),
    );
    if (written === undefined) return { written: false };
    this.openedConfiguration = { ...opened, source: written };
    this.consoleWrittenConfiguration = written;
    return { written: true };
  }

  /**
   * The active record when the slot holds one matching this id and it has not
   * been deleted, else undefined. A deleted (but not-yet-freed) slot shows
   * 404 here.
   */
  getJob(id: string): JobRecord | undefined {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record.id === id &&
      !slot.deleted
    )
      return slot.record;
    return undefined;
  }

  /** The uniform view for a job, or null when no live record matches the id. */
  getJobView(id: string): JobView | null {
    const record = this.getJob(id);
    return record !== undefined ? liveJobView(record) : null;
  }

  /**
   * What a job's folder holds, for the exchange the console holds or for a
   * folder a restart left behind under a valid id, or null when there is no such
   * folder. The slot's own id while it is starting or deleted is null too: its
   * folder belongs to a child that is not done with it. The leftover arm applies
   * the same containment and real-directory guards the disk-only DELETE does.
   */
  async describeJobFolder(id: string): Promise<JobFolderView | null> {
    const live = this.getJob(id) !== undefined;
    if (!live && this.slotId() === id) return null;
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir === null) return null;
    if (!(await workdirDirectoryExists(workdir))) return null;
    return { live, contents: readJobFolderContents(workdir) };
  }

  /**
   * The id of the exchange occupying the single slot, or null when free.
   * Occupied is exactly the states {@link ExchangeBusyError} refuses on -- a
   * starting or active exchange, including one deleted whose child is still
   * dying -- so `GET /api/jobs/slot` and the busy create disclose the same
   * occupant. Delegates to {@link slotId}, the same value `createJob` puts in
   * the busy error.
   */
  occupiedSlotId(): string | null {
    return this.slotId();
  }

  /**
   * The recurring-run hand-off for a job, or null when no live record matches the
   * id (an unknown, deleted, or restart-forgotten job). Held on the record from
   * creation, so it is available across the run's whole lifetime -- the panel reads
   * it at completion, but the endpoint's 404 discipline keys on job existence, not
   * status.
   */
  getJobHandoff(id: string): JobHandoff | null {
    const record = this.getJob(id);
    return record !== undefined ? record.handoff : null;
  }

  /**
   * Append an event to a job's buffer with the next monotonic id, notify SSE
   * listeners, and enforce the cap. On overflow the job is failed with a
   * synthesized error terminal so a supervisor always sees a terminal event.
   */
  private appendEvent(record: JobRecord, event: RelayEvent): void {
    if (record.terminalEmitted) return;
    if (record.events.length >= this.eventBufferCap) {
      this.failOnOverflow(record);
      return;
    }
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event: relayedForConsole(record, event),
    };
    record.events.push(entry);
    this.notifyListeners(record, entry);
    if (
      event.type === "error" &&
      record.termsProposalBasis !== null &&
      statesWrittenTermsProposal(event)
    )
      record.termsProposal = "available";
    if (event.type === "result") {
      const stamp = stampOfResultPath(event.resultPath);
      if (stamp !== null) {
        record.runStamp = stamp;
        record.runStampResolved = true;
      }
    }
    if (event.type === "result" || event.type === "error")
      this.markTerminalEmitted(record, event.type);
  }

  /**
   * Apply the terms proposal a run of the opened configuration ended on to the
   * mounted configuration, by running the CLI's `alcove apply`
   * ({@link runTermsProposalApply}); the console writes nothing itself.
   *
   * `unavailable` where no live job has the id or its run wrote no proposal
   * this console can apply, or one was already applied; `busy` while an apply
   * is running or the run's child has not exited; `configuration-changed`
   * where the mounted `alcove.yaml` is no longer the one the run was opened
   * from, so the change the operator was shown is not the one the file would
   * take on; `run-terms-differ` where the run's own configuration states
   * other linkage terms than that file, for the same reason.
   */
  async applyTermsProposal(
    id: string,
  ): Promise<
    | TermsProposalApplyResult
    | { kind: "unavailable" | "busy" | "configuration-changed" }
  > {
    if (this.shuttingDown) throw new ConsoleShuttingDownError();
    const record = this.getJob(id);
    const basis = record?.termsProposalBasis ?? null;
    if (
      record === undefined ||
      basis === null ||
      record.termsProposal !== "available"
    )
      return { kind: "unavailable" };
    if (this.termsApplyInFlight || record.terminal === null)
      return { kind: "busy" };
    if (
      basis.openedSource === undefined ||
      !mountedConfigurationUnchanged(this.dataRoot, basis.openedSource)
    )
      return { kind: "configuration-changed" };
    this.termsApplyInFlight = true;
    try {
      const result = await this.runStoppableChild((stop) =>
        runTermsProposalApply({
          binaryPath: this.binaryPath,
          dataRoot: this.dataRoot,
          workdir: record.runsInWorkingFolder ? this.dataRoot : record.workdir,
          keyPath: basis.keyPath,
          ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
          stop,
        }),
      );
      if (result.kind === "applied") record.termsProposal = "applied";
      return result;
    } finally {
      this.termsApplyInFlight = false;
    }
  }

  /**
   * Notify every SSE listener of one buffered entry, isolating each: a listener
   * whose enqueue throws (a controller in an unexpected state) is dropped rather
   * than allowed to propagate out of the fd-3 relay and break every other
   * subscriber's stream.
   */
  private notifyListeners(record: JobRecord, entry: BufferedEvent): void {
    for (const listener of record.listeners) {
      try {
        listener(entry);
      } catch {
        record.listeners.delete(listener);
      }
    }
  }

  /** Fail a job whose event buffer overflowed, appending a synthesized error. */
  private failOnOverflow(record: JobRecord): void {
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event: {
        v: 1,
        type: "error",
        category: "exchange",
        message:
          "event stream exceeded the buffer cap; failing the job to avoid " +
          "dropping events",
      },
    };
    record.events.push(entry);
    this.notifyListeners(record, entry);
    this.markTerminalEmitted(record, "error");
    record.status = "failed";
    record.handle?.signal("SIGKILL");
  }

  /** Record that a terminal event has been buffered and close SSE streams. */
  private markTerminalEmitted(
    record: JobRecord,
    terminalType: "result" | "error",
  ): void {
    record.terminalEmitted = true;
    if (record.status === "running")
      record.status = terminalType === "result" ? "succeeded" : "failed";
  }

  /**
   * Reconcile the child's exit into the job's terminal state. An
   * already-emitted CLI terminal event stands; otherwise one is synthesized
   * to match the exit: cancelled -> a `cancelled`-flavored error, succeeded
   * -> a `result`, persistence loss -> a non-retryable `output`-category
   * error, an internal fault -> an `exchange`-category error marked
   * `internalFault`, which withholds its retry, anything else -> a stream-broke
   * `exchange`-category error.
   *
   * The exit decides the outcome; the terminal event's type decides the
   * status the result route gates on. A persistence loss with the CLI's own
   * `result` terminal is therefore `succeeded` and serves its result, with
   * the loss named on `terminal.outcome`; with no terminal event at all the
   * status is `failed` and nothing is offered.
   *
   * A synthesized failure names what the CLI printed on stderr
   * ({@link diagnosedTerminal}): that terminal stands in for the diagnosis the
   * run never emitted, and the tail is the only account of it the console
   * holds. An interrupt takes none -- the operator asked for the exit -- and a
   * run that emitted its own terminal event is synthesized nothing at all, so
   * no diagnosis reaches the operator twice.
   *
   * A run that terminated itself and then reported protocol files left by an
   * unfinished transport close puts that report on
   * {@link JobRecord.transportTeardownOverran}, for the status body to hand a
   * client: the report is on the tail this run's own terminal left unread, and
   * that terminal has closed the event stream. A run whose terminal was
   * synthesized states nothing there -- that terminal's cause link already holds
   * the end of the tail, the report among it.
   *
   * The only slot-release point besides the pre-spawn create failure: fires
   * on the child's `close`, so a killed child is confirmed dead before
   * {@link maybeFreeSlot} frees the slot for a successor.
   */
  private reconcileTerminal(
    record: JobRecord,
    state: JobTerminalState,
    diagnostics: CliRunDiagnostics,
  ): void {
    record.terminal = state;
    if (record.workingFolderPair !== null) {
      record.workingFolderPair.latest = workingFolderExchangeFileDigests(
        this.dataRoot,
      );
      if (this.slotDeleted(record))
        this.removeUnchangedPair(record.workingFolderPair, "was discarded");
    }
    if (!record.runStampResolved) {
      record.runStamp = latestRunStampIn(record.workdir);
      record.runStampResolved = true;
    }
    this.clearCancelTimers(record);

    // An already-emitted terminal is authoritative: a job failed on buffer
    // overflow signals SIGKILL, and if the child's own clean exit is observed
    // before that kill lands, this exit outcome must not overwrite the failed
    // status the overflow already committed.
    if (!record.terminalEmitted) {
      if (state.outcome === "succeeded") record.status = "succeeded";
      else if (state.outcome === "cancelled") record.status = "cancelled";
      else record.status = "failed";

      if (state.outcome === "cancelled")
        this.synthesizeTerminal(record, {
          v: 1,
          type: "error",
          category: "exchange",
          message:
            state.exitCode === 130 || state.signal === "SIGINT"
              ? "run cancelled (SIGINT)"
              : "run cancelled (SIGTERM)",
          cancelled: true,
        });
      else if (state.outcome === "succeeded")
        this.synthesizeTerminal(record, {
          v: 1,
          type: "result",
          resultWritten: true,
        });
      else if (state.outcome === "completedWithPersistenceLoss")
        this.synthesizeTerminal(
          record,
          diagnosedTerminal(
            "output",
            "the run reported a lost local write and its event stream broke " +
              "before naming which one, so this console cannot confirm which " +
              "files reached disk; look in the folder it writes its exchange " +
              "files to",
            diagnostics.stderrTail,
          ),
        );
      else if (state.exitCode === INTERNAL_FAULT_EXIT_CODE)
        this.synthesizeTerminal(record, {
          ...diagnosedTerminal(
            "exchange",
            internalFaultStopMessage(
              record.logPath !== null && jobFileExists(record.logPath),
              diagnostics.stderrTail !== null,
            ),
            diagnostics.stderrTail,
          ),
          internalFault: true,
          recoveryHint: true,
        });
      else
        this.synthesizeTerminal(
          record,
          diagnosedTerminal(
            "exchange",
            "CLI exited without a terminal event; the event stream broke" +
              (state.exitCode !== null ? ` (exit ${state.exitCode})` : ""),
            diagnostics.stderrTail,
          ),
        );
    } else
      record.transportTeardownOverran = diagnostics.transportTeardownOverran;

    this.maybeFreeSlot(record);
    this.shutdownWaits.get(record)?.resolveExited();
  }

  /** Whether the slot holds this record, deleted. */
  private slotDeleted(record: JobRecord): boolean {
    const slot = this.slot;
    return (
      slot !== null &&
      slot.phase === "active" &&
      slot.record === record &&
      slot.deleted
    );
  }

  /**
   * Free the slot exactly when it is active for this record, the exchange
   * was deleted, and the child's exit has been observed
   * (`record.terminal !== null`, set only in {@link reconcileTerminal}).
   * Keyed on `terminal` rather than `terminalEmitted` (which the overflow
   * path sets while a SIGKILLed child may still be running): no path frees
   * the slot while a killed child might still touch the shared rendezvous or
   * remote directory.
   */
  private maybeFreeSlot(record: JobRecord): void {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record === record &&
      slot.deleted &&
      record.terminal !== null
    )
      this.slot = null;
  }

  /** Append a synthesized terminal event and close the streams. */
  private synthesizeTerminal(record: JobRecord, event: RelayEvent): void {
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event,
    };
    record.events.push(entry);
    this.notifyListeners(record, entry);
    this.markTerminalEmitted(
      record,
      event.type === "result" ? "result" : "error",
    );
  }

  /**
   * Register an SSE listener that receives every event with an id strictly
   * greater than `afterId` (the Last-Event-ID offset; 0 replays from the start).
   * Returns the buffered replay and an unsubscribe. When the job has already
   * emitted its terminal event, no live listener is registered -- the replay is
   * the complete history.
   */
  subscribe(
    record: JobRecord,
    afterId: number,
    onEntry: (entry: BufferedEvent) => void,
  ): { replay: Array<BufferedEvent>; unsubscribe: () => void } {
    const replay = record.events.filter((entry) => entry.id > afterId);
    if (record.terminalEmitted) return { replay, unsubscribe: () => undefined };
    record.listeners.add(onEntry);
    return {
      replay,
      unsubscribe: () => {
        record.listeners.delete(onEntry);
      },
    };
  }

  /**
   * Cancel a running job: SIGINT first, escalate to SIGTERM after a grace, then
   * SIGKILL as a last resort. The escalation timers are cleared when the child
   * exits, so a child that stops on SIGINT is never over-signaled. A job already
   * terminal is a no-op.
   */
  cancelJob(record: JobRecord): void {
    if (record.terminal !== null || record.handle === null) return;
    if (!record.handle.isRunning()) return;
    record.handle.signal("SIGINT");
    const toSigterm = setTimeout(() => {
      if (record.handle?.isRunning()) record.handle.signal("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
      }, this.cancelSigkillGraceMs);
      record.cancelTimers.push(toSigkill);
      toSigkill.unref();
    }, this.cancelSigtermGraceMs);
    record.cancelTimers.push(toSigterm);
    toSigterm.unref();
  }

  private clearCancelTimers(record: JobRecord): void {
    for (const timer of record.cancelTimers) clearTimeout(timer);
    record.cancelTimers = [];
  }

  /**
   * Delete a job: mark the slot deleted and remove the workdir on disk,
   * signaling a still-running child SIGKILL first. The slot is not freed
   * here when the child was still running -- a SIGKILL is asynchronous, so
   * the child may still be touching the rendezvous after this returns;
   * {@link reconcileTerminal} frees the slot on the child's `close`.
   *
   * When no live record matches the id, the disk-only arm removes a
   * restart-orphaned workdir named by a valid id, refusing the slot's own id
   * (a starting or already-deleted id whose directory a live or dying child
   * owns).
   */
  async deleteJob(id: string): Promise<boolean> {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record.id === id &&
      !slot.deleted
    ) {
      const record = slot.record;
      this.clearCancelTimers(record);
      if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
      slot.deleted = true;
      // A child still running is gone only once reconcileTerminal sees it
      // exit, which removes the pair then.
      if (record.workingFolderPair !== null && record.terminal !== null)
        this.removeUnchangedPair(record.workingFolderPair, "was discarded");
      const workdir = resolveWorkdir(this.dataRoot, id);
      if (workdir !== null) await removeWorkdir(workdir);
      this.maybeFreeSlot(record);
      return true;
    }
    return this.deleteOrphanWorkdir(id);
  }

  /**
   * Remove a restart-orphaned workdir named by a valid id: a disk-only
   * removal touching no in-memory state. Refuses the slot's own id (owned by
   * a live or still-dying child), then applies the containment check
   * ({@link resolveWorkdir}) and the real-directory guard
   * ({@link workdirDirectoryExists}, which lstats so a symlinked leaf is
   * refused rather than followed).
   */
  private async deleteOrphanWorkdir(id: string): Promise<boolean> {
    if (this.slotId() === id) return false;
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir === null) return false;
    if (!(await workdirDirectoryExists(workdir))) return false;
    await removeWorkdir(workdir);
    return true;
  }

  /** The id the slot currently holds, in either phase, or null when free. */
  private slotId(): string | null {
    if (this.slot === null) return null;
    return this.slot.phase === "starting" ? this.slot.id : this.slot.record.id;
  }

  /**
   * Shutdown hook: SIGTERM the running exchange child and every running
   * captured child -- the host-key probe, the signing fingerprint, the terms
   * apply, and the relay check -- SIGKILL each still running after the
   * SIGKILL grace, and resolve once their exits have been observed, so the
   * server exits only after the CLI's own cleanup and no orphaned CLI
   * outlives it. Resolves at once when none is running. A repeated call while
   * a child is stopping signals nothing further. From the first call on,
   * every spawn is refused with {@link ConsoleShuttingDownError}.
   */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    const exchangeStopped = this.stopExchangeChild();
    if (this.capturedChildren.size === 0) return exchangeStopped;
    const settled = [...this.capturedChildren].map((child) => {
      child.stop.abort();
      return child.settled;
    });
    return Promise.all([exchangeStopped, ...settled]).then(() => undefined);
  }

  /**
   * The exchange half of {@link shutdown}: signal the slot's running child
   * and return the promise of its exit, the same promise on a repeated call.
   */
  private stopExchangeChild(): Promise<void> {
    const slot = this.slot;
    if (slot === null || slot.phase !== "active") return Promise.resolve();
    const record = slot.record;
    if (record.terminal !== null || record.handle === null)
      return Promise.resolve();
    const inProgress = this.shutdownWaits.get(record);
    if (inProgress !== undefined) return inProgress.exited;

    let resolveExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    this.shutdownWaits.set(record, { exited, resolveExited });
    this.clearCancelTimers(record);
    record.handle.signal("SIGTERM");
    const toSigkill = setTimeout(() => {
      if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
    }, this.cancelSigkillGraceMs);
    record.cancelTimers.push(toSigkill);
    toSigkill.unref();
    return exited;
  }
}

/**
 * The record pair's availability for a live record, offered all-or-nothing:
 * the run has settled, both the record and keys files exist, and the record
 * parses into a `createdAt`, an `outcome`, and the certificate-mismatch marker.
 *
 * Gated on the record's own existence rather than the run having succeeded:
 * a record is owed from the moment this party's payload crosses
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed), so a run that
 * disclosed and then terminated writes one too. Settling is read separately
 * because the CLI writes the pair near the end of a run, so a mid-run ask
 * could read a half-written state. Settled is the child's exit, not its
 * terminal event: a failing run reports its error before it exits.
 *
 * `recordOutcome` travels with the availability so a client can tell a
 * terminated record (no result file behind it) from a completed one, and
 * `recordCertificateMismatchObserved` beside it so a client can tell a run that
 * found the partner's certificate was not the pinned identity from one that
 * found no such thing. `RecordUnavailableReason` separates the console's definitive denial
 * from a record on disk this bundle cannot describe.
 */
function liveRecordAvailability(record: JobRecord):
  | { recordAvailable: false; recordUnavailableReason: RecordUnavailableReason }
  | {
      recordAvailable: true;
      recordCreatedAt: string;
      recordOutcome: ExchangeRecordOutcome;
      recordCertificateMismatchObserved: boolean;
    } {
  const withheld = (recordUnavailableReason: RecordUnavailableReason) => ({
    recordAvailable: false as const,
    recordUnavailableReason,
  });
  if (record.terminal === null) return withheld("not-settled");
  const artifacts = runArtifactsOf(record);
  if (artifacts === null || !jobFileExists(artifacts.record))
    return withheld("no-record");
  const summary = readRecordSummary(artifacts.record);
  if (summary === null || !jobFileExists(artifacts.keys))
    return withheld("undescribable-record");
  return {
    recordAvailable: true,
    recordCreatedAt: summary.createdAt,
    recordOutcome: summary.outcome,
    recordCertificateMismatchObserved: summary.certificateMismatchObserved,
  };
}

/** How the cause link naming the child's stderr introduces it. */
const STDERR_CAUSE_LABEL = "the CLI last wrote on stderr: ";

/**
 * A synthesized terminal naming what the CLI printed on stderr, so an operator
 * whose run emitted no terminal event reads the cause rather than only that the
 * stream broke.
 *
 * The tail rides a LABELLED CAUSE LINK of its own rather than being
 * interpolated into the first-party message, and it is the branded type that
 * holds that apart rather than this site's own care: the tail arrives as a
 * {@link PartnerOriginText}, which no `+`, template or `join` accepts, so
 * `errorWithPartnerCauseLinks` is the only way to put it in front of an
 * operator and the labelling, redacting, control-replacing and fitting are its
 * obligation. What that buys the reader of this console: a chooser's bytes
 * composed into the first-party sentence could spell whatever delimiter closed
 * them and read on as console copy, which on the persistence-loss terminal is a
 * do-not-repeat instruction the operator must not misread.
 *
 * The flat `message` field stays this console's own text at every width of
 * tail, and a run whose child wrote nothing carries no chain at all, which the
 * seat reads as the flat field.
 *
 * `keep: "end"` is what the tail needs of the fit: a run writes its diagnosis
 * last, so a cut taken from the front deletes exactly the line the link exists
 * to carry.
 */
function diagnosedTerminal(
  category: "output" | "exchange",
  message: string,
  stderrTail: PartnerOriginText | null,
): RelayEvent {
  const chain =
    stderrTail === null
      ? null
      : rawChainLinks(
          errorWithPartnerCauseLinks(message, STDERR_CAUSE_LABEL, stderrTail, {
            keep: "end",
          }),
        );
  return {
    v: 1,
    type: "error",
    category,
    message,
    ...(chain === null ? {} : { [ERROR_MESSAGE_CHAIN_FIELD]: chain }),
  };
}

/**
 * The message of the terminal synthesized for a run that exited
 * {@link INTERNAL_FAULT_EXIT_CODE} with no terminal event: what stopped it, and
 * what to report it with -- the run log where this run captured one, else the
 * stderr link beside the message, else the message itself.
 */
function internalFaultStopMessage(
  logCaptured: boolean,
  stderrLinked: boolean,
): string {
  const reportWith = logCaptured
    ? "the run log this page offers to download"
    : stderrLinked
      ? "what the CLI last wrote on stderr, below"
      : "this message";
  return (
    "the exchange process stopped on a fault in Alcove itself before " +
    `reporting it (exit ${INTERNAL_FAULT_EXIT_CODE}); report the fault with ` +
    reportWith
  );
}

/**
 * An error's own message and each of its causes' messages, in order, as the
 * relay's chain field holds them -- RAW, since the seat rendering the chain
 * escapes each link once ({@link CliRunDiagnostics}).
 *
 * It reads a plain `Error`, so it is no second way out of the branded type: the
 * links it returns are whatever built the error, and for a synthesized terminal
 * that is the one elimination, which has already labelled, redacted,
 * control-replaced and fitted every partner byte on them.
 *
 * Walked to `MAX_ERROR_CAUSE_DEPTH`, the depth the relay's own derivation of
 * this field stops at (`sanitizeErrorChainLinks` in {@link CliRunDiagnostics}'s
 * module), so the field holds the same shape whichever route filled it and no
 * chain can walk without end.
 */
function rawChainLinks(error: Error): Array<string> {
  const links: Array<string> = [];
  let link: unknown = error;
  while (link instanceof Error && links.length < MAX_ERROR_CAUSE_DEPTH) {
    links.push(link.message);
    link = (link as { cause?: unknown }).cause;
  }
  return links;
}

/**
 * A fixed-name artifact's path inside a job workdir, resolved through the
 * containment check {@link resolveWorkdirFile} rather than joined directly.
 * Every name is a server constant, so a null resolution is a caller bug --
 * reported as a hard error rather than a path outside the workdir the
 * artifact's endpoint would then serve.
 */
/**
 * The warning a run of the opened configuration raises when what it composes
 * from is not what the working folder holds now, or undefined when the two
 * agree. The run and its hand-off state the configuration as it was opened;
 * the notice names the file and says how to run what it holds instead.
 */
function openedConfigurationWarning(
  dataRoot: string,
  opened: OpenedMountedConfiguration | undefined,
): string | undefined {
  if (opened === undefined)
    return (
      "The console has no record of the alcove.yaml you opened, so the " +
      "recurring-run configuration for this run holds only the settings " +
      "shown on these pages. To include the file's other settings, open the " +
      "configuration again and start a new run."
    );
  if (mountedConfigurationUnchanged(dataRoot, opened.source)) return undefined;
  return (
    "The alcove.yaml in your working folder changed after you opened it. " +
    "This run and its recurring-run configuration use the settings as you " +
    "opened them, not the changed file. To use the changed file, open the " +
    "configuration again and start a new run."
  );
}

/**
 * Whether `named` is the authored server: the same host, the same port once
 * an omitted one is read as the authored scheme's default, and the same path
 * once it ends in `/`, as the authored one does. A run also names the relay
 * it uses, or none where none is authored: an acceptor's the accepted
 * invitation's, and an inviter's the locator an invitation names for the
 * console's own ({@link ownRelayInvitationLocator}).
 */
function namesSignalingServer(
  named: NonNullable<JobWebrtcExchangeIntent["signalingServer"]>,
  authored: AuthoredSignalingServer,
  side: JobWebrtcExchangeIntent["side"],
): boolean {
  const defaultPort = authored.secure ? 443 : 80;
  const path = named.path.endsWith("/") ? named.path : `${named.path}/`;
  return (
    named.host === authored.host &&
    (named.port ?? defaultPort) === (authored.port ?? defaultPort) &&
    path === authored.path &&
    isDeepStrictEqual(
      named.relay,
      side === "acceptor"
        ? authored.invitationRelay
        : ownRelayInvitationLocator(authored.ownRelay),
    )
  );
}

function workdirArtifactPath(workdir: string, name: string): string {
  const artifactPath = resolveWorkdirFile(workdir, name);
  if (artifactPath === null)
    throw new Error(`the job ${name} did not resolve inside the workdir`);
  return artifactPath;
}

/**
 * The event the browser is served in place of the one the child emitted: the
 * first-contact pin messages and the notice of payload columns taken without
 * asking, whose CLI wording names the configuration file written, a path
 * inside this container. Every other event passes through untouched.
 */
function relayedForConsole(record: JobRecord, event: RelayEvent): RelayEvent {
  if (event.type === "warning")
    return withConsolePayloadReceiveTakenNotice(
      rewrittenPartnerPinNotice(record, event),
      record.handoff.mode,
    );
  if (event.type === "error")
    return rewrittenTermsProposalRefusal(
      record,
      rewrittenPartnerPinFailure(record, event),
    );
  return event;
}

/**
 * Whether a relayed `error` event states that its run wrote the partner's
 * changed terms beside its configuration (`termsChange` in
 * docs/spec/CLI_EVENTS.md).
 */
function statesWrittenTermsProposal(event: RelayEvent): boolean {
  const termsChange = event.termsChange;
  return (
    event.category === "config" &&
    termsChange !== null &&
    typeof termsChange === "object" &&
    (termsChange as { proposalWritten?: unknown }).proposalWritten === true
  );
}

/** The console's account of a run of the opened configuration that stopped on
 * a partner terms change and wrote it as a proposal. */
export const TERMS_PROPOSAL_REFUSAL =
  "Your partner's linkage terms changed since your last exchange, so this " +
  "run stopped before any linkage key or data moved and your configuration " +
  "was not changed. Review the change below. Apply it to the alcove.yaml in " +
  "your working folder and run the exchange again, or start over to leave " +
  "the configuration as it is.";

/** The console's account of any other run that stopped on a partner terms
 * change and wrote it as a proposal: its configuration is composed per run,
 * so there is nothing on the mount to apply the change to. */
export const TERMS_CHANGE_REFUSAL =
  "Your partner's linkage terms differ from the terms this run was given, " +
  "so it stopped before any linkage key or data moved. Review the change " +
  "below, agree on the terms with your partner, and start over.";

/**
 * Replace the CLI's refusal of a partner terms change it wrote as a proposal,
 * whose wording names the container paths of the job's composed configuration
 * and an `alcove apply` command for them, with the console's own account.
 * Every other event passes through untouched.
 */
function rewrittenTermsProposalRefusal(
  record: JobRecord,
  event: RelayEvent,
): RelayEvent {
  if (!statesWrittenTermsProposal(event)) return event;
  const message =
    record.termsProposalBasis !== null
      ? TERMS_PROPOSAL_REFUSAL
      : TERMS_CHANGE_REFUSAL;
  return { ...event, message, [ERROR_MESSAGE_CHAIN_FIELD]: [message] };
}

/**
 * Replace the CLI's first-contact pin notice with the console's own, which
 * states the recorded fingerprint and names no file.
 *
 * The CLI's wording names the configuration file it wrote the pin into, a path
 * inside this container: every other console surface holds paths back, and a
 * relayed warning is no exception. The value is read out of the configuration
 * the CLI was started with rather than out of the sentence
 * ({@link recordedPartnerFingerprint}); for a webrtc run that is the working
 * folder's `alcove.yaml`, where the pin stays for the next exchange.
 *
 * A run whose composed configuration already named a partner fingerprint had no
 * first contact to report, so its warning relays in the CLI's own words rather
 * than taking console copy stating a pin was adopted
 * ({@link JobRecord.partnerFingerprintPinnedAtCreation}).
 *
 * Gated on the run signing receipts as well, the gate the failure rebuild below
 * holds: only a signing run pins anything, so console copy about a pin this run
 * adopted is composed only where this server launched a run that could adopt one
 * ({@link JobRecord.receiptRequested}).
 */
function rewrittenPartnerPinNotice(
  record: JobRecord,
  event: RelayEvent,
): RelayEvent {
  if (
    event.source !== PARTNER_CERTIFICATE_PINNED_SOURCE ||
    !record.receiptRequested ||
    record.partnerFingerprintPinnedAtCreation
  )
    return event;
  return {
    ...event,
    message: partnerCertificatePinnedNotice(
      recordedPartnerFingerprint(runConfigurationPath(record)),
      record.runsInWorkingFolder,
    ),
  };
}

/** The configuration the CLI was started with: the working folder's for a
 * webrtc run, the one composed into the workdir for any other exchange. */
function runConfigurationPath(record: JobRecord): string {
  return (
    record.exchangeFiles?.configPath ??
    workdirArtifactPath(record.workdir, JOB_FILE_NAMES.config)
  );
}

/**
 * Replace the terminal failure of a first contact whose pin could not be
 * recorded with the console's own, which names no file and asks for the value
 * out of band -- the CLI's remedies are an edit of that file and a writable
 * mount of it, neither of which a console operator can act on.
 *
 * The failure is identified from what this server knows rather than from the
 * child's wording: the run signs receipts, its composed configuration holds no
 * pin, so no first contact has been recorded, and the message states the path
 * of that configuration, which is the whole of what must not cross. Both the
 * flat field and the derived chain are read, since the path may sit in either,
 * and both are replaced together so the seat shows the console's sentence
 * whichever it reads ({@link ERROR_MESSAGE_CHAIN_FIELD}).
 *
 * Both sides of that search are display text: a data root holding a backslash or
 * any character outside printable ASCII reaches the event as its escape, and a
 * raw spelling would not be found there -- leaving the path to cross. The path
 * is escaped to the same form rather than the event's text unescaped, since the
 * escaped text is what would reach the operator
 * ({@link configPathAsRelayed}). Matching one spelling of one path is a stopgap:
 * the general close is a partner-origin type that makes a path-bearing message
 * unrenderable at this boundary rather than searched for here.
 */
function rewrittenPartnerPinFailure(
  record: JobRecord,
  event: RelayEvent,
): RelayEvent {
  if (event.category !== "config" || !record.receiptRequested) return event;
  const configPath = runConfigurationPath(record);
  const searchedPath = configPathAsRelayed(configPath);
  if (
    !errorDisplayStrings(event).some((text) => text.includes(searchedPath)) ||
    recordedPartnerFingerprint(configPath) !== undefined
  )
    return event;
  return {
    ...event,
    message: PARTNER_PIN_UNRECORDABLE_FAILURE,
    [ERROR_MESSAGE_CHAIN_FIELD]: [PARTNER_PIN_UNRECORDABLE_FAILURE],
  };
}

/**
 * A container path as it reads on a relayed `error` event, which is the form
 * {@link rewrittenPartnerPinFailure} has to search for.
 *
 * TWO display escapes stand between the path and that search, not one. The CLI
 * escapes its whole terminal message where it builds the event (`buildErrorEvent`
 * in `apps/cli/src/eventStream.ts`), and the relay escapes every string field it
 * validates again at the trust boundary (`validateAndSanitizeEvent` in
 * `./cliDriver.ts`, whose derivation of the chain field escapes per link). The
 * second pass doubles the first pass's backslashes, so a data root spelled
 * `root-\xfc` after the CLI's escape reads `root-\\xfc` on the event and a
 * once-escaped needle does not occur in it. A path of printable ASCII with no
 * backslash is unchanged by either pass, so this is the one spelling that
 * matches whatever the path holds.
 *
 * `Infinity` on both passes: what is wanted here is the escape and not the cap,
 * whose truncation is the callers' own and would cut the needle short.
 */
function configPathAsRelayed(configPath: string): string {
  return sanitizeForDisplay(
    sanitizeForDisplay(configPath, { maxLength: Infinity }),
    { maxLength: Infinity },
  );
}

/** Every string a relayed `error` event puts in front of the operator: the flat
 * message field and the links of the chain the relay derived from it, which is
 * what the seat renders when it holds any text. */
function errorDisplayStrings(event: RelayEvent): Array<string> {
  const chain = event[ERROR_MESSAGE_CHAIN_FIELD];
  return [event.message, ...(Array.isArray(chain) ? chain : [])].filter(
    (text): text is string => typeof text === "string",
  );
}

/**
 * This run's artifact paths inside its workdir, or null while its stamp is not
 * known. The run is the one its `result` event named; a run whose event named
 * no result file is the latest whose artifacts the workdir holds once the child
 * has exited, read once in the exit handler and kept. Every path is
 * under that one stamp, so a workdir holding several runs' artifacts never
 * serves one run's result beside another's record.
 */
function runArtifactsOf(record: JobRecord): RunArtifactPaths | null {
  return record.runStamp === null
    ? null
    : runArtifactPaths(record.workdir, record.runStamp);
}

/** The live view of an in-memory record, mirroring what the routes report. */
function liveJobView(record: JobRecord): JobView {
  const artifacts = runArtifactsOf(record);
  const receiptPath =
    record.receiptRequested && artifacts !== null ? artifacts.receipt : null;
  return {
    id: record.id,
    status: record.status,
    terminal: record.terminal,
    terminalEmitted: record.terminalEmitted,
    eventCount: record.events.length,
    resultAvailable: record.status === "succeeded",
    ...liveRecordAvailability(record),
    // Both answer from the log path set at creation from the intent, so what a
    // client is told about this run's log comes from what the console
    // launched rather than from anything the reading request holds.
    logRequested: record.logPath !== null,
    // Not gated on the run having finished: a diagnostic log's whole point is a
    // run that misbehaved, including one still stalled, so it is offered as soon
    // as the CLI has opened the file.
    logAvailable: record.logPath !== null && jobFileExists(record.logPath),
    // Answered from the receipt path set at creation from the intent, exactly as
    // the log pair above is: what a client is told about this run's receipt comes
    // from what the console launched.
    receiptRequested: record.receiptRequested,
    receiptAvailable: receiptPath !== null && jobFileExists(receiptPath),
    transportTeardownOverran: record.transportTeardownOverran,
    outputPath: artifacts?.result ?? null,
    recordPath: artifacts?.record ?? null,
    keysPath: artifacts?.keys ?? null,
    logPath: record.logPath,
    receiptPath,
    resultFileName:
      artifacts !== null ? runArtifactNames(artifacts.stamp).result : null,
  };
}

/** An exchange whose configuration is composed into its workdir. A webrtc
 * exchange runs on the working folder's files instead. */
type WorkdirComposedExchangeIntent = Exclude<
  JobExchangeIntent,
  JobWebrtcExchangeIntent
>;

/**
 * Compose the CLI config document for the intent's channel: filedrop
 * rendezvous in the operator-configured rendezvous mount; sftp rendezvous at
 * the operator-authored connection. Each arm requires the resource `createJob`
 * already resolved, so a missing one here is a caller bug reported as a hard
 * error, not a silent fallback.
 */
function composeDocumentByChannel(
  intent: WorkdirComposedExchangeIntent,
  rendezvousDir: string | undefined,
  outboundRendezvousDir: string | undefined,
  serverEntry: JobSftpServerEntry | undefined,
  signingPaths: JobSigningPaths,
): string {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp job reached compose without a resolved server");
    return composeSftpConfigDocument(intent, serverEntry, signingPaths);
  }
  if (rendezvousDir === undefined)
    throw new Error("filedrop job reached compose without a shared folder");
  return composeConfigDocument(
    intent,
    rendezvousDir,
    outboundRendezvousDir,
    signingPaths,
  );
}
