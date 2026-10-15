/**
 * The default relay a build names (`VITE_DEFAULT_RELAY_TURN_URL` and
 * `VITE_DEFAULT_RELAY_REGISTRAR_URL`). An invitation this build creates names
 * it and its registrar, and every browser run lists it beside any relay the invitation or this
 * browser's own setting names, once the run has enrolled its relay key at the
 * relay's registrar without a token (`enrollRelayKeyWithoutToken` in core),
 * right before it connects. The key and the exchange id it is enrolled under
 * both derive from the run's current shared secret.
 */

import {
  MAX_RELAY_LOCATOR_URLS,
  enrollRelayKeyWithoutToken,
  getLogger,
} from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayLocator } from "./rendezvous";
import type { RelayUrls } from "./ownRelaySetting";

const log = getLogger("defaultRelay");

/**
 * How long a dial waits for its enrollment at the default relay's registrar
 * before it connects without the relay. An arbitrary working value, raised on
 * request: a registrar that is up answers with one HTTPS request, a few
 * network round trips, which fits well inside it even on a slow link, and a
 * registrar that is down or slow costs a dial no more than this.
 */
export const DEFAULT_RELAY_DIAL_WAIT_MS = 3_000;

/** What the default relay's enrollment reads from its surroundings, and where
 * it reports a failure: injectable for tests. */
export interface DefaultRelayDependencies {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  setting?: () => DefaultRelaySetting | undefined;
  /** The registrar client; core's {@link enrollRelayKeyWithoutToken}. */
  enroll?: typeof enrollRelayKeyWithoutToken;
  /** Cancels the enrollment and the wait for it. */
  signal?: AbortSignal;
  /** How long a dial waits; {@link DEFAULT_RELAY_DIAL_WAIT_MS} when unset. */
  dialWaitMs?: number;
  /** Receives {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} when the enrollment
   * fails. */
  onRunNotice?: (message: string) => void;
}

/**
 * The relay an invitation names: `ownRelay`, followed by the default relay's
 * TURN url when the build names one, once, and only where the locator has
 * room for it under {@link MAX_RELAY_LOCATOR_URLS}. Where the result names
 * that url, it also names the default relay's registrar, where a command-line
 * party enrolls without a token. A new invitation and a managed re-invite both
 * name it this way.
 */
export function invitationRelayWithDefault(
  ownRelay: RelayUrls | undefined,
  defaultRelay: DefaultRelaySetting | undefined,
): RelayUrls | undefined {
  if (defaultRelay === undefined) return ownRelay;
  const turn = ownRelay?.turn ?? [];
  if (turn.includes(defaultRelay.turnUrl))
    return { ...ownRelay, registrar: defaultRelay.registrarUrl };
  if (turn.length >= MAX_RELAY_LOCATOR_URLS) return ownRelay;
  return {
    ...ownRelay,
    turn: [...turn, defaultRelay.turnUrl],
    registrar: defaultRelay.registrarUrl,
  };
}

/**
 * The run notice a run shows, as it connects, when its enrollment at the
 * default relay fails.
 */
export const DEFAULT_RELAY_NOT_ENROLLED_NOTICE =
  "The site's relay server could not be set up for this exchange. " +
  "Connecting without it.";

type Enrollment = "enrolled" | "failed" | "cancelled";

// One enrollment attempt. A refusal, a registrar that cannot be reached and
// `waitMs` passing are each "failed", and logged once.
async function enrollWithinDialWait(
  setting: DefaultRelaySetting,
  sharedSecret: string,
  dependencies: DefaultRelayDependencies,
): Promise<Enrollment> {
  const { signal } = dependencies;
  if (signal?.aborted === true) return "cancelled";
  const enroll = dependencies.enroll ?? enrollRelayKeyWithoutToken;
  const waitMs = dependencies.dialWaitMs ?? DEFAULT_RELAY_DIAL_WAIT_MS;
  const attempt = enroll(
    { registrarUrl: setting.registrarUrl, sharedSecret },
    {
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: waitMs,
      retryDelaysMs: [],
    },
  ).then(
    (outcome): true | string =>
      outcome.kind === "registered"
        ? true
        : `did not enroll this exchange (${outcome.kind}` +
          `${outcome.status === undefined ? "" : ` ${outcome.status}`})`,
    () => "could not be reached",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting = (): void => {};
  const waited = new Promise<string | undefined>((resolve) => {
    timer = setTimeout(
      () => resolve(`did not answer within ${waitMs} ms`),
      waitMs,
    );
    stopWaiting = () => resolve(undefined);
    signal?.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    const first = await Promise.race([attempt, waited]);
    if (first === true) return "enrolled";
    if (first === undefined) return "cancelled";
    log.warn(
      `the default relay's registrar ${first}, so this run connects ` +
        "without it",
    );
    return "failed";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stopWaiting);
  }
}

/**
 * The relay a browser run dials with: `relay`, this browser's own and the
 * invitation's (`relayForRun`), then the build's default relay once one
 * attempt to enroll the run's key at its registrar confirms, within
 * {@link DEFAULT_RELAY_DIAL_WAIT_MS}. A same-key repeat confirms. Otherwise
 * the default relay's TURN url is left out, even where the invitation names
 * it, and the run dials with the rest. A refused, unreachable or unanswered
 * enrollment shows {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} through
 * `onRunNotice`, once, before this returns; a cancelled one shows nothing.
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RelayLocator | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RelayLocator | undefined> {
  const setting = (dependencies.setting ?? defaultRelaySetting)();
  if (setting === undefined) return relay;
  const enrollment = await enrollWithinDialWait(
    setting,
    sharedSecret,
    dependencies,
  );
  if (enrollment === "failed")
    dependencies.onRunNotice?.(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
  const others = (relay?.turn ?? []).filter((url) => url !== setting.turnUrl);
  const turn =
    enrollment === "enrolled" ? [...others, setting.turnUrl] : others;
  const stun = [...(relay?.stun ?? [])];
  return turn.length + stun.length === 0 ? undefined : { turn, stun };
}
