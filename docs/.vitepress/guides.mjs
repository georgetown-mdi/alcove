// @ts-check
// The markup the guides under docs/guides/ are written in, rendered for the
// project site: a `::: tabs <group>` switcher with `== <name>` pane lines, step
// headings (`### N. <text>`) drawn as a timeline with the acting party's mark,
// `Screen:`, `You should see:` and `More detail:` paragraphs, the choice and
// "What you get" tables, the page ledger built from the front matter, the home
// page's landing and the About page's person rows. Only pages under
// docs/guides/ are touched; every other page renders as before.

import { readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The directory the guides live in, relative to the repository root. */
export const GUIDES_DIR = "docs/guides/";
const HOME = `${GUIDES_DIR}index.md`;
const ABOUT = `${GUIDES_DIR}about.md`;

/**
 * The guides' menu: each group's pages in order, by file stem and title. A
 * group with `topNav: false` is left out of the top bar.
 */
export const GUIDE_SECTIONS = [
  {
    group: "Start",
    topNav: false,
    pages: [
      ["index", "Home"],
      ["agree-on-terms", "Agree on terms"],
    ],
  },
  {
    group: "Web app",
    pages: [
      ["web-invite", "Invite with the web app"],
      ["web-accept", "Accept with the web app"],
      ["web-schedule", "Run it on a schedule"],
    ],
  },
  {
    group: "Console",
    pages: [
      ["console-start", "Start the console"],
      ["console-invite", "Invite from the console"],
      ["console-accept", "Accept in the console"],
      ["console-schedule", "Move it to a schedule"],
    ],
  },
  {
    group: "Command line",
    pages: [
      ["cli-install", "Install and run"],
      ["cli-invite", "Invite a partner"],
      ["cli-accept", "Accept an invitation"],
      ["cli-schedule", "Schedule it"],
      ["cli-other", "Other ways to exchange"],
    ],
  },
  { group: "About", pages: [["about", "About"]] },
];

/**
 * Each guide is served at the site root under its file stem, the home page at
 * the root itself: a VitePress rewrite for every Markdown file in GUIDES_DIR.
 * @returns {Record<string, string>}
 */
export function guideRewrites() {
  return Object.fromEntries(
    readdirSync(resolve(repoRoot, GUIDES_DIR))
      .filter((name) => name.endsWith(".md"))
      .map((name) => [`${GUIDES_DIR}${name}`, name]),
  );
}

/** The menu group a guide is listed under, if any. */
function groupOf(path) {
  const stem = path.slice(GUIDES_DIR.length).replace(/\.md$/, "");
  return GUIDE_SECTIONS.find((section) =>
    section.pages.some(([page]) => page === stem),
  )?.group;
}

/** The front-matter keys shown in a guide's ledger, with their labels. */
const LEDGER_ROWS = [
  ["reader", "For"],
  ["needs", "You need"],
  ["before", "Before this"],
  ["partner", "Your partner reads"],
];

const PARTIES = {
  You: "a",
  "Your partner": "b",
  "Each of you": "both",
  "Both of you": "both",
};

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\{\{/g, "&#123;&#123;");
}

/** The repository-relative path of the page being rendered, if any. */
function pagePath(env) {
  const path = env?.realPath ?? env?.path;
  return typeof path === "string"
    ? relative(repoRoot, path).split(sep).join("/")
    : undefined;
}

function isGuide(env) {
  return pagePath(env)?.startsWith(GUIDES_DIR) ?? false;
}

/** The plain text of an inline token, without its emphasis markup. */
function inlineText(inline) {
  return (inline?.children ?? [])
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content)
    .join("")
    .trim();
}

/**
 * Remove `pattern` from the start of an inline token's first text child.
 * Returns the index the text child had, or -1 when it does not start so.
 */
function stripLeadingText(inline, pattern) {
  const children = inline.children ?? [];
  const index = children.findIndex((child) => child.type === "text");
  if (index === -1 || !pattern.test(children[index].content)) return -1;
  children[index].content = children[index].content.replace(pattern, "");
  return index;
}

