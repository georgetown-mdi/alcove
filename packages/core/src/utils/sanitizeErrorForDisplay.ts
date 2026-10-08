import { errorMessage } from "../errors";
import { MAX_ERROR_CAUSE_DEPTH } from "../failureAnnotation";
import {
  operatorSuppliedSpans,
  operatorSuppliedValue,
  spansOfMessage,
} from "./operatorSuppliedText";
import type {
  DisplaySpan,
  MessageWithOperatorText,
  OperatorSuppliedText,
} from "./operatorSuppliedText";
import {
  boundRawFragmentForFit,
  clipToRenderedCost,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  renderedDisplayCost,
  renderOperatorSuppliedSpanText,
  replaceControlCharactersForDisplay,
  sanitizeForDisplay,
} from "./sanitizeForDisplay";
import type {
  Displayable,
  SanitizeForDisplayOptions,
} from "./sanitizeForDisplay";

export { MAX_ERROR_CAUSE_DEPTH };

/**
 * Marker {@link sanitizeErrorForDisplay} appends to the last link it renders
 * when the walk stops at {@link MAX_ERROR_CAUSE_DEPTH} with the chain still
 * running. Holds no count: counting the remainder means walking it.
 *
 * Plain ASCII, so it is not authenticated: a link ending in the same text
 * renders identically. A copy can claim a loss that did not happen but cannot
 * conceal one that did, so the marker's absence is what an operator can rely
 * on (docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format).
 */
export const CAUSE_DEPTH_ELISION_MARKER = "...[further causes elided]";

/**
 * {@link CAUSE_DEPTH_ELISION_MARKER} as it sits on a rendered chain's last
 * link; the renderer and the re-render in {@link sanitizeErrorChainLinks} both
 * write and look for it through this constant.
 */
const ELISION_SUFFIX = ` ${CAUSE_DEPTH_ELISION_MARKER}`;

/**
 * Separator placed between an error's message and each chained `cause`
 * message. Its leading newline is the one control character this module emits
 * itself; every message byte is escaped by {@link sanitizeForDisplay} before
 * the join, so no message can forge a `caused by:` boundary and
 * {@link sanitizeErrorChainLinks} can split on this text. A kept break
 * ({@link keepFirstPartyLineBreaks}) never stands in front of one either
 * ({@link refuseCauseSeparatorOpening}). HTML consumers need
 * `white-space: pre-line` to show the newline.
 */
const ERROR_CAUSE_SEPARATOR = "\ncaused by: ";

/**
 * Fallback for a link whose message cannot be read (a throwing getter or
 * `toString`, or a non-string `.message`). Plain ASCII, so the renderer stays
 * total.
 */
const UNREADABLE_LINK = "[unreadable error]";

const REDACTED_PRIVATE_KEY = "[redacted private key]";

/**
 * A PEM / OpenSSH private-key block, BEGIN marker to the next END marker, plus
 * a fallback for a truncated block (BEGIN with no END). PGP blocks are not
 * matched: Alcove uses no PGP keys.
 *
 * The tempered lookahead keeps the gap from crossing another BEGIN marker;
 * without it a long run of BEGIN markers with no END makes the lazy
 * `[\s\S]*?` rescan to the end of the string per attempt, O(n^2) on
 * partner-controlled error text.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_DANGLING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * Last-resort redaction of PEM / OpenSSH private-key blocks in text about to
 * be shown to an operator. Not the primary defense: secret-bearing files are
 * parsed through the sensitive-file chokepoint so a parse error never holds
 * source.
 *
 * The dangling rule replaces from an unmatched BEGIN marker to the end of the
 * text and fails closed: a sliced key has no structure to infer a body end
 * from. It also consumes whatever was composed after the marker, so a
 * partner-controlled fragment is passed through this function at its
 * composition site, before interpolation. Idempotent.
 *
 * Redaction, not escaping: the fragment is escaped once, at the display sink
 * (CONTRIBUTING.md, Operator-facing escaping). It does not scrub by secret
 * shape, since a shared secret and a host-key fingerprint share one and
 * fingerprints are shown on purpose. The three sinks and their reach limits:
 * docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
 */
