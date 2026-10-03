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

/**
 * Presses Tab (or Shift+Tab when `backward`) until `target` holds focus, and
 * fails naming the stops it passed when the order never reaches it.
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
    await userEvent.tab({ shift: options.backward === true });
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
