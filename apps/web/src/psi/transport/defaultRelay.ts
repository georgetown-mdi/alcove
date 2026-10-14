/**
 * The default relay a build names (`VITE_DEFAULT_RELAY_TURN_URL` and
 * `VITE_DEFAULT_RELAY_REGISTRAR_URL`): every browser run lists it beside any
 * relay the invitation or this browser's own setting names, once the run has
 * enrolled its relay key at the relay's registrar without a token
 * (`enrollRelayKeyWithoutToken` in core). The key and the exchange id it is
 * enrolled under both derive from the run's current shared secret.
 */

import { enrollRelayKeyWithoutToken, getLogger } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayLocator } from "./rendezvous";

const log = getLogger("defaultRelay");

/** How enrolling the run's key at the default relay's registrar turned out. */
export type DefaultRelayEnrollment =
  /** The build names no default relay; nothing was sent. */
  | { kind: "none" }
  /** The registrar holds the key: the default relay is listed. */
  | { kind: "enrolled"; turnUrl: string }
  /** The registrar refused it, or could not be reached. */
  | { kind: "not-enrolled"; turnUrl: string };

/** What the default relay's enrollment reads from its surroundings:
 * injectable for tests. */
export interface DefaultRelayDependencies {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  setting?: () => DefaultRelaySetting | undefined;
  /** The registrar client; core's {@link enrollRelayKeyWithoutToken}. */
  enroll?: typeof enrollRelayKeyWithoutToken;
  /** Cancels the enrollment and its retries. */
  signal?: AbortSignal;
}

/**
 * Enroll the relay key `sharedSecret` derives at the default relay's
 * registrar, with no token. Never throws for a refusal or a network failure:
 * each is `not-enrolled`, logged without the registrar's text.
 */
export async function enrollAtDefaultRelay(
  sharedSecret: string,
  dependencies: DefaultRelayDependencies = {},
): Promise<DefaultRelayEnrollment> {
  const setting = (dependencies.setting ?? defaultRelaySetting)();
  if (setting === undefined) return { kind: "none" };
  const enroll = dependencies.enroll ?? enrollRelayKeyWithoutToken;
  const outcome = await enroll(
    { registrarUrl: setting.registrarUrl, sharedSecret },
    dependencies.signal !== undefined ? { signal: dependencies.signal } : {},
  );
  if (outcome.kind === "registered")
    return { kind: "enrolled", turnUrl: setting.turnUrl };
  const status = outcome.status === undefined ? "" : ` ${outcome.status}`;
  log.warn(
    `the default relay's registrar did not enroll this exchange ` +
      `(${outcome.kind}${status}), so the default relay is left out`,
  );
  return { kind: "not-enrolled", turnUrl: setting.turnUrl };
}

/**
 * `relay` with the default relay's TURN url added when `enrollment` enrolled
 * it, once: an invitation from this build already names it.
 */
export function withDefaultRelay(
  relay: RelayLocator | undefined,
  enrollment: DefaultRelayEnrollment,
): RelayLocator | undefined {
  if (enrollment.kind !== "enrolled") return relay;
  const turn = relay?.turn ?? [];
  return {
    turn: turn.includes(enrollment.turnUrl)
      ? [...turn]
      : [...turn, enrollment.turnUrl],
    stun: [...(relay?.stun ?? [])],
  };
}

/**
 * The run notice a run whose default relay enrollment failed shows when its
 * connection does not open.
 */
export const DEFAULT_RELAY_NOT_ENROLLED_NOTICE =
  "The relay server could not be set up for this exchange, so the " +
  "connection was tried without it. Try again; if it fails again, try " +
  "from another network.";

/** The relay a run lists, and whether its default relay enrollment failed. */
export interface RunRelay {
  relay: RelayLocator | undefined;
  defaultRelayNotEnrolled: boolean;
}

/**
 * The relay a browser run gathers against: `relay`, the invitation's or this
 * browser's own (`relayForRun`), plus the default relay once the run
 * has enrolled its key there ({@link enrollAtDefaultRelay}).
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RelayLocator | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RunRelay> {
  const enrollment = await enrollAtDefaultRelay(sharedSecret, dependencies);
  return {
    relay: withDefaultRelay(relay, enrollment),
    defaultRelayNotEnrolled: enrollment.kind === "not-enrolled",
  };
}

/**
 * `connect`'s result, or its failure after showing
 * {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} through `onRunNotice` when the
 * run's default relay enrollment failed and `signal` has not cancelled it.
 */
export async function connectNoticingDefaultRelay<T>(
  runRelay: Pick<RunRelay, "defaultRelayNotEnrolled">,
  options: { onRunNotice: (message: string) => void; signal?: AbortSignal },
  connect: () => Promise<T>,
): Promise<T> {
  try {
    return await connect();
  } catch (error) {
    if (runRelay.defaultRelayNotEnrolled && options.signal?.aborted !== true)
      options.onRunNotice(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
    throw error;
  }
}
