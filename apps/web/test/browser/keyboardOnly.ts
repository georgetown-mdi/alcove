import { expect } from "vitest";

import { userEvent } from "vitest/browser";

import { accessibleName } from "./accessibilityRules";

/**
 * Helpers for a journey driven only from the keyboard: focus moves by Tab and
 * Shift+Tab alone, and a control is operated by the key a keyboard user presses
 * on it. Nothing here clicks, so a control the Tab order cannot reach fails the
 * journey rather than being clicked past.
 *
 * One step is outside the keyboard: a native file chooser is an operating-system
 * dialog the runner cannot drive, so a journey focuses the file control by Tab
 * and then hands the file to its input with `userEvent.upload`.
 */

/** The Tab presses a single move may take before it fails: well past the
 * longest Tab order these screens have, so reaching the cap means the target
 * is not in the order at all. */
const MAX_TAB_PRESSES = 200;

/**
 * The test timeout of a whole keyboard journey. A journey makes 38 to 58
 * keyboard calls to the browser driver one after another, so its time grows
 * with CPU load: the slowest measured, the recurring-setup journey, took 24.7 s
 * at a load average of 33 to 39 on 10 cores, past vitest's 15 s browser
 * default. 37 s is a 1.5x margin over it.
 */
export const KEYBOARD_JOURNEY_TIMEOUT_MS = 37_000;

/** What a target is matched by: an element, or a predicate over the focused
 * element for a target the caller can name but not hold (it may not have
 * rendered yet). */
export type FocusTarget = Element | ((focused: Element) => boolean);

function matches(target: FocusTarget, focused: Element): boolean {
  return typeof target === "function" ? target(focused) : focused === target;
}

function describeElement(element: Element | null): string {
  if (element === null) return "nothing";
  return `<${element.tagName.toLowerCase()}> "${accessibleName(element).slice(0, 40)}"`;
}

const FOCUS_STYLE_PROPERTIES = [
  "outline-style",
  "outline-width",
  "outline-color",
  "box-shadow",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "background-color",
  "color",
  "text-decoration-line",
] as const;

/** The element that may paint `element`'s focus: itself, the element drawing
 * it on its behalf (a switch's track, the next sibling) and its parent. */
function focusDrawers(element: Element): Array<Element | null> {
  return [element, element.nextElementSibling, element.parentElement];
}

/** How `drawer` paints. A running CSS transition is finished first, so the
 * reading is the settled state. */
function appearance(drawer: Element | null): string {
  if (drawer === null) return "";
  for (const animation of drawer.getAnimations())
    if (animation instanceof CSSTransition) animation.finish();
  const style = getComputedStyle(drawer);
  return FOCUS_STYLE_PROPERTIES.map((property) =>
    style.getPropertyValue(property),
  ).join(";");
}

/** The elements a Tab press can move focus to. */
const TABBABLE_SELECTOR =
  "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";

/** How each drawer of every element a Tab press could focus paints before the
 * press: each one's unfocused appearance. */
function readUnfocused(): Map<Element, string> {
  const unfocused = new Map<Element, string>();
  for (const element of document.body.querySelectorAll(TABBABLE_SELECTOR))
    for (const drawer of focusDrawers(element))
      if (drawer !== null && !unfocused.has(drawer))
        unfocused.set(drawer, appearance(drawer));
  return unfocused;
}

/** Fails when the element a Tab press just focused paints the same as it did
 * before the press: it shows no focus indicator (WCAG 2.4.7). A drawer that is
 * or holds the element the press moved focus from is left out, since its
 * change is that element losing focus, not this one gaining it. */
