/**
 * The relay test on the Relay server page: whether each TURN url a browser run
 * lists answers this browser, asked with a placeholder credential the relay
 * refuses. It contacts no registrar and enrolls nothing, and runs only when
 * the user starts it. Spec: docs/spec/PROTOCOL.md, Testing the browser's
 * relays.
 */

import { sanitizeForDisplay } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import { readOwnRelaySetting } from "./ownRelaySetting";

import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { OwnRelayRead } from "./ownRelaySetting";

/**
 * How long the test waits for each relay. An arbitrary working value, the
 * CLI relay check's own: Chromium was measured taking about 40 seconds to
 * report an unanswered UDP relay, so such a relay ends on this bound.
 */
export const RELAY_TEST_BOUND_MS = 30_000;

/** The username the test presents; the credential beside it is random. */
const RELAY_TEST_USERNAME = "alcove-relay-test";

/** Bound on the browser's error text as quoted in a result. */
const MAX_ERROR_TEXT_LENGTH = 200;

/** The STUN code a relay answers a credential it does not accept with. */
const UNAUTHORIZED = 401;

/** The code Chromium reports for a server it could not reach. */
const NO_ANSWER = 701;

/** The transport a TURN url names. */
export type RelayTransport = "udp" | "tcp" | "tls";

const TRANSPORT_LABEL: Record<RelayTransport, string> = {
  udp: "UDP",
  tcp: "TCP",
  tls: "TLS",
};

/** Which setting a tested url comes from. */
export type RelayTestSource = "own" | "site";

/** One TURN url the test contacts. */
export interface RelayTestTarget {
  url: string;
  source: RelayTestSource;
  transport: RelayTransport;
}

/** What one relay did over one transport. */
export type RelayTestOutcome =
  /** A 401 came back, or the relay gave a relay address. */
  | { kind: "answered"; relayAddress: boolean }
  /** The relay answered with an error other than 401. */
  | { kind: "refused"; errorCode: number; errorText: string }
  /** Chromium reported no answer, or none came within the bound. */
  | { kind: "no-answer"; reason: "reported"; errorText: string }
  | { kind: "no-answer"; reason: "bound" | "gathering-ended" }
  /** The browser refused the url, so the relay was not asked. */
  | { kind: "not-asked" };

/** The result for one url over one transport. */
export interface RelayTestResult {
  url: string;
  source: RelayTestSource;
  transport: RelayTransport;
  outcome: RelayTestOutcome;
}

/**
 * The transport a TURN url names, as the browser reads it: `turns:` is TLS,
 * `turn:` is TCP where its `transport` parameter says `tcp`, and UDP
 * otherwise.
 */
export function turnUrlTransport(url: string): RelayTransport {
  if (url.startsWith("turns:")) return "tls";
  const queryStart = url.indexOf("?");
  const query = queryStart === -1 ? "" : url.slice(queryStart + 1);
  return new URLSearchParams(query).get("transport") === "tcp" ? "tcp" : "udp";
}

/**
 * The TURN urls the test contacts: those a browser run lists from this
 * browser's saved relay and the build's default relay, in a run's order, each
 * once. The invitation's relay is not known here, so it is not listed.
 */
export function relayTestTargets(
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
  defaultRelay: () => DefaultRelaySetting | undefined = defaultRelaySetting,
): Array<RelayTestTarget> {
  const own = readOwn();
  const site = defaultRelay();
  const ownTurn = own.kind === "set" ? own.relay.turn : [];
  const targets: Array<RelayTestTarget> = [...new Set(ownTurn)]
    .filter((url) => url !== site?.turnUrl)
    .map((url) => ({ url, source: "own", transport: turnUrlTransport(url) }));
  if (site !== undefined)
    targets.push({
      url: site.turnUrl,
      source: "site",
      transport: turnUrlTransport(site.turnUrl),
    });
  return targets;
}

/** What the test reads from its surroundings: injectable for tests. */
export interface RelayTestDependencies {
  /** Builds each peer connection; the browser's `RTCPeerConnection`. */
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  /** How long each relay is waited on; {@link RELAY_TEST_BOUND_MS}. */
  boundMs?: number;
  /** Ends the test early, closing every peer connection. */
  signal?: AbortSignal;
}

