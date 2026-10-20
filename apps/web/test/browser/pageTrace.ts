import { vi } from "vitest";

import { userEvent } from "vitest/browser";

/**
 * A record of what the page did during one test, for a failure to report where
 * the test stood: the steps it marks, the start and end of each `click`,
 * `upload` and `fill`, each change to the disabled state of the buttons it
 * watches and to the text of the region it watches, and the longest gap between
 * ticks of a {@link TICK_MS} interval. A gap far past that interval is a page
 * whose timers did not run, which no step of the test would show.
 */
export interface PageTrace {
  /** Record a step the test has reached. */
  mark: (step: string) => void;
  /** Stop recording, restore the user events, and describe what was seen. */
  stop: () => string;
}

/** What a trace watches on the page. */
export interface PageTraceTargets {
  /** The buttons whose disabled state is recorded. */
  buttons: (button: HTMLButtonElement) => boolean;
  /** A selector for the region whose text is recorded. */
  region: string;
}

/** The tick interval a stalled page misses: an arbitrary working value. */
const TICK_MS = 100;

/** How many of the last entries a description holds: an arbitrary working
 * value that keeps one failure's report to a screen or two. */
const DESCRIBED_ENTRIES = 80;

/** How much of the region's text an entry holds: an arbitrary working value. */
const REGION_TEXT_CHARS = 120;

const TRACED_EVENTS = ["click", "upload", "fill"] as const;

function describeTarget(target: unknown): string {
  if (
    typeof target === "object" &&
    target !== null &&
    "serialize" in target &&
    typeof target.serialize === "function"
  )
    return String((target.serialize() as { locator?: unknown }).locator);
  if (target instanceof Element) {
    const label = target.getAttribute("aria-label");
    return `<${target.tagName.toLowerCase()}${label === null ? "" : ` "${label}"`}>`;
  }
  return String(target);
}

function describeArgument(argument: unknown): string {
  if (argument instanceof File) return argument.name;
  if (Array.isArray(argument)) return argument.map(describeArgument).join(", ");
  return typeof argument === "string" ? JSON.stringify(argument) : "";
}

/** Start a {@link PageTrace} of `targets`. */
export function startPageTrace(targets: PageTraceTargets): PageTrace {
  const origin = performance.now();
  const entries: Array<string> = [];
  const mark = (step: string): void => {
    entries.push(`${Math.round(performance.now() - origin)} ms: ${step}`);
  };

  const spies = TRACED_EVENTS.map((name) => {
    const original = userEvent[name].bind(userEvent) as (
      ...args: Array<unknown>
    ) => Promise<void>;
    return vi
      .spyOn(userEvent, name)
      .mockImplementation(async (...args: Array<unknown>) => {
        const what = `${name} ${describeTarget(args[0])} ${describeArgument(args[1])}`;
        mark(`${what.trimEnd()} started`);
        try {
          await original(...args);
        } finally {
          mark(`${what.trimEnd()} ended`);
        }
      });
  });

  let seen = "";
  const observe = (): void => {
    const buttons = [...document.querySelectorAll("button")]
      .filter(targets.buttons)
      .map((b) => `${b.textContent.trim()}${b.disabled ? " (disabled)" : ""}`);
    const region = document.querySelector(targets.region);
    const text = (region?.textContent ?? "").slice(0, REGION_TEXT_CHARS);
    const now = `buttons [${buttons.join("; ")}], region "${text}"`;
    if (now === seen) return;
    seen = now;
    mark(now);
  };
  const observer = new MutationObserver(observe);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });

  let lastTick = performance.now();
  let longestGap = 0;
  let longestGapEndedAt = 0;
  const tick = (): void => {
    const now = performance.now();
    if (now - lastTick > longestGap) {
      longestGap = now - lastTick;
      longestGapEndedAt = now - origin;
    }
    lastTick = now;
  };
  const ticker = setInterval(tick, TICK_MS);

  return {
    mark,
    stop: () => {
      clearInterval(ticker);
      tick();
      observer.disconnect();
      for (const spy of spies) spy.mockRestore();
      const dropped = entries.length - DESCRIBED_ENTRIES;
      return [
        "the page during this test, from its start:",
        ...(dropped > 0 ? [`(${dropped} earlier entries left out)`] : []),
        ...entries.slice(-DESCRIBED_ENTRIES),
        `longest gap between ${TICK_MS} ms ticks: ${Math.round(longestGap)} ms, ` +
          `ending at ${Math.round(longestGapEndedAt)} ms`,
      ].join("\n");
    },
  };
}
