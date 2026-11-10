/// <reference types="@vitest/browser-playwright/context" />

import { expect } from "vitest";

import { page } from "vitest/browser";

/**
 * Layout checks for the WCAG 2.1 criteria about content surviving a narrow
 * viewport (1.4.10 Reflow) and user text spacing (1.4.12), run in the real
 * browser over a rendered surface.
 */

/** The width WCAG 1.4.10 names: a 1280-pixel window zoomed to 400%. */
export const REFLOW_WIDTH = 320;

/** The height reflow is measured at, 1280x1024 zoomed to 400%. */
export const REFLOW_HEIGHT = 256;

/** The text-spacing overrides WCAG 1.4.12 names, as a stylesheet a user
 * stylesheet or bookmarklet would apply. */
export const WCAG_TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p { margin-bottom: 2em !important; }
`;

function describe(element: Element, detail: string): string {
  const tag = element.tagName.toLowerCase();
  const text = element.textContent.trim().slice(0, 50);
  return `<${tag}> ${detail} "${text}"`;
}

function scrollsHorizontally(element: Element): boolean {
  const overflowX = getComputedStyle(element).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

function clips(element: Element): boolean {
  const style = getComputedStyle(element);
  return [style.overflowX, style.overflowY].some(
    (overflow) => overflow === "hidden" || overflow === "clip",
  );
}

/**
 * Content the reader loses under `root`: the page scrolling sideways, an
 * element past the viewport's left or right edge, or an element that clips
 * its own text. An element inside a block that scrolls on its own (a code
 * block's long line) is reachable by that block's scroll, so is not lost.
 */
export function lostContent(root: Element): Array<string> {
  const lost: Array<string> = [];
  const viewportWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewportWidth)
    lost.push(
      `the page scrolls sideways: ${document.documentElement.scrollWidth} px of content in ${viewportWidth} px`,
    );
  for (const element of root.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    let ancestor = element.parentElement;
    let insideScroller = false;
    while (ancestor !== null && ancestor !== root) {
      if (scrollsHorizontally(ancestor)) insideScroller = true;
      ancestor = ancestor.parentElement;
    }
    if (insideScroller) continue;
    if (rect.right > viewportWidth + 0.5 || rect.left < -0.5)
      lost.push(
        describe(
          element,
          `spans ${Math.round(rect.left)} to ${Math.round(rect.right)} px`,
        ),
      );
    // A loading button slides its label, made transparent, out of its box
    // and shows a spinner in its place; the label is measured in the
    // button's idle state.
    if (
      clips(element) &&
      !element.hasAttribute("data-loading") &&
      element.textContent.trim() !== "" &&
      (element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1)
    )
      lost.push(
        describe(
          element,
          `clips ${element.scrollWidth}x${element.scrollHeight} px of content to ${element.clientWidth}x${element.clientHeight}`,
        ),
      );
  }
  return lost;
}

async function nextFrames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let frame = 0; frame < 2; frame += 1)
    await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** How many rounds of finishing CSS transitions {@link settled} takes: a
 * disclosure panel whose content grew while it opened starts a second
 * transition to the new height when the first ends. */
const MAX_TRANSITION_ROUNDS = 5;

/** Resolves once the browser has laid out and painted any update a style or
 * viewport change set off, React's included. A running CSS transition, such
 * as a disclosure panel still opening at a fixed height, is finished, and the
 * frames after it let its end handler run. */
async function settled(root: Element): Promise<void> {
  await nextFrames();
  for (let round = 0; round < MAX_TRANSITION_ROUNDS; round += 1) {
    const transitions = root
      .getAnimations({ subtree: true })
      .filter((animation) => animation instanceof CSSTransition);
    if (transitions.length === 0) return;
    for (const transition of transitions) transition.finish();
    await nextFrames();
  }
}

/**
 * Fails when `root`, as it stands, loses content under the WCAG text spacing
 * at the current viewport or at {@link REFLOW_WIDTH} CSS pixels. For a state
 * only a journey reaches: the spacing and the viewport are put back after, so
 * the journey goes on from where it was.
 */
export async function expectLayoutHolds(root: Element): Promise<void> {
  const spacing = document.createElement("style");
  spacing.textContent = WCAG_TEXT_SPACING_CSS;
  document.head.appendChild(spacing);
  try {
    await settled(root);
    expect(lostContent(root), "under the WCAG text spacing").toEqual([]);
  } finally {
    spacing.remove();
  }
  const { innerWidth: width, innerHeight: height } = window;
  await page.viewport(REFLOW_WIDTH, REFLOW_HEIGHT);
  try {
    await settled(root);
    expect(lostContent(root), `at ${REFLOW_WIDTH} CSS pixels`).toEqual([]);
  } finally {
    await page.viewport(width, height);
    await settled(root);
  }
}
