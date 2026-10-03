import { isConsoleBuild } from "@utils/clientConfig";

/** The task guide for a one-off exchange in the hosted browser app. */
export const WEB_APP_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/WEB_APP.md";

/** The guide for running the console container. */
export const CONSOLE_GUIDE_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/CONSOLE.md";

/** The user guide for the build this page is: the console guide on a console
 * build, the browser task guide otherwise. */
export function userGuideUrl(): string {
  return isConsoleBuild() ? CONSOLE_GUIDE_URL : WEB_APP_GUIDE_URL;
}
