import {
  ALLOW_MISSING_PREREQUISITES_ENV,
  prerequisitesAreRequired,
} from "@alcove/testkit/prerequisiteGate";
import { loopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";

/**
 * The vitest `globalSetup` entry point. The HTTPS legs of
 * `signalingServer.test.ts` and `signalingUpgradeTimeout.test.ts` skip when no
 * loopback certificate can be minted; where the environment must supply
 * `openssl` (CI) that is a failed run rather than a skip, and elsewhere the
 * skipped-leg reporter names the legs.
 */
export default function setup(): void {
  if (loopbackTlsCert === null && prerequisitesAreRequired(process.env))
    throw new Error(
      "no loopback TLS certificate could be minted here, so the broker's " +
        "HTTPS legs would skip in an environment that is supposed to supply " +
        "one. Install `openssl`, or set " +
        `${ALLOW_MISSING_PREREQUISITES_ENV}=1 to skip those legs.`,
    );
}