/** A block token of raw HTML. */
function htmlBlock(state, html) {
  const token = new state.Token("html_block", "", 0);
  token.content = html;
  return token;
}

function htmlInline(state, html) {
  const token = new state.Token("html_inline", "", 0);
  token.content = html;
  return token;
}

/** Whether a top-level heading token opens an h1, h2 or h3. */
function isSectionHeading(token) {
  return (
    token.type === "heading_open" &&
    token.level === 0 &&
    /^h[1-3]$/.test(token.tag)
  );
}

// `::: tabs <group>`, then `== <name>` lines each opening a pane, then `:::`.
// Lines inside fenced code are not markers.
function tabsBlock(state, startLine, endLine, silent) {
  const line = (n) =>
    state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const open = /^:::[ \t]*tabs[ \t]+(\w+)[ \t]*$/.exec(line(startLine));
  if (!open || !isGuide(state.env)) return false;

  const panes = [];
  let close = -1;
  let fence = "";
  for (let n = startLine + 1; n < endLine; n++) {
    const text = line(n);
    if (fence) {
      if (text.startsWith(fence) && /^[`~]*\s*$/.test(text)) fence = "";
      continue;
    }
    const fenceOpen = /^(`{3,}|~{3,})/.exec(text);
    if (fenceOpen) {
      fence = fenceOpen[1];
      continue;
    }
    if (/^:::[ \t]*$/.test(text)) {
      close = n;
      break;
    }
    const pane = /^==[ \t]+(.+?)[ \t]*$/.exec(text);
    if (pane) panes.push({ name: pane[1], line: n });
  }
  if (close === -1 || panes.length === 0) return false;
  if (silent) return true;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = "guide_tabs";
  const openToken = state.push("guide_tabs_open", "div", 1);
  openToken.block = true;
  openToken.map = [startLine, close + 1];
  openToken.meta = { group: open[1], names: panes.map((pane) => pane.name) };
  panes.forEach((pane, index) => {
    const end = index + 1 < panes.length ? panes[index + 1].line : close;
    const paneOpen = state.push("guide_pane_open", "template", 1);
    paneOpen.block = true;
    paneOpen.meta = { index };
    state.lineMax = end;
    state.md.block.tokenize(state, pane.line + 1, end);
    state.push("guide_pane_close", "template", -1).block = true;
  });
  state.push("guide_tabs_close", "div", -1).block = true;
  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = close + 1;
  return true;
}

// Paragraphs that open with one of the guide markers take its class.
function markParagraphs(state) {
  const { tokens } = state;
  tokens.forEach((token, index) => {
    if (token.type !== "paragraph_open") return;
    const inline = tokens[index + 1];
    const text = inlineText(inline);
    if (/^More detail:/.test(text)) {
      token.attrJoin("class", "guide-more");
    } else if (/^You should see:/.test(text)) {
      token.attrJoin("class", "guide-checkpoint");
      const at = stripLeadingText(inline, /^\s*You should see:/);
      if (at !== -1) {
        const strongOpen = new state.Token("strong_open", "strong", 1);
        const label = new state.Token("text", "", 0);
        label.content = "You should see:";
        const strongClose = new state.Token("strong_close", "strong", -1);
        inline.children.splice(at, 0, strongOpen, label, strongClose);
      }
    }
  });
}

// Every table is wrapped so it scrolls on its own. One headed `Option` or
// `Default option` is a choice table, its `Usual:` row marked; one headed
// `File` is a "What you get" table, its private rows marked. The home page's
// first table is the chooser.
function markTables(state, isHome) {
  const { tokens } = state;
  const wraps = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== "table_open") continue;
    const close = tokens.findIndex(
      (token, at) =>
        at > index &&
        token.type === "table_close" &&
        token.level === tokens[index].level,
    );
    if (close === -1) continue;
    const firstHeader = tokens.findIndex(
      (token, at) => at > index && token.type === "th_open",
    );
    const head = inlineText(tokens[firstHeader + 1]);
    const kind =
      head === "Option" || head === "Default option"
        ? "choice"
        : head === "File"
          ? "files"
          : undefined;
    const classes = ["guide-table"];
    if (kind) classes.push(`guide-${kind}`);
    if (isHome && wraps.length === 0) classes.push("guide-chooser");
    wraps.push({ open: index, close, classes });
    if (!kind) continue;
    let rowCells = [];
    let row;
    for (let at = index; at < close; at++) {
      const token = tokens[at];
      if (token.type === "tr_open") {
        row = token;
        rowCells = [];
      } else if (token.type === "td_open") {
        rowCells.push(at);
      } else if (token.type === "tr_close" && rowCells.length > 0) {
        const last = rowCells[rowCells.length - 1];
        const lastInline = tokens[last + 1];
        if (kind === "choice") {
          const badgeAt = stripLeadingText(lastInline, /^\s*Usual:\s*/);
          if (badgeAt !== -1) {
            row.attrJoin("class", "guide-usual");
            lastInline.children.splice(
              badgeAt,
              0,
              htmlInline(state, '<span class="guide-badge">Usual</span>'),
            );
          }
        } else if (/private/i.test(inlineText(lastInline))) {
          tokens[last].attrJoin("class", "guide-private");
        }
      }
    }
  }
  for (const { open, close, classes } of wraps.reverse()) {
    tokens.splice(close + 1, 0, htmlBlock(state, "</div>\n"));
    tokens.splice(
      open,
      0,
      htmlBlock(state, `<div class="${classes.join(" ")}">\n`),
    );
  }
}

