import { PROJECT_SITE_URL, SOURCE_CODE_URL } from "@alcove/core";

/** A section of a page under `docs/`, as the project site serves it. */
function docsSectionUrl(page: string, anchor: string): string {
  return `${PROJECT_SITE_URL}/docs/${page}#${anchor}`;
}

/** The CLI guide's account of re-establishing a shared secret. */
export const OUT_OF_SYNC_TOKENS_DOC_URL = docsSectionUrl(
  "CLI",
  "out-of-sync-tokens",
);

/** The CLI guide's section on `alcove doctor probe` and `doctor mount`. */
export const SHARED_FOLDER_CHECK_DOC_URL = docsSectionUrl(
  "CLI",
  "checking-a-network-shared-folder",
);

/** The CLI guide's section on `alcove doctor relay`. */
export const RELAY_CHECK_DOC_URL = docsSectionUrl(
  "CLI",
  "checking-the-relay-of-a-webrtc-exchange",
);

/**
 * The Windows file-drop troubleshooting page. It lives under `support/`, which
 * the project site does not publish, so it is linked in the repository.
 */
export const WINDOWS_TROUBLESHOOTING_URL =
  `${SOURCE_CODE_URL}/blob/main/support/windows-network-filedrop/` +
  "troubleshooting.md";

/**
 * A pointer to one section of {@link WINDOWS_TROUBLESHOOTING_URL}, by its
 * heading, ending in the URL so no punctuation follows it.
 */
export function windowsTroubleshootingSection(heading: string): string {
  return `'${heading}' on the troubleshooting page, ${WINDOWS_TROUBLESHOOTING_URL}`;
}
