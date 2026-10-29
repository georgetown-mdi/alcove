// @ts-check
// The project site, built by VitePress from the Markdown under docs/ and a few
// files at the repository root, in place: `npm run site:build` writes
// docs/.vitepress/dist, which site_deploy.yaml uploads to Cloudflare Pages.
// What the site is and how it deploys: docs/DEPLOYMENT.md, "The project site".

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { slugify } from "../../scripts/lib/headingSlug.mjs";
import {
  GUIDE_SECTIONS,
  GUIDES_DIR,
  guideMarkdown,
  guidePageData,
  guideRewrites,
} from "./guides.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const REPOSITORY_URL = "https://github.com/georgetown-mdi/alcove";
const WEB_APP_URL = "https://psi.data-bridge.org/";

// The repository-root documents the site publishes beside docs/. Every other
// root entry is excluded, so a new top-level file or directory stays off the
// site until it is named here and in site_deploy.yaml's path filters, which
// scripts/site-deploy-trigger.test.mjs holds.
export const ROOT_PAGES = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
];

const srcExclude = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.name !== "docs" && !ROOT_PAGES.includes(entry.name))
  .map((entry) => (entry.isDirectory() ? `${entry.name}/**` : entry.name))
  .concat(["**/node_modules/**", "docs/.vitepress/**"]);

// The guides are served at the site root, the overview beside the
// documentation index, and each directory's README at the directory's own
// address.
const REWRITES = {
  ...guideRewrites(),
  "docs/index.md": "docs/overview.md",
  "docs/README.md": "docs/index.md",
  "docs/spec/README.md": "docs/spec/index.md",
  "docs/notes/README.md": "docs/notes/index.md",
};

const toPosix = (path) => path.split(sep).join(posix.sep);

/** Whether a repository-relative path is a page this site renders. */
function isSitePage(path) {
  return (
    path.endsWith(".md") &&
    (ROOT_PAGES.includes(path) || path.startsWith("docs/")) &&
    existsSync(resolve(repoRoot, path))
  );
}

