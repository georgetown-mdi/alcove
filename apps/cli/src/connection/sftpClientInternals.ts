// Types for the ssh2 / ssh2-sftp-client internals the SFTP adapter reaches
// past their public APIs, and pure resolvers that detect the close members.
// Re-verify on any bump:
// docs/spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client.

import { UsageError } from "@alcove/core";

import { REPORT_LIBRARY_INCOMPATIBILITY } from "./libraryIncompatibility";

/** One ssh2 SFTPWrapper.readdir entry, typed as far as the adapter reads. */
export interface Ssh2DirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

/** An ssh2 SFTP failure, with the numeric SFTP status on `code`. */
export type Ssh2SftpError = Error & { code?: number };

/**
 * The ssh2 Client's underlying net.Socket. Every member is optional so a
 * relocated member is undefined; each call site decides whether that warns or
 * fails the dial.
 */
export interface Ssh2ClientSocket {
  /** ssh2 does not expose setKeepAlive, so connect() reaches the socket. */
  setKeepAlive?(enable: boolean, initialDelay: number): void;
  /**
   * Node's half-close flags, read by the connection-per-poll release to tell
   * who ended the transport. See releaseForIdle() and sessionTransportEnded().
   */
  readableEnded?: boolean;
  writableEnded?: boolean;
  /**
   * Teardown that needs nothing from the peer, for a transport whose close the
   * partner withheld. See forceCloseEndedTransport() and
   * forceCloseTerminalTransport().
   */
  destroy?(): void;
  /**
   * Read back by the terminal close after destroy(); an absent flag counts as
   * "did not close" and warns rather than failing a dial.
   */
  destroyed?: boolean;
}

/**
 * ssh2-sftp-client's `this.client` (the ssh2 Client) and `this.sftp` (the raw
 * SFTPWrapper).
 */
export interface Ssh2SftpClientInternals {
  /** Optional so connect() warns and continues if an upgrade relocates it. */
  client?: {
    setNoDelay(noDelay: boolean): void;
    _sock?: Ssh2ClientSocket;
    /**
     * Typed only for the events the adapter listens on: see
     * attachKeyboardInteractive and watchTransportLifecycle.
     */
    on?(
      event: "keyboard-interactive",
      listener: (
        name: string,
        instructions: string,
        lang: string,
        prompts: { prompt: string; echo?: boolean }[],
        finish: (answers: string[]) => void,
      ) => void,
    ): void;
    on?(event: "end" | "close", listener: () => void): void;
    /**
     * The release awaits 'close' after the ssh2 Client's own end(), not
     * ssh2-sftp-client's, which disables the listener that clears this.sftp
     * on a later drop. 'ready' arms the subsystem-open bound
     * (./sftpSubsystemOpen). See resolveTransportCloseSeams().
     */
    once?(event: "close" | "ready", listener: () => void): void;
    removeListener?(event: "close" | "ready", listener: () => void): void;
    /**
     * Sets `SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS` (ssh2SftpAdapter.ts) once
     * at construction; a missing member warns rather than failing a dial.
     */
    setMaxListeners?(n: number): void;
    end?(): void;
  };
  sftp: {
    open(
      path: string,
      flags: number,
      attrs: Record<string, unknown>,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    close(handle: Buffer, callback: (err: Error | null) => void): void;
    opendir(
      path: string,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    /**
     * Returns one server batch per call and reports end-of-directory as an
     * error with `code` SSH_FX_EOF; `list` is undefined whenever `err` is set.
     */
    readdir(
      handle: Buffer,
      callback: (err: Ssh2SftpError | null, list?: Ssh2DirEntry[]) => void,
    ): void;
    /**
     * ssh2 emits a fatal 'error' here on a malformed SFTP packet; connect()
     * attaches the listener that keeps it from crashing the process.
     */
    on(event: "error", listener: (err: Error) => void): unknown;
  } | null;
}

/** The ssh2 member the terminal close drives. See resolveTerminalCloseSeam. */
export interface TerminalCloseSeam {
  destroy: () => void;
  socket: Ssh2ClientSocket;
}

/**
 * The ssh2 members a forced close drives: the socket destroy plus the Client's
 * 'close' subscription that reports it landed. See resolveForcedCloseSeams.
 */
export interface ForcedCloseSeams extends TerminalCloseSeam {
  once: (event: "close", listener: () => void) => void;
  removeListener: (event: "close", listener: () => void) => void;
}

/**
 * The above plus the ssh2 Client's own end(), which the idle release drives.
 * See resolveTransportCloseSeams.
 */
export interface TransportCloseSeams extends ForcedCloseSeams {
  end: () => void;
}

/**
 * The first member the installed library lacks, named as the adapter reaches
 * it (e.g. `client._sock.destroy()`).
 */
export interface UnavailableTransportCloseSeam {
  missing: string;
}

/**
 * The socket destroy() the terminal close drives, resolved alone so a relocated
 * member this path never calls cannot disable it and leave a completed run
 * holding a half-open socket.
 */
export function resolveTerminalCloseSeam(
  internals: Ssh2SftpClientInternals,
): TerminalCloseSeam | UnavailableTransportCloseSeam {
  const socket = internals.client?._sock;
  if (typeof socket?.destroy !== "function")
    return { missing: "client._sock.destroy()" };
  return { destroy: socket.destroy.bind(socket), socket };
}

/**
 * The ssh2 Client's once()/removeListener() for 'close', plus the socket
 * destroy(). Each caller resolves them where it uses them.
 */
export function resolveForcedCloseSeams(
  internals: Ssh2SftpClientInternals,
): ForcedCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.once !== "function") return { missing: "client.once()" };
  if (typeof client.removeListener !== "function")
    return { missing: "client.removeListener()" };
  const terminal = resolveTerminalCloseSeam(internals);
  if ("missing" in terminal) return terminal;
  return {
    once: client.once.bind(client),
    removeListener: client.removeListener.bind(client),
    ...terminal,
  };
}

/**
 * The above plus the socket's writableEnded flag, required only by a close that
 * reads it.
 */
export function resolveEndedTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): ForcedCloseSeams | UnavailableTransportCloseSeam {
  const seams = resolveForcedCloseSeams(internals);
  if ("missing" in seams) return seams;
  if (typeof seams.socket.writableEnded !== "boolean")
    return { missing: "client._sock.writableEnded" };
  return seams;
}

/**
 * The ssh2 Client's own end() plus the forced-close members, which the idle
 * release drives. connect() resolves them in that mode so a relocated member
 * fails the dial, and the release resolves them again where it uses them.
 */
export function resolveTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): TransportCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.end !== "function") return { missing: "client.end()" };
  const ended = resolveEndedTransportCloseSeams(internals);
  if ("missing" in ended) return ended;
  return { end: client.end.bind(client), ...ended };
}

/**
 * The usage fault (exit 64) the connect-time check and the idle release raise
 * for a missing member. The message names no ssh2 internal; the caller logs the
 * member at debug.
 */
export function transportCloseSeamError(): UsageError {
  return new UsageError(
    `this exchange closes the SFTP connection from this side at every poll ` +
      `boundary, which the installed SFTP library does not support, so the ` +
      `exchange cannot run. This build of Alcove is not compatible with ` +
      `that library; ${REPORT_LIBRARY_INCOMPATIBILITY}`,
  );
}
