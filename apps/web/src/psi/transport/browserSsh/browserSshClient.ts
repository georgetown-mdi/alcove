import {
  BrowserSshAuthenticationRefusedError,
  BrowserSshHostKeyRefusedError,
  BrowserSshSubsystemRefusedError,
  noCommonAlgorithmError,
} from "./browserSshErrors";
import {
  Buffer,
  CommandRequestMessage,
  SshAuthenticationType,
  SshClientSession,
} from "./sshLibrary";
import { SshRelayStream } from "./sshRelayStream";
import { createBrowserSshConfiguration } from "./sshSessionConfiguration";

import type { NonExtractableEcdsaP256KeyPair } from "./nonExtractableEcdsaKey";
import type { RelaySocket } from "./sshRelayStream";
import type { SshChannel } from "./sshLibrary";

/** The server's host key as it arrived, before any credential is sent. */
export interface BrowserSshHostKey {
  /** The negotiated host-key algorithm, e.g. `ssh-ed25519`. */
  algorithm: string;
  /** The SSH wire-format public-key blob the server sent. */
  blob: Uint8Array<ArrayBuffer>;
}

/** What {@link connectBrowserSsh} needs. */
export interface BrowserSshConnectOptions {
  /** The SFTP relay's `ws:` or `wss:` url. */
  relayUrl: string;
  username: string;
  key: NonExtractableEcdsaP256KeyPair;
  /**
   * Decides whether to continue with this server. Called once, after the key
   * exchange has verified the server holds the key and before the client
   * signs anything; resolving `false` ends the session.
   */
  onHostKey: (hostKey: BrowserSshHostKey) => boolean | Promise<boolean>;
  /**
   * Stops the connection at any step, `onHostKey` included: it closes the relay
   * socket and rejects with the signal's reason, and nothing more reaches the
   * server. The SSH library's own pending steps are not cancelled: one can
   * still reject with nothing handling it, and once client authentication has
   * begun the library can still sign with the client key, though the
   * signature is never sent. It has no effect once the session is returned;
   * close that with its own `close`.
   */
  signal?: AbortSignal;
  /** @internal */
  createSocket?: (url: string) => RelaySocket;
}

/**
 * A host-key verifier in the shape core's file-sync connection installs as
 * `hostVerifier`: its pin check, its no-pin refusal, or its first-use capture
 * (docs/spec/SFTP_CONNECTION.md, SFTP host-key verification).
 */
export type BrowserSshHostVerifier = (
  keyBlob: Uint8Array,
  verdict: (permitted: boolean) => void,
) => void;

/**
 * The `onHostKey` that asks `verify` about the server's key, so the session
 * continues only on its verdict. A verifier that throws refuses the key.
 */
export function onHostKeyFromVerifier(
  verify: BrowserSshHostVerifier,
): BrowserSshConnectOptions["onHostKey"] {
  return (hostKey) =>
    new Promise<boolean>((resolve) => {
      try {
        verify(hostKey.blob, resolve);
      } catch {
        resolve(false);
      }
    });
}

/** An authenticated session with the `sftp` subsystem started on a channel. */
export interface BrowserSshSftpSession {
  /** The channel the SFTP protocol runs over. */
  channel: SshChannel;
  hostKey: BrowserSshHostKey;
  /** Close the channel, the session and the relay socket. */
  close: () => Promise<void>;
}

/**
 * Give the page a global `Buffer` if it has none. The SSH library reads one,
 * unimported, in its key exchange, channel and authentication code
 * (`algorithms/web/jsonWebKeyFormatter.js`, `sshChannel.js`,
 * `services/authenticationService.js`); it is the same `buffer` the library
 * imports elsewhere.
 *
 * @internal exported for testing
 */
export function provideBufferGlobal(): void {
  const scope = globalThis as { Buffer?: unknown };
  if (scope.Buffer === undefined) scope.Buffer = Buffer;
}

/** `work`, or a rejection with the signal's reason once it aborts. */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Connect to an SFTP server through the SFTP relay, check its host key with
 * the caller, authenticate with a non-extractable key, and start the `sftp`
 * subsystem. Rejects with a named error from ./browserSshErrors.ts when the
 * server offers no algorithm in common, the host key or the client key is
 * refused, the subsystem is refused, or the relay closes, and with the
 * signal's reason when `options.signal` aborts first.
 */
export async function connectBrowserSsh(
  options: BrowserSshConnectOptions,
): Promise<BrowserSshSftpSession> {
  const { signal } = options;
  signal?.throwIfAborted();
  provideBufferGlobal();
  const stream = await SshRelayStream.open(
    options.relayUrl,
    options.createSocket,
    signal,
  );
  const session = new SshClientSession(createBrowserSshConfiguration());
  let hostKey: BrowserSshHostKey | undefined;
  session.onAuthenticating((event) => {
    if (event.authenticationType !== SshAuthenticationType.serverPublicKey)
      return;
    event.authenticationPromise = (async () => {
      const blob = await event.publicKey?.getPublicKeyBytes();
      const algorithm = session.algorithms?.publicKeyAlgorithmName;
      if (blob === null || blob === undefined || algorithm === undefined)
        return null;
      hostKey = { algorithm, blob: new Uint8Array(blob) };
      return (await options.onHostKey(hostKey)) ? {} : null;
    })();
  });

  const establish = async (): Promise<{
    channel: SshChannel;
    acceptedHostKey: BrowserSshHostKey;
  }> => {
    // After an abort the session is disposed, and a step called on it raises
    // an error nothing awaits, so each step first checks the signal.
    await session.connect(stream);
    signal?.throwIfAborted();
    const serverAccepted = await session.authenticateServer();
    signal?.throwIfAborted();
    if (!serverAccepted || hostKey === undefined)
      throw new BrowserSshHostKeyRefusedError();
    const acceptedHostKey = hostKey;
    const authenticated = await session.authenticateClient({
      username: options.username,
      publicKeys: [options.key],
    });
    signal?.throwIfAborted();
    if (!authenticated)
      throw new BrowserSshAuthenticationRefusedError(options.username);
    const channel = await session.openChannel("session");
    signal?.throwIfAborted();
    const request = new CommandRequestMessage();
    request.requestType = "subsystem";
    request.command = "sftp";
    request.wantReply = true;
    const subsystemStarted = await channel.request(request);
    signal?.throwIfAborted();
    if (!subsystemStarted) throw new BrowserSshSubsystemRefusedError();
    return { channel, acceptedHostKey };
  };

  let channel: SshChannel;
  let acceptedHostKey: BrowserSshHostKey;
  try {
    ({ channel, acceptedHostKey } = await untilAborted(establish(), signal));
  } catch (error) {
    session.dispose();
    stream.dispose();
    if (signal?.aborted) throw signal.reason as Error;
    throw noCommonAlgorithmError(error) ?? stream.closeError ?? error;
  }

  return {
    channel,
    hostKey: acceptedHostKey,
    async close() {
      try {
        await channel.close();
      } catch {
        // The session may already be closed; closing it below ends the channel.
      }
      session.dispose();
      stream.dispose();
    },
  };
}
