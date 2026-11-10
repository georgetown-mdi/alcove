---
title: "Where the project site's content lives in the repository"
---

# Where the project site's content lives in the repository

_Status: proposal, agent-written; nothing is moved, and the layout waits on the
maintainer's ruling. It weighs where the project site's pages, guides and
build configuration live, against the repository documentation the site also
renders. What the site is and how it deploys:
[DEPLOYMENT.md](../DEPLOYMENT.md#the-project-site)._

Every count below was measured at `origin/staging` 837cde344 on 2026-11-10.

## The current layout

### What the site publishes

The build ([config.mjs](../.vitepress/config.mjs)) sets `srcDir` to the
repository root and excludes every root entry except `docs/`, `site/` and six
root pages. It publishes:

| Source | Pages | Address | Layout |
| ------ | ----- | ------- | ------ |
| `site/` (home, who it is for, about, contact) | 4 | `/`, `/<stem>` | guide layout |
| `docs/guides/` | 14, plus 2 include files | `/guides`, `/<stem>` | guide layout |
| `docs/*.md` (overview, governance, contributor references) | 22 | `/docs/<NAME>` | default theme |
| `docs/spec/` | 29 | `/docs/spec/<NAME>` | default theme |
| `docs/notes/` | 72 | `/docs/notes/<name>` | default theme |
| `CHANGELOG`, `CONTRIBUTING`, `LICENSE`, `PRIVACY`, `SECURITY`, `SUPPORT` | 6 | `/<NAME>` | default theme |

So every Markdown file under `docs/` is on the site, the design notes and the
spec included, not only on GitHub.

### Where the site's own files sit

The site's own material is split over three directories:

- `site/`: the 4 project pages and 5 images.
- `docs/guides/`: the 16 guide files.
- `docs/.vitepress/`: 8 files - the two config modules, the theme (4 files),
  `_redirects` and `security.txt`.

The build configuration sits inside `docs/` but reads the whole repository.

### What moves when a page is added

- **A project page:** the file in `site/`, and a menu entry in
  `docs/.vitepress/guides.mjs`. A test fails a project page with no menu entry.
- **A guide:** the file in `docs/guides/`, a menu entry in the same module, and
  a file stem no project page uses.
- **Any other Markdown file under `docs/`:** nothing. A new note or spec page is
  public at `/docs/...` from the next publish, with or without a sidebar entry.
- **A new root file or directory:** nothing reaches the site until it is named
  in `ROOT_PAGES` and in `site_deploy.yaml`'s filters, which a test holds
  together.

### How a collision arises

`guideRewrites()` in [guides.mjs](../.vitepress/guides.mjs) serves every page
of two directories, `site/` and `docs/guides/`, at the site root under its
file stem. A guide and a project page with the same stem, or a project page
named `guides.md`, would share an address. The filesystem cannot prevent this
because the two files sit in different directories, so the build throws.

The check covers only those two directories. A guide named after a root page
(`SECURITY.md`) would also be served at `/SECURITY`, and its rewrite table
does not hold the root pages. Whether VitePress itself refuses that is not
driven here.

### Which paths are named, and where

- **Build:** `package.json` (`site:build`, `site:dev`: `vitepress build docs`),
  `config.mjs` (`SOURCE_DIRECTORIES`, `ROOT_PAGES`, the `docs/.vitepress/**`
  exclude, `publicDir`), `guides.mjs` (`GUIDES_DIR`, `SITE_DIR`), `.gitignore`
  (`docs/.vitepress/cache`).
- **Workflows:**
  - [site_deploy.yaml](../../.github/workflows/site_deploy.yaml): 14 path
    filters, listed twice, and the artifact path `docs/.vitepress/dist`.
  - [site_publish.yaml](../../.github/workflows/site_publish.yaml): the same
    artifact path, and `REVIEW_PATHS` (`docs site` and the six root pages).
  - [pr_checklist.yaml](../../.github/workflows/pr_checklist.yaml):
    `paths-ignore: site/**`.
- **Tests and checks:**
  - `scripts/site-deploy-trigger.test.mjs`: the config path, the output path,
    the rewrites, the filters and the review compare.
  - `scripts/security-txt.test.mjs`: 3 paths.
  - `scripts/check-pr-checklist.test.mjs`: the `paths-ignore` entry.
  - `scripts/check-guide-labels.mjs`: `GUIDES_DIR`, and the include scan over
    `docs/`. Its test uses about 15 fixture paths.
- **Docs:**
  - `CONTRIBUTING.md` (the layout table, `site:build`).
  - `docs/DEPLOYMENT.md` (The project site).
  - `docs/RELEASES.md` step 11, whose compare command the test holds to
    `REVIEW_PATHS`.
  - `docs/README.md` (the Guides heading).
  - `.claude/commands/audit-day.md` (2 guide paths).
- **Links to the published site:**
  - The web app links 10 `/docs/...` addresses from 6 files, 3 root pages
    (`/PRIVACY`, `/SECURITY`, `/SUPPORT`), `/instructions` (redirected to
    `/guides`) and `/console-start`.
  - The CLI prints 3 `/docs/CLI#...` addresses (`apps/cli/src/docLinks.ts`).
  - `README.md` links 19 `/docs/...` addresses and 4 guide addresses.
- **Relative links:** the guides hold 42 links out of their directory, 40 of
  them to `../<NAME>.md`. Other files hold 17 links into `docs/guides/`: 13 in
  `WEB_APP.md`, and one each in `DEPLOYMENT.md`, `docs/README.md` and two
  project pages.

### What it costs

- **The site is in three places,** and one of them, the build configuration,
  sits inside the documentation tree it does not belong to.
- **Flat addresses over two directories** need the duplicate-address check.
- **The publish review spans all of `docs/`.** Over the 30 days to
  2026-11-10, commits touching `docs/` numbered 449. Of those, 305 touched
  `docs/spec/`, 172 `docs/notes/`, 28 `docs/guides/`, 13 `docs/.vitepress/` and
  1 `site/`; a commit can touch several. Each publish's compare
  ([RELEASES.md](../RELEASES.md#11-publish-the-project-site)) is mostly spec
  and note churn.
- **The PR checklist skip is uneven:** a change to the project pages alone
  skips it, but a change to the guides alone runs it. Both are reviewed again
  at publication.

## Layouts

### A. Keep the current layout

- **Moves:** none.
- **Readers and URLs:** unchanged.
- **CI and publishing:** unchanged.
- **Simpler or harder:** nothing to do. Every cost above stays, and the check
  stays necessary.

### B. The site self-contained under `site/`, the reference still published

The site's own files move into `site/`: the configuration and theme into
`site/.vitepress/`, and the guides into `site/guides/`. `docs/` holds only
repository documents. The site goes on rendering them as its reference
section, so `srcDir` stays the repository root. VitePress renders pages only
under `srcDir`: this is advisory, from its documented model, and not driven
here.

- **Moves:** 24 files. These are the 8 under `docs/.vitepress/` and the 16
  under `docs/guides/`.
- **References that change:**
  - 57 relative links: the guides' 40 `../<NAME>.md` links become
    `../../docs/<NAME>.md`, and the 17 links into the guides change. The guides'
    2 `../../` links stay as they are.
  - About 25 path strings in code, workflows and tests, plus the
    `check-guide-labels` fixtures.
  - About 12 lines of prose in `CONTRIBUTING.md`, `DEPLOYMENT.md`,
    `docs/README.md` and `audit-day.md`.
- **Readers and URLs:** no address changes, so no redirect is needed.
  - Deciders, operators and agency reviewers see the same site.
  - On GitHub, the guides are under `site/guides/`, and the documentation index
    links them there.
  - Contributors find the whole site in one directory.
- **CI and publishing:**
  - The artifact path becomes `site/.vitepress/dist` in both workflows.
  - `site_deploy.yaml`'s filters and `REVIEW_PATHS` already list `docs/**` and
    `site/**`, so they do not change.
  - `pr_checklist.yaml`'s `site/**` skip would then cover the guides and the
    build configuration too. It needs narrowing to the project pages
    (`site/*.md`, `site/img/**`), or a ruling that guides skip as well.
  - The tests above change their paths, and the include check scans `site/`.
- **Simpler or harder:**
  - Simpler: `docs/` is documentation only, and the build configuration sits
    beside the pages it lays out.
  - Unchanged: the flat addresses still span two directories (`site/` and
    `site/guides/`), so the check stays as ruled.
  - Unchanged: the configuration still reads the whole repository.

One variant drops the check instead of keeping it. Serving the guides at
`/guides/<stem>` makes each address mirror its path. That removes the guides'
rewrites and the collision with them, but it needs 13 redirects, one per
guide. It also
breaks `/console-start` in already-shipped console images unless a redirect
holds it.

### C. The site self-contained under `site/`, publishing only itself

The moves are as in B, but `srcDir` becomes `site/`. The reference, the spec,
the notes and the root pages are read only on GitHub.

- **Moves:** the same 24 files.
- **References that change:** B's, plus these:
  - The 10 `/docs/...` addresses and 3 root-page addresses in the web app, and
    the CLI's 3. Each is repointed to GitHub.
  - The 19 `/docs/...` addresses in `README.md`.
- **Readers and URLs:**
  - About 129 published pages leave the site (123 under `/docs/`, 6 root
    pages). A `_redirects` rule set of a few lines sends them to GitHub:
    one `/docs/*` splat, plus the README and index cases.
  - Shipped CLI images and web builds keep the old addresses, so those
    redirects are permanent.
  - Whether Cloudflare Pages redirects a splat to an external URL, and whether
    GitHub honours the `#anchor` it lands on, is not driven here.
  - An operator who follows a guide's "More detail" link (40 of them) leaves
    the site for GitHub, and the site's search no longer covers the reference.
  - Agency reviewers read governance and design on GitHub, as they can today.
- **CI and publishing:**
  - `site_deploy.yaml`'s filters shrink to `site/**` and the build inputs.
  - `REVIEW_PATHS` and the RELEASES.md compare become `site`, so the publish
    review covers only what the site shows.
  - The `ROOT_PAGES` and filter tests are removed or rewritten.
- **Simpler or harder:**
  - Simpler: the configuration drops the root-page list, the exclude list and
    the reference sidebar, about 70 of its 300 lines, and the site's sources
    are one directory.
  - Harder: it changes what the site is, from the project's documentation to
    its front door and guides. It also drops the reference's site-wide search
    and the styled reference pages that the README and both apps send users
    to.

### A separate question: the design notes and the spec

Whether the site publishes `docs/notes/` and `docs/spec/` is independent of
where the site's files live. Either A or B could leave them out with one
exclude entry and two sidebar entries, and 2 redirects to GitHub. No app or
README address names them.

Leaving them out would take most commits out of the publish compare, and it
would stop agent-written notes, which are proposals until ratified, from
appearing as published documentation. This note leaves that question open.

## Recommendation

**B.** It is argued from cost and benefit to readers, as
[product-principles.md](../../.claude/product-principles.md) sets out.

- **No reader loses anything.** Every address stays, including the ones
  printed by shipped CLI images and web builds, and no redirect is needed.
- **The win is for contributors.** The site is one directory: a page, a guide,
  the menu that lists them and the layout that draws them sit together.
  `docs/` becomes the repository's documentation alone.
- **No new machinery.** B adds nothing, and keeps the duplicate-address check
  as ruled.
- **C was weighed and set aside.** Its simplification is real, but its cost
  falls on operators in the middle of a guide and on every link already
  shipped. A question about where files live does not need that.
- **A was weighed and set aside.** It costs nothing now, but it keeps the site
  in three places.

B's one judgment call is the PR checklist skip: whether the guides join the
project pages in skipping it. B is priced with the skip narrowed to the project
pages, which keeps today's behaviour.
