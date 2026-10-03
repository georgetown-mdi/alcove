import { expect, onTestFinished, vi } from "vitest";
import { getDiagnosticSink, setDiagnosticSink } from "@alcove/core";

/** The console levels a failure path logs at: `console.error` for a caught
 * run or exchange failure, `warn` for a logger's warning line. */
export type ExpectedConsoleLevel = "error" | "warn";

/** One expected line: the exact rendered text, or a pattern for a line whose
 * text carries a value the test does not fix (a generated id, a parser's
 * multi-line detail). */
export type ExpectedLine = string | RegExp;

// How long the end-of-test check waits for an expected line still owed: a
// failure can be logged from an async path that settles after the test's last
// assertion.
const LATE_LINE_WAIT_MS = 2_000;

function renderArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  // JSON has no form for these, and stringify answers them with undefined.
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderLine(args: ReadonlyArray<unknown>): string {
  return args.map(renderArgument).join(" ");
}

function matches(expected: ExpectedLine, line: string): boolean {
  return typeof expected === "string" ? expected === line : expected.test(line);
}

/**
 * Declare the console lines this test's failure path logs at `level`, and
 * assert them. Each line is rendered the way it is matched: string arguments
 * as-is, an `Error` as `Name: message`, anything else as JSON, joined by a
 * space; a logger line is rendered without its `[time] [LEVEL] [name]` prefix.
 *
 * For the rest of the test, a line at `level` that matches an entry is kept
 * off the console, and the test fails at its end -- after a short wait for a
 * line logged late -- if any entry matched no line, so a failure path that
 * stops logging, or whose text changes, is reported rather than passed. A line
 * that matches no entry prints as it would without this. Calling it twice in
 * one test adds to the same declaration.
 *
 * It reaches `console.error` / `console.warn` called directly and every logger
 * from `@alcove/core`'s `getLogger`, through the diagnostic sink those loggers
 * resolve per call.
 */
export function expectConsole(
  level: ExpectedConsoleLevel,
  ...lines: Array<ExpectedLine>
): void {
  getCapture().expected.push(...lines.map((line) => ({ level, line })));
}

interface Capture {
  expected: Array<{ level: ExpectedConsoleLevel; line: ExpectedLine }>;
  seen: Array<{ level: ExpectedConsoleLevel; line: string }>;
}

let active: Capture | undefined;

function getCapture(): Capture {
  if (active !== undefined) return active;
  const capture: Capture = { expected: [], seen: [] };
  active = capture;

  const originalError = console.error;
  const originalWarn = console.warn;
  const priorSink = getDiagnosticSink();

  // Whether `line` at `level` is one this test declared; recorded either way
  // so the end-of-test failure can say what did print.
  const claim = (level: ExpectedConsoleLevel, line: string): boolean => {
    capture.seen.push({ level, line });
    return capture.expected.some(
      (entry) => entry.level === level && matches(entry.line, line),
    );
  };

  console.error = (...args: Array<unknown>) => {
    if (!claim("error", renderLine(args))) originalError(...args);
  };
  console.warn = (...args: Array<unknown>) => {
    if (!claim("warn", renderLine(args))) originalWarn(...args);
  };
  setDiagnosticSink((methodName, prefix, args) => {
    if (
      (methodName === "error" || methodName === "warn") &&
      claim(methodName, renderLine(args))
    )
      return;
    if (priorSink !== undefined) {
      priorSink(methodName, prefix, args);
      return;
    }
    // The routing loglevel gives a logger with no sink installed.
    const route =
      methodName === "error"
        ? originalError
        : methodName === "warn"
          ? originalWarn
          : methodName === "debug"
            ? console.log
            : console[methodName];
    route(prefix, ...args);
  });

  onTestFinished(async () => {
    try {
      const unmet = () =>
        capture.expected.filter(
          (entry) =>
            !capture.seen.some(
              (seen) =>
                seen.level === entry.level && matches(entry.line, seen.line),
            ),
        );
      await vi
        .waitFor(
          () => {
            if (unmet().length > 0) throw new Error("expected line not seen");
          },
          { timeout: LATE_LINE_WAIT_MS, interval: 25 },
        )
        .catch(() => undefined);
      const missing = unmet();
      expect(
        missing.length,
        [
          "expected console line(s) were not logged:",
          ...missing.map((entry) => `  ${entry.level}: ${String(entry.line)}`),
          "lines logged at error/warn during the test:",
          ...capture.seen.map((seen) => `  ${seen.level}: ${seen.line}`),
        ].join("\n"),
      ).toBe(0);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      setDiagnosticSink(priorSink);
      active = undefined;
    }
  });
  return capture;
}
