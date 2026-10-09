import { READINESS_BODY } from "@alcove/peerjs-broker/standaloneOptions";

import { startStandaloneBroker } from "../utils/standaloneBroker.ts";

import { CLI_IDENTITY, startCliInviter } from "./cliPeer.ts";
import { LEG_ENVIRONMENT_FAILURE } from "./legTypes.ts";
import { startConsoleParty } from "./consolePeer.ts";

import type {
  ConsoleJobOutcome,
  ConsoleLegStart,
  LiveLegCliOutcome,
  LiveLegStart,
} from "./legTypes.ts";
import type { CliInviter } from "./cliPeer.ts";
import type { ConsoleParty } from "./consolePeer.ts";
import type { StandaloneBroker } from "../utils/standaloneBroker.ts";

/**
 * The Node half of the live CLI-to-browser WebRTC leg, registered as vitest
 * browser commands on the `live-webrtc` project (apps/web/vite.config.ts).
 *
 * A browser test cannot spawn a broker or an `alcove` process, and this leg
 * needs both standing while it runs. Commands are the channel vitest provides
 * for exactly that, and they are what lets the browser test assert BOTH
 * parties' association tables in its own body rather than in a teardown hook,
 * where a mismatch would report as a run-level error instead of a failed
 * assertion.
 *
 * The state below is per vitest node process. The leg's broker, the signaling
 * probe's broker (`signalingProbe.test.ts`) and the console leg's broker
 * (`consoleExchange.test.ts`) are held apart, so no file stops another's
 * broker.
 */

let broker: StandaloneBroker | undefined;
let inviter: CliInviter | undefined;
let probeBroker: StandaloneBroker | undefined;
let consoleBroker: StandaloneBroker | undefined;
let consoleParty: ConsoleParty | undefined;

/**
 * Start the broker on its own loopback origin, then an `alcove invite` waiting
 * at it, and hand the browser peer the invitation.
 *
 * The CLI is invited over `ws://`: the broker terminates no TLS, and the page
 * this leg runs on is itself plain HTTP, so the browser peer resolves the same
 * scheme from its own origin (PeerJS's `secure` default).
 */
async function startLeg(): Promise<LiveLegStart> {
  await stopLeg();
  broker = await startStandaloneBroker(LEG_ENVIRONMENT_FAILURE);
  inviter = await startCliInviter(
    `ws://127.0.0.1:${broker.port}${broker.path}`,
  );
  return {
    invitation: inviter.invitation,
    brokerOrigin: `http://127.0.0.1:${broker.port}`,
    readinessBody: broker.readinessBody,
    expectedReadinessBody: READINESS_BODY,
    cliIdentity: CLI_IDENTITY,
  };
}

/** Wait for the CLI party to finish and report what its run did. */
async function cliOutcome(): Promise<LiveLegCliOutcome> {
  if (inviter === undefined)
    throw new Error("no CLI party is running; the leg was never started");
  return await inviter.outcome();
}

/** Stop both processes and remove the CLI party's working directory.
 * Idempotent, and safe to call on a leg that never started. */
async function stopLeg(): Promise<void> {
  const running = [inviter?.stop(), broker?.stop()];
  inviter = undefined;
  broker = undefined;
  await Promise.all(running);
}

/** Start a broker alone for the signaling probe and return its port and
 * mount path. */
async function startProbeBroker(): Promise<{ port: number; path: string }> {
  await stopProbeBroker();
  probeBroker = await startStandaloneBroker(LEG_ENVIRONMENT_FAILURE);
  return { port: probeBroker.port, path: probeBroker.path };
}

/** Stop the probe's broker. Idempotent. */
async function stopProbeBroker(): Promise<void> {
  const running = probeBroker?.stop();
  probeBroker = undefined;
  await running;
}

/**
 * Start the broker on its own loopback origin and the console server beside
 * it, with the broker authored as the console's coordination server over
 * `ws://`, the scheme the plain-HTTP page resolves too.
 */
async function startConsoleLeg(): Promise<ConsoleLegStart> {
  await stopConsoleLeg();
  consoleBroker = await startStandaloneBroker(LEG_ENVIRONMENT_FAILURE);
  consoleParty = await startConsoleParty(
    `ws://127.0.0.1:${consoleBroker.port}${consoleBroker.path}`,
  );
  return {
    signaling: consoleParty.signaling,
    readinessBody: consoleBroker.readinessBody,
    expectedReadinessBody: READINESS_BODY,
  };
}

function runningConsoleParty(): ConsoleParty {
  if (consoleParty === undefined)
    throw new Error("no console party is running; the leg was never started");
  return consoleParty;
}

/** Stop the console server and its broker. Idempotent. */
async function stopConsoleLeg(): Promise<void> {
  const running = [consoleParty?.stop(), consoleBroker?.stop()];
  consoleParty = undefined;
  consoleBroker = undefined;
  await Promise.all(running);
}

/**
 * The commands `test.browser.commands` registers. Each takes the browser
 * command context, which this leg does not read: the processes are the Node
 * side's own, not the page's.
 */
export const liveWebrtcLegCommands = {
  startLiveWebrtcLeg: (): Promise<LiveLegStart> => startLeg(),
  liveWebrtcCliOutcome: (): Promise<LiveLegCliOutcome> => cliOutcome(),
  stopLiveWebrtcLeg: (): Promise<void> => stopLeg(),
  startSignalingProbeBroker: (): Promise<{ port: number; path: string }> =>
    startProbeBroker(),
  stopSignalingProbeBroker: (): Promise<void> => stopProbeBroker(),
  startConsoleWebrtcLeg: (): Promise<ConsoleLegStart> => startConsoleLeg(),
  createConsoleWebrtcJob: (
    _context: unknown,
    intent: unknown,
  ): Promise<string> => runningConsoleParty().createJob(intent),
  consoleWebrtcJobOutcome: (): Promise<ConsoleJobOutcome> =>
    runningConsoleParty().outcome(),
  stopConsoleWebrtcLeg: (): Promise<void> => stopConsoleLeg(),
};
