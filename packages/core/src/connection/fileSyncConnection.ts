import { default as EventEmitter } from "eventemitter3";
import { v4 as uuidv4 } from "uuid";

import { getLoggerForVerbosity } from "../utils/logger";
import { pathsResolveToSameDir } from "../utils/pathCompare";
import {
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
} from "../utils/sanitizeErrorForDisplay";
import {
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  INACTIVITY_TIMEOUT_KEY,
} from "../config/connection";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../config/connection";
import type { HandshakeRole } from "../types";
import {
  AuthenticationError,
  InternalConsistencyError,
  UsageError,
  ConnectionClosedError,
  TransportOperationStalledError,
  chainDetailCauses,
  errorMessage,
} from "../errors";
import { cancellableDelay } from "./fileSyncConstants";
import { ackMarkerName } from "./fileSyncNames";
import { FileSyncMessageLoop } from "./fileSyncMessageLoop";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import { joinFileSyncPath } from "./fileSyncPath";
import type { PresentedHostKey } from "./sftpConnect";
import { AbortMarkerSubsystem } from "./abortMarker";
import { SftpSession } from "./sftpSession";
export type { PresentedHostKey } from "./sftpConnect";
import {
  composeDirsDisplay,
  FileSyncRendezvous,
  type RendezvousScope,
} from "./fileSyncRendezvous";

/**
 * Canonicalize a `filedrop` connection path to its on-disk form: backslashes
 * folded to forward slashes and trailing slashes stripped, keeping a root
 * ("/", "C:/") intact. Exported so the CLI's config reconcile compares two
 * paths exactly as {@link FileSyncConnection.open} does.
 */
export function normalizeFiledropPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  const stripped = normalized.replace(/\/+$/, "");
  return /^[A-Za-z]:$/.test(stripped) ? stripped + "/" : stripped || "/";
}

// The terminal error for a transport await that outran the peer-inactivity
// budget: a UsageError, so the poll loop stops and the CLI exits 64. A path
// can be partner-chosen, so each gets its own cause link and cannot forge the
// label introducing another; values are redacted here and escaped where the
// message is shown. See
// docs/spec/CHANNEL_SECURITY.md#whole-exchange-budget.
const transportBudgetExceededError = (
  operation: string,
  budgetMs: number,
  targets: readonly string[] = [],
  guidance?: string,
  setting?: string,
): TransportOperationStalledError =>
  new TransportOperationStalledError(
    `a file operation got no answer within ${budgetMs} ms` +
      (setting === undefined ? "" : ` (the limit ${setting} sets)`) +
      `, so the exchange stopped waiting for it` +
      (guidance === undefined ? "" : `. ${guidance}`),
    {
      details: [
        `stalled operation: ${redactPrivateKeyMaterial(operation)}`,
        ...targets.map((target) => redactPrivateKeyMaterial(target)),
      ],
    },
  );

// Races `op` against `budgetMs`, rejecting with `makeError()` if the budget
// elapses first; the losing operation is abandoned, not cancelled. The timer is
// unref'd so it never holds the process open, and a late rejection from `op` is
// absorbed. See docs/spec/CHANNEL_SECURITY.md#whole-exchange-budget.
function withTransportBudget<T>(
  op: Promise<T>,
  budgetMs: number,
  makeError: () => TransportOperationStalledError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), budgetMs);
    timer.unref();
  });
  const settled = op.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

// withTransportBudget for safeDelete: resolves rather than rejects when the
// budget wins, keeping safeDelete's never-reject contract for callers in
// `catch` blocks.
function withTransportBudgetVoid(
  op: Promise<void>,
  budgetMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref();
  });
  const settled = op.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

/**
 * Default arrival budget when `peerTimeoutMs` is unset: how long this side
 * waits for the partner to arrive.
 */
export const DEFAULT_PEER_TIMEOUT_MS = 1000 * 60 * 60;
/**
 * Default peer-inactivity budget when `inactivityTimeoutMs` is unset: how long
 * one wait on a present peer or one transport operation may take. Also the
 * fallback for {@link fromEventConnection}'s inactivity deadline.
 */
export const DEFAULT_PEER_INACTIVITY_TIMEOUT_MS = 1000 * 60 * 60;
// Teardown bound on close()'s delete-mode wait for the peer to consume the last
// sent frame, applied as min(this, inactivityTimeoutMs); when it expires
// cleanup() deletes the frame as a fallback. Not a config setting. See
// docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close.
/** @internal */
export const TERMINAL_FRAME_DRAIN_TIMEOUT_MS = 1000 * 60;
// Teardown bound on core's wait for the transport's end(), applied as
// min(this, inactivityTimeoutMs). It abandons the wait only; a session-holding
// transport bounds its own close below this (FileTransportClient.end). Not a
// config setting. See docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close.
/** @internal */
export const CONNECTION_CLOSE_TIMEOUT_MS = 1000 * 30;
/**
 * Default poll interval, in milliseconds, when `pollIntervalMs` is unset;
 * exported so the CLI's config template pre-fills the same value. Not
 * sub-second: a faster cadence can trip an SFTP server's anti-flood protection
 * and drop the connection (seen at 100 ms), and PSI encryption dominates an
 * exchange's time anyway.
 */
