/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { generateSharedSecret } from "@alcove/core";

import { listenAsInviter } from "@psi/transport/rendezvous";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";

import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";

/**
 * What a browser run under Relay only offers its partner, measured in real
 * Chromium: the peer connection is built from the configuration the run hands
 * PeerJS (`relayPlanForRun`, then `listenAsInviter`), and every candidate it
 * gathers, and every candidate line its offer holds, is read. No relay is
 * reachable here, so a relay-only run gathers nothing at all; the same run
 * without Relay only gathers a host candidate, which shows the measurement
 * sees one when it is there.
 */

/** A relay under a reserved name that never resolves (RFC 6761). */
const UNREACHABLE_RELAY_URL = "turn:relay.invalid:3478";

/**
 * How long a run's gathering is watched where it does not complete: Chromium
 * under a relay-only policy was measured not completing within 15 seconds
 * here. An arbitrary working value, far past the few milliseconds the same
 * run without Relay only takes to gather a host candidate, which the last
 * test checks.
 */
const OBSERVATION_WINDOW_MS = 5_000;

/** A Peer that opens at once and holds the options it was built with. */
class CapturingPeer extends EventEmitter {
  destroy(): void {}
  constructor(readonly options: PeerOptions) {
    super();
    queueMicrotask(() => this.emit("open", "inviter"));
  }
}

async function configurationForRun(
  relayOnly: boolean,
  ownTurn: ReadonlyArray<string>,
): Promise<RTCConfiguration> {
  const secret = generateSharedSecret();
  const plan = await relayPlanForRun(secret, undefined, {
    readOwn: () => ({ kind: "set", relay: { turn: ownTurn, stun: [] } }),
    setting: () => undefined,
    restriction: () => ({ relayOnly }),
  });
  let captured: CapturingPeer | undefined;
  await listenAsInviter(secret, {
    ...plan,
    peerFactory: (_id, options) => {
      captured = new CapturingPeer(options);
      return captured as unknown as Peer;
    },
  });
  const config = captured?.options.config as RTCConfiguration | undefined;
  if (config === undefined) throw new Error("no peer configuration captured");
  return config;
}

/** The candidate types a peer connection gathers for an offer, and the
 * types its offer names, once gathering completes, once a candidate of type
 * `until` is gathered where it is given, or once the observation window
 * ends, whichever is first. */
async function offeredCandidateTypes(
  configuration: RTCConfiguration,
  until?: RTCIceCandidateType,
): Promise<{
  gathered: Array<string>;
  inOffer: Array<string>;
  elapsedMs: number;
}> {
  const pc = new RTCPeerConnection(configuration);
  const gathered: Array<string> = [];
  const started = performance.now();
  try {
    const observed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, OBSERVATION_WINDOW_MS);
      pc.addEventListener("icecandidate", (event) => {
        const type = event.candidate?.type;
        if (type !== undefined && type !== null) gathered.push(type);
        if (
          event.candidate === null ||
          (until !== undefined && type === until)
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    await observed;
    const sdp = pc.localDescription?.sdp ?? "";
    const inOffer = [...sdp.matchAll(/^a=candidate:.* typ (\w+)/gm)].map(
      (match) => match[1],
    );
    return { gathered, inOffer, elapsedMs: performance.now() - started };
  } finally {
    pc.close();
  }
}

describe("a browser run under Relay only", () => {
  test(
    "builds its peer connection relay-only and offers no host or server-reflexive candidate",
    { timeout: 60_000 },
    async () => {
      const configuration = await configurationForRun(true, [
        UNREACHABLE_RELAY_URL,
      ]);
      expect(configuration.iceTransportPolicy).toBe("relay");
      const { gathered, inOffer } = await offeredCandidateTypes(configuration);
      for (const types of [gathered, inOffer]) {
        expect(types).not.toContain("host");
        expect(types).not.toContain("srflx");
        expect(types).not.toContain("prflx");
      }
    },
  );

  test(
    "with no TURN url to use, offers no candidate at all",
    { timeout: 60_000 },
    async () => {
      const configuration = await configurationForRun(true, []);
      expect(configuration.iceTransportPolicy).toBe("relay");
      const { gathered, inOffer } = await offeredCandidateTypes(configuration);
      expect({ gathered, inOffer }).toEqual({ gathered: [], inOffer: [] });
    },
  );

  test(
    "without Relay only, the same run offers a host candidate well within the window",
    { timeout: 60_000 },
    async () => {
      const configuration = await configurationForRun(false, [
        UNREACHABLE_RELAY_URL,
      ]);
      expect(configuration.iceTransportPolicy).toBe("all");
      const { gathered, inOffer, elapsedMs } = await offeredCandidateTypes(
        configuration,
        "host",
      );
      expect(gathered).toContain("host");
      expect(inOffer).toContain("host");
      expect(elapsedMs).toBeLessThan(OBSERVATION_WINDOW_MS / 2);
    },
  );
});
