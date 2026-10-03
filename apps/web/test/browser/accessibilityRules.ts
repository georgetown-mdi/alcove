import { expect } from "vitest";

/**
 * An accessibility rule scan over a rendered surface, run in the real browser.
 *
 * In-house, not axe-core, for the reason test/browser/themeContrastSweep.test.ts
 * gives for its contrast math: no new development dependency. The rules are a
 * fixed subset of WCAG 2.1 failures a DOM walk can decide without judgment, so a
 * clean scan is not a WCAG conformance claim. Contrast is measured by that sweep,
 * and keyboard reach by the keyboard-only journeys, not here.
 *
 * The rules:
 *   duplicate-id         two elements share an id (1.3.1, 4.1.1)
 *   broken-reference     an aria-labelledby, aria-describedby or label `for`
 *                        names an id no element has (1.3.1)
 *   control-name         a focusable control has no accessible name (4.1.2)
 *   image-name           an <img> has no alt, or an svg with role="img" has
 *                        no name (1.1.1)
 *   nested-interactive   a control inside a button or link (4.1.2)
 *   positive-tabindex    a tabindex above 0, which reorders Tab (2.4.3)
 *   hidden-focusable     a focusable control inside aria-hidden="true" (4.1.2)
 *   heading-skip         a heading more than one level below the one before
 *                        it (1.3.1)
 *   list-children        a <ul> or <ol> with a direct child that is not <li>
 *                        (1.3.1)
 *   page-h1              a page surface with no h1 (2.4.6)
 */

/** One rule a scanned element breaks. */
export interface RuleViolation {
  rule: string;
  element: string;
}

const CONTROL_SELECTOR = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="menuitem"]',
].join(", ");

/** Whether `element` is rendered: a node with no box, or one hidden by style,
 * is out of reach of every user and judged by no rule. */
function isRendered(element: Element): boolean {
  if (element.closest("[hidden]") !== null) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function textOf(element: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (node instanceof Element) {
      if (node.getAttribute("aria-hidden") === "true") continue;
      if (node instanceof HTMLImageElement) text += node.alt;
      else if (node.hasAttribute("aria-label"))
        text += node.getAttribute("aria-label");
      else text += textOf(node);
    }
  }
  return text;
}

/** An approximation of the accessible name computation, in its precedence
 * order: aria-labelledby, aria-label, the native label, then content, with
 * aria-hidden text (a required-field asterisk) left out. Enough to tell a named
 * control from an unnamed one, and to find a control by its name. */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((label) => label !== null)
      .map((label) => textOf(label))
      .join(" ")
      .trim();
    if (text !== "") return text;
  }
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel !== undefined && ariaLabel !== "") return ariaLabel;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const labelText = Array.from(element.labels ?? [])
      .map((label) => textOf(label))
      .join(" ")
      .trim();
    if (labelText !== "") return labelText;
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    )
      return element.value.trim();
    const placeholder = element.getAttribute("placeholder")?.trim();
    if (placeholder !== undefined && placeholder !== "") return placeholder;
  } else {
    const content = textOf(element).trim();
    if (content !== "") return content;
  }
  return element.getAttribute("title")?.trim() ?? "";
}

function describe(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id === "" ? "" : `#${element.id}`;
  const role = element.getAttribute("role");
  const text = element.textContent.trim().slice(0, 50);
  return `<${tag}${id}${role === null ? "" : ` role=${role}`}> "${text}"`;
}

/**
 * Scans the rendered subtree under `root` and returns every violation. A
 * `page` scan also requires an h1, which a lone component mount does not have.
 */
export function scanAccessibility(
  root: Element,
  options: { page?: boolean } = {},
): Array<RuleViolation> {
  const violations: Array<RuleViolation> = [];
  const report = (rule: string, element: Element) =>
    violations.push({ rule, element: describe(element) });

  const seenIds = new Map<string, Element>();
  for (const element of root.querySelectorAll("[id]")) {
    if (seenIds.has(element.id)) report("duplicate-id", element);
    else seenIds.set(element.id, element);
  }

  for (const element of root.querySelectorAll(
    "[aria-labelledby], [aria-describedby], label[for]",
  )) {
    const ids = [
      ...(element.getAttribute("aria-labelledby") ?? "").split(/\s+/),
      ...(element.getAttribute("aria-describedby") ?? "").split(/\s+/),
      element.getAttribute("for") ?? "",
    ].filter((id) => id !== "");
    if (ids.some((id) => document.getElementById(id) === null))
      report("broken-reference", element);
  }

  for (const element of root.querySelectorAll(CONTROL_SELECTOR)) {
    if (!isRendered(element)) continue;
    if (accessibleName(element) === "") report("control-name", element);
    const enclosing = element.parentElement?.closest(
      'button, a[href], [role="button"], [role="link"]',
    );
    if (
      enclosing !== null &&
      enclosing !== undefined &&
      root.contains(enclosing)
    )
      report("nested-interactive", element);
    if (element.closest('[aria-hidden="true"]') !== null)
      report("hidden-focusable", element);
  }

  for (const element of root.querySelectorAll("[tabindex]"))
    if (Number(element.getAttribute("tabindex")) > 0)
      report("positive-tabindex", element);

  for (const image of root.querySelectorAll("img"))
    if (isRendered(image) && !image.hasAttribute("alt"))
      report("image-name", image);
  for (const svg of root.querySelectorAll('svg[role="img"]'))
    if (accessibleName(svg) === "" && svg.querySelector("title") === null)
      report("image-name", svg);

  let previousLevel = 0;
  for (const heading of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!isRendered(heading)) continue;
    const level = Number(heading.tagName.slice(1));
    if (previousLevel !== 0 && level > previousLevel + 1)
      report("heading-skip", heading);
    previousLevel = level;
  }

  for (const list of root.querySelectorAll("ul, ol"))
    for (const child of list.children)
      if (!["LI", "SCRIPT", "TEMPLATE"].includes(child.tagName))
        report("list-children", child);

  if (
    options.page === true &&
    Array.from(root.querySelectorAll("h1")).every((h1) => !isRendered(h1))
  )
    report("page-h1", root);

  return violations;
}

/** Fails the test with every violation the scan finds under `root`. */
export function expectNoAccessibilityViolations(
  root: Element,
  options: { page?: boolean } = {},
): void {
  expect(scanAccessibility(root, options)).toEqual([]);
}