function placeholderCredential(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRelayTransport(value: unknown): value is RelayTransport {
  return value === "udp" || value === "tcp" || value === "tls";
}

/** What one peer connection saw for one transport. */
interface TransportObservation {
  relayAddress: boolean;
  errors: Array<{ errorCode: number; errorText: string }>;
}

function outcomeOf(
  observation: TransportObservation | undefined,
  ended: "bound" | "gathering-ended",
): RelayTestOutcome {
  if (observation?.relayAddress)
    return { kind: "answered", relayAddress: true };
  const errors = observation?.errors ?? [];
  if (errors.some((error) => error.errorCode === UNAUTHORIZED))
    return { kind: "answered", relayAddress: false };
  const refusal = errors.find((error) => error.errorCode !== NO_ANSWER);
  if (refusal !== undefined) return { kind: "refused", ...refusal };
  const unreached = errors.at(0);
  if (unreached !== undefined)
    return {
      kind: "no-answer",
      reason: "reported",
      errorText: unreached.errorText,
    };
  return { kind: "no-answer", reason: ended };
}

/** Ask the relay at `target` for a relay address, and report per transport. */
async function testOneRelay(
  target: RelayTestTarget,
  createPeerConnection: (configuration: RTCConfiguration) => RTCPeerConnection,
  boundMs: number,
  signal: AbortSignal | undefined,
): Promise<Array<RelayTestResult>> {
  const observations = new Map<RelayTransport, TransportObservation>();
  const observe = (transport: RelayTransport): TransportObservation => {
    let observation = observations.get(transport);
    if (observation === undefined) {
      observation = { relayAddress: false, errors: [] };
      observations.set(transport, observation);
    }
    return observation;
  };
  let pc: RTCPeerConnection;
  try {
    pc = createPeerConnection({
      iceServers: [
        {
          urls: [target.url],
          username: RELAY_TEST_USERNAME,
          credential: placeholderCredential(),
        },
      ],
      iceTransportPolicy: "relay",
    });
  } catch {
    return [
      {
        url: target.url,
        source: target.source,
        transport: target.transport,
        outcome: { kind: "not-asked" },
      },
    ];
  }
  let ended: "bound" | "gathering-ended" = "bound";
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, boundMs);
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const gatheringEnded = () => {
        ended = "gathering-ended";
        stop();
      };
      if (signal?.aborted === true) {
        stop();
        return;
      }
      signal?.addEventListener("abort", stop);
      pc.addEventListener("icecandidate", (event) => {
        const { candidate } = event;
        if (candidate === null) gatheringEnded();
        else if (candidate.type === "relay") {
          // Standard, and in Chromium, but not yet in TypeScript's DOM types.
          const { relayProtocol } = candidate as RTCIceCandidate & {
            relayProtocol?: unknown;
          };
          const transport = isRelayTransport(relayProtocol)
            ? relayProtocol
            : target.transport;
          observe(transport).relayAddress = true;
          if (transport === target.transport) stop();
        }
      });
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") gatheringEnded();
      });
      pc.addEventListener("icecandidateerror", (event) => {
        const { url, errorCode, errorText } = event;
        const transport =
          typeof url === "string" && /^turns?:/i.test(url)
            ? turnUrlTransport(url)
            : target.transport;
        const code = typeof errorCode === "number" ? errorCode : 0;
        const observation = observe(transport);
        if (!observation.errors.some((error) => error.errorCode === code))
          observation.errors.push({
            errorCode: code,
            errorText: typeof errorText === "string" ? errorText : "",
          });
        if (code === UNAUTHORIZED && transport === target.transport) stop();
      });
      pc.createDataChannel("relay-test");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(gatheringEnded);
    });
  } finally {
    pc.close();
  }
  const transports = [
    target.transport,
    ...[...observations.keys()].filter(
      (transport) => transport !== target.transport,
    ),
  ];
  return transports.map((transport) => ({
    url: target.url,
    source: target.source,
    transport,
    outcome: outcomeOf(observations.get(transport), ended),
  }));
}

/**
 * Ask every relay in `targets` at once, each on a peer connection of its own
 * holding that url alone, a placeholder credential and the `relay` transport
 * policy, and report each url per transport, in `targets` order. Each
 * connection is closed when its relay's result is known or the bound expires.
 */
export async function runRelayTest(
  targets: ReadonlyArray<RelayTestTarget>,
  dependencies: RelayTestDependencies = {},
): Promise<Array<RelayTestResult>> {
  const createPeerConnection =
    dependencies.createPeerConnection ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const boundMs = dependencies.boundMs ?? RELAY_TEST_BOUND_MS;
  const results = await Promise.all(
    targets.map((target) =>
      testOneRelay(target, createPeerConnection, boundMs, dependencies.signal),
    ),
  );
  return results.flat();
}

/** How a url's source is named beside it. */
export function relayTestSourceLabel(source: RelayTestSource): string {
  return source === "own" ? "your relay" : "this site's relay";
}

/** The transport as a result names it. */
export function relayTestTransportLabel(transport: RelayTransport): string {
  return TRANSPORT_LABEL[transport];
}

const UNREACHED_REMEDY =
  "Check that the relay address is correct and that this network allows " +
  "connections to it, then run the test again.";

const REFUSED_REMEDY =
  "Check the relay's settings for this error, or ask whoever runs it, then " +
  "run the test again.";

function described(code: number, errorText: string): string {
  const text = sanitizeForDisplay(errorText.trim(), {
    maxLength: MAX_ERROR_TEXT_LENGTH,
  });
  return text === "" ? `error ${code}` : `error ${code}: ${text}`;
}

/**
 * One result as the page shows it: the outcome over its transport and what it
 * shows, with a reason and a remedy for a failure. The url is shown beside it.
 */
export function relayTestResultText(result: RelayTestResult): string {
  const over = TRANSPORT_LABEL[result.transport];
  const { outcome } = result;
  switch (outcome.kind) {
    case "answered":
      return outcome.relayAddress
        ? `Answered over ${over}: the relay gave a relay address, so this ` +
            `browser reaches it over ${over}.`
        : `Answered over ${over}: the relay refused the test's placeholder ` +
            `credential, so this browser reaches it over ${over}.`;
    case "refused":
      return (
        `Refused over ${over}: the relay answered with ` +
        `${described(outcome.errorCode, outcome.errorText)}. ${REFUSED_REMEDY}`
      );
    case "no-answer":
      return `No answer over ${over}: ${noAnswerReason(outcome)}. ${UNREACHED_REMEDY}`;
    case "not-asked":
      return (
        "Not tested: this browser did not accept the address, so the relay " +
        "was not asked. Check that the relay address is correct."
      );
  }
}

function noAnswerReason(
  outcome: Extract<RelayTestOutcome, { kind: "no-answer" }>,
): string {
  switch (outcome.reason) {
    case "reported":
      return `the browser reported ${described(NO_ANSWER, outcome.errorText)}`;
    case "bound":
      return `the relay did not answer within ${String(RELAY_TEST_BOUND_MS / 1000)} seconds`;
    case "gathering-ended":
      return "the browser stopped asking without an answer from the relay";
  }
}
