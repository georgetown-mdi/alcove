import { expect } from "vitest";

import { userEvent } from "vitest/browser";

import { expectLayoutHolds } from "./reflowChecks";
import { expectNoAccessibilityViolations } from "./accessibilityRules";
import { expectNoAxeViolations } from "./axeScan";

/**
 * Every check a keyboard-only journey runs on a page state it reaches: the
 * rule scan, axe, and the layout checks under the WCAG text spacing and at 320
 * CSS pixels. The route-state suites run the same checks on each route's
 * landing state; this reaches the states only a run or a loaded file shows.
 *
 * The checks read a settled page (see {@link settlePage}).
 */
export async function expectStepAccessible(root: Element): Promise<void> {
  const releasePointer = await settlePage(root);
  try {
    expectNoAccessibilityViolations(root, { page: true });
    await expectNoAxeViolations(root);
    await expectLayoutHolds(root);
  } finally {
    releasePointer();
  }
}

/**
 * Parks the pointer on an element outside `root`, then waits until nothing
 * under `root` is hovered or pressed and no CSS transition under it is
 * running. A keyboard journey never moves the pointer, but the test page
 * keeps it wherever an earlier test left it, so a control rendered beneath
 * it would be scanned in its hover colours. Returns the park's removal.
 */
async function settlePage(root: Element): Promise<() => void> {
  const park = document.createElement("div");
  park.setAttribute("aria-hidden", "true");
  Object.assign(park.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    zIndex: "2147483647",
  });
  document.body.appendChild(park);
  try {
    await userEvent.hover(park);
    await expect.poll(() => root.querySelector(":hover, :active")).toBeNull();
    await expect.poll(() => runningTransitionCount(root)).toBe(0);
  } catch (error) {
    park.remove();
    throw error;
  }
  return () => park.remove();
}

function runningTransitionCount(root: Element): number {
  return document.getAnimations().filter((animation) => {
    if (!(animation instanceof CSSTransition)) return false;
    if (animation.playState !== "running") return false;
    const target =
      animation.effect instanceof KeyframeEffect
        ? animation.effect.target
        : null;
    return target !== null && root.contains(target);
  }).length;
}
