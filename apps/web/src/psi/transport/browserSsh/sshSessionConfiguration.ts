import {
  SshAlgorithms,
  SshProtocolExtensionNames,
  SshSessionConfiguration,
} from "./sshLibrary";
import { EcdsaP256PublicKeyAlgorithm } from "./nonExtractableEcdsaKey";
import { Ed25519PublicKeyAlgorithm } from "./ed25519PublicKeyAlgorithm";

import type { SshAlgorithm } from "./sshLibrary";

/** The key exchanges the client offers, in order: ECDH only. */
export const BROWSER_SSH_KEY_EXCHANGES = [
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
] as const;

function present<T extends SshAlgorithm>(
  algorithm: T | null | undefined,
  label: string,
): T {
  if (algorithm === null || algorithm === undefined)
    throw new Error(`The SSH library provides no ${label}.`);
  return algorithm;
}

/**
 * The browser client's session configuration. It offers no finite-field
 * Diffie-Hellman (the bundle's `diffie-hellman` is a stub that throws), no
 * `none` algorithm, no key-exchange guess, and only public-key authentication.
 */
export function createBrowserSshConfiguration(): SshSessionConfiguration {
  const config = new SshSessionConfiguration(true);
  const { keyExchange, publicKey, encryption, hmac } = SshAlgorithms;

  config.keyExchangeAlgorithms.splice(
    0,
    Infinity,
    present(keyExchange.ecdhNistp256Sha256, "ecdh-sha2-nistp256"),
    present(keyExchange.ecdhNistp384Sha384, "ecdh-sha2-nistp384"),
    present(keyExchange.ecdhNistp521Sha512, "ecdh-sha2-nistp521"),
  );
  config.publicKeyAlgorithms.splice(
    0,
    Infinity,
    new Ed25519PublicKeyAlgorithm(),
    new EcdsaP256PublicKeyAlgorithm(),
    present(publicKey.ecdsaSha2Nistp384, "ecdsa-sha2-nistp384"),
    present(publicKey.ecdsaSha2Nistp521, "ecdsa-sha2-nistp521"),
    present(publicKey.rsaWithSha512, "rsa-sha2-512"),
    present(publicKey.rsaWithSha256, "rsa-sha2-256"),
  );
  config.encryptionAlgorithms.splice(
    0,
    Infinity,
    present(encryption.aes256Gcm, "aes256-gcm@openssh.com"),
    present(encryption.aes256Ctr, "aes256-ctr"),
  );
  config.hmacAlgorithms.splice(
    0,
    Infinity,
    present(hmac.hmacSha512Etm, "hmac-sha2-512-etm@openssh.com"),
    present(hmac.hmacSha256Etm, "hmac-sha2-256-etm@openssh.com"),
    present(hmac.hmacSha512, "hmac-sha2-512"),
    present(hmac.hmacSha256, "hmac-sha2-256"),
  );
  config.protocolExtensions.splice(
    0,
    Infinity,
    SshProtocolExtensionNames.serverSignatureAlgorithms,
  );
  // The library types the list with a const enum, which isolatedModules
  // cannot reference; "publickey" is its value.
  config.authenticationMethods.splice(
    0,
    Infinity,
    "publickey" as (typeof config.authenticationMethods)[number],
  );
  config.enableKeyExchangeGuess = false;
  return config;
}
