import { PROJECT_SITE_URL } from "@components/projectLinks";

export {
  CONSOLE_INSTRUCTIONS_URL,
  INSTRUCTIONS_URL,
  userGuideUrl,
} from "@components/projectLinks";

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
