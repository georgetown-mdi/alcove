/**
 * Whether this browser's user turned on a default relay the build offers
 * switched off (`VITE_DEFAULT_RELAY_MODE=opt-in`), kept in localStorage for
 * this site, and the words that name the switch where a run that did not
 * connect points at it. Which relay a run then lists: ./defaultRelay.ts.
 */

/** The localStorage key the switch is written under while it is on. */
const STORAGE_KEY = "alcove-default-relay-on";

/** The value the key holds while the switch is on. */
const ON = "1";

/** The switch's label on the relay settings page. */
export const DEFAULT_RELAY_SWITCH_LABEL = "Use this site's relay server";

/**
 * What the failure alert of a run whose connection did not open adds to its
 * own message where the build offers its default relay switched off, the run
 * did not list it, and the run's allowed relays keep it
 * (`failedWithDefaultRelayOff` in ./iceGathering.ts).
 */
export const DEFAULT_RELAY_OFF_REMEDY =
  "This site's relay server is off in this browser. If a network blocks " +
  "direct connections, or blocks connections to TURN relays, turning on " +
  `the switch to ${DEFAULT_RELAY_SWITCH_LABEL.charAt(0).toLowerCase()}` +
  `${DEFAULT_RELAY_SWITCH_LABEL.slice(1)} on the Relay server page (the relay ` +
  "settings link on the start page) and trying again may let the exchange " +
  "connect.";

function storage(): Storage | undefined {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    return store;
  } catch {
    return undefined;
  }
}

/** Whether the switch is on; off where storage is unreachable. */
export function readDefaultRelaySwitch(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === ON;
  } catch {
    return false;
  }
}

/**
 * Turn the switch on or off. Off removes the key, the state of a browser that
 * never turned it on.
 *
 * @throws where storage is unavailable or refuses the write.
 */
export function writeDefaultRelaySwitch(on: boolean): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (on) store.setItem(STORAGE_KEY, ON);
  else store.removeItem(STORAGE_KEY);
}
