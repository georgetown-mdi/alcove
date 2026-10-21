/** The search parameter the "Set up a recurring exchange" entries add to the
 * invite flow's URL, so the flow can say where saving happens. */
export const RECURRING_SETUP_PARAM = "recurring";

/** Where the "Set up a recurring exchange" entries go. A full navigation, not
 * the SPA Link: the invite flow reads the parameter from the real URL on
 * mount, and the route has no typed search schema to hold it. */
export const RECURRING_SETUP_HREF = `/exchange?${RECURRING_SETUP_PARAM}=1`;

/** The invite flow's opening line for a visitor who came to set up a
 * recurring exchange. */
export const RECURRING_SETUP_NOTE =
  "You can save this exchange to run again once it finishes.";

/** Whether the URL's query string marks an arrival from a "Set up a recurring
 * exchange" entry. */
export function arrivedForRecurringSetup(search: string): boolean {
  return new URLSearchParams(search).get(RECURRING_SETUP_PARAM) === "1";
}
