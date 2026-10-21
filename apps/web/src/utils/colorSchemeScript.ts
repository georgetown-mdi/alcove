import { APP_COLOR_SCHEME } from "../theme.ts";

// Mantine's localStorageColorSchemeManager key, which MantineProvider reads
// and writes when given no manager of its own.
const MANTINE_COLOR_SCHEME_STORAGE_KEY = "mantine-color-scheme-value";

/**
 * The script that sets the document's `data-mantine-color-scheme` before the
 * first paint, as Mantine's `ColorSchemeScript` does, so a dark system does not
 * show a light page until the app loads. Unlike Mantine's, only the storage
 * read is guarded: a page whose storage access throws still follows the
 * system setting.
 */
export const colorSchemeScriptSource = `(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem(${JSON.stringify(MANTINE_COLOR_SCHEME_STORAGE_KEY)});
  } catch (e) {}
  var scheme = stored === "light" || stored === "dark" || stored === "auto" ? stored : ${JSON.stringify(APP_COLOR_SCHEME)};
  if (scheme === "auto")
    scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
})();`;

/** {@link colorSchemeScriptSource} as the element a document's head holds. */
export const colorSchemeScriptElement = `<script data-mantine-script>${colorSchemeScriptSource}</script>`;

/**
 * `html` with {@link colorSchemeScriptElement} added at the end of its head:
 * the hosted and console builds each pass their document template through it.
 */
export function withColorSchemeScript(html: string): string {
  if (!html.includes("</head>"))
    throw new Error("the document template has no </head>");
  return html.replace("</head>", `  ${colorSchemeScriptElement}\n  </head>`);
}
