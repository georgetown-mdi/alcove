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
 * What a run that did not connect adds to its failure where the build offers
 * its default relay switched off and the run did not list it.
 */
export const DEFAULT_RELAY_OFF_REMEDY =
  "This site's relay server is off in this browser. Where a network blocks " +
  "direct connections, or blocks connections to TURN relays, turning on " +
  `"${DEFAULT_RELAY_SWITCH_LABEL}" on the Relay server page (relay settings ` +
  "on the start page) may let the exchange connect.";

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
