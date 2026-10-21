/// <reference types="@vitest/browser-playwright/context" />

import { page, userEvent } from "vitest/browser";
import { expect } from "vitest";

import { flushPendingUpdates } from "./renderApp";

import type { AppMount } from "./renderApp";
import type { RouteState } from "./routeStates";

// The BREADTH contrast sweep the route sweeps (themeContrastSweep*.test.ts) run,
// complementing test/browser/themeContrast.test.ts, which pins a handful of theme
// tokens by their exact resolved colour at specific call sites. A sweep instead
// mounts a route state and measures EVERY rendered text-bearing element against
// the WCAG 2.1 AA floor, catching a per-call-site drift a token pin would miss (a
// stray `c=`/`color=` on a Text, a non-filled variant on a primary
// Button/ActionIcon/Checkbox, an anchor repainted by a stylesheet rule). Neither
// harness subsumes the other.
//
// In-house, not axe-core: the contrast check is the local WCAG luminance/ratio
// math below (~10 lines, the same formula as themeContrast.test.ts, kept
// self-contained so the sweep does not depend on that harness or add a second
// colour engine as a dev dependency).
//
// KNOWN BLIND SPOTS (the sweep is a breadth net, not full WCAG coverage):
//   - Gradients and background images: only a solid computed backgroundColor is
//     resolved. A text element painted over a gradient or image resolves to the
//     nearest solid layer beneath it, which may not be what the eye sees.
//   - Overlapping / z-stacked layers: the walk climbs the DOM ancestor chain, not
//     the paint order, so a sibling that visually overlaps a text element is not
//     considered.
//   - Transparent stacks: where no ancestor (up to the page canvas) paints an
//     opaque background, the element is RECORDED as unresolved rather than
//     silently passed -- see the unresolved handling below.
//   - Disabled controls: WCAG 1.4.3 exempts disabled elements, so they are
//     skipped; a disabled control's contrast is not asserted here.
//   - Deeper interaction states (a loaded file, a run in flight, hover/focus
//     colours): a sweep stays at each route state's initial mount for
//     determinism; the per-surface harness drives the specific hover/variant
//     states it pins.

/** sRGB channels + alpha of a computed `rgb(r, g, b)` / `rgba(r, g, b, a)`
 * string. Alpha defaults to 1 when absent. */
function rgba(color: string): [number, number, number, number] {
  const m = color.match(/-?\d+(\.\d+)?/g);
  if (m === null || m.length < 3)
    throw new Error(`unparseable color: ${color}`);
  return [
    Number(m[0]),
    Number(m[1]),
    Number(m[2]),
    m.length >= 4 ? Number(m[3]) : 1,
  ];
}

/** WCAG 2.1 relative luminance of an opaque `rgb(r, g, b)` triple. The 0.03928
 * threshold is the value printed in the WCAG 2.1 text (and used by Mantine's own
 * luminance()), matching the byte-for-byte copy in themeContrast.test.ts; kept
 * duplicated so the sweep does not churn or merge-conflict the token harness for
 * a ten-line formula. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(r / 255) +
    0.7152 * linear(g / 255) +
    0.0722 * linear(b / 255)
  );
}

/** WCAG contrast ratio between two opaque `rgb` triples (1..21). */
function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `top` (which may have alpha) over the opaque `under`, returning the
 * resulting opaque triple (the standard source-over "over" operator). */
function composite(
  top: [number, number, number, number],
  under: [number, number, number],
): [number, number, number] {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
  ];
}

/** The page canvas the app paints behind everything: Mantine's
 * --mantine-color-body (white in light, dark-7 in dark), resolved on the document
 * element. Used as the base an ancestor walk composites onto when the walk itself
 * never reaches an opaque paint. Returns undefined only if even the canvas
 * resolves transparent. */
function pageCanvas(): [number, number, number] | undefined {
  const body = getComputedStyle(document.documentElement).getPropertyValue(
    "--mantine-color-body",
  );
  if (body.trim() === "") return undefined;
  const probe = document.createElement("span");
  probe.style.color = body;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const [r, g, b, a] = rgba(resolved);
  return a === 0 ? undefined : [r, g, b];
}

/** Fold the translucent layers gathered from the innermost outward onto an opaque
 * base: the outermost gathered layer sits nearest the base, so composite from the
 * end of the list inward. */
function foldLayers(
  layers: Array<[number, number, number, number]>,
  base: [number, number, number],
): [number, number, number] {
  let result = base;
  for (let i = layers.length - 1; i >= 0; i -= 1)
    result = composite(layers[i], result);
  return result;
}

/** Resolve the effective (opaque) background painted behind `el` by walking its
 * ancestor chain, compositing each translucent layer over the one beneath, until
 * an opaque layer is reached; then the page canvas is the base. Returns undefined
 * (recorded, never silently passed) when nothing up to and including the canvas
 * paints -- a transparent stack this walk cannot resolve. */
function effectiveBackground(
  el: HTMLElement,
): [number, number, number] | undefined {
  const layers: Array<[number, number, number, number]> = [];
  let node: HTMLElement | null = el;
  while (node !== null) {
    const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
    if (a > 0) {
      if (a >= 1) return foldLayers(layers, [r, g, b]);
      layers.push([r, g, b, a]);
    }
    node = node.parentElement;
  }
  const canvas = pageCanvas();
  if (canvas === undefined) return undefined;
  return foldLayers(layers, canvas);
}

/** True when `el` is not painted (so its text is not seen and not judged):
 * display:none, visibility hidden, aria-hidden, the hidden attribute, or a zero
 * box. A disabled control is also excluded -- WCAG 1.4.3 exempts disabled
 * elements (a documented blind spot). */