export function redactPrivateKeyMaterial(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, REDACTED_PRIVATE_KEY)
    .replace(PRIVATE_KEY_DANGLING, REDACTED_PRIVATE_KEY);
}

/**
 * Whether {@link redactPrivateKeyMaterial} would replace anything in `text`,
 * for a caller that refuses such a value rather than showing the marker
 * (`packages/core/src/config/transformParamDisplay.ts`). It runs the redaction
 * and compares, so the two cannot disagree on what a marker is.
 */
export function holdsPrivateKeyMaterial(text: string): boolean {
  return redactPrivateKeyMaterial(text) !== text;
}

/**
 * One BEGIN or END marker, un-anchored and non-global, for the incremental
 * scan in {@link createPrivateKeyStreamRedactor}.
 */
const PRIVATE_KEY_BEGIN_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_MARKER = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * The longest marker the streaming scan holds back for, in UTF-16 code units:
 * the fixed opener and closer around a label of at most 64. Bounds the
 * lookahead, not what matches: a marker with a longer label is still matched
 * inside one delivery, and only one whose label passes 64 characters across a
 * delivery boundary escapes (the longest label in use is ten).
 */
const PRIVATE_KEY_MARKER_LOOKAHEAD =
  "-----BEGIN ".length + 64 + "PRIVATE KEY-----".length;

/**
 * A redactor for private-key material arriving in pieces, for a sink that
 * keeps a window of what it is given -- the console's retained stderr tail
 * (`attachStderrTail` in `apps/web/src/jobs/cliDriver.ts`).
 *
 * A key longer than the window lands in it as body alone, with no marker for
 * {@link redactPrivateKeyMaterial} to see, so the stream is redacted in front
 * of the window. On a BEGIN marker the scan emits {@link REDACTED_PRIVATE_KEY}
 * once and nothing more until an END marker; a block still open at
 * {@link PrivateKeyStreamRedactor.close} stays redacted. An END with no BEGIN
 * is ordinary text: the reach is forward only.
 */
export interface PrivateKeyStreamRedactor {
  /** Redact `chunk` in the stream's state and return what may be emitted. */
  push(chunk: string): string;
  /**
   * The held-back remainder, redacted; nothing while a block is still open.
   * A caller that never calls it loses at most
   * {@link PRIVATE_KEY_MARKER_LOOKAHEAD} code units of the last delivery.
   */
  close(): string;
}

/** Open a {@link PrivateKeyStreamRedactor} over a fresh, empty stream. */
export function createPrivateKeyStreamRedactor(): PrivateKeyStreamRedactor {
  let held = "";
  let insideBlock = false;

  return {
    push(chunk: string): string {
      let pending = held + chunk;
      let emitted = "";
      for (;;) {
        if (insideBlock) {
          const end = PRIVATE_KEY_END_MARKER.exec(pending);
          if (end === null) break;
          pending = pending.slice(end.index + end[0].length);
          insideBlock = false;
          continue;
        }
        const begin = PRIVATE_KEY_BEGIN_MARKER.exec(pending);
        if (begin === null) break;
        emitted += pending.slice(0, begin.index) + REDACTED_PRIVATE_KEY;
        pending = pending.slice(begin.index + begin[0].length);
        insideBlock = true;
      }
      // Inside a block the remainder is held as context an END marker may
      // span; outside one all but the lookahead is emitted.
      const kept = Math.min(pending.length, PRIVATE_KEY_MARKER_LOOKAHEAD);
      if (!insideBlock) emitted += pending.slice(0, pending.length - kept);
      held = pending.slice(pending.length - kept);
      return emitted;
    },
    close(): string {
      const remainder = insideBlock ? "" : redactPrivateKeyMaterial(held);
      held = "";
      return remainder;
    },
  };
}