function expectFocusIndicatorShown(
  previous: Element | null,
  unfocused: Map<Element, string>,
): void {
  const focused = document.activeElement;
  if (focused === null || focused === document.body) return;
  if (!unfocused.has(focused))
    throw new Error(
      `${describeElement(focused)} was not on the page before the Tab press that focused it, so its focus indicator cannot be compared`,
    );
  const changed = focusDrawers(focused).some(
    (drawer) =>
      drawer !== null &&
      (drawer === focused || previous === null || !drawer.contains(previous)) &&
      unfocused.has(drawer) &&
      appearance(drawer) !== unfocused.get(drawer),
  );
  if (!changed)
    throw new Error(
      `${describeElement(focused)} looks the same focused and unfocused: it shows no focus indicator (WCAG 2.4.7)`,
    );
}

/**
 * Presses Tab (or Shift+Tab when `backward`) until `target` holds focus, and
 * fails naming the stops it passed when the order never reaches it.
 *
 * Every element a press focuses, the target included, must look different
 * focused from how it looked just before the press: an outline, shadow,
 * border, background, color or underline that changes with focus. A browser
 * shows a keyboard focus indicator only for focus the keyboard moved, so only
 * a press's stops are held to one. Best effort: an element that also changes
 * for another reason as focus arrives passes, and whether the change is
 * visible enough is a judgment this does not make.
 */
export async function tabTo(
  target: FocusTarget,
  options: { backward?: boolean } = {},
): Promise<void> {
  const passed: Array<string> = [];
  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    const focused = document.activeElement;
    if (
      focused !== null &&
      focused !== document.body &&
      matches(target, focused)
    )
      return;
    passed.push(describeElement(focused));
    const unfocused = readUnfocused();
    await userEvent.tab({ shift: options.backward === true });
    expectFocusIndicatorShown(focused, unfocused);
  }
  throw new Error(
    `Tab never reached the target; it passed: ${passed.slice(-20).join(", ")}`,
  );
}

/** A predicate matching a control by its role and accessible name, for
 * {@link tabTo}. */
export function control(
  role: "button" | "link" | "checkbox" | "textbox" | "combobox",
  name: string | RegExp,
): (focused: Element) => boolean {
  return (focused) => {
    if (!hasRole(focused, role)) return false;
    const actual = accessibleName(focused).replace(/\s+/g, " ").trim();
    return typeof name === "string" ? actual === name : name.test(actual);
  };
}

function hasRole(element: Element, role: string): boolean {
  const explicit = element.getAttribute("role");
  if (explicit !== null) return explicit === role;
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  switch (role) {
    case "button":
      return (
        tag === "button" ||
        (tag === "input" && ["button", "submit", "reset"].includes(type))
      );
    case "link":
      return tag === "a" && element.hasAttribute("href");
    case "checkbox":
      return tag === "input" && type === "checkbox";
    case "textbox":
      return (
        tag === "textarea" ||
        (tag === "input" &&
          ["text", "email", "search", "tel", "url", "password"].includes(type))
      );
    case "combobox":
      return tag === "select";
    default:
      return false;
  }
}

/** Tabs to `target` and presses Enter on it: a button's or a link's activation
 * key. */
export async function activate(target: FocusTarget): Promise<void> {
  await tabTo(target);
  await userEvent.keyboard("{Enter}");
}

/** Tabs to a checkbox and toggles it with Space. */
export async function toggle(target: FocusTarget): Promise<void> {
  await tabTo(target);
  await userEvent.keyboard(" ");
}

/** Tabs to a text field and types `text` into it, key by key. */
export async function typeInto(
  target: FocusTarget,
  text: string,
): Promise<void> {
  await tabTo(target);
  await userEvent.keyboard(text);
}

/** Waits for focus to land on the page's h1 reading `text`: where a screen
 * that replaces its content sends focus. */
export async function expectHeadingFocused(
  text: string | RegExp,
): Promise<void> {
  await expect
    .poll(() => {
      const focused = document.activeElement;
      return focused?.tagName === "H1" ? focused.textContent : "";
    })
    .toMatch(
      typeof text === "string" ? new RegExp(`^${escapeRegExp(text)}$`) : text,
    );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
