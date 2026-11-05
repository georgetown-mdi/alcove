import axe from "axe-core";
import { expect } from "vitest";

/**
 * axe-core's WCAG 2.1 Level A and AA rules over a rendered surface, run in the
 * real browser beside the in-house rule scan (accessibilityRules.ts). A clean
 * run is evidence for the criteria docs/ACCESSIBILITY.md maps to it, not a
 * conformance claim: axe decides only what a DOM walk can, and reports the rest
 * as incomplete, which this helper does not fail on.
 *
 * The scan's context is the mounted container, not the document: the test
 * runner owns the document, so the document-level rules (html-has-lang,
 * document-title) have no element to judge here, and the shipped documents'
 * language and titles are checked from source instead.
 */

/** The axe tags of the WCAG 2.0 and 2.1 Level A and AA success criteria. */
export const WCAG_21_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** One axe rule a scanned surface breaks, with the elements that break it. */
export interface AxeViolation {
  rule: string;
  targets: Array<string>;
}

/** Runs the WCAG 2.1 A and AA rules over `root` and returns every violation. */
export async function axeViolations(
  root: Element,
): Promise<Array<AxeViolation>> {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: WCAG_21_AA_TAGS },
    rules: { "label-content-name-mismatch": { enabled: true } },
    resultTypes: ["violations"],
  });
  return results.violations.map((violation) => ({
    rule: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

/** Fails the test with every WCAG 2.1 A or AA violation axe finds under `root`. */
export async function expectNoAxeViolations(root: Element): Promise<void> {
  expect(await axeViolations(root)).toEqual([]);
}
