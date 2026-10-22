import { X509Certificate, createHash } from "node:crypto";

import { loopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";

import type { LoopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";

// The certificate the test WebSocket relays serve `wss` under, and the
// Chromium switch that trusts its key alone. vite.config.ts reads the switch
// before Chromium launches, and a relay started later in the same run, from a
// globalSetup or a browser command, serves the same certificate: it is held in
// the environment, since those files load as separate module instances.

const HELD_CERTIFICATE_ENV = "ALCOVE_TEST_RELAY_TLS";

/** The run's relay certificate, or `null` where none can be minted here. */
export function relayTlsCert(): LoopbackTlsCert | null {
  const held = process.env[HELD_CERTIFICATE_ENV];
  if (held !== undefined) return JSON.parse(held) as LoopbackTlsCert;
  if (loopbackTlsCert === null) return null;
  process.env[HELD_CERTIFICATE_ENV] = JSON.stringify(loopbackTlsCert);
  return loopbackTlsCert;
}

/**
 * The Chromium launch switch that accepts {@link relayTlsCert} by the hash of
 * its public key, and no other certificate; none where it cannot be minted.
 */
export function relayTlsLaunchArgs(): Array<string> {
  const credentials = relayTlsCert();
  if (credentials === null) return [];
  const spki = new X509Certificate(credentials.cert).publicKey.export({
    type: "spki",
    format: "der",
  });
  const hash = createHash("sha256").update(spki).digest("base64");
  return [`--ignore-certificate-errors-spki-list=${hash}`];
}