export const DEFAULT_POLLING_FREQUENCY_MS = 5000;
const DEFAULT_VERBOSITY = 1;

// Wall-clock allowance for a peer's publish-and-rename to land: how long the
// lock-path peer waits for a joiner whose `<id>-joining.json` sentinel is
// visible, and the floor under every poll-cycle rendezvous bound
// (rendezvousBoundMs), so lowering it can abort a live partner mid-round-trip.
// Capped at the remaining peerTimeoutMs; not a config setting. See
// docs/spec/FILE_SYNC.md#phase-1----entry-present-peer-hello.
const DEFAULT_JOINER_RECOVERY_MS = 1000 * 30;

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

interface Options {
  // When unset, open() derives it from peerTimeoutMs after connecting.
  timeToLive?: Date;
  pollingFrequency: number;
  verbose: number;
  timestampInFilename: boolean;
  locklessRendezvous: boolean;
  peerId?: string;
  retainFiles: boolean;
  // For a file that appears mid-loop and is neither an exchange file nor a
  // temp write. Unset resolves to a mode-dependent default at the use site
  // (resolveUnexpectedFilesPolicy); an explicit value wins.
  unexpectedFiles?: "error" | "warn" | "ignore";
  // CLI-only and never persisted (--sweep-exchange-files): absent from
  // FileSyncOptions and its schema, so it reaches here only through the
  // constructor. See
  // docs/spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate.
  sweepExchangeFiles: boolean;
  // Lets the sweep clear a directory that shows a retain signal; the CLI
  // refuses it without sweepExchangeFiles.
  forceRetainSweep: boolean;
  // See DEFAULT_JOINER_RECOVERY_MS. Not in the public config; tests lower it to
  // reach the abort path without a real-time wait.
  joinerRecoveryMs: number;
  // A sentence appended to a timeout failure naming the setting that bounds
  // it. Unset leaves the message bare.
  inactivityTimeoutGuidance?: string;
}

const getDefaultOptions = (): Options => {
  return {
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY,
    timestampInFilename: false,
    locklessRendezvous: false,
    retainFiles: false,
    sweepExchangeFiles: false,
    forceRetainSweep: false,
    joinerRecoveryMs: DEFAULT_JOINER_RECOVERY_MS,
  };
};

export interface FileInfo {
  name: string;
  // Not read by the rendezvous tiebreaker, which orders on UUID because sync
  // tools stamp transfer time rather than creation time.
  modifyTime: number;
  // poll() compares it against the byte count a message filename declares, so a
  // partially synced file is not read as a complete message.
  size: number;
}

export interface PutOptions {
  mode?: number | string;
  flags?: "w" | "a";
  encoding?: null | string;
}

/**
 * Body for {@link FileTransportClient.put}: one `Buffer`, or an ordered chunk
 * list written back-to-back without concatenating, so a binary frame takes ~1x
 * its size in memory. A chunk list, like a Buffer, can be re-read for a retry;
 * a stream gets one attempt and is not produced by this codebase.
 */
export type PutSource = Buffer | Uint8Array[] | NodeJS.ReadableStream;

export interface GetOptions {
  mode?: number | string;
  flags?: "r";
  encoding?: null | string;
  handle?: null | string;
  /**
   * Most bytes the read may pull into memory: a larger file is refused with a
   * {@link FrameSizeExceededError}, so allocation stays near `maxBytes` even
   * when a server under-reports the size in its listing. Required: no read is
   * uncapped. A capped read resolves to a raw Buffer; `encoding` is ignored.
   */
  maxBytes: number;
}

/**
 * Abstract file transport used by {@link FileSyncConnection}. Implemented by
 * {@link SSH2SFTPClientAdapter} for real SFTP servers and by `LocalFSClient`
 * for locally-mounted network folders.
 */
export interface FileTransportClient {
  /**
   * Options are defined by each transport. Whether a client may be dialed
   * again after {@link FileTransportClient.end} is per-transport:
   * `LocalFSClient.connect()` is a stateless access check, while
   * {@link SSH2SFTPClientAdapter} refuses a dial after `end()` and a repeat dial
   * over a live session (apps/cli/test/integration/sftpStackPremises.test.ts).
   * Build a new client to re-dial portably. See D10 in
   * docs/notes/sftp-adapter-state-machine.md.
   */
  connect: (options: Record<string, unknown>) => Promise<void>;
  /**
   * Ends the connection. Must return within seconds and may return without a
   * clean close: a session-holding transport bounds its own wait for the other
   * side and closes from its own. Best-effort: {@link FileSyncConnection.close}
   * logs a rejection at debug and proceeds. Core's own bound
   * ({@link CONNECTION_CLOSE_TIMEOUT_MS}) abandons the wait only.
   */
  end: () => Promise<void>;
  list: (path: string) => Promise<Array<FileInfo>>;
  get: (path: string, options: GetOptions) => Promise<Buffer<ArrayBufferLike>>;
  put: (src: PutSource, dest: string, options?: PutOptions) => Promise<unknown>;
  delete: (path: string) => Promise<void>;
  /**
   * Removes `path`, swallowing all errors (file-absent, permission, transport).
   * Implementations must never reject so callers may use this in `catch` blocks
   * to clean up without masking the original error.
   */
  safeDelete: (path: string) => Promise<void>;
  rename: (fromPath: string, toPath: string) => Promise<void>;
  /**
   * Creates an empty file at `path` atomically. Throws with
   * `code === "EEXIST"` (or an equivalent server error) if `path` already
   * exists, giving atomic "only one winner" semantics for the lock-file race.
   */
  createExclusive: (path: string) => Promise<void>;
  exists: (remotePath: string) => Promise<boolean>;
  /**
   * Called by the poll loop at the inter-poll reschedule so a session-holding
   * transport in connection-per-poll mode can release its session for the idle
   * gap. A connectionless transport omits it; with the mode off it is a no-op.
   * The release must not prevent the next cycle's reconnect. See
   * docs/spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary.
   */
  releaseForIdle?: () => Promise<void>;
  /**
   * Companion to {@link FileTransportClient.releaseForIdle}, called at the start
   * of a cycle and before close()'s drain: resolves `true` once a session is
   * live, `false` on a transient re-dial failure (the cycle is skipped), and
   * rejects only on a fatal host-key or credential refusal.
   */
  ensureConnected?: () => Promise<boolean>;
  /**
   * Called once at the top of {@link FileSyncConnection.close} so the re-dials
   * teardown still makes (the abort-marker write, the terminal-frame drain) are
   * exempt from the transport's reconnection cap. A connectionless transport
   * omits it.
   */
  beginTeardown?: () => void;
}

