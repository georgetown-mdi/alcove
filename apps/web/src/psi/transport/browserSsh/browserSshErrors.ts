/** The algorithm lists an SSH key exchange negotiates, one at a time. */
export type BrowserSshNegotiationCategory =
  | "KeyExchange"
  | "PublicKey"
  | "ClientEncryption"
  | "ServerEncryption"
  | "ClientHmac"
  | "ServerHmac"
  | "ClientCompression"
  | "ServerCompression";

const NEGOTIATION_CATEGORY_WORDS: Readonly<
  Record<BrowserSshNegotiationCategory, string>
> = {
  KeyExchange: "key exchange",
  PublicKey: "host key",
  ClientEncryption: "encryption",
  ServerEncryption: "encryption",
  ClientHmac: "message authentication",
  ServerHmac: "message authentication",
  ClientCompression: "compression",
  ServerCompression: "compression",
};

function isNegotiationCategory(
  category: string,
): category is BrowserSshNegotiationCategory {
  return Object.hasOwn(NEGOTIATION_CATEGORY_WORDS, category);
}

/**
 * The server offered no algorithm in one category that the client supports,
 * so the session ended before authentication. The server's list is the
 * server's own text, composed raw for the display sink to escape.
 */
export class BrowserSshNoCommonAlgorithmError extends Error {
  override readonly name = "BrowserSshNoCommonAlgorithmError";
  constructor(
    readonly category: BrowserSshNegotiationCategory,
    readonly serverAlgorithms: ReadonlyArray<string>,
    readonly clientAlgorithms: ReadonlyArray<string>,
    options?: ErrorOptions,
  ) {
    super(
      `The SFTP server offers no ${NEGOTIATION_CATEGORY_WORDS[category]} algorithm this client supports. ` +
        `Server: ${serverAlgorithms.join(", ") || "(none)"}. ` +
        `Client: ${clientAlgorithms.join(", ")}. ` +
        "Ask the SFTP server's administrator to enable one of the client's algorithms.",
      options,
    );
  }
}

/** The caller's host-key check refused the server's key. */
export class BrowserSshHostKeyRefusedError extends Error {
  override readonly name = "BrowserSshHostKeyRefusedError";
  constructor() {
    super("The SFTP server's host key was refused, so no credential was sent.");
  }
}

/** The server refused the client's key. */
export class BrowserSshAuthenticationRefusedError extends Error {
  override readonly name = "BrowserSshAuthenticationRefusedError";
  constructor(readonly username: string) {
    super(`The SFTP server refused the key for user ${username}.`);
  }
}

/** The server refused the `sftp` subsystem on an open session channel. */
export class BrowserSshSubsystemRefusedError extends Error {
  override readonly name = "BrowserSshSubsystemRefusedError";
  constructor() {
    super("The SFTP server refused to start its sftp subsystem.");
  }
}

/** The relay WebSocket closed; `code` is from the relay's close-code table. */
export class BrowserSshRelayClosedError extends Error {
  override readonly name = "BrowserSshRelayClosedError";
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(
      `The SFTP relay closed the connection (code ${code}${reason === "" ? "" : `: ${reason}`}).`,
    );
  }
}

/** This client closed its connection to the relay, and then used it. */
export class BrowserSshClientClosedError extends Error {
  override readonly name = "BrowserSshClientClosedError";
  constructor() {
    super("This client closed its connection to the SFTP relay.");
  }
}

/**
 * Finite-field Diffie-Hellman was called. The browser bundle replaces the
 * library's `diffie-hellman` dependency with a stub that throws this, and the
 * session offers only ECDH key exchanges, so reaching it means a configuration
 * offered a key exchange this client does not ship.
 */
export class BrowserSshUnsupportedKeyExchangeError extends Error {
  override readonly name = "BrowserSshUnsupportedKeyExchangeError";
  constructor(readonly entry: string) {
    super(
      `Finite-field Diffie-Hellman (${entry}) is not available in the browser SSH client; only ECDH key exchanges are offered.`,
    );
  }
}

/** A signing call reached a public-key algorithm this client only verifies. */
export class BrowserSshVerifyOnlyError extends Error {
  override readonly name = "BrowserSshVerifyOnlyError";
  constructor(readonly algorithm: string) {
    super(`${algorithm} is supported for host-key verification only.`);
  }
}

const NEGOTIATION_FAILURE =
  /^Failed (\w+) negotiation: Server \((.*)\) Client \((.*)\)$/s;

function splitList(list: string): Array<string> {
  return list === "" ? [] : list.split(", ");
}

/**
 * The named error for the library's negotiation failure (`keyExchangeService`'s
 * `chooseAlgorithm`, a plain `Error`), or `null` for any other error.
 */
export function noCommonAlgorithmError(
  error: unknown,
): BrowserSshNoCommonAlgorithmError | null {
  if (!(error instanceof Error)) return null;
  const match = NEGOTIATION_FAILURE.exec(error.message);
  if (match === null) return null;
  const [, category, server, client] = match;
  if (!isNegotiationCategory(category)) return null;
  return new BrowserSshNoCommonAlgorithmError(
    category,
    splitList(server),
    splitList(client),
    { cause: error },
  );
}
