import {
  FileSyncConnection,
  fromEventConnection,
  DEFAULT_PEER_INACTIVITY_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_KEY,
  getLogger,
  InternalConsistencyError,
  assertSharedSecretReadyForHandshake,
  handshakeRoleForRendezvousRole,
  redactAndSanitizeForDisplay,
  UsageError,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type {
  HandshakeRole,
  MessageConnection,
  PreparedExchange,
  FileDropConnectionConfig,
  RelayCredential,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@alcove/core";

import { LocalFSClient } from "../connection/localFSClient";
import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import { INACTIVITY_TIMEOUT_GUIDANCE } from "../connection/timeoutGuidance";
import {
  brokerLocationFromConnection,
  iceServersFromConnection,
  relayCredentialForRun,
  relayCredentialNotice,
  relayCredentialPerAttempt,
} from "../connection/webrtc/weriftPeer";
import { assertFirstRoundFits } from "../firstRoundFits";
import { preflightKeyFilePath } from "../keyFilePreflight";
import type {
  AuthPersist,
  FileSyncRuntimeOptions,
  ProtocolConnectionConfig,
  SigningPersist,
} from "../protocol";
import { withFirstRoundCountDisplay } from "../psiProgressDisplay";
import { checkPsiMemoryBudget, readMemory } from "../psiMemoryBudget";
import { psiEngineRunsInWorker } from "../psiWorkerHost";
import {
  preflightOutputFolder,
  runFilesInSharedFolderWarnings,
} from "../resultFile";
import {
  openEventStream,
  reportLogFileLoss,
  type EventStreamEmitter,
} from "../eventStream";
import {
  entryHelloResidueGuidance,
  payloadSendBeyondConfigurationNotice,
  peerSilenceGuidance,
  SIGNING_WITHOUT_RECORD_WARNING,
  undeclaredColumnsNotice,
} from "./notices";

import type { WebRtcMessageConnectionOptions } from "../connection/webrtc/webrtcMessageConnection";
import type { WebRtcPeerOptions } from "../connection/webrtc/weriftPeer";

/**
 * The refusal a webrtc exchange gets when the run holds no shared secret.
 *
 * Both parties derive the signaling id they register under, and the one they
 * dial, from the shared secret, so with none there is no address and the
 * broker has nothing to pair the two sockets by. This is why the zero-setup
 * bootstrap -- whose assumption is that the parties share nothing beforehand
 * -- cannot run over this channel; the refusal names that rather than
 * reporting the channel itself as unsupported.
 */
export const WEBRTC_RENDEZVOUS_SECRET_REQUIRED =
  "the webrtc channel needs a shared secret: both parties derive the " +
  "signaling ids they meet at from it, so without one there is no address to " +
  "dial. Establish one with 'alcove invite' and 'alcove accept', then run " +
  "'alcove exchange'.";

/**
 * The refusal a webrtc connection with no `role` gets.
 *
 * The two parties register under complementary ids, so each has to know which
 * end it is; a config missing the field is a misconfiguration that would
 * otherwise show up as a rendezvous that never completes. `alcove invite` and
 * `alcove accept` stamp it, so a config missing it was hand-authored.
 */
export const WEBRTC_ROLE_REQUIRED =
  "this webrtc connection has no `role`: each party registers with the " +
  "coordination server under the id its own role derives, and dials the id the " +
  "other's does. Set `role: inviter` or `role: acceptor` on the connection " +
  "block.";

/** The webrtc rendezvous inputs, resolved before anything is dialed. */
interface WebRtcDial {
  /** The key-exchange role this party takes once the channel is open. */
  handshakeRole: HandshakeRole;
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions;
}

/**
 * Resolve a webrtc connection and this run's shared secret into the rendezvous
 * the transport is opened with. Every failure it can raise is locally knowable,
 * so it runs in {@link runProtocol}'s prepare block, before any socket is
 * opened.
 *
 * The rendezvous roles are asymmetric and so is the handshake: the acceptor
 * dials the data channel and sends the first key-exchange message, the inviter
 * listens and answers. A browser peer maps the two the same way
 * (`apps/web/src/psi/authenticateExchange.ts`), which is what lets a CLI peer
 * complete an exchange with one.
 *
 * @param runRelayCredential This run's minted TURN credential
 *   (`relayCredentialForRun`), for the TURN urls the connection's invitation
 *   relay names or its own `turn` entries that set no username or credential;
 *   unused when every selected TURN entry sets its own. When one is given,
 *   each connection attempt after the first mints its own
 *   (`relayCredentialPerAttempt`).
 * @throws {UsageError} when the run holds no shared secret, when the connection
 *   names no role, when the server block cannot be resolved to a broker, or
 *   when the connection sets `ice_provision` (via `iceServersFromConnection`).
 * @internal exported for testing
 */
export function webRtcDialFrom(
  connection: WebRTCConnectionConfig,
  sharedSecret: string | undefined,
  runRelayCredential?: RelayCredential,
): WebRtcDial {
  if (sharedSecret === undefined)
    throw new UsageError(WEBRTC_RENDEZVOUS_SECRET_REQUIRED);
  const { role } = connection;
  if (role === undefined) throw new UsageError(WEBRTC_ROLE_REQUIRED);
  // peer_timeout_ms bounds the partner's arrival (the rendezvous) and
  // inactivity_timeout_ms a present partner's silence on the open channel.
  // Neither reaches the channel open between them: once both descriptions are
  // exchanged the partner is present, and a channel that still does not open
  // is a network path failure, held to the transport's fixed ceiling.
  const peerTimeoutMs = connection.options?.peerTimeoutMs;
  const inactivityTimeoutMs = connection.options?.inactivityTimeoutMs;
  return {
    handshakeRole: handshakeRoleForRendezvousRole(role),
    options: {
      location: brokerLocationFromConnection(connection.server),
      role,
      sharedSecret,
      iceServers: iceServersFromConnection(connection, runRelayCredential),
      ...(runRelayCredential !== undefined && {
        attemptIceServers: relayCredentialPerAttempt(connection, sharedSecret),
      }),
      ...(connection.iceTransportPolicy !== undefined && {
        iceTransportPolicy: connection.iceTransportPolicy,
      }),
      ...(peerTimeoutMs !== undefined && {
        rendezvousTimeoutMs: peerTimeoutMs,
      }),
      ...(inactivityTimeoutMs !== undefined && { inactivityTimeoutMs }),
    },
  };
}

/**
 * The parked-receive deadline a file-sync run's message bridge applies: the
 * configured `inactivity_timeout_ms`, else core's default. `peer_timeout_ms`
 * bounds the rendezvous in `FileSyncConnection.open()` and never this.
 *
 * @internal exported for testing
 */
export function fileSyncInactivityTimeoutMs(
  connection: SFTPConnectionConfig | FileDropConnectionConfig,
): number {
  return (
    connection.options?.inactivityTimeoutMs ??
    DEFAULT_PEER_INACTIVITY_TIMEOUT_MS
  );
}

/** What {@link checkRunLocalInputs} resolves, for the transport to be built from. */
interface RunLocalInputs {
  trimmedKeyFilePath?: string;
  webRtcDial?: WebRtcDial;
  runRelayCredential?: RelayCredential;
}

/**
 * Emit {@link SIGNING_WITHOUT_RECORD_WARNING} -- on both stderr and the
 * machine-interface stream -- when a signed run has no record output: a
 * receipt no verifier can ever pair to its run, and nothing after the
 * exchange can repair it. Raised before any credential, terms, or data are
 * sent, while both choices are still the operator's to change, and before
 * every other local check, so a run refused by one of them still shows the
 * warning ahead of its terminal error.
 *
 * `preflightRun` and `prepareTransport` each call this ahead of their own
 * {@link checkRunLocalInputs} pass. The caller threads its own return value
 * back in as `alreadyWarned` on the later call, so the same run emits it at
 * most once regardless of which of the two calls actually raises the
 * refusal.
 */
function warnSigningWithoutRecord(params: {
  signing: SigningPersist | null;
  writeRecord: boolean;
  alreadyWarned: boolean;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
}): boolean {
  const { signing, writeRecord, alreadyWarned, log, emit } = params;
  if (alreadyWarned || signing === null || writeRecord) return alreadyWarned;
  log.warn(SIGNING_WITHOUT_RECORD_WARNING);
  emit((e) =>
    e.warning("signingWithoutRecord", SIGNING_WITHOUT_RECORD_WARNING),
  );
  return true;
}

/**
 * Emit {@link undeclaredColumnsNotice} -- on both stderr and the
 * machine-interface stream -- when the input has columns metadata does not
 * declare, so the operator can add them or silence the notice before any
 * credential, terms, or data are sent. Composes the text through
 * `undeclaredColumnsNotice`, the one place the notice is worded.
 *
 * `preflightRun` and `prepareTransport` each call this ahead of their own
 * {@link checkRunLocalInputs} pass, the same shape as
 * {@link warnSigningWithoutRecord}: the caller threads its own return value
 * back in as `alreadyWarned` on the later call, so the same run emits it at
 * most once regardless of which of the two calls actually raises the
 * refusal. A command that opens its own stream and runs no `preflightRun`
 * calls this itself before its host-key step, then passes the result to
 * `runProtocol` as `undeclaredColumnsWarned`.
 */
export function warnUndeclaredColumns(params: {
  prepared: Pick<PreparedExchange, "undeclaredColumns">;
  alreadyWarned: boolean;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
  /** The notice's closing remedy, for a run with no configuration to edit. */
  remedy?: string;
}): boolean {
  const { prepared, alreadyWarned, log, emit, remedy } = params;
  if (alreadyWarned) return alreadyWarned;
  const undeclaredNotice = undeclaredColumnsNotice(prepared, remedy);
  if (undeclaredNotice === undefined) return alreadyWarned;
  log.warn(
    redactAndSanitizeForDisplay(undeclaredNotice, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  );
  emit((e) => e.warning("undeclaredColumns", undeclaredNotice));
  return true;
}

/**
 * Log the memory a PSI round over this party's input needs against what the
 * process has, and refuse the run when the need is over it -- or, under
 * `--allow-memory-shortfall`, warn on stderr and the machine-interface stream
 * and continue. Decided from local inputs alone, so it runs before any
 * network contact. A caller that runs it passes `memoryBudgetReported` to
 * `runProtocol` so a later pass of the same run does not repeat it.
 */
export function checkRunMemoryBudget(params: {
  prepared: Pick<PreparedExchange, "rowCount">;
  allowMemoryShortfall: boolean;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
}): void {
  const { prepared, allowMemoryShortfall, log, emit } = params;
  checkPsiMemoryBudget({
    records: prepared.rowCount,
    allowShortfall: allowMemoryShortfall,
    readings: readMemory(psiEngineRunsInWorker()),
    log,
    onShortfallWarning: (message) => {
      log.warn(message);
      emit((e) => e.warning("memoryShortfall", message));
    },
  });
}

/**
 * The run's refusals decided from local inputs alone: the output folder
 * ({@link preflightOutputFolder}), the shared secret's readiness and its
 * key-file path, the memory the round needs
 * ({@link checkRunMemoryBudget}, skipped when `memoryBudgetReported`), the
 * first round's size against one message on the channel, and on webrtc the
 * rendezvous resolution. None of them contacts the network, so
 * {@link preflightRun} runs them ahead of a command's own first network
 * contact as well.
 */
async function checkRunLocalInputs(params: {
  connection: ProtocolConnectionConfig;
  prepared: PreparedExchange;
  output: string | undefined;
  auth: AuthPersist | null;
  verbosity: number;
  logFile: string | undefined;
  allowMemoryShortfall: boolean;
  memoryBudgetReported: boolean;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
}): Promise<RunLocalInputs> {
  const {
    connection,
    prepared,
    output,
    auth,
    verbosity,
    logFile,
    allowMemoryShortfall,
    memoryBudgetReported,
    log,
    emit,
  } = params;
  if (output !== undefined) preflightOutputFolder(output, log);
  let trimmedKeyFilePath: string | undefined;
  if (auth) {
    // Fail fast on the locally-knowable secret preconditions -- a malformed
    // or already-expired shared secret -- before any credential is
    // presented, rather than letting a dead credential drive the file-sync
    // rendezvous first, whose losing side would then get a misleading
    // "peer abandoned the handshake" hint for what is really an expired or
    // malformed secret. authenticateConnection still runs the same check
    // as the authoritative boundary for library consumers that bypass
    // runProtocol. The shared check's errors state their own next step, so
    // runProtocol's catch block suppresses its generic advisory.
    assertSharedSecretReadyForHandshake(auth);
    // Validate and trim the key-file path before any credential is
    // presented, so a misconfiguration fails here rather than at
    // saveKeyFile post-handshake, before the partner could be left holding
    // a rotated token this side cannot persist. The trimmed path is the one
    // saveKeyFile writes after the handshake.
    trimmedKeyFilePath = preflightKeyFilePath(auth.keyFilePath, log);
  }
  // The memory check reads only the record count, so it is decided before the
  // first-round count walks the input.
  if (!memoryBudgetReported)
    checkRunMemoryBudget({ prepared, allowMemoryShortfall, log, emit });
  // A first round over the protocol's per-set maximum is refused before the
  // rendezvous is resolved, before the transport is built, and before anything
  // is sent.
  await withFirstRoundCountDisplay({ verbosity, logFile, log }, (report) =>
    assertFirstRoundFits(prepared, report),
  );
  if (connection.channel !== "webrtc") return { trimmedKeyFilePath };
  // Resolve the rendezvous -- broker location, ICE servers, role, and the
  // secret both ids derive from -- here rather than at the dial, so a
  // misconfigured connection fails with no socket opened and no id
  // registered.
  const runRelayCredential = await relayCredentialForRun(
    connection,
    auth?.sharedSecret,
    new Date(),
  );
  return {
    trimmedKeyFilePath,
    runRelayCredential,
    webRtcDial: webRtcDialFrom(
      connection,
      auth?.sharedSecret,
      runRelayCredential,
    ),
  };
}

/**
 * Emit the operational-counter summary, and report any `--log-file` lines
 * lost, ahead of a terminal event, so the terminal event stays last on the
 * stream. `client` is the file-sync transport client, when one was built.
 */
export function emitRunMetrics(
  eventStream: EventStreamEmitter | undefined,
  rowCount: number,
  client: LocalFSClient | SSH2SFTPClientAdapter | undefined,
): void {
  reportLogFileLoss(eventStream);
  eventStream?.metrics(
    rowCount,
    client?.transportRetryCount ?? 0,
    client?.reconnectCount ?? 0,
  );
}

/**
 * Report a refusal raised before the run's first network contact on the
 * machine-interface stream, as {@link preflightRun} does its own: the counter
 * summary, then the terminal `error` event in the "prepare" phase. For a
 * command that opens the stream itself and runs no `preflightRun`.
 */
export function emitPrepareRefusal(
  eventStream: EventStreamEmitter | undefined,
  rowCount: number,
  err: unknown,
): void {
  emitRunMetrics(eventStream, rowCount, undefined);
  eventStream?.error(err, "prepare");
}

/** What {@link preflightRun} resolves with. */
export interface PreflightRunResult {
  /** The opened machine-interface stream; `undefined` when not requested. */
  eventStream: EventStreamEmitter | undefined;
  /**
   * Whether this preflight already emitted
   * {@link SIGNING_WITHOUT_RECORD_WARNING}. The caller passes it back to
   * `runProtocol` (`signingWithoutRecordWarned`) so `prepareTransport`'s own
   * pass does not repeat it.
   */
  signingWithoutRecordWarned: boolean;
  /**
   * Whether this preflight already emitted {@link undeclaredColumnsNotice}.
   * The caller passes it back to `runProtocol`
   * (`undeclaredColumnsWarned`) so `prepareTransport`'s own pass does not
   * repeat it.
   */
  undeclaredColumnsWarned: boolean;
  /**
   * Whether this preflight already logged the run's memory statement
   * ({@link checkRunMemoryBudget}). The caller passes it back to
   * `runProtocol` (`memoryBudgetReported`) so `prepareTransport`'s own pass
   * does not repeat it.
   */
  memoryBudgetReported: boolean;
}

/**
 * Open the run's machine-interface stream, unless the command passes the one
 * it opened, and run {@link runProtocol}'s refusals decided from local inputs,
 * for a command whose own first network contact comes before `runProtocol`. A
 * refusal emits the run's one terminal `error` event, in the "prepare" phase
 * `runProtocol` would have given it, and is rethrown. Resolves with the open
 * stream, which the caller passes to `runProtocol` as
 * `fileSyncRuntime.eventStream`; `runProtocol` runs the same checks again, and
 * a first round already counted is not counted twice.
 *
 * `signing` and `writeRecord` are the same run's signed-receipt inputs, so a
 * signed run this preflight refuses still shows
 * {@link SIGNING_WITHOUT_RECORD_WARNING} ahead of the terminal error, as a
 * run this preflight passes does ahead of `runProtocol`'s own pass. Omit both
 * on an unsigned run.
 *
 * `prepared` also carries this run's undeclared columns, if any, so a run
 * this preflight refuses still shows {@link undeclaredColumnsNotice} ahead of
 * the terminal error, in the same "emit once, at either call" shape.
 */
export async function preflightRun(options: {
  connection: ProtocolConnectionConfig;
  auth: AuthPersist | null;
  prepared: PreparedExchange;
  /** The run's `OUTPUT` folder, as `runProtocol` is given it. */
  output: string | undefined;
  signing?: SigningPersist | null;
  writeRecord?: boolean;
  verbosity: number;
  loggerName: string;
  logFile?: string;
  /** The stream the command opened, or the `--event-stream` flag to open it. */
  eventStream: boolean | EventStreamEmitter | undefined;
  /** `--allow-memory-shortfall`: warn rather than refuse a memory shortfall. */
  allowMemoryShortfall?: boolean;
}): Promise<PreflightRunResult> {
  const {
    connection,
    auth,
    prepared,
    output,
    signing = null,
    writeRecord = false,
    verbosity,
    loggerName,
    logFile,
    allowMemoryShortfall = false,
  } = options;
  // A command opens its stream once, ahead of its configuration load, and
  // passes the emitter here: a second open would install a second writer whose
  // exit-boundary reporter replaces the first one's.
  const eventStream =
    typeof options.eventStream === "object"
      ? options.eventStream
      : openEventStream(options.eventStream);
  const emit = (fn: (e: EventStreamEmitter) => void): void => {
    if (eventStream !== undefined) fn(eventStream);
  };
  const log = getLogger(loggerName);
  const signingWithoutRecordWarned = warnSigningWithoutRecord({
    signing,
    writeRecord,
    alreadyWarned: false,
    log,
    emit,
  });
  const undeclaredColumnsWarned = warnUndeclaredColumns({
    prepared,
    alreadyWarned: false,
    log,
    emit,
  });
  try {
    await checkRunLocalInputs({
      connection,
      prepared,
      output,
      auth,
      verbosity,
      logFile,
      allowMemoryShortfall,
      memoryBudgetReported: false,
      log,
      emit,
    });
  } catch (err) {
    emitPrepareRefusal(eventStream, prepared.rowCount, err);
    throw err;
  }
  return {
    eventStream,
    signingWithoutRecordWarned,
    undeclaredColumnsWarned,
    memoryBudgetReported: true,
  };
}

/**
 * What the preparation stage builds: the transport pieces the run then opens
 * and exchanges over, plus the validated key-file path. Filled in place rather
 * than returned, so a throw partway through still leaves the caller holding
 * whatever was already constructed -- the terminal metrics event reads the
 * client's counters, which a failure after its construction must not lose.
 */
export interface PreparedTransport {
  trimmedKeyFilePath?: string;
  webRtcDial?: WebRtcDial;
  client?: LocalFSClient | SSH2SFTPClientAdapter;
  fileSync?: FileSyncConnection;
  transport?: MessageConnection;
}

/**
 * The run's preparation stage: check the channel and the caller's contract,
 * confirm the shared secret and its key-file path, then construct the
 * transport for this channel. Everything here runs before the exchange's own
 * try block, so a throw is a "prepare"-phase fault and no connection has been
 * opened.
 */
export async function prepareTransport(
  build: PreparedTransport,
  params: {
    connection: ProtocolConnectionConfig;
    prepared: PreparedExchange;
    output: string | undefined;
    auth: AuthPersist | null;
    saveIntent: boolean | undefined;
    onAuthenticated: (() => void | Promise<void>) | undefined;
    signing: SigningPersist | null;
    writeRecord: boolean;
    signingWithoutRecordWarned: boolean;
    undeclaredColumnsWarned: boolean;
    allowMemoryShortfall: boolean;
    memoryBudgetReported: boolean;
    verbosity: number;
    logFile: string | undefined;
    fileSyncRuntime: FileSyncRuntimeOptions;
    log: ReturnType<typeof getLogger>;
    emit: (fn: (e: EventStreamEmitter) => void) => void;
  },
): Promise<void> {
  const {
    connection,
    prepared,
    output,
    auth,
    saveIntent,
    onAuthenticated,
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
  } = params;
  if (
    connection.channel !== "filedrop" &&
    connection.channel !== "sftp" &&
    connection.channel !== "webrtc"
  ) {
    // Only reachable via an unsafe cast past ProtocolConnectionConfig. The
    // `never` binding holds the other half at build time: it compiles only
    // while the dispatch below covers every channel the type admits.
    const unsupported: never = connection;
    throw new InternalConsistencyError(
      `unsupported channel: ` +
        (unsupported as unknown as { channel: string }).channel,
    );
  }

  // saveIntent drives the zero-setup `--save` bootstrap, which exists only
  // on the unauthenticated path: an authenticated exchange has a
  // persistent key already and no provisioning step to consume a bootstrap
  // result, so a stray saveIntent here would advertise a save field inside
  // the authenticated channel with nothing reading it back. Reject the
  // combination rather than leave the mistake open to a future caller.
  if (auth && saveIntent !== undefined)
    throw new InternalConsistencyError(
      "saveIntent is only valid on an unauthenticated (zero-setup) exchange; " +
        "an authenticated exchange must not pass it",
    );
  // The mirror constraint: onAuthenticated hooks the moment of acceptance,
  // which exists only on the authenticated path -- its invocation below is
  // nested in `if (auth)`. Reject a hook supplied with `auth: null` up
  // front, so a future caller wiring a hook to a zero-setup exchange gets
  // a clear error instead of a persistence step that never runs.
  if (!auth && onAuthenticated !== undefined)
    throw new InternalConsistencyError(
      "onAuthenticated is only valid on an authenticated exchange; an " +
        "unauthenticated (zero-setup) exchange has no acceptance step to hook",
    );
  // The signed-receipt step binds the receipt to the session key, which
  // only the authenticated key exchange produces. Reject a signing config
  // on the unauthenticated (`auth: null`) path up front: there is no
  // session key to derive the replay binder from, so a caller that wired
  // it would get a receipt-less exchange with no signal why.
  if (!auth && signing !== null)
    throw new InternalConsistencyError(
      "a signing identity is only valid on an authenticated exchange; an " +
        "unauthenticated (zero-setup) exchange has no session key to bind the " +
        "signed receipt to",
    );
  // A caller that ran preflightRun already raised
  // SIGNING_WITHOUT_RECORD_WARNING and passed that back as
  // signingWithoutRecordWarned; a caller that did not run preflightRun (or
  // whose preflight had no signing/writeRecord to check) has it raised here,
  // still ahead of every check below.
  warnSigningWithoutRecord({
    signing,
    writeRecord,
    alreadyWarned: signingWithoutRecordWarned,
    log,
    emit,
  });
  // A caller that already raised undeclaredColumnsNotice, from preflightRun
  // or its own warnUndeclaredColumns call, passed that back as
  // undeclaredColumnsWarned; any other run has it raised here, still ahead of
  // every check below.
  warnUndeclaredColumns({
    prepared,
    alreadyWarned: undeclaredColumnsWarned,
    log,
    emit,
  });
  const payloadSendNotice = payloadSendBeyondConfigurationNotice(prepared);
  if (payloadSendNotice !== undefined) {
    log.warn(
      redactAndSanitizeForDisplay(payloadSendNotice, {
        maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
      }),
    );
    emit((e) => e.warning("payloadSendBeyondConfiguration", payloadSendNotice));
  }
  const checked = await checkRunLocalInputs({
    connection,
    prepared,
    output,
    auth,
    verbosity,
    logFile,
    allowMemoryShortfall,
    memoryBudgetReported,
    log,
    emit,
  });
  build.trimmedKeyFilePath = checked.trimmedKeyFilePath;
  for (const warning of runFilesInSharedFolderWarnings({
    connection,
    output,
    writeRecord,
    keyFilePath: checked.trimmedKeyFilePath,
  }))
    log.warn(warning);
  if (connection.channel === "webrtc") {
    // The file-sync construction below has no webrtc counterpart: on this
    // channel there is no client to build.
    build.webRtcDial = checked.webRtcDial;
    if (checked.runRelayCredential !== undefined)
      log.info(relayCredentialNotice(connection, checked.runRelayCredential));
  } else {
    const client =
      connection.channel === "filedrop"
        ? new LocalFSClient()
        : new SSH2SFTPClientAdapter({
            verbosity,
            // connection_per_poll (SFTP-only) turns on the adapter's
            // ephemeral-session mode: a fresh session per poll cycle, released
            // before the idle gap. Resolved from the merged config; undefined
            // (unset) leaves the adapter's held-session default.
            ephemeralSessions: connection.options?.connectionPerPoll,
          });
    build.client = client;
    // CLI-only sweep controls are passed straight to the constructor (the
    // verbose/joinerRecoveryMs precedent), never through config.options, so they
    // cannot be persisted to alcove.yaml. Spread conditionally so an unset value
    // does not clobber the constructor default.
    const fileSyncConn = new FileSyncConnection(client, {
      verbose: verbosity,
      ...(fileSyncRuntime.sweepExchangeFiles !== undefined && {
        sweepExchangeFiles: fileSyncRuntime.sweepExchangeFiles,
      }),
      ...(fileSyncRuntime.forceRetainSweep !== undefined && {
        forceRetainSweep: fileSyncRuntime.forceRetainSweep,
      }),
      inactivityTimeoutGuidance: INACTIVITY_TIMEOUT_GUIDANCE,
    });
    build.fileSync = fileSyncConn;

    // The PSI protocol layer (authenticateConnection / runExchange)
    // consumes the pull-based MessageConnection interface. Bridge the
    // event-based FileSyncConnection through fromEventConnection so its
    // data/error events reach awaited receive() calls with no per-phase
    // listener gap. The bridge bounds a parked receive() by the
    // peer-inactivity budget, so a silent peer fails as a transport error
    // rather than hanging.
    // inactivityHint enriches the generic peer-silence error with
    // file-sync operator guidance: the receiver names its own cause
    // locally, but the sender only sees the inactivity timeout, so this
    // points at the likely receiver-side causes (peerSilenceGuidance).
    // Supplied as a function because which guidance applies depends on the
    // rendezvous outcome, known only after this bridge is built and read
    // from the connection when the deadline fires.
    build.transport = fromEventConnection(fileSyncConn, {
      inactivityTimeoutMs: fileSyncInactivityTimeoutMs(connection),
      inactivityTimeoutSetting: INACTIVITY_TIMEOUT_KEY,
      inactivityHint: (limitNamed) => {
        const leftover = fileSyncConn.unconfirmedEntryPeerHello;
        return leftover === undefined
          ? peerSilenceGuidance(limitNamed)
          : entryHelloResidueGuidance(leftover);
      },
    });
  }
}