/**
 * File-based rendezvous and message-passing connection. Implements the
 * `-hello.json`/`-lock.json` handshake (or the lockless ack-handshake barrier) and
 * `.json` polling protocol over any {@link FileTransportClient} -- an SFTP
 * server via {@link SSH2SFTPClientAdapter} or a locally-mounted folder via
 * `LocalFSClient`.
 */
export class FileSyncConnection extends EventEmitter<Events, never> {
  private client: FileTransportClient;
  id: string;
  role: string;
  options: Options;
  log: ReturnType<typeof getLoggerForVerbosity>;
  get seq(): number {
    return this.messageLoop.seq;
  }
  set seq(value: number) {
    this.messageLoop.seq = value;
  }
  connected = false;

  // The inbound directory, where this party reads the peer's files; undefined
  // outside an open session.
  path: string | undefined;
  // The separate outbound directory in split mode, which requires retain mode;
  // undefined in shared mode. See
  // docs/spec/FILE_SYNC.md#split-inboundoutbound-directories.
  outbound: string | undefined;
  private config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
  // The partner-arrival budget open() derived timeToLive from; unset when the
  // constructor supplied timeToLive, whose budget is not known.
  private arrivalBudgetMs: number | undefined;

  peerId: string | undefined;
  handshakeRole: HandshakeRole | undefined;
  // The host key the SFTP server presented, or undefined where none was
  // observed (filedrop, the browser SFTP path, a refused connection). Read
  // after the handshake for cross-party fingerprint reconciliation.
  get observedHostKey(): PresentedHostKey | undefined {
    return this.sftpSession.observedHostKey;
  }
  // Aborted by close() so an in-flight wait rejects. Re-armed per session in
  // synchronize(), not in resetSessionState(), so a recovery reset
  // mid-rendezvous cannot wipe a concurrent close()'s abort.
  private abortController = new AbortController();
  private responsibleFiles: Set<string>;
  // Grammar-failing names present at synchronize() entry, which the poll loop
  // tolerates; the new-foreign-file warning counts only later arrivals. Rebuilt
  // at each entry and not cleared by resetSessionState(). See
  // docs/spec/FILE_SYNC.md#file-taxonomy.
  private foreignFileSnapshot = new Set<string>();
  private entryPeerHello: string | undefined;
  // The most recent `error` emitted with no listener, held for the next
  // receive (see emit).
  private bufferedError: unknown;

  // The unwrapped transport, so the abort-marker write gets its own short
  // budget rather than the per-await one boundTransport applies. close()
  // awaits that write before end(), which is what keeps end() from cutting it
  // off.
  private rawClient: FileTransportClient;

  // See docs/spec/CHANNEL_SECURITY.md#authenticated-abort-marker.
  private readonly abortMarker: AbortMarkerSubsystem;

  // Connect options, the host-key verifier, and the host-key probe. See
  // docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification.
  private readonly sftpSession: SftpSession;

  // The entry scan and sweep and both rendezvous paths. It sets this
  // connection's identity through setters and mutates responsibleFiles and
  // foreignFileSnapshot by reference. See
  // docs/spec/FILE_SYNC.md#the-five-enforcement-sites.
  private readonly rendezvous: FileSyncRendezvous;

  // The poll, ack and sequence loop behind send(), start() and stop(). See
  // docs/spec/FILE_SYNC.md#the-five-enforcement-sites.
  private readonly messageLoop: FileSyncMessageLoop;

  // True once armAbort() has run; only an armed connection writes or verifies
  // abort markers.
  get abortArmed(): boolean {
    return this.abortMarker.armed;
  }

  // Caps inbound frames at min(maxBytes, MAX_FRAME_SIZE_BYTES) until cleared
  // with undefined, so it can only tighten the static cap. Single-pass sets it
  // one peer round trip before the reply it governs; a lost race with the poll
  // loop's read-ahead falls back to the static cap. See
  // docs/spec/CHANNEL_SECURITY.md#single-pass-per-exchange-cap.
  setInboundFrameCap(maxBytes: number | undefined): void {
    this.messageLoop.setInboundFrameCap(maxBytes);
  }

