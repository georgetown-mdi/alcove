// @ts-check
// The markup the guides under docs/guides/ are written in, rendered for the
// project site: a `::: tabs <group>` switcher with `== <name>` pane lines, step
// headings (`### N. <text>`) drawn as a timeline with the acting party's mark,
// `Screen:`, `You should see:` and `More detail:` paragraphs, the choice and
// "What you get" tables, and the front-matter rows shown under the title. Only
// pages under docs/guides/ are touched; every other page renders as before.

import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The directory the guides live in, relative to the repository root. */
export const GUIDES_DIR = "docs/guides/";
const HOME = `${GUIDES_DIR}index.md`;

/** The front-matter keys shown under a guide's title, with their labels. */
const LEDGER_ROWS = [
  ["reader", "For"],
  ["needs", "You need"],
  ["before", "Before this"],
  ["partner", "Your partner reads"],
  ["timing", "Timing"],
  ["next", "Next"],
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

// A table headed `Option` is a choice table, its `Usual:` row marked; one
// headed `File` is a "What you get" table, its private rows marked.
function markTables(state) {
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
    const firstHeader = tokens.findIndex(
      (token, at) => at > index && token.type === "th_open",
    );
    const head = inlineText(tokens[firstHeader + 1]);
    const kind =
      head === "Option" ? "choice" : head === "File" ? "files" : undefined;
    if (!kind || close === -1) continue;
    wraps.push({ open: index, close, kind });
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
  for (const { open, close, kind } of wraps.reverse()) {
    tokens.splice(
      close + 1,
      0,
      htmlBlock(state, "</div>\n"),
    );
    tokens.splice(
      open,
      0,
      htmlBlock(state, `<div class="guide-table guide-${kind}">\n`),
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
    const isBoundary =
      token.type === "heading_open" &&
      token.level === 0 &&
      /^h[1-3]$/.test(token.tag);
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
      htmlBlock(state, `<p class="guide-party-key">${key}</p>\n`),
    );
  } else {
    for (const step of steps) step.meta.party = "";
  }
  state.tokens = out;
}

// The front-matter rows, shown under the title and its first paragraph. The
// home page is a chooser and takes none.
function insertLedger(state, md) {
  const frontmatter = state.env?.frontmatter ?? {};
  if (pagePath(state.env) === HOME) return;
  const rows = LEDGER_ROWS.filter(([key]) => typeof frontmatter[key] === "string")
    .map(([key, label]) => {
      const value = frontmatter[key];
      const html =
        key === "reader" ? escapeHtml(value) : md.renderInline(value, state.env);
      return `<div class="guide-ledger-row"><dt>${label}</dt><dd>${html}</dd></div>`;
    })
    .join("");
  if (!rows) return;
  const { tokens } = state;
  const title = tokens.findIndex(
    (token) => token.type === "heading_open" && token.tag === "h1",
  );
  if (title === -1) return;
  let at = title + 3;
  if (tokens[at]?.type === "paragraph_open") {
    tokens[at].attrJoin("class", "guide-lede");
    at += 3;
  }
  tokens.splice(at, 0, htmlBlock(state, `<dl class="guide-ledger">${rows}</dl>\n`));
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
    const { party, first, last, screen } = tokens[index].meta;
    const classes = ["guide-step"];
    if (first) classes.push("first");
    if (last) classes.push("last");
    if (screen) classes.push("has-screen");
    const partyAttribute = party ? ` data-party="${party}"` : "";
    return `<section class="${classes.join(" ")}"${partyAttribute}>\n`;
  };
  md.renderer.rules.guide_step_close = () => "</section>\n";
  md.core.ruler.push("alcove_guides", (state) => {
    if (state.inlineMode || !isGuide(state.env)) return;
    markParagraphs(state);
    markTables(state);
    wrapSteps(state);
    insertLedger(state, md);
  });
}

/**
 * Page data for a guide: the page class the guide styles are scoped to. The
 * `next` row is the guide's own and shown in its ledger, so the footer's next
 * link follows the sidebar order instead.
 */
export function guidePageData(pageData) {
  if (!pageData.relativePath.startsWith(GUIDES_DIR)) return;
  const frontmatter = { ...pageData.frontmatter };
  delete frontmatter.next;
  frontmatter.pageClass =
    pageData.relativePath === `${GUIDES_DIR}about.md`
      ? "guide-page guide-about"
      : "guide-page";
  pageData.frontmatter = frontmatter;
}
