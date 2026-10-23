import { isConsoleBuild } from "@utils/clientConfig";

/** The task guide for a one-off exchange in the hosted browser app. */
export const WEB_APP_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/WEB_APP.md";

/** The guide for running the console container. */
export const CONSOLE_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/CONSOLE.md";

/** How the built-in rules behind each Built-in rules choice were chosen. */
export const BUILT_IN_RULES_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/EXCHANGE_REFERENCE.md#choosing-rules-by-precision-floor";

/** What an exchange's Allowed relays decide in the browser, and what they do
 * not. */
export const ALLOWED_RELAYS_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/WEB_APP.md#allowed-relays";

/** The `connection.allowed_relays` key the console writes a run's Allowed
 * relays into. */
export const CONSOLE_ALLOWED_RELAYS_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/EXCHANGE_REFERENCE.md#connectionallowed_relays";

/** Where the README describes the ways to use Alcove besides this web app. */
export const OTHER_WAYS_TO_USE_ALCOVE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/README.md#three-ways-to-use-alcove";

/** The user guide for the build this page is: the console guide on a console
 * build, the browser task guide otherwise. */
export function userGuideUrl(): string {
  return isConsoleBuild() ? CONSOLE_GUIDE_URL : WEB_APP_GUIDE_URL;
}
