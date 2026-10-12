// The anchor a Markdown heading takes, by GitHub's rule. `npm run linkcheck`
// checks every `#anchor` link against it, and the project site
// (docs/.vitepress/config.mjs) gives its headings the same anchors, so a link
// that resolves on GitHub resolves on the site.

/**
 * GitHub-style heading slug: lowercase, drop characters that are not word
 * characters (letters, digits, underscore), whitespace, or hyphen, then turn
 * each remaining whitespace character into a hyphen without collapsing runs
 * (so "ssh2 / ssh2" -> "ssh2--ssh2"). Inline links and code spans in a heading
 * are reduced to their text first.
 */
export function slugify(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation; \w keeps underscores, as GitHub does
    .trim()
    .replace(/\s/g, "-"); // each whitespace char -> hyphen, runs not collapsed
}
