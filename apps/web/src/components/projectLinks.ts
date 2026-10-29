import { isConsoleBuild } from "@utils/clientConfig";

/** The project site: the step-by-step instructions at its root, the
 * documentation under `/docs/`. */
export const PROJECT_SITE_URL = "https://data-bridge.org";

/** The project's source repository. */
export const SOURCE_CODE_URL = "https://github.com/georgetown-mdi/alcove";

/** The Massive Data Institute's page for its privacy-enhancing technologies work. */
export const MDI_PETS_URL = "https://mdi.georgetown.edu/pets/";

/** The documentation index on the project site. */
export const DOCUMENTATION_URL = `${PROJECT_SITE_URL}/docs/`;

/** The privacy statement for the hosted site. */
export const PRIVACY_URL = `${PROJECT_SITE_URL}/PRIVACY`;

/** The security policy and how to report a vulnerability. */
export const SECURITY_URL = `${PROJECT_SITE_URL}/SECURITY`;

/** Where to get help. */
export const SUPPORT_URL = `${PROJECT_SITE_URL}/SUPPORT`;

/** The step-by-step instructions' home page, which sets out the web app, the
 * console and the command line and links each one's instructions. */
export const INSTRUCTIONS_URL = `${PROJECT_SITE_URL}/`;

/** The step-by-step instructions for starting the console container. */
export const CONSOLE_INSTRUCTIONS_URL = `${PROJECT_SITE_URL}/console-start`;

/** The instructions for the build this page is: starting the console on a
 * console build, the instructions' home page otherwise. */
export function userGuideUrl(): string {
  return isConsoleBuild() ? CONSOLE_INSTRUCTIONS_URL : INSTRUCTIONS_URL;
}