function isSkippable(el: HTMLElement): boolean {
  if (el.closest("[hidden]") !== null) return true;
  if (el.closest('[aria-hidden="true"]') !== null) return true;
  if (
    el.closest(":disabled") !== null ||
    el.closest('[aria-disabled="true"]') !== null ||
    // Mantine marks a disabled control's label, which sits beside the input
    // rather than inside it, with data-disabled.
    el.closest("[data-disabled]") !== null
  )
    return true;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  const rect = el.getBoundingClientRect();
  return rect.width === 0 || rect.height === 0;
}

/** Whether `el` owns a direct, non-whitespace text node -- the text this element
 * paints in its own colour (a text node belongs to exactly one element, so each
 * run of text is judged once, on the element that renders it). */
function ownsText(el: HTMLElement): boolean {
  for (const node of el.childNodes)
    if (
      node.nodeType === Node.TEXT_NODE &&
      (node.textContent ?? "").trim() !== ""
    )
      return true;
  return false;
}

/** WCAG "large text": >= 24px, or >= 18.66px when bold (>= 700). Large text
 * clears at 3:1; normal text needs 4.5:1. */
function largeTextFloor(style: CSSStyleDeclaration): number {
  const px = parseFloat(style.fontSize);
  const bold = Number(style.fontWeight) >= 700;
  const isLarge = px >= 24 || (bold && px >= 18.66);
  return isLarge ? 3 : 4.5;
}

/** What a sweep found: the below-floor elements, and the text of each element
 * whose background it could not resolve. Either fails the surface. */
export interface SweepResult {
  failures: Array<Failure>;
  unresolved: Array<string>;
}

/** One text element under its contrast floor. */
export interface Failure {
  text: string;
  color: string;
  background: string;
  ratio: number;
  floor: number;
}

/** Sweep every painted, text-bearing element under `rootEl`, measuring each
 * against its WCAG AA floor. Returns the below-floor failures and any element
 * whose background could not be resolved -- both fail the surface. */
function sweepContrast(rootEl: HTMLElement): SweepResult {
  const failures: Array<Failure> = [];
  const unresolved: Array<string> = [];
  for (const el of rootEl.querySelectorAll<HTMLElement>("*")) {
    if (!ownsText(el) || isSkippable(el)) continue;
    const style = getComputedStyle(el);
    const background = effectiveBackground(el);
    const label = el.textContent.trim().slice(0, 60);
    if (background === undefined) {
      unresolved.push(label);
      continue;
    }
    // Text may itself have alpha (rare); composite it onto its own background so
    // the ratio is between what is actually painted, not a nominal colour.
    const textColor = composite(rgba(style.color), background);
    const ratio = contrast(textColor, background);
    const floor = largeTextFloor(style);
    if (ratio + 1e-9 < floor)
      failures.push({
        text: label,
        color: style.color,
        background: `rgb(${background.map(Math.round).join(", ")})`,
        ratio: Number(ratio.toFixed(2)),
        floor,
      });
  }
  return { failures, unresolved };
}

/** Light-scheme failures not yet fixed, keyed by `${route}: ${state}`, each the
 * text of the element that fails: --app-accent link text on the --app-accent-bg
 * callout and on the red Alert tint. A listed text that stops failing fails its
 * test, so the list only shrinks. */
const KNOWN_LIGHT_FAILURES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/accept: an invitation that cannot be read": ["paste it on the start page"],
  "/saved/$id: ready to run": ["new exchange", "verify page"],
  "/saved/$id: an exchange with recorded runs and a relay set": [
    "new exchange",
    "verify page",
  ],
  "/saved/$id: an exchange on an agreed schedule": [
    "new exchange",
    "verify page",
  ],
};

/** Assert a sweep of `state` in `scheme` found nothing below its floor beyond
 * the state's {@link KNOWN_LIGHT_FAILURES}, and no element it could not
 * resolve. */
export function expectAaClean(
  { failures, unresolved }: SweepResult,
  scheme: "light" | "dark",
  { route, state }: Pick<RouteState, "route" | "state">,
): void {
  const known =
    scheme === "light"
      ? (KNOWN_LIGHT_FAILURES[`${route}: ${state}`] ?? [])
      : [];
  // A newly-introduced below-floor element (a stray colour, a non-filled primary
  // variant) fails here with the offending text, colours, and ratio.
  expect(failures.filter(({ text }) => !known.includes(text))).toEqual([]);
  expect(failures.map(({ text }) => text)).toEqual(known);
  // A text element whose background the walk cannot resolve is a coverage gap,
  // not a pass: fail so the sweep is extended rather than the surface quietly
  // under-checked.
  expect(unresolved).toEqual([]);
}

/** Mount `state` in `scheme`, wait for its page heading and pending updates, un-hover
 * any filled-primary control, then sweep the mount. The browser project shares one
 * pointer across the suite, so a stale hover can paint a lighter fill that reads
 * under the AA floor the resting colour clears; a surface with no such control
 * just no-ops. */
export async function mountAndSweep(
  app: AppMount,
  scheme: "light" | "dark",
  { heading, node }: Pick<RouteState, "heading" | "node">,
): Promise<SweepResult> {
  app.render(await node(), { forceColorScheme: scheme });
  await expect
    .element(page.getByRole("heading", { level: 1, name: heading }))
    .toBeInTheDocument();
  await flushPendingUpdates();
  for (const control of app.container.querySelectorAll<HTMLElement>(
    ".mantine-Button-root, .mantine-ActionIcon-root",
  )) {
    if (control.matches(":hover")) {
      await userEvent.unhover(control);
      await expect.poll(() => control.matches(":hover")).toBe(false);
    }
  }
  return sweepContrast(app.container);
}