/** The step number and party of a `### N. <text>` heading, if it is one. */
function stepOf(tokens, index) {
  const token = tokens[index];
  if (token.type !== "heading_open" || token.tag !== "h3" || token.level !== 0)
    return undefined;
  const text = inlineText(tokens[index + 1]);
  const step = /^(\d+)\.\s+(.*)$/.exec(text);
  if (!step) return undefined;
  const who = /^(You|Your partner|Each of you|Both of you):/.exec(step[2]);
  return { number: step[1], party: who ? PARTIES[who[1]] : "", who: who?.[1] };
}

// Each step runs from its heading to the next h1-h3 heading, wrapped in a
// section the timeline is drawn on. A `Screen:` paragraph right under the
// heading moves above it.
function wrapSteps(state) {
  const { tokens } = state;
  const out = [];
  const steps = [];
  const labels = {};
  let open;
  const closeStep = (last) => {
    if (!open) return;
    open.last = last;
    out.push(new state.Token("guide_step_close", "section", -1));
    open = undefined;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const isBoundary = isSectionHeading(token);
    const step = isBoundary ? stepOf(tokens, index) : undefined;
    if (isBoundary) closeStep(!step);
    if (!step) {
      out.push(token);
      continue;
    }
    const stepOpen = new state.Token("guide_step_open", "section", 1);
    stepOpen.meta = {
      party: step.party,
      first: out.at(-1)?.type !== "guide_step_close",
      last: false,
      screen: false,
      nextScreen: false,
    };
    open = stepOpen.meta;
    steps.push(stepOpen);
    if (step.who) labels[step.party] ??= step.who;
    out.push(stepOpen);

    const inline = tokens[index + 1];
    const numberAt = stripLeadingText(inline, /^\s*\d+\.\s+/);
    if (numberAt !== -1) {
      inline.children.splice(
        numberAt,
        0,
        htmlInline(state, `<span class="guide-num">${step.number}</span>`),
      );
    }
    const after = index + 3;
    if (
      tokens[after]?.type === "paragraph_open" &&
      /^Screen:/.test(inlineText(tokens[after + 1]))
    ) {
      const screenAt = stripLeadingText(tokens[after + 1], /^\s*Screen:\s*/);
      if (screenAt !== -1) {
        tokens[after + 1].children.splice(
          screenAt,
          0,
          htmlInline(state, '<span class="visually-hidden">Screen: </span>'),
        );
      }
      tokens[after].attrJoin("class", "guide-screen");
      out.push(tokens[after], tokens[after + 1], tokens[after + 2]);
      stepOpen.meta.screen = true;
      out.push(tokens[index], tokens[index + 1], tokens[index + 2]);
      index = after + 2;
    } else {
      out.push(token);
    }
  }
  closeStep(true);
  if (steps.length === 0) return;

  // A step followed by one with a screen header draws its line further down.
  steps.forEach((step, index) => {
    const next = steps[index + 1];
    if (next && out[out.indexOf(next) - 1]?.type === "guide_step_close") {
      step.meta.nextScreen = next.meta.screen;
    }
  });

  const used = new Set(steps.map((step) => step.meta.party).filter(Boolean));
  if (used.has("b") || used.has("both")) {
    for (const step of steps) step.meta.party ||= "a";
    const keys = [
      ["a", labels.a ?? "You"],
      ["b", labels.b],
      ["both", labels.both],
    ].filter(([party]) => party === "a" || used.has(party));
    const key = keys
      .map(
        ([party, label]) =>
          `<span><i class="guide-mark" data-party="${party}"></i>${escapeHtml(label)}</span>`,
      )
      .join("");
    out.splice(
      out.indexOf(steps[0]),
      0,
      htmlBlock(state, `<div class="guide-party-key">${key}</div>\n`),
    );
  } else {
    for (const step of steps) step.meta.party = "";
  }
  state.tokens = out;
}

