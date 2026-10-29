import { PROJECT_SITE_URL } from "@components/projectLinks";
import { isConsoleBuild } from "@utils/clientConfig";

/** The step-by-step instructions' home page, which sets out the web app, the
 * console and the command line and links each one's instructions. */
export const INSTRUCTIONS_URL = `${PROJECT_SITE_URL}/`;

/** The step-by-step instructions for starting the console container. */
export const CONSOLE_INSTRUCTIONS_URL = `${PROJECT_SITE_URL}/console-start`;

/** How the built-in rules behind each Built-in rules choice were chosen. */
export const BUILT_IN_RULES_GUIDE_URL = `${PROJECT_SITE_URL}/docs/EXCHANGE_REFERENCE#choosing-the-built-in-rules`;

/** What an exchange's Allowed relays decide in the browser, and what they do
 * not. */
export const ALLOWED_RELAYS_GUIDE_URL = `${PROJECT_SITE_URL}/docs/WEB_APP#allowed-relays`;

/** What each setting on the Relay server page does. */
export const RELAY_SETTINGS_GUIDE_URL = `${PROJECT_SITE_URL}/docs/WEB_APP#relay-settings`;

/** The `connection.allowed_relays` key the console writes a run's Allowed
 * relays into. */
export const CONSOLE_ALLOWED_RELAYS_GUIDE_URL = `${PROJECT_SITE_URL}/docs/EXCHANGE_REFERENCE#connectionallowed_relays`;

/** The instructions for the build this page is: starting the console on a
 * console build, the instructions' home page otherwise. */
export function userGuideUrl(): string {
  return isConsoleBuild() ? CONSOLE_INSTRUCTIONS_URL : INSTRUCTIONS_URL;
}
