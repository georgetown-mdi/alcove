// Routes the SSH stack's diagnostic lines (identification strings, algorithm
// offers, packet flow) into Alcove's logger at the trace level. Every line holds
// text the remote server chose, so this module is a display sink and escapes what
// it emits (CONTRIBUTING.md, Operator-facing escaping; what the stack escapes
// first: docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack").

import logLibrary from "loglevel";

import { redactAndSanitizeForDisplay } from "@alcove/core";

/**
 * Name of the SSH trace logger. Separate from the adapter's logger so it follows
 * `--log-level` rather than the `-v`-floored adapter level.
 */
export const SSH_WIRE_TRACE_LOGGER_NAME = "ssh";

/**
 * Cap on the escaped characters one traced line emits. Above the 256-character
 * `sanitizeForDisplay` default, which would cut the stack's algorithm name-lists
 * (sftpWireTraceLineLength.test.ts measures them); still bounded so a server
 * padding its name-lists cannot fill the operator's log.
 */
export const SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH = 1024;

/** What {@link sshWireTrace} needs of a logger. */
export interface WireTraceLogger {
  getLevel: () => number;
  trace: (message: string) => void;
}

/**
 * One SSH stack line as operator-safe display text: escapes server-chosen bytes
 * (ANSI sequences, a CR/LF forging a log line) and strips private keys as the
 * connect log does.
 */
export const sshWireTraceLine = (line: string): string =>
  redactAndSanitizeForDisplay(line, {
    maxLength: SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH,
  });

/**
 * A trace installed on one connection: the `debug` callback the SSH stack calls,
 * and the detach that ends it.
 */
export interface SshWireTrace {
  /** The `debug` connect option, one call per line the stack renders. */
  emit: (line: string) => void;
  /**
   * Emit nothing further; idempotent. Detach when the connection is done: a line
   * emitted after the command's `--log-file` closes goes to stderr, not the file.
   */
  detach: () => void;
}

/**
 * The trace to install on a connection, or `undefined` below the trace level, so
 * the stack skips its per-packet formatting entirely. The level is read once,
 * here; a later level change does not apply.
 */
export const sshWireTrace = (
  log: WireTraceLogger,
): SshWireTrace | undefined => {
  if (log.getLevel() > logLibrary.levels.TRACE) return undefined;
  let attached = true;
  return {
    emit: (line: string) => {
      if (attached) log.trace(sshWireTraceLine(line));
    },
    detach: () => {
      attached = false;
    },
  };
};