  /** Implements `Connection.inboundPollIntervalMs`. */
  inboundPollIntervalMs(): number {
    return this.options.pollingFrequency;
  }

  /** Implements `Connection.outboundFileSyncFrameBound`. */
  outboundFileSyncFrameBound(): number {
    return MAX_FRAME_SIZE_BYTES;
  }

  private get lastSentFile(): string | undefined {
    return this.messageLoop.lastSentFile;
  }

  /**
   * The peer hello found in the inbound directory at `synchronize()` entry,
   * until a live peer is confirmed (its ack of this party's hello, or a
   * delivered peer message); `undefined` when none predated the run. Such a
   * hello cannot be told apart from one an interrupted run left behind, so while
   * this is set a later silence is more likely that leftover than a partner-side
   * fault. See docs/spec/FILE_SYNC.md#phase-1----entry-present-peer-hello.
   */
  get unconfirmedEntryPeerHello(): string | undefined {
    return this.entryPeerHello;
  }

  // Where every self-write goes: the outbound directory in split mode, else
  // `path`. Peer-file reads stay on `path`.
  private get outboundPath(): string | undefined {
    return this.outbound ?? this.path;
  }

  constructor(client: FileTransportClient, options?: Partial<Options>) {
    super();
    // The wrap reads the budget per call, so installing it before open() sets
    // the config is safe.
    this.rawClient = client;
    this.client = this.boundTransport(client);
    // No peerId validation here: a caller passing one must validate it through
    // FileSyncOptionsSchema first.
    this.id = options?.peerId ?? uuidv4();
    this.role = "unknown role";
    this.responsibleFiles = new Set();

    this.options = { ...getDefaultOptions(), ...options } as Options;
    this.log = getLoggerForVerbosity(
      `filesync-${this.id.substring(0, 8)}`,
      this.options.verbose,
    );
    // The subsystems read through accessors whatever open() or the rendezvous
    // reassigns after this point (id, log, role, path, options, the abort
    // signal), and share responsibleFiles and foreignFileSnapshot by reference.
    this.abortMarker = new AbortMarkerSubsystem({
      log: () => this.log,
      role: () => this.role,
      runBudgeted: withTransportBudget,
      stalledError: transportBudgetExceededError,
    });
    this.sftpSession = new SftpSession({
      log: () => this.log,
      role: () => this.role,
      rawClient: this.rawClient,
    });
    this.rendezvous = new FileSyncRendezvous({
      responsibleFiles: this.responsibleFiles,
      foreignFileSnapshot: this.foreignFileSnapshot,
      client: () => this.client,
      id: () => this.id,
      role: () => this.role,
      outbound: () => this.outbound,
      log: () => this.log,
      options: () => this.options,
      channel: () => this.config?.channel,
      arrivalBudgetMs: () => this.arrivalBudgetMs,
      signal: () => this.abortController.signal,
      wait: (ms) => this.wait(ms),
      peerId: () => this.peerId,
      handshakeRole: () => this.handshakeRole,
      setRole: (role) => {
        this.role = role;
      },
      setPeerId: (peerId) => {
        this.peerId = peerId;
      },
      setHandshakeRole: (role) => {
        this.handshakeRole = role;
      },
      setEntryPeerHello: (name) => {
        this.entryPeerHello = name;
      },
      resetSessionState: () => this.resetSessionState(),
      clearAbortMarker: () => this.abortMarker.clear(),
      writeAck: (dir, originalName) => this.writeAck(dir, originalName),
    });
    // emit() passes through synchronously to this connection's emit, so a
    // poll-loop error with no listener is still buffered.
    this.messageLoop = new FileSyncMessageLoop({
      responsibleFiles: this.responsibleFiles,
      foreignFileSnapshot: this.foreignFileSnapshot,
      client: () => this.client,
      id: () => this.id,
      role: () => this.role,
      log: () => this.log,
      options: () => this.options,
      inactivityBudgetMs: () => this.inactivityBudgetMs(),
      path: () => this.path,
      outbound: () => this.outbound,
      peerId: () => this.peerId,
      connected: () => this.connected,
      abortArmed: () => this.abortArmed,
      wait: (ms) => this.wait(ms),
      emit: (event, arg) => this.emit(event, arg),
      writeAck: (dir, originalName) => this.writeAck(dir, originalName),
      verifyPeerAbortMarker: (files, path, peerId) =>
        this.abortMarker.verifyPeerMarker(this.client, files, path, peerId),
    });
  }