/** Whether an inline token holds one image and nothing else. */
function isSoleImage(inline) {
  const children = (inline?.children ?? []).filter(
    (child) => !(child.type === "text" && child.content.trim() === ""),
  );
  return children.length === 1 && children[0].type === "image";
}

// The About page: the institute's logo on a plate, and each `###` person with
// their portrait beside their text.
function aboutLayout(state) {
  const { tokens } = state;
  const logo = tokens.findIndex(
    (token, index) =>
      token.type === "paragraph_open" &&
      token.level === 0 &&
      isSoleImage(tokens[index + 1]) &&
      /mdi-logo\.png$/.test(
        tokens[index + 1].children
          .find((child) => child.type === "image")
          ?.attrGet("src") ?? "",
      ),
  );
  if (logo !== -1) {
    tokens[logo].tag = "div";
    tokens[logo].attrJoin("class", "guide-logo-plate");
    tokens[logo + 2].tag = "div";
  }

  const out = [];
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];
    if (!(isSectionHeading(token) && token.tag === "h3")) {
      out.push(token);
      index++;
      continue;
    }
    let end = index + 1;
    while (end < tokens.length && !isSectionHeading(tokens[end])) end++;
    const section = tokens.slice(index, end);
    const portrait =
      section[3]?.type === "paragraph_open" && isSoleImage(section[4])
        ? section.splice(3, 3)
        : [];
    for (const paragraph of [portrait[0], portrait[2]]) {
      if (paragraph) paragraph.hidden = true;
    }
    out.push(
      htmlBlock(state, '<div class="guide-person">\n'),
      ...portrait,
      htmlBlock(state, "<div>\n"),
      ...section,
      htmlBlock(state, "</div>\n</div>\n"),
    );
    index = end;
  }
  state.tokens = out;
}