/**
 * Prepare a fragment somebody else chose for interpolation into a line that
 * reaches a log, console, or prompt sink: {@link redactPrivateKeyMaterial}
 * first, then {@link sanitizeForDisplay}, pairing with the per-argument pass
 * the log prefixer applies (`setLogPrefixer` in `./logger`).
 *
 * Redact before escaping: the cap would otherwise cut a long fragment between
 * its `BEGIN` and `END`, leaving a dangling marker where a whole block stood,
 * and a planted marker must not exist when the sink's pass runs or that pass
 * consumes the first-party text behind the fragment. Use it uniformly rather
 * than by position in the line. A fragment routed into an `Error` stays raw
 * and is escaped by {@link sanitizeErrorForDisplay}.
 *
 * Do not fit a length budget by comparing this against
 * {@link sanitizeForDisplay} at the same `maxLength`: the result can be the
 * longer of the two. {@link redactPrivateKeyMaterial} never lengthens its
 * input, and the budgeted callers fit over that.
 */
export function redactAndSanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  return sanitizeForDisplay(redactPrivateKeyMaterial(value), options);
}

/**
 * `value` redacted and fitted so its single escape at the sink stays within
 * `budget`, but not escaped. Cut to a raw length first
 * ({@link boundRawFragmentForFit}), then redacted, then clipped: redacting
 * after the clip would let a dangling `BEGIN` in the kept prefix consume the
 * truncation marker ({@link clipToRenderedCost}).
 */
export function redactAndFitUnescaped(value: string, budget: number): string {
  return clipToRenderedCost(
    redactPrivateKeyMaterial(boundRawFragmentForFit(value, budget)),
    budget,
  );
}

/**
 * {@link redactAndSanitizeForDisplay} for a fragment the operator supplied:
 * {@link redactPrivateKeyMaterial} first, then
 * {@link ./sanitizeForDisplay.renderOperatorSuppliedText}, which leaves the
 * operator's own bytes as typed. The log, console and prompt half of the
 * fragment boundary; the error route renders the same text per span
 * (`./operatorSuppliedText`).
 *
 * Takes the mark on both routes: an unmarked value does not compile, and one
 * that arrives unmarked is escaped rather than rendered as given. Redaction
 * runs first for the reason {@link redactAndSanitizeForDisplay} gives.
 */
export function redactAndRenderOperatorSuppliedText(
  value: OperatorSuppliedText,
  options?: SanitizeForDisplayOptions,
): Displayable {
  const text = operatorSuppliedValue(value);
  return text === undefined
    ? redactAndSanitizeForDisplay(String(value), options)
    : renderOperatorSuppliedSpanText(redactPrivateKeyMaterial(text), options);
}

/**
 * Where the display form of a message whose line breaks are its own is kept
 * for {@link sanitizeErrorForDisplay} to read.
 *
 * Symbol-keyed, so no parsed value (`JSON.parse`, YAML, `structuredClone`
 * yield string keys alone) can ask for the treatment. Registered rather than
 * module-private, so a second copy of this module reads the mark the other
 * wrote instead of escaping the breaks.
 */
const FIRST_PARTY_LINE_BREAK_TEXT = Symbol.for(
  "alcove.errorDisplay.firstPartyLineBreaks",
);

/**
 * Keep the line breaks between `lines`, so {@link sanitizeErrorForDisplay}
 * renders them as line breaks rather than the escape's `\x0a`. For a
 * first-party composition whose structure is the line break, such as a
 * per-field conflict list above a recovery step.
 *
 * Only the breaks between `lines` are kept: every control character inside a
 * line becomes its printable marker ({@link replaceControlCharactersForDisplay}),
 * so a fragment somebody else chose opens no line of its own. Every line passes
 * through {@link refuseCauseSeparatorOpening}, so a fragment at the start of
 * one cannot forge a link boundary.
 *
 * Marks the error and returns it; `error.message` is untouched, so
 * classification and comparison read the same text.
 */