  // EventEmitter3 drops an `error` with no listener (Node's throws), so the
  // most recent one is held for the next receive (takeBufferedError).
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    // A delivered peer message confirms a live peer; cleared here, the one
    // funnel every delivery passes through.
    if (event === "data") this.entryPeerHello = undefined;
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      // A superseded error is logged and chained as the new error's cause,
      // unless the new one already has a cause or is the same object, which
      // would make the chain loop.
      const incoming = args[0];
      if (this.bufferedError !== undefined) {
        this.log.warn(
          `[${this.role}] superseding earlier buffered error: ` +
            // A transport error's message can embed a partner-controlled path.
            redactAndSanitizeForDisplay(errorMessage(this.bufferedError)),
        );
        if (
          incoming instanceof Error &&
          incoming.cause === undefined &&
          incoming !== this.bufferedError
        ) {
          try {
            incoming.cause = this.bufferedError;
          } catch {
            /* error object is frozen; chain is best-effort. */
          }
        }
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  // A sleep close() can cancel. Reads the signal per call: the controller is
  // swapped per session, so a hoisted signal would go stale.
  private wait(ms: number): Promise<void> {
    return cancellableDelay(ms, this.abortController.signal);
  }

  /**
   * The peer-inactivity budget for one await, read live because open() sets
   * the config after the constructor installs the transport wrap.
   */
  private inactivityBudgetMs(): number {
    return (
      this.config?.options?.inactivityTimeoutMs ??
      DEFAULT_PEER_INACTIVITY_TIMEOUT_MS
    );
  }

  // Races every data-plane await against a fresh peer-inactivity budget: the
  // safety check beneath the SFTP adapter's per-operation bounds, and the only
  // bound on LocalFSClient's operations. Fresh per await rather than one
  // absolute deadline, so it bounds a silent peer or server without capping a
  // long healthy exchange. See
  // docs/spec/CHANNEL_SECURITY.md#whole-exchange-budget.
  private boundTransport(raw: FileTransportClient): FileTransportClient {
    const budgetMs = (): number => this.inactivityBudgetMs();
    const bound = <T>(
      op: Promise<T>,
      operation: string,
      targets?: readonly string[],
    ): Promise<T> => {
      const ms = budgetMs();
      return withTransportBudget(op, ms, () =>
        transportBudgetExceededError(
          operation,
          ms,
          targets,
          this.options.inactivityTimeoutGuidance,
          INACTIVITY_TIMEOUT_KEY,
        ),
      );
    };
    return {
      // Each adapter bounds its own connect. See
      // docs/spec/CHANNEL_SECURITY.md#connect-probe-bound.
      connect: (options) => raw.connect(options),
      end: () => {
        const ms = Math.min(CONNECTION_CLOSE_TIMEOUT_MS, budgetMs());
        return withTransportBudget(
          raw.end(),
          ms,
          () =>
            new TransportOperationStalledError(
              `closing the connection did not finish within ${ms} ms, so ` +
                `shutdown went ahead without waiting for it`,
            ),
        );
      },
      list: (path) => bound(raw.list(path), `directory listing of ${path}`),
      get: (path, options) =>
        bound(raw.get(path, options), `file read of ${path}`),
      put: (src, dest, options) =>
        bound(raw.put(src, dest, options), `file write to ${dest}`),
      delete: (path) => bound(raw.delete(path), `delete of ${path}`),
      // Each path gets its own cause link, so one cannot forge the label that
      // introduces the other.
      rename: (fromPath, toPath) =>
        bound(raw.rename(fromPath, toPath), "rename", [
          `rename source: ${fromPath}`,
          `rename destination: ${toPath}`,
        ]),
      createExclusive: (path) =>
        bound(raw.createExclusive(path), `exclusive create of ${path}`),
      exists: (path) => bound(raw.exists(path), `existence check of ${path}`),
      safeDelete: (path) =>
        withTransportBudgetVoid(raw.safeDelete(path), budgetMs()),
      // Unwrapped, and only when implemented: none is a peer round trip, and
      // ensureConnected's re-dial has its own connect bounds.
      releaseForIdle: raw.releaseForIdle?.bind(raw),
      ensureConnected: raw.ensureConnected?.bind(raw),
      beginTeardown: raw.beginTeardown?.bind(raw),
    };
  }

  /** Opens a connection from a typed config. Dispatches on `config.channel`. */
  async open(
    config: SFTPConnectionConfig | FileDropConnectionConfig,
  ): Promise<void> {
    if (config.options?.pollIntervalMs !== undefined)
      this.options.pollingFrequency = config.options.pollIntervalMs;
    if (config.options?.timestampInFilename !== undefined)
      this.options.timestampInFilename = config.options.timestampInFilename;
    if (config.options?.locklessRendezvous !== undefined)
      this.options.locklessRendezvous = config.options.locklessRendezvous;
    if (config.options?.retainFiles !== undefined)
      this.options.retainFiles = config.options.retainFiles;
    if (config.options?.unexpectedFiles !== undefined)
      this.options.unexpectedFiles = config.options.unexpectedFiles;
    if (config.options?.peerId !== undefined) {
      this.options.peerId = config.options.peerId;
      this.id = config.options.peerId;
      this.log = getLoggerForVerbosity(
        `filesync-${this.id.substring(0, 8)}`,
        this.options.verbose,
      );
    }
    this.config = config;

    if (config.channel === "filedrop") {
      // The config schema guarantees either `path` or the full
      // inbound/outbound pair.
      const split =
        config.inboundPath !== undefined && config.outboundPath !== undefined;
      const inboundDir = normalizeFiledropPath(
        split ? config.inboundPath! : config.path!,
      );
      const outboundDir = split
        ? normalizeFiledropPath(config.outboundPath!)
        : inboundDir;
      // The schema's distinctness rule, re-checked for a caller that builds a
      // connection directly; pathsResolveToSameDir states what it cannot catch.
      if (split && pathsResolveToSameDir(inboundDir, outboundDir))
        throw new UsageError(
          "filedrop inbound and outbound directories resolve to the same " +
            "directory after normalization; they must be distinct",
        );
      this.log.debug(
        `[${this.role}] opening local path ${redactAndSanitizeForDisplay(inboundDir)}` +
          (split
            ? ` (inbound) and ${redactAndSanitizeForDisplay(outboundDir)} (outbound)`
            : ""),
      );
      const connectTimeoutMs =
        // A config with no options block never got the schema default.
        config.options?.serverConnectTimeoutMs ??
        DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
      const maxReconnectAttempts =
        config.options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      await this.client.connect({
        path: inboundDir,
        connectTimeoutMs,
        maxReconnectAttempts,
      });
      // Probe the outbound directory too, so an inaccessible write target fails
      // at connect. A second connect() is safe: filedrop runs on LocalFSClient,
      // whose connect() is a stateless access check.
      if (split)
        await this.client.connect({
          path: outboundDir,
          connectTimeoutMs,
          maxReconnectAttempts,
        });
      this.path = inboundDir;
      this.outbound = split ? outboundDir : undefined;
    } else {
      // The schema guarantees either `server.path` (unset for the login home)
      // or the full pair. One SSH session serves both directories.
      const split =
        config.server.inboundPath !== undefined &&
        config.server.outboundPath !== undefined;
      const stripTrailingSlash = (p: string): string =>
        p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
      const inboundDir = stripTrailingSlash(
        split ? config.server.inboundPath! : (config.server.path ?? ""),
      );
      const outboundDir = split
        ? stripTrailingSlash(config.server.outboundPath!)
        : inboundDir;
      // The schema's rule on the same raw inputs, re-checked for a direct
      // caller before any dial. It cannot see server-side equivalence (a
      // relative path under the login home, ".." across a symlink); that stays
      // the operator's (see
      // docs/EXCHANGE_REFERENCE.md#connectioninbound_path--connectionoutbound_path).
      if (
        split &&
        pathsResolveToSameDir(
          config.server.inboundPath!,
          config.server.outboundPath!,
        )
      )
        throw new UsageError(
          "sftp inbound and outbound directories resolve to the same " +
            "directory; they must be distinct",
        );

      const connectOptions = this.sftpSession.buildConnectOptions(config, {
        includeCredentials: true,
      });
      // Installed after buildConnectOptions applies providerOptions, so no
      // providerOptions entry can replace it.
      const hostKeyVerifier = this.sftpSession.installEnforcingVerifier(
        connectOptions,
        config,
      );

      const portString =
        config.server.port !== undefined ? `:${config.server.port}` : "";
      // The username is a credential component: log only that one is set.
      const usernameString =
        config.server.username !== undefined ? " as a configured user" : "";
      // Host and path can come from the partner's invitation and hold control
      // bytes; a log call site escapes what it shows. The port is a validated
      // integer.
      this.log.debug(
        `[${this.role}] connecting to ` +
          `${redactAndSanitizeForDisplay(config.server.host)}${portString}` +
          `${usernameString}, path: ${redactAndSanitizeForDisplay(inboundDir)}` +
          (split
            ? ` (inbound), outbound: ${redactAndSanitizeForDisplay(outboundDir)}`
            : ""),
      );
      try {
        await this.client.connect(connectOptions);
      } catch (err) {
        const refusal = hostKeyVerifier.refusal();
        if (refusal !== undefined) {
          // A pinned-fingerprint mismatch or the no-pin refusal.
          throw new AuthenticationError(
            `SFTP host-key verification failed: ${refusal.summary}`,
            { cause: chainDetailCauses(refusal.details, err) },
          );
        }
        throw err;
      }
      // Set only once the server accepted the session: close() keys its
      // teardown I/O on `path`.
      this.path = inboundDir;
      this.outbound = split ? outboundDir : undefined;
    }

    this.connected = true;
    // After connect(), so connection retries do not spend the arrival budget;
    // a constructor-supplied timeToLive wins.
    if (this.options.timeToLive === undefined) {
      const ttlMs = config.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
      this.options.timeToLive = new Date(Date.now() + ttlMs);
      this.arrivalBudgetMs = ttlMs;
    }
    this.log.debug(`[${this.role}] connected`);
  }

  /**
   * Connects only far enough to observe the server's host key, then refuses
   * the connection without authenticating: the ssh-keyscan analogue for a
   * first-use pin. See {@link SftpSession.probeHostKeyFingerprint}.
   */
  async probeHostKeyFingerprint(
    config: SFTPConnectionConfig,
  ): Promise<PresentedHostKey> {
    return this.sftpSession.probeHostKeyFingerprint(config);
  }

  async cleanup() {
    // Retain mode removes nothing: the directory is the durable transcript, and
    // temp writes are cleaned up inline where they fail.
    if (this.options.retainFiles) {
      this.log.debug(
        `[${this.role}] retain mode: directory is transcript, skipping cleanup`,
      );
      return;
    }
    const responsibleFilesString =
      this.responsibleFiles.size > 0
        ? `: ${[...this.responsibleFiles]
            .map((name) => redactAndSanitizeForDisplay(name))
            .join(", ")}`
        : "";
    this.log.debug(
      `[${this.role}] cleaning up ${this.responsibleFiles.size} file(s)` +
        `${responsibleFilesString}`,
    );
    // responsibleFiles are self-writes, so they live in the outbound directory.
    return Promise.all(
      Array.from(this.responsibleFiles).map((filename) =>
        this.client.safeDelete(
          joinFileSyncPath(this.outboundPath ?? "", filename),
        ),
      ),
    );
  }

  /**
   * Arms the abort marker once after the handshake, with the token this party
   * writes into `<myId>-abort.json` and the token a `<peerId>-abort.json` must
   * verify against. Call after open(); without a path the write is a no-op.
   * See docs/spec/CHANNEL_SECURITY.md#authenticated-abort-marker.
   */
  armAbort(
    selfToken: Uint8Array<ArrayBuffer>,
    peerToken: Uint8Array<ArrayBuffer>,
  ): void {
    this.abortMarker.arm(
      selfToken,
      peerToken,
      this.id,
      this.outboundPath,
      this.rawClient,
    );
  }

  /**
   * Writes this party's abort marker on a terminal fault, pre-empting a later
   * sealAbort(). Idempotent: every caller gets the same promise, and absorbs its
   * rejection. Best-effort: a failed write leaves no marker, and the peer falls
   * back to its silence timeout.
   */
  writeAbortMarker(): Promise<void> {
    return this.abortMarker.writeMarker();
  }

  /**
   * Declares that no marker is coming, freeing a close() parked on that
   * decision. Called on every terminal path; a no-op after writeAbortMarker()
   * and safe on an unarmed connection.
   */
  sealAbort(): void {
    this.abortMarker.seal();
  }

  /**
   * Tears the connection down: stops the poll loop, drains the last sent
   * frame, sweeps this side's files, then ends the client. The poller stops
   * first so no cycle runs against a dead client, and cleanup deletes through
   * the client so it runs before end(). The drain and end() waits use the short
   * teardown bounds. Idempotent, and safe on a connection never opened. See
   * docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close.
   */
  async close() {
    // Before the marker gate, so the drain's and the marker write's re-dials
    // are exempt from the transport's reconnection cap. The marker write
    // signals this too, since it can precede close().
    this.client.beginTeardown?.();
    // Stop polling before the gate can wait: a poll during the wait would
    // consume a peer message nothing will receive.
    this.stop();
    // Before the drain and end(), which would kill a marker write on the same
    // transport. An undecided close() waits for the decision or the fallback
    // grace, then awaits any write in flight.
    if (this.abortArmed && !this.abortMarker.decisionResolved)
      await this.abortMarker.awaitDecisionOrGrace();
    await this.abortMarker.pendingWrite?.catch(() => {});

    // Cancel any in-flight wait; stop() already cleared the poller, so poll()'s
    // catch swallows the rejection. Every abort() here passes a
    // ConnectionClosedError: cancellableDelay rejects with signal.reason, and
    // the exit-69 classification depends on it.
    this.abortController.abort(
      new ConnectionClosedError("connection closed during wait"),
    );

    if (this.path !== undefined) {
      // Re-establish a session released for the idle gap before the drain clock
      // starts, so a re-dial cannot time the drain out. The marker write above
      // does not get this call: it re-dials through the transport's own
      // recovery, which a second re-dial would race. See
      // docs/spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary.
      try {
        await this.client.ensureConnected?.();
      } catch {
        /* best-effort; teardown proceeds against whatever session state results */
      }
      // Delete mode only: wait for the peer to consume the terminal frame so
      // cleanup() does not delete it unread. Retain mode never deletes a
      // message, so the frame stays on disk for the peer.
      if (this.lastSentFile !== undefined && !this.options.retainFiles) {
        const path = this.path;
        const lastSentFile = this.lastSentFile;
        const drainTimeoutMs = Math.min(
          TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
          this.inactivityBudgetMs(),
        );
        const deadline = Date.now() + drainTimeoutMs;
        // Each list() races the time left to `deadline`, not a fresh inactivity
        // budget, so a late list cannot hold teardown past the drain deadline;
        // a lost race falls through to cleanup().
        const filePresent = async () => {
          const remaining = Math.max(0, deadline - Date.now());
          const files = await withTransportBudget(
            this.client.list(path),
            remaining,
            () =>
              new TransportOperationStalledError(
                `drain of ${lastSentFile} did not complete within the ` +
                  `${remaining} ms teardown window`,
              ),
          );
          return files.some((f) => f.name === lastSentFile);
        };
        try {
          if (await filePresent()) {
            // Not escaped: this party's own message name, built from this.id (a
            // local UUID or the operator's peer_id), which no partner input sets.
            this.log.info(
              `[${this.role}] close: waiting up to ${drainTimeoutMs} ms for ` +
                `peer to consume ${lastSentFile} before cleanup`,
            );
            this.log.debug(
              `[${this.role}] draining ${lastSentFile} before cleanup`,
            );
            // The last observed presence, so the timeout log fires only when
            // the peer never consumed the file, not on the clock alone.
            let stillPresent = true;
            while (Date.now() < deadline) {
              stillPresent = await filePresent();
              if (!stillPresent) break;
              // Not this.wait(): the session signal is already aborted, so it
              // would reject at once.
              await new Promise((resolve) =>
                setTimeout(resolve, this.options.pollingFrequency),
              );
            }
            if (stillPresent) {
              this.log.info(
                `[${this.role}] close: drain deadline reached after ` +
                  `${drainTimeoutMs} ms; deleting ${lastSentFile} as fallback`,
              );
            }
          }
        } catch {
          // list() failure during drain; fall through to cleanup.
        }
      }

      // Best-effort: a delete failure must not stop the client from ending.
      try {
        await this.cleanup();
      } catch (err: unknown) {
        this.log.debug(
          // Lock and ack names embed the partner's peerId.
          `[${this.role}] cleanup during close: ` +
            `${redactAndSanitizeForDisplay(errorMessage(err))}`,
        );
      }
    }

    if (this.connected) {
      this.log.debug(`[${this.role}] closing connection`);
      // Cleared before end(), which can reject at its bound, so `connected` does
      // not stay true and a second close() does not call end() again.
      this.connected = false;
      try {
        await this.client.end();
      } catch (err: unknown) {
        this.log.debug(
          `[${this.role}] end() during close: ${redactAndSanitizeForDisplay(errorMessage(err))}`,
        );
      }
    }
    this.path = undefined;
    this.outbound = undefined;
    this.config = undefined;
    // Here, not in resetSessionState(), which resets only the message loop's
    // counters.
    this.abortMarker.clear();
    this.resetSessionState();
  }

  /**
   * Negotiates rendezvous with the peer: `-hello.json` and
   * `<peer1>-<peer2>-lock.json` files (lock mode) or hellos and zero-length
   * `-ack.json` markers (lockless mode), assigning `peerId` and `handshakeRole`.
   * A failure rejects this call and is not emitted on `error`, which is
   * reserved for the poll loop (see {@link start}).
   */
  async synchronize() {
    const scope = this.validateSynchronizeEntry();
    return this.rendezvous.run(scope);
  }

  // The entry guards for synchronize(); returns the directory scope the
  // rendezvous runs in.
  private validateSynchronizeEntry(): RendezvousScope {
    if (!this.connected || this.path === undefined)
      throw new InternalConsistencyError("not connected");

    const inboundPath = this.path;
    const outboundPath = this.outbound ?? this.path;
    const split = this.outbound !== undefined;
    // Both directories in split mode, so entry-time logs and errors name both.
    const dirsDisplay = composeDirsDisplay(
      inboundPath,
      split ? outboundPath : undefined,
    );

    if (this.peerId) throw new InternalConsistencyError("already synchronized");

    // Re-armed after the re-entry guard and not in resetSessionState(), which
    // runs inside a live synchronize() and would wipe a concurrent close()'s
    // abort. A second synchronize() before the first settles is unsupported:
    // it would re-arm the controller under the first.
    this.abortController = new AbortController();

    // The three mode guards below repeat the config schema's rules for a
    // caller that builds a connection directly. See
    // docs/spec/FILE_SYNC.md#two-orthogonal-mode-axes.
    if (this.outbound !== undefined && !this.options.retainFiles)
      throw new UsageError(
        "a separate outbound directory requires retain mode: without it the " +
          "rendezvous can take a lock/delete path that renames across the two " +
          "directories, which is not atomic",
      );

    if (this.options.retainFiles && !this.options.locklessRendezvous)
      throw new UsageError(
        "retain mode requires lockless rendezvous: lock rendezvous is " +
          "delete-based and cannot produce the whole-directory no-delete " +
          "transcript required by retain mode",
      );

    if (this.options.retainFiles && !this.options.timestampInFilename)
      throw new UsageError(
        "retain mode requires timestamp_in_filename: without it message " +
          "filenames have no NNN segment and the receiver cannot sequence " +
          "them (every message would be silently skipped)",
      );

    this.log.info(
      `[${this.role}] synchronizing at path ${redactAndSanitizeForDisplay(dirsDisplay)}`,
    );

    return { inboundPath, outboundPath, split, dirsDisplay };
  }

  /**
   * Writes one message for the peer to consume. A failure rejects this call
   * and is not emitted on `error` (see {@link synchronize}).
   */
  send(data: unknown): Promise<void> {
    return this.messageLoop.send(data);
  }

  // Publishes the zero-length marker `<myId>-<originalName>-ack.json`
  // (ackMarkerName) temp-then-rename, for the lockless rendezvous ack and the
  // retain-mode message ack; `originalName` omits `.json`. The name depends only
  // on this party's id and `originalName`, so a re-write after a reprocess
  // cannot duplicate it. Returns the marker's file name.
  private async writeAck(dir: string, originalName: string): Promise<string> {
    const name = ackMarkerName(this.id, originalName);
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = joinFileSyncPath(dir, tempFile);
    try {
      await this.client.put(Buffer.alloc(0), tempPath, {
        flags: "w",
        encoding: null,
      });
      await this.client.rename(tempPath, joinFileSyncPath(dir, name));
    } catch (err) {
      await this.client.safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
    return name;
  }

  // Resets the message loop's per-session counters, for a rendezvous retry and
  // on close().
  private resetSessionState() {
    this.messageLoop.resetSessionState();
  }

  start() {
    this.messageLoop.start();
  }

  stop() {
    this.messageLoop.stop();
  }
}