// The figure beside the home page's chooser: two files, the rows they share
// joined through the encrypted comparison between them.
function figureSvg() {
  const rowsLeft = [92, 70, 104, 58, 84, 76];
  const rowsRight = [66, 98, 80, 104, 62, 88];
  const matches = [
    [1, 3],
    [4, 0],
  ];
  const sharedLeft = new Set(matches.map(([left]) => left));
  const sharedRight = new Set(matches.map(([, right]) => right));
  const top = 66;
  const pitch = 26;
  const label =
    'font-family="var(--sans)" font-size="11" font-weight="650" letter-spacing="0.6" fill="var(--secondary)"';
  const rowFill = (shared) => (shared ? "var(--ink)" : "var(--rule-soft)");
  const parts = [
    '<rect x="8" y="22" width="132" height="200" rx="2" fill="var(--column)" stroke="var(--rule)"/>',
    '<rect x="240" y="22" width="132" height="200" rx="2" fill="var(--column)" stroke="var(--rule)"/>',
    `<rect x="20" y="36" width="10" height="10" fill="var(--accent)"/><text x="38" y="45" ${label}>YOUR FILE</text>`,
    `<rect x="253" y="37" width="9" height="9" fill="none" stroke="var(--accent)" stroke-width="2"/><text x="270" y="45" ${label}>PARTNER'S FILE</text>`,
    '<rect x="168" y="22" width="44" height="200" fill="url(#guide-figure-stripe)"/>',
    '<text x="190" y="240" text-anchor="middle" font-family="var(--mono)" font-size="11" fill="var(--faint)">encrypted comparison</text>',
    ...rowsLeft.map(
      (width, row) =>
        `<rect x="20" y="${top + row * pitch}" width="${width}" height="8" fill="${rowFill(sharedLeft.has(row))}"/>`,
    ),
    ...rowsRight.map(
      (width, row) =>
        `<rect x="${360 - width}" y="${top + row * pitch}" width="${width}" height="8" fill="${rowFill(sharedRight.has(row))}"/>`,
    ),
    ...matches.map(([left, right]) => {
      const from = top + left * pitch + 4;
      const to = top + right * pitch + 4;
      return `<path d="M${20 + rowsLeft[left] + 6} ${from} L168 ${from} L212 ${to} L${360 - rowsRight[right] - 6} ${to}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
    }),
  ];
  return (
    '<figure class="guide-figure"><svg viewBox="0 0 380 250" role="img" aria-labelledby="guide-figure-title guide-figure-desc">' +
    '<title id="guide-figure-title">Two files compared</title>' +
    '<desc id="guide-figure-desc">Two organizations each keep their own file. An encrypted comparison between them finds the records they share; the other records never leave their owner.</desc>' +
    '<defs><pattern id="guide-figure-stripe" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="14" fill="var(--accent)"/><rect x="7" width="7" height="14" fill="var(--stripe)"/></pattern></defs>' +
    parts.join("") +
    "</svg><figcaption>Each of you keeps your own file. The comparison finds the records you share, and the other records never leave their owner.</figcaption></figure>"
  );
}

/** The ledger: the front-matter rows, the page's sections and what is next. */
function ledgerHtml(state, md, group) {
  const frontmatter = state.env?.frontmatter ?? {};
  const row = (label, html) =>
    `<div class="guide-ledger-row"><dt>${label}</dt><dd>${html}</dd></div>`;
  const rows = LEDGER_ROWS.filter(
    ([key]) => typeof frontmatter[key] === "string",
  ).map(([key, label]) => {
    const value = frontmatter[key];
    return row(
      label,
      key === "reader" ? escapeHtml(value) : md.renderInline(value, state.env),
    );
  });
  const contents = [];
  state.tokens.forEach((token, index) => {
    const id = token.attrGet("id");
    if (token.type !== "heading_open" || token.level !== 0) return;
    if (token.tag !== "h2" || !id) return;
    const text = inlineText(state.tokens[index + 1]);
    contents.push(`<li><a href="#${escapeHtml(id)}">${escapeHtml(text)}</a></li>`);
  });
  if (contents.length > 0) {
    rows.push(
      row(
        "On this page",
        `<ul class="guide-toc">${contents.join("")}</ul>`,
      ),
    );
  }
  if (typeof frontmatter.next === "string") {
    rows.push(row("Next", md.renderInline(frontmatter.next, state.env)));
  }
  if (rows.length === 0) return "";
  const heading = group ? `<h2>${escapeHtml(group)}</h2>` : "";
  return `<div class="guide-ledger">${heading}<dl>${rows.join("")}</dl></div>`;
}

// Above the title, the page's group; the paragraph under the title is its
// lede, and below that the ledger, shown there only on a narrow screen. The
// ledger's HTML is kept in the front matter for the layout's ledger column.
// The home page's title, lede and chooser sit beside the figure instead.
function insertHeader(state, md, path) {
  const { tokens } = state;
  const title = tokens.findIndex(
    (token) =>
      token.type === "heading_open" && token.tag === "h1" && token.level === 0,
  );
  if (title === -1) return;
  let after = title + 3;
  if (tokens[after]?.type === "paragraph_open") {
    if (tokens[after].tag === "p") tokens[after].attrJoin("class", "guide-lede");
    after += 3;
  }
  if (path === HOME) {
    const tableClose = tokens.findIndex(
      (token, index) =>
        index > title && token.type === "table_close" && token.level === 0,
    );
    const end = tableClose === -1 ? after : tableClose + 2;
    tokens.splice(end, 0, htmlBlock(state, `</div>\n${figureSvg()}\n</div>\n`));
    tokens.splice(
      title,
      0,
      htmlBlock(
        state,
        '<div class="guide-landing"><div><p class="guide-eyebrow">Privacy-preserving record linkage</p>\n',
      ),
    );
    return;
  }
  const group = groupOf(path);
  const ledger = ledgerHtml(state, md, group);
  state.env.frontmatter = { ...state.env.frontmatter, guideLedger: ledger };
  if (ledger) {
    tokens.splice(
      after,
      0,
      htmlBlock(state, `<div class="guide-inline-ledger">${ledger}</div>\n`),
    );
  }
  if (group) {
    tokens.splice(
      title,
      0,
      htmlBlock(state, `<p class="guide-eyebrow">${escapeHtml(group)}</p>\n`),
    );
  }
}

/** Add the guide markup to a markdown-it instance. */
export function guideMarkdown(md) {
  md.block.ruler.before("fence", "guide_tabs", tabsBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.guide_tabs_open = (tokens, index) => {
    const { group, names } = tokens[index].meta;
    return `<GuideTabs group="${escapeHtml(group)}" names="${escapeHtml(names.join("|"))}">\n`;
  };
  md.renderer.rules.guide_tabs_close = () => "</GuideTabs>\n";
  md.renderer.rules.guide_pane_open = (tokens, index) =>
    `<template #pane-${tokens[index].meta.index}>\n`;
  md.renderer.rules.guide_pane_close = () => "</template>\n";
  md.renderer.rules.guide_step_open = (tokens, index) => {
    const { party, first, last, screen, nextScreen } = tokens[index].meta;
    const classes = ["guide-step"];
    if (first) classes.push("first");
    if (last) classes.push("last");
    if (screen) classes.push("has-screen");
    if (nextScreen) classes.push("next-screen");
    const partyAttribute = party ? ` data-party="${party}"` : "";
    return `<section class="${classes.join(" ")}"${partyAttribute}>\n`;
  };
  md.renderer.rules.guide_step_close = () => "</section>\n";
  md.core.ruler.push("alcove_guides", (state) => {
    if (state.inlineMode || !isGuide(state.env)) return;
    const path = pagePath(state.env) ?? "";
    markParagraphs(state);
    markTables(state, path === HOME);
    wrapSteps(state);
    if (path === ABOUT) aboutLayout(state);
    insertHeader(state, md, path);
  });
}

/**
 * Page data for a guide: the `guide` front-matter entry the guide layout is
 * drawn from, holding the page's group and its ledger. The `next` row is the
 * guide's own and shown in its ledger.
 */
export function guidePageData(pageData) {
  const source = pageData.filePath ?? pageData.relativePath;
  if (!source.startsWith(GUIDES_DIR)) return;
  const { guideLedger, ...frontmatter } = pageData.frontmatter;
  delete frontmatter.next;
  const stem = source.slice(GUIDES_DIR.length).replace(/\.md$/, "");
  frontmatter.guide = {
    stem,
    group: groupOf(source) ?? "",
    ledger: typeof guideLedger === "string" ? guideLedger : "",
  };
  pageData.frontmatter = frontmatter;
}
