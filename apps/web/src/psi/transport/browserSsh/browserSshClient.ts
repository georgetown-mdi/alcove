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
  /** @internal */
  createSocket?: (url: string) => RelaySocket;
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

/**
 * Connect to an SFTP server through the SFTP relay, check its host key with
 * the caller, authenticate with a non-extractable key, and start the `sftp`
 * subsystem. Rejects with a named error from ./browserSshErrors.ts when the
 * server offers no algorithm in common, the host key or the client key is
 * refused, the subsystem is refused, or the relay closes.
 */
export async function connectBrowserSsh(
  options: BrowserSshConnectOptions,
): Promise<BrowserSshSftpSession> {
  provideBufferGlobal();
  const stream = await SshRelayStream.open(
    options.relayUrl,
    options.createSocket,
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

  const fail = (error: unknown): never => {
    session.dispose();
    stream.dispose();
    throw noCommonAlgorithmError(error) ?? stream.closeError ?? error;
  };

  try {
    await session.connect(stream);
  } catch (error) {
    return fail(error);
  }
  let channel: SshChannel;
  try {
    if (!(await session.authenticateServer()) || hostKey === undefined)
      throw new BrowserSshHostKeyRefusedError();
    const authenticated = await session.authenticateClient({
      username: options.username,
      publicKeys: [options.key],
    });
    if (!authenticated)
      throw new BrowserSshAuthenticationRefusedError(options.username);
    channel = await session.openChannel("session");
    const request = new CommandRequestMessage();
    request.requestType = "subsystem";
    request.command = "sftp";
    request.wantReply = true;
    if (!(await channel.request(request)))
      throw new BrowserSshSubsystemRefusedError();
  } catch (error) {
    return fail(error);
  }

  const acceptedHostKey = hostKey;
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
