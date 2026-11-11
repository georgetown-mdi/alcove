/**
 * The SFTP client's named errors. A server's status message is composed raw,
 * for the display sink to escape.
 */

/** The SFTP version 3 status codes (draft-ietf-secsh-filexfer-02, 7). */
export const SftpStatusCode = {
  ok: 0,
  eof: 1,
  noSuchFile: 2,
  permissionDenied: 3,
  failure: 4,
  badMessage: 5,
  noConnection: 6,
  connectionLost: 7,
  operationUnsupported: 8,
} as const;

/** What a failed request was doing, for its error message. */
export interface SftpOperation {
  /** The request, e.g. `open`, `rename`. */
  name: string;
  /** The path it named, if any. */
  path?: string;
}

function describe(operation: SftpOperation): string {
  return operation.path === undefined
    ? operation.name
    : `${operation.name} of ${operation.path}`;
}

function withServerMessage(serverMessage: string): string {
  return serverMessage === "" ? "" : ` (server: ${serverMessage})`;
}

/** The server answered a request with an error status. */
export class SftpStatusError extends Error {
  override readonly name: string = "SftpStatusError";
  constructor(
    readonly code: number,
    readonly serverMessage: string,
    readonly operation: SftpOperation,
    message?: string,
  ) {
    super(
      message ??
        `The SFTP server refused the ${describe(operation)} with status ${code}${withServerMessage(serverMessage)}. ` +
          "Try again; if it repeats, ask the server's administrator what the server logged.",
    );
  }
}

/** `SSH_FX_NO_SUCH_FILE`: nothing at the path. */
export class SftpNoSuchFileError extends SftpStatusError {
  override readonly name = "SftpNoSuchFileError";
  constructor(serverMessage: string, operation: SftpOperation) {
    super(
      SftpStatusCode.noSuchFile,
      serverMessage,
      operation,
      `The SFTP server has no file or folder for the ${describe(operation)}. ` +
        "Check that the path exists on the server.",
    );
  }
}

/** `SSH_FX_PERMISSION_DENIED`: the account may not do this. */
export class SftpPermissionDeniedError extends SftpStatusError {
  override readonly name = "SftpPermissionDeniedError";
  constructor(serverMessage: string, operation: SftpOperation) {
    super(
      SftpStatusCode.permissionDenied,
      serverMessage,
      operation,
      `The SFTP server denied this account the ${describe(operation)}. ` +
        "Ask the server's administrator to grant the account access to that path.",
    );
  }
}

/** `SSH_FX_FAILURE`: the server's catch-all, e.g. a file already present. */
export class SftpFailureError extends SftpStatusError {
  override readonly name = "SftpFailureError";
  constructor(serverMessage: string, operation: SftpOperation) {
    super(
      SftpStatusCode.failure,
      serverMessage,
      operation,
      `The SFTP server could not complete the ${describe(operation)}${withServerMessage(serverMessage)}. ` +
        "Check the path on the server, for example that a file being created or renamed to does not already exist, then try again.",
    );
  }
}

/** `SSH_FX_OP_UNSUPPORTED`: the server does not implement the request. */
export class SftpOperationUnsupportedError extends SftpStatusError {
  override readonly name = "SftpOperationUnsupportedError";
  constructor(serverMessage: string, operation: SftpOperation) {
    super(
      SftpStatusCode.operationUnsupported,
      serverMessage,
      operation,
      `The SFTP server does not support the ${operation.name} request. ` +
        "Use an SFTP server that implements SFTP version 3 in full.",
    );
  }
}

/** The named error for a status reply other than OK and EOF. */
export function sftpStatusError(
  code: number,
  serverMessage: string,
  operation: SftpOperation,
): SftpStatusError {
  switch (code) {
    case SftpStatusCode.noSuchFile:
      return new SftpNoSuchFileError(serverMessage, operation);
    case SftpStatusCode.permissionDenied:
      return new SftpPermissionDeniedError(serverMessage, operation);
    case SftpStatusCode.failure:
      return new SftpFailureError(serverMessage, operation);
    case SftpStatusCode.operationUnsupported:
      return new SftpOperationUnsupportedError(serverMessage, operation);
    default:
      return new SftpStatusError(code, serverMessage, operation);
  }
}

/**
 * The server sent something SFTP version 3 does not allow: a malformed
 * packet, a reply to no outstanding request, or the wrong reply for one. The
 * session ends.
 */
export class SftpProtocolError extends Error {
  override readonly name = "SftpProtocolError";
  constructor(readonly detail: string) {
    super(
      `The SFTP server sent a packet this client cannot read (${detail}), so the session was ended. ` +
        "If it happens again, give this message to the server's administrator.",
    );
  }
}

/** The server declared a packet longer than the client's inbound cap. */
export class SftpPacketTooLargeError extends Error {
  override readonly name = "SftpPacketTooLargeError";
  constructor(
    readonly declaredLength: number,
    readonly maxLength: number,
  ) {
    super(
      `The SFTP server sent a packet of ${declaredLength} bytes, over this client's limit of ${maxLength}, so the session was ended. ` +
        `Give this message to the server's administrator: the server must send packets of at most ${maxLength} bytes to be used from the browser.`,
    );
  }
}

/** The session ended, so the request cannot complete. */
export class SftpSessionClosedError extends Error {
  override readonly name = "SftpSessionClosedError";
  constructor(options?: ErrorOptions) {
    super(
      "The SFTP session has ended, so the request did not complete. Connect again to continue.",
      options,
    );
  }
}
