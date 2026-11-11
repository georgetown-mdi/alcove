/**
 * First-use host-key trust for a browser SFTP run: the browser counterpart of
 * the CLI's first-use step (`apps/cli/src/hostKeyTrust.ts`). It decides the
 * pin a run connects with; the check against that pin is core's verifier,
 * which the run's connect hands the SSH client's `onHostKey`
 * ({@link ./browserSshClient.ts}). Rules: docs/spec/SFTP_CONNECTION.md, SFTP
 * host-key verification, The browser SFTP path.
 */

import { HOST_KEY_FINGERPRINT_REGEX, UsageError } from "@alcove/core";

import type { PresentedHostKey, SFTPConnectionConfig } from "@alcove/core";
import type { SftpRelayForExchange } from "../sftpRelaySetting";

/** Where the SFTP relay a run dials came from. */
export type BrowserSftpRelaySource = Extract<
  SftpRelayForExchange,
  { url: string }
>["kind"];

/** The run a first-use decision is made for. */
export interface BrowserHostKeyTrustContext {
  /** Whether a person is at the page to answer; a scheduled run is not. */
  attended: boolean;
  relay: BrowserSftpRelaySource;
}

/** The steps that reach the server or the operator, injected by the page. */
export interface BrowserHostKeyTrustDeps {
  /**
   * Read the server's host key without authenticating: core's
   * `FileSyncConnection.probeHostKeyFingerprint` over the browser transport.
   */
  probe: (connection: SFTPConnectionConfig) => Promise<PresentedHostKey>;
  /** Show the presented key; resolves true only on the operator's yes. */
  confirmPresentedKey: (presented: PresentedHostKey) => Promise<boolean>;
  /**
   * Ask for the server's fingerprint as its administrator gives it; resolves
   * undefined when the operator cancels.
   */
  enterServerFingerprint: () => Promise<string | undefined>;
}

/** What {@link establishBrowserHostKeyTrust} decided. */
export interface BrowserHostKeyTrust {
  /** The connection to open, with the pin its connect checks the server against. */
  connection: SFTPConnectionConfig;
  /**
   * The fingerprint pinned on this first use, for the caller to store with a
   * recurring exchange (`persistManagedExchangeHostKeyPin`); undefined where a
   * pin was already set.
   */
  newPin?: string;
}

/**
 * Decide the host-key pin an SFTP run connects with. A connection that has a
 * pin is returned unchanged, and its connect checks the server against it. One
 * with none needs a person at the page: through a relay the party set itself,
 * the server's key is read without authenticating and pinned on the
 * operator's yes; through a relay the invitation names, the operator enters
 * the server's fingerprint and the key the relay shows is never pinned. The
 * returned connection is a copy; `connection` is not changed.
 *
 * @throws {UsageError} when no pin is set and the run is unattended, the
 *   operator declines or cancels, or the entered text is not a fingerprint;
 *   nothing has been sent to the server.
 * @throws what `deps.probe` throws when it reads no key.
 */
export async function establishBrowserHostKeyTrust(
  connection: SFTPConnectionConfig,
  context: BrowserHostKeyTrustContext,
  deps: BrowserHostKeyTrustDeps,
): Promise<BrowserHostKeyTrust> {
  if (connection.server.hostKeyFingerprint !== undefined) return { connection };
  if (!context.attended)
    throw new UsageError(
      "The SFTP server's host key is not pinned, so a scheduled run cannot " +
        "check the server and did not connect. Open the exchange and run it " +
        "once to pin the server's host key.",
    );
  const newPin =
    context.relay === "own"
      ? await confirmedPresentedKey(connection, deps)
      : await enteredFingerprint(deps);
  return {
    connection: {
      ...connection,
      server: { ...connection.server, hostKeyFingerprint: newPin },
    },
    newPin,
  };
}

async function confirmedPresentedKey(
  connection: SFTPConnectionConfig,
  deps: BrowserHostKeyTrustDeps,
): Promise<string> {
  const presented = await deps.probe(connection);
  if (!(await deps.confirmPresentedKey(presented)))
    throw new UsageError(
      "The server's host key was not trusted, so nothing was sent to the " +
        "server. Check its fingerprint with the server's administrator, then " +
        "run the exchange again.",
    );
  return presented.fingerprint;
}

async function enteredFingerprint(
  deps: BrowserHostKeyTrustDeps,
): Promise<string> {
  const entered = (await deps.enterServerFingerprint())?.trim();
  if (entered === undefined || entered === "")
    throw new UsageError(
      "No host key fingerprint was entered, so nothing was sent to the " +
        "server. Ask the server's administrator for its SHA256 fingerprint, " +
        "then run the exchange again.",
    );
  if (!HOST_KEY_FINGERPRINT_REGEX.test(entered))
    throw new UsageError(
      "The text entered is not a host key fingerprint. Enter it as the " +
        "server's administrator gives it, for example SHA256: followed by 43 " +
        "characters.",
    );
  return entered;
}
