/**
 * The default relay a build names (`VITE_DEFAULT_RELAY_TURN_URL` and
 * `VITE_DEFAULT_RELAY_REGISTRAR_URL`): every browser run lists it beside any
 * relay the invitation or this browser's own setting names, once the run's
 * relay key is enrolled at the relay's registrar without a token
 * (`enrollRelayKeyWithoutToken` in core). The key and the exchange id it is
 * enrolled under both derive from the run's current shared secret.
 *
 * Enrollment starts before the dial where the page can start it -- at
 * invitation creation, when an invitation is opened for acceptance, at a
 * managed run's start -- and the dial waits for it at most
 * {@link DEFAULT_RELAY_DIAL_WAIT_MS}.
 */

import {
  MAX_RELAY_LOCATOR_URLS,
  deriveRelayExchangeId,
  deriveRelayKey,
  enrollRelayKeyWithoutToken,
  getLogger,
} from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import { PartnerNoShowError } from "./waitForConnection";
import { RELAY_CREDENTIAL_TTL_SECONDS } from "./relayCredentialTtl";

import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayLocator } from "./rendezvous";
import type { RelayRegistrationEnvironment } from "@alcove/core";
import type { RelayUrls } from "./ownRelaySetting";

const log = getLogger("defaultRelay");

/**
 * How long a dial waits for the run's default relay enrollment before it
 * gathers without the relay. An arbitrary working value, raised on request: a
 * registrar that is up answers with one HTTPS request, a few network round
 * trips, which fits well inside it even on a slow link, and a registrar that
 * is down or slow costs a dial no more than this.
 */
export const DEFAULT_RELAY_DIAL_WAIT_MS = 3_000;

/** How enrolling the run's key at the default relay's registrar turned out. */
export type DefaultRelayEnrollment =
  /** The build names no default relay; nothing was sent. */
  | { kind: "none" }
  /** The registrar holds the key: the default relay is listed. */
  | { kind: "enrolled"; turnUrl: string }
  /** The registrar refused it, could not be reached, or had not answered
   * within the dial's wait. */
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
  /** How long a dial waits; {@link DEFAULT_RELAY_DIAL_WAIT_MS} when unset. */
  dialWaitMs?: number;
}

interface PageEnrollment {
  outcome: Promise<DefaultRelayEnrollment>;
  /** Set once confirmed: when the registrar lets the enrollment lapse. */
  lapsesAtMs?: number;
}

// The enrollments this page has started or confirmed, by registrar, exchange
// id and relay key. An unconfirmed one is dropped when it settles and a
// confirmed one once it would lapse before a run's relay credential expires,
// so a later run of the same exchange enrolls again.
const pageEnrollments = new Map<string, PageEnrollment>();

async function pageEnrollmentKey(
  setting: DefaultRelaySetting,
  sharedSecret: string,
): Promise<string> {
  const [exchangeId, relayKey] = await Promise.all([
    deriveRelayExchangeId(sharedSecret),
    deriveRelayKey(sharedSecret),
  ]);
  return `${setting.registrarUrl} ${exchangeId} ${relayKey}`;
}

function heldEnrollment(key: string): PageEnrollment | undefined {
  const held = pageEnrollments.get(key);
  if (
    held?.lapsesAtMs !== undefined &&
    held.lapsesAtMs - Date.now() < RELAY_CREDENTIAL_TTL_SECONDS * 1000
  ) {
    pageEnrollments.delete(key);
    return undefined;
  }
  return held;
}