/** The address a page is served at, for a sidebar entry or a link. */
function siteAddress(path) {
  const served = REWRITES[path] ?? path;
  return `/${served.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
}

// A relative link is resolved against the file it is written in, as GitHub
// and `npm run linkcheck` resolve it, before VitePress sees it: one to a page
// the site renders becomes that page's site address, which a page served at
// another path (REWRITES) cannot resolve relatively. One to anything else in
// the repository -- a source file, a workflow, a directory, a Markdown file the
// site does not publish -- points at that path on GitHub.
function linkRepositoryFiles(md) {
  md.core.ruler.push("alcove_repository_links", (state) => {
    const sourcePath = state.env?.realPath ?? state.env?.path;
    // A heading parsed for a page title has no source path and no link.
    if (typeof sourcePath !== "string") return;
    const tokens = state.tokens.flatMap((token) => token.children ?? []);
    for (const token of tokens) {
      if (token.type !== "link_open") continue;
      const href = token.attrGet("href");
      if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
      const [, target, fragment] = /^([^#?]*)(.*)$/s.exec(href) ?? [];
      if (!target) continue;
      const absolute = resolve(dirname(sourcePath), decodeURIComponent(target));
      const path = toPosix(relative(repoRoot, absolute));
      if (path.startsWith("..") || !existsSync(absolute)) continue;
      const isDirectory = statSync(absolute).isDirectory();
      const page = isDirectory ? posix.join(path, "README.md") : path;
      if (isSitePage(page)) {
        token.attrSet("href", `${siteAddress(page)}${fragment}`);
        continue;
      }
      const view = isDirectory ? "tree" : "blob";
      token.attrSet(
        "href",
        `${REPOSITORY_URL}/${view}/main/${path}${fragment}`,
      );
    }
  });
}

// VitePress compiles each page as a Vue template, which reads `{{` in text or
// inline code as an expression. Writing the braces as character references
// shows them as written; fenced code is already excluded from compilation.
function escapeTemplateDelimiters(md) {
  for (const rule of ["text", "code_inline"]) {
    const render = md.renderer.rules[rule];
    if (!render) {
      throw new Error(`markdown-it has no ${rule} renderer rule to wrap.`);
    }
    md.renderer.rules[rule] = (...args) =>
      render(...args).replace(/\{\{/g, "&#123;&#123;");
  }
}

// With raw HTML off, an HTML comment GitHub hides would print as text. A block
// comment is dropped from its `<!--` line through the line holding `-->`, as
// CommonMark ends an HTML comment block; an inline one is dropped through its
// `-->`. An unterminated comment is left as text.
function dropHtmlComments(md) {
  md.block.ruler.before(
    "html_block",
    "alcove_html_comment_block",
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const lineText = (line) =>
        state.src.slice(
          state.bMarks[line] + state.tShift[line],
          state.eMarks[line],
        );
      if (!lineText(startLine).startsWith("<!--")) return false;
      let line = startLine;
      let closing = lineText(line).indexOf("-->", 4);
      while (closing === -1 && ++line < endLine) {
        closing = lineText(line).indexOf("-->");
      }
      if (closing === -1) return false;
      if (!silent) state.line = line + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote"] },
  );
  md.inline.ruler.before(
    "html_inline",
    "alcove_html_comment_inline",
    (state) => {
      if (!state.src.startsWith("<!--", state.pos)) return false;
      const closing = state.src.indexOf("-->", state.pos + 4);
      if (closing === -1) return false;
      state.pos = closing + 3;
      return true;
    },
  );
}

/** A sidebar entry for a page, refusing one whose file does not exist. */
function page(text, path) {
  if (!isSitePage(path)) {
    throw new Error(
      `docs/.vitepress/config.mjs names ${path} in a menu, which is not a page the site renders. Correct the path or remove the entry.`,
    );
  }
  return { text, link: siteAddress(path) };
}

/** @type {import("vitepress").UserConfig} */
export default {
  title: "Alcove",
  description:
    "Privacy-preserving record linkage through private set intersection.",
  lang: "en-US",
  srcDir: "..",
  srcExclude,
  rewrites: REWRITES,
  cleanUrls: true,
  lastUpdated: false,
  // Without JavaScript the guide switchers cannot change pane, so every pane
  // is shown under its name, and a narrow screen shows the rail of pages in
  // place of the page picker.
  head: [
    [
      "noscript",
      {},
      '<style>html .guide-site .guide-tabs [role="tablist"]{display:none}html .guide-site .guide-tabs [role="tabpanel"][hidden]{display:block}html .guide-site .guide-tabs [role="tabpanel"]::before{content:attr(data-name);display:block;margin-top:16px;font-weight:650}@media (max-width:860px){html .guide-site .rail{display:grid;position:static}html .guide-site .picker{display:none}}</style>',
    ],
  ],
  // With srcDir at the repository root, the default public directory would be
  // a top-level public/; the site's static files sit beside this config.
  vite: { publicDir: resolve(repoRoot, "docs/.vitepress/public") },
  markdown: {
    // Raw HTML is shown as text, and HTML comments are dropped
    // (dropHtmlComments): a `<name>` placeholder in prose would otherwise reach
    // the Vue template compiler as an element that is never closed.
    html: false,
    // Heading anchors follow GitHub's rule, the one `npm run linkcheck` checks
    // every `#anchor` link against, so a link that resolves there resolves here.
    anchor: { slugify },
    config: (md) => {
      dropHtmlComments(md);
      linkRepositoryFiles(md);
      escapeTemplateDelimiters(md);
      guideMarkdown(md);
    },
  },
  transformPageData: guidePageData,
  themeConfig: {
    search: { provider: "local" },
    // The reference pages' title leads to the documentation index; the nav's
    // Guides entry is their one link to the guides.
    logoLink: "/docs/",
    nav: [
      { text: "Guides", link: "/" },
      { text: "Changelog", link: "/CHANGELOG" },
      { text: "Security", link: "/SECURITY" },
      { text: "Web app", link: WEB_APP_URL },
    ],
    socialLinks: [{ icon: "github", link: REPOSITORY_URL }],
    repositoryUrl: REPOSITORY_URL,
    webAppUrl: WEB_APP_URL,
    // The guides' own menu, drawn by theme/GuideLayout.mjs.
    guideSections: GUIDE_SECTIONS.map(({ group, topNav = true, pages }) => ({
      group,
      topNav,
      pages: pages.map(([stem, title]) => ({
        stem,
        title,
        link: page(title, `${GUIDES_DIR}${stem}.md`).link,
      })),
    })),
    sidebar: [
      {
        text: "Using Alcove",
        items: [
          page("Overview", "docs/index.md"),
          page("Documentation index", "docs/README.md"),
          page("Web app", "docs/WEB_APP.md"),
          page(
            "Recurring exchanges in the browser",
            "docs/MANAGED_EXCHANGE.md",
          ),
          page("Command line", "docs/CLI.md"),
          page(
            "Exchange configuration reference",
            "docs/EXCHANGE_REFERENCE.md",
          ),
          page("Console", "docs/CONSOLE.md"),
          page("Deployment", "docs/DEPLOYMENT.md"),
          page("FIPS SFTP profile", "docs/FIPS_SFTP_PROFILE.md"),
        ],
      },
      {
        text: "Design and security",
        items: [
          page("Design", "docs/DESIGN.md"),
          page("Security design", "docs/SECURITY_DESIGN.md"),
          page("Shared responsibility", "docs/SHARED_RESPONSIBILITY.md"),
          page("Compliance", "docs/COMPLIANCE.md"),
          page("Service fact sheet", "docs/SERVICE_FACT_SHEET.md"),
          page("Privacy", "PRIVACY.md"),
          page("How an exchange communicates", "docs/COMMUNICATION.md"),
          page("Technical specifications", "docs/spec/README.md"),
          page("Design notes", "docs/notes/README.md"),
        ],
      },
      {
        text: "Project",
        items: [
          page("Changelog", "CHANGELOG.md"),
          page("Releases", "docs/RELEASES.md"),
          page("Roadmap", "docs/ROADMAP.md"),
          page("Security policy", "SECURITY.md"),
          page("Incident response", "docs/INCIDENT_RESPONSE.md"),
          page("Contributing", "CONTRIBUTING.md"),
          page("Testing", "docs/TESTING.md"),
          page("Support", "SUPPORT.md"),
          page("License", "LICENSE.md"),
        ],
      },
    ],
  },
};
