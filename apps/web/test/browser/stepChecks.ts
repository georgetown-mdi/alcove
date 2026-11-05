import { expectLayoutHolds } from "./reflowChecks";
import { expectNoAccessibilityViolations } from "./accessibilityRules";
import { expectNoAxeViolations } from "./axeScan";

/**
 * Every check a keyboard-only journey runs on a page state it reaches: the
 * rule scan, axe, and the layout checks under the WCAG text spacing and at 320
 * CSS pixels. The route-state suites run the same checks on each route's
 * landing state; this reaches the states only a run or a loaded file shows.
 */
export async function expectStepAccessible(root: Element): Promise<void> {
  expectNoAccessibilityViolations(root, { page: true });
  await expectNoAxeViolations(root);
  await expectLayoutHolds(root);
}