function lapseTime(lapsesAt: string | null): number {
  if (lapsesAt === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(lapsesAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function beginEnrollment(
  key: string,
  setting: DefaultRelaySetting,
  sharedSecret: string,
  dependencies: DefaultRelayDependencies,
  environment: RelayRegistrationEnvironment,
): PageEnrollment {
  const enroll = dependencies.enroll ?? enrollRelayKeyWithoutToken;
  const held: PageEnrollment = {
    outcome: enroll(
      { registrarUrl: setting.registrarUrl, sharedSecret },
      environment,
    ).then(
      (outcome): DefaultRelayEnrollment => {
        if (outcome.kind === "registered") {
          held.lapsesAtMs = lapseTime(outcome.lapsesAt);
          return { kind: "enrolled", turnUrl: setting.turnUrl };
        }
        if (pageEnrollments.get(key) === held) pageEnrollments.delete(key);
        const status = outcome.status === undefined ? "" : ` ${outcome.status}`;
        log.warn(
          `the default relay's registrar did not enroll this exchange ` +
            `(${outcome.kind}${status}), so the default relay is left out`,
        );
        return { kind: "not-enrolled", turnUrl: setting.turnUrl };
      },
      (error: unknown) => {
        if (pageEnrollments.get(key) === held) pageEnrollments.delete(key);
        throw error;
      },
    ),
  };
  pageEnrollments.set(key, held);
  return held;
}

/**
 * Enroll the relay key `sharedSecret` derives at the default relay's
 * registrar, with no token and core's retries, or join this page's enrollment
 * of the same key. Never throws for a refusal or a network failure: each is
 * `not-enrolled`, logged without the registrar's text.
 */
export async function enrollAtDefaultRelay(
  sharedSecret: string,
  dependencies: DefaultRelayDependencies = {},
): Promise<DefaultRelayEnrollment> {
  const setting = (dependencies.setting ?? defaultRelaySetting)();
  if (setting === undefined) return { kind: "none" };
  const key = await pageEnrollmentKey(setting, sharedSecret);
  const held =
    heldEnrollment(key) ??
    beginEnrollment(
      key,
      setting,
      sharedSecret,
      dependencies,
      dependencies.signal !== undefined ? { signal: dependencies.signal } : {},
    );
  return held.outcome;
}

/**
 * Start {@link enrollAtDefaultRelay} without waiting for it, so a later dial
 * of the same exchange finds it confirmed or under way.
 */
export function startDefaultRelayEnrollment(
  sharedSecret: string,
  dependencies: DefaultRelayDependencies = {},
): void {
  enrollAtDefaultRelay(sharedSecret, dependencies).catch(() => {
    log.warn("the default relay enrollment could not start");
  });
}

// `outcome`, or `not-enrolled` once `waitMs` passes or `signal` aborts first.
async function withinDialWait(
  outcome: Promise<DefaultRelayEnrollment>,
  turnUrl: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<DefaultRelayEnrollment> {
  const notEnrolled: DefaultRelayEnrollment = { kind: "not-enrolled", turnUrl };
  if (signal?.aborted === true) return notEnrolled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting = (): void => {};
  const waited = new Promise<"waited" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("waited"), waitMs);
    stopWaiting = () => resolve("cancelled");
    signal?.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    const first = await Promise.race([outcome, waited]);
    if (first === "waited") {
      log.warn(
        `the default relay's registrar did not confirm within ${waitMs} ms, ` +
          "so this run connects without the default relay",
      );
      return notEnrolled;
    }
    return first === "cancelled" ? notEnrolled : first;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stopWaiting);
  }
}

/**
 * The enrollment a dial lists the default relay under, waiting at most
 * `dialWaitMs`: this page's confirmed enrollment of the run's key at once,
 * one under way until it settles, and otherwise one attempt bounded by the
 * same wait.
 */
async function enrollmentForDial(
  sharedSecret: string,
  dependencies: DefaultRelayDependencies,
): Promise<DefaultRelayEnrollment> {
  const setting = (dependencies.setting ?? defaultRelaySetting)();
  if (setting === undefined) return { kind: "none" };
  const waitMs = dependencies.dialWaitMs ?? DEFAULT_RELAY_DIAL_WAIT_MS;
  const key = await pageEnrollmentKey(setting, sharedSecret);
  const held =
    heldEnrollment(key) ??
    beginEnrollment(key, setting, sharedSecret, dependencies, {
      ...(dependencies.signal !== undefined
        ? { signal: dependencies.signal }
        : {}),
      timeoutMs: waitMs,
      retryDelaysMs: [],
    });
  return withinDialWait(
    held.outcome,
    setting.turnUrl,
    waitMs,
    dependencies.signal,
  );
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
 * The relay an invitation names: `ownRelay`, followed by the default relay's
 * TURN url when `enrollment` enrolled it and the locator has room for it
 * under {@link MAX_RELAY_LOCATOR_URLS}. A new invitation and a managed
 * re-invite both name it this way.
 */
export function invitationRelayWithDefault(
  ownRelay: RelayUrls | undefined,
  enrollment: DefaultRelayEnrollment,
): RelayUrls | undefined {
  const turn = ownRelay?.turn ?? [];
  if (
    enrollment.kind !== "enrolled" ||
    turn.includes(enrollment.turnUrl) ||
    turn.length >= MAX_RELAY_LOCATOR_URLS
  )
    return ownRelay;
  return { ...ownRelay, turn: [...turn, enrollment.turnUrl] };
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
 * browser's own (`relayForRun`), plus the default relay once the run's key is
 * enrolled there. Waits for the enrollment at most
 * {@link DEFAULT_RELAY_DIAL_WAIT_MS}.
 */
export async function relayWithDefaultForRun(
  sharedSecret: string,
  relay: RelayLocator | undefined,
  dependencies: DefaultRelayDependencies = {},
): Promise<RunRelay> {
  const enrollment = await enrollmentForDial(sharedSecret, dependencies);
  return {
    relay: withDefaultRelay(relay, enrollment),
    defaultRelayNotEnrolled: enrollment.kind === "not-enrolled",
  };
}

/**
 * Whether a run whose connection failed with `error` shows
 * {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE}: its default relay enrollment
 * failed, and the connection failed for a reason other than the partner never
 * arriving ({@link PartnerNoShowError}), which no relay would have changed.
 */
export function showsDefaultRelayNotice(
  runRelay: Pick<RunRelay, "defaultRelayNotEnrolled">,
  error: unknown,
): boolean {
  return (
    runRelay.defaultRelayNotEnrolled && !(error instanceof PartnerNoShowError)
  );
}

/**
 * `connect`'s result, or its failure after showing
 * {@link DEFAULT_RELAY_NOT_ENROLLED_NOTICE} through `onRunNotice` when
 * {@link showsDefaultRelayNotice} holds and `signal` has not cancelled the run.
 */
export async function connectNoticingDefaultRelay<T>(
  runRelay: Pick<RunRelay, "defaultRelayNotEnrolled">,
  options: { onRunNotice: (message: string) => void; signal?: AbortSignal },
  connect: () => Promise<T>,
): Promise<T> {
  try {
    return await connect();
  } catch (error) {
    if (
      showsDefaultRelayNotice(runRelay, error) &&
      options.signal?.aborted !== true
    )
      options.onRunNotice(DEFAULT_RELAY_NOT_ENROLLED_NOTICE);
    throw error;
  }
}