export function keepFirstPartyLineBreaks<E extends Error>(
  error: E,
  lines: ReadonlyArray<string>,
): E {
  const display = lines
    .map(replaceControlCharactersForDisplay)
    .map(refuseCauseSeparatorOpening)
    .join("\n");
  // Empty lines would render the link as nothing; the unmarked route shows the
  // message instead.
  if (display === "") return error;
  Object.defineProperty(error, FIRST_PARTY_LINE_BREAK_TEXT, {
    value: display,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/**
 * Where {@link keepFirstPartyLinesWithOperatorText} keeps the spans of each
 * line, registered and symbol-keyed as {@link FIRST_PARTY_LINE_BREAK_TEXT} is.
 */
const FIRST_PARTY_LINE_SPANS = Symbol.for(
  "alcove.errorDisplay.firstPartyLineSpans",
);

/**
 * {@link keepFirstPartyLineBreaks} for lines composed with
 * {@link ./operatorSuppliedText.messageWithOperatorText}: inside each line the
 * spans the operator supplied render as typed and every other span is escaped.
 * Pass the error whose message is `lines` joined with `\n`; the renderer
 * checks that join and escapes the message whole where it does not hold.
 */
export function keepFirstPartyLinesWithOperatorText<E extends Error>(
  error: E,
  lines: ReadonlyArray<MessageWithOperatorText>,
): E {
  const spanLines = lines.map(spansOfMessage);
  if (spanLines.every((line) => line.length === 0)) return error;
  Object.defineProperty(error, FIRST_PARTY_LINE_SPANS, {
    value: spanLines,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/**
 * The lines {@link keepFirstPartyLinesWithOperatorText} left on `link` whose
 * text joins back to `message`, or `undefined` for an unmarked link or a mark
 * that does not describe its message.
 */
function firstPartyLineSpans(
  link: unknown,
  message: string,
): ReadonlyArray<ReadonlyArray<DisplaySpan>> | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  if (!Object.hasOwn(link, FIRST_PARTY_LINE_SPANS)) return undefined;
  const marked = (link as Record<symbol, unknown>)[FIRST_PARTY_LINE_SPANS];
  if (!Array.isArray(marked)) return undefined;
  const lines: DisplaySpan[][] = [];
  for (const line of marked as unknown[]) {
    if (!Array.isArray(line)) return undefined;
    const spans: DisplaySpan[] = [];
    for (const span of line as unknown[]) {
      if (typeof span !== "object" || span === null) return undefined;
      const { text, operatorSupplied } = span as Partial<DisplaySpan>;
      if (typeof text !== "string" || typeof operatorSupplied !== "boolean")
        return undefined;
      spans.push({ text, operatorSupplied });
    }
    lines.push(spans);
  }
  return lines
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n") === message
    ? lines
    : undefined;
}

/** The text {@link ERROR_CAUSE_SEPARATOR} puts behind its newline. */
const CAUSE_SEPARATOR_LINE_OPENING = ERROR_CAUSE_SEPARATOR.slice("\n".length);

/**
 * `line` prefixed with a backslash where it opens on
 * {@link CAUSE_SEPARATOR_LINE_OPENING}, so a kept break in front of it does not
 * spell a link boundary. {@link sanitizeForDisplay} doubles the backslash, so
 * the line reaches the operator as `\\caused by: `, visibly not the separator.
 */
function refuseCauseSeparatorOpening(line: string): string {
  return line.startsWith(CAUSE_SEPARATOR_LINE_OPENING) ? `\\${line}` : line;
}

/**
 * What a block costs when shown with its line breaks kept
 * ({@link keepFirstPartyLineBreaks}): each line's {@link renderedDisplayCost}
 * plus one character per break, which is what {@link renderFirstPartyLineBreaks}
 * emits. {@link renderedDisplayCost} would price a break at the four characters
 * of `\x0a`, leaving three per line of the budget unspendable.
 *
 * A raw block measures what its marked form renders to: the mark's control
 * character replacement is as wide as the escape (every control character is
 * at or below U+009F), and the {@link refuseCauseSeparatorOpening} prefix is
 * applied here too.
 */
export function renderedDisplayCostKeepingLineBreaks(block: string): number {
  const lines = block.split("\n");
  return (
    lines.reduce(
      (total, line) =>
        total + renderedDisplayCost(refuseCauseSeparatorOpening(line)),
      0,
    ) +
    lines.length -
    1
  );
}

/**
 * The display form {@link keepFirstPartyLineBreaks} left on `link`, or
 * `undefined` for a link that asked for no such treatment.
 */
function firstPartyLineBreakText(link: unknown): string | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  // Own property only: a mark on a prototype must not lend the treatment to
  // everything built from it.
  if (!Object.hasOwn(link, FIRST_PARTY_LINE_BREAK_TEXT)) return undefined;
  const kept = (link as Record<symbol, unknown>)[FIRST_PARTY_LINE_BREAK_TEXT];
  return typeof kept === "string" ? kept : undefined;
}

/**
 * Escape one link that kept its own line breaks: redact the whole text first,
 * so a private-key block spanning lines goes as one block, then escape each
 * line and join with the break.
 *
 * The budget is the link's: each line is charged its rendered length plus one
 * for the break behind it, so a many-line link is bounded at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH} as a one-line link is. Lines
 * dropped for want of room are marked on the last line rendered.
 *
 * Each line passes {@link refuseCauseSeparatorOpening} again here, since this
 * reads a stored string that other code could have planted; applying it twice
 * changes nothing.
 */
function renderFirstPartyLineBreaks(text: string): string {
  const lines = redactPrivateKeyMaterial(text).split("\n");
  const rendered: string[] = [];
  let spent = 0;
  for (const line of lines) {
    const room = COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - spent;
    if (room <= 0) {
      rendered[rendered.length - 1] += DISPLAY_TRUNCATION_MARKER;
      break;
    }
    const escaped = sanitizeForDisplay(refuseCauseSeparatorOpening(line), {
      maxLength: room,
    });
    rendered.push(escaped);
    // The escape truncated and marked this line; no room is left for the rest.
    if (escaped.length > room) break;
    spent += escaped.length + 1;
  }
  return rendered.join("\n");
}

/**
 * Escape one link span by span: operator-supplied spans render as typed, every
 * other span is escaped.
 *
 * The budget is the link's, spent in span order; the first span that does not
 * fit is cut and marked and the rest dropped. Redaction runs per span, so a
 * `BEGIN` marker in an operator's path costs that path and not the sentence
 * telling them what to do.
 */
function renderSpans(
  spans: ReadonlyArray<DisplaySpan>,
  budget: number = COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
): string {
  let rendered = "";
  for (const span of spans) {
    const room = budget - rendered.length;
    if (room <= 0) break;
    const text = redactPrivateKeyMaterial(span.text);
    const shown = span.operatorSupplied
      ? renderOperatorSuppliedSpanText(text, { maxLength: room })
      : sanitizeForDisplay(text, { maxLength: room });
    rendered += shown;
    // The render truncated and marked this span; no room is left for the rest.
    if (shown.length > room) break;
  }
  return rendered;
}

/**
 * Render one link {@link keepFirstPartyLinesWithOperatorText} marked: each line
 * span by span ({@link renderSpans}), joined with the break, under the link's
 * one budget as in {@link renderFirstPartyLineBreaks}. A line opening on the
 * cause separator's text is led by a backslash, as
 * {@link refuseCauseSeparatorOpening} does.
 */
function renderLinesOfSpans(
  lines: ReadonlyArray<ReadonlyArray<DisplaySpan>>,
): string {
  const rendered: string[] = [];
  let spent = 0;
  for (const line of lines) {
    const room = COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - spent;
    if (room <= 0) {
      rendered[rendered.length - 1] += DISPLAY_TRUNCATION_MARKER;
      break;
    }
    const opensOnSeparator = line
      .map((span) => span.text)
      .join("")
      .startsWith(CAUSE_SEPARATOR_LINE_OPENING);
    const shown = renderSpans(
      opensOnSeparator
        ? [{ text: "\\", operatorSupplied: false }, ...line]
        : line,
      room,
    );
    rendered.push(shown);
    if (shown.length > room) break;
    spent += shown.length + 1;
  }
  return rendered.join("\n");
}

/**
 * Render an arbitrary thrown value as operator-safe display text: its own
 * message followed by each chained `cause` message, every link escaped by
 * {@link sanitizeForDisplay} and passed through
 * {@link redactPrivateKeyMaterial}, so partner- or server-controlled bytes
 * cannot reach a terminal, log line, or UI element. Redaction is fail-closed
 * past a truncated key, so a partner-controlled fragment is redacted where it
 * is composed rather than only here.
 *
 * A link marked by {@link keepFirstPartyLineBreaks} is escaped line by line and
 * joined with its breaks. A link marked by
 * {@link ./operatorSuppliedText.keepOperatorSuppliedText} is rendered span by
 * span, and the mark is read only where its spans join back to the link's own
 * message. A link marked by {@link keepFirstPartyLinesWithOperatorText} takes
 * both treatments.
 *
 * This is the display-boundary call for a raw error instance: the transport
 * and message layers keep the original error so it can be classified by type,
 * so escaping happens here. Never use it on a value used for comparison,
 * storage, or hashing (it is lossy). The walk:
 * - reads only each link's `.message` (via {@link errorMessage}) and `.cause`,
 *   never `.stack` or another property;
 * - is cycle-safe and bounded at {@link MAX_ERROR_CAUSE_DEPTH} links, each
 *   capped at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, so the output is
 *   bounded without a total-length cap;
 * - marks a chain that outruns the depth bound with
 *   {@link CAUSE_DEPTH_ELISION_MARKER}; a chain that ends on its own or on the
 *   cycle guard has no marker;
 * - suppresses a link whose raw message repeats the one before it (as
 *   `asConnectionError` makes a wrapper repeat its cause);
 * - never throws: an unreadable link renders as `[unreadable error]`.
 *
 * An unmarked error with no `cause` renders as `errorMessage(err)` escaped at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}; a non-`Error` value renders its
 * `String(...)` form, matching {@link errorMessage}.
 */
export function sanitizeErrorForDisplay(err: unknown): string {
  const rawLinks: Array<{
    message: string;
    kept: string | undefined;
    spans: ReadonlyArray<DisplaySpan> | undefined;
    lineSpans: ReadonlyArray<ReadonlyArray<DisplaySpan>> | undefined;
  }> = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let elided = false;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth++) {
    // Read each link defensively: a throwing getter or `toString`, or a
    // non-string `.message`, must yield a marker, never crash the renderer.
    let message: string;
    let kept: string | undefined;
    let spans: ReadonlyArray<DisplaySpan> | undefined;
    let lineSpans: ReadonlyArray<ReadonlyArray<DisplaySpan>> | undefined;
    try {
      const raw = errorMessage(current);
      message = typeof raw === "string" ? raw : String(raw);
    } catch {
      message = UNREADABLE_LINK;
    }
    // A throwing mark read (a Proxy or getter) means no treatment, not an
    // unreadable link.
    try {
      kept = firstPartyLineBreakText(current);
    } catch {
      kept = undefined;
    }
    // Read after the message: kept only where its spans join back to it.
    try {
      spans = operatorSuppliedSpans(current, message);
    } catch {
      spans = undefined;
    }
    try {
      lineSpans = firstPartyLineSpans(current, message);
    } catch {
      lineSpans = undefined;
    }
    // Suppress a link repeating the previous raw message, keeping the marked
    // one of the two so an unmarked wrapper over a marked cause of the same
    // text still renders as written.
    const previous = rawLinks[rawLinks.length - 1];
    if (previous?.message !== message)
      rawLinks.push({ message, kept, spans, lineSpans });
    else {
      if (previous.kept === undefined) previous.kept = kept;
      if (previous.spans === undefined) previous.spans = spans;
      if (previous.lineSpans === undefined) previous.lineSpans = lineSpans;
    }
    seen.add(current);
    // Not delegated to causeChainSome: this walk renders every link under a
    // depth bound and an elision marker. A throwing `.cause` getter ends the
    // chain.
    let next: unknown;
    try {
      next =
        typeof current === "object" && current !== null
          ? (current as { cause?: unknown }).cause
          : undefined;
    } catch {
      next = undefined;
    }
    if (next === undefined || next === null || seen.has(next)) break;
    // The bound is spent with a further link left: record it so the cut is
    // marked.
    if (depth === MAX_ERROR_CAUSE_DEPTH - 1) {
      elided = true;
      break;
    }
    current = next;
  }
  // The line-and-span mark describes a link completely, so it wins over the
  // line-break form, which escapes every span.
  const links: string[] = rawLinks.map(({ message, kept, spans, lineSpans }) =>
    lineSpans !== undefined
      ? renderLinesOfSpans(lineSpans)
      : kept !== undefined
        ? renderFirstPartyLineBreaks(kept)
        : spans !== undefined
          ? renderSpans(spans)
          : sanitizeForDisplay(redactPrivateKeyMaterial(message), {
              maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
            }),
  );
  // Appended after the escape and the cap, so a link that spent its budget can
  // still say the chain went on.
  if (elided)
    links[links.length - 1] = `${links[links.length - 1]}${ELISION_SUFFIX}`;
  return joinErrorCauseChain(links);
}

/**
 * Join already-escaped links into the rendered chain
 * {@link sanitizeErrorForDisplay} produces, so a boundary that held the chain
 * link by link assembles the text by the same code.
 */
export function joinErrorCauseChain(links: ReadonlyArray<string>): string {
  return links.join(ERROR_CAUSE_SEPARATOR);
}

/**
 * Take a chain {@link sanitizeErrorForDisplay} already rendered and return its
 * links, each escaped and bounded as that renderer bounds them (at most
 * {@link MAX_ERROR_CAUSE_DEPTH} links, each escaped at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}). For a boundary that receives a
 * rendered chain as text and shows it: the console relay reading the CLI's fd-3
 * terminal error, and the console role rendering one. Escaping link by link,
 * not whole at the per-value {@link DEFAULT_MAX_DISPLAY_LENGTH}, keeps a later
 * link's recovery step from being cut off.
 *
 * The split on {@link ERROR_CAUSE_SEPARATOR} is exact. Each link is escaped
 * whole, so a break kept through {@link keepFirstPartyLineBreaks} arrives as
 * `\x0a`: the mark lives on the error object, which rendered text has not.
 *
 * A chain arriving with {@link CAUSE_DEPTH_ELISION_MARKER} leaves with it: it
 * is lifted off the last link before the escape and appended after, so a cut
 * chain is not delivered as a whole one.
 *
 * It escapes and does not redact: redaction already ran at composition and per
 * link, and another pass would give a planted marker a second chance to
 * consume the recovery text behind it.
 */
export function sanitizeErrorChainLinks(rendered: string): Array<string> {
  const links = rendered.split(ERROR_CAUSE_SEPARATOR);
  const kept = links.slice(0, MAX_ERROR_CAUSE_DEPTH);
  const last = kept.length - 1;
  const arrivedElided = kept[last].endsWith(ELISION_SUFFIX);
  if (arrivedElided) kept[last] = kept[last].slice(0, -ELISION_SUFFIX.length);
  const escaped = kept.map((link) =>
    sanitizeForDisplay(link, {
      maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  ) as Array<string>;
  // Appended after the escape and the cap, as the renderer does.
  if (arrivedElided || links.length > MAX_ERROR_CAUSE_DEPTH)
    escaped[last] = `${escaped[last]}${ELISION_SUFFIX}`;
  return escaped;
}
