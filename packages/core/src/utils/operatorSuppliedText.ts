declare const operatorSuppliedBrand: unique symbol;

/**
 * One string whose bytes the operator supplied (a path they typed, a value in
 * their own configuration), marked per fragment where it enters a message so
 * the display sink renders it as given; unmarked text is escaped. It marks who
 * chose the bytes: a path copied from a partner's invitation stays unmarked.
 * The control class is left out either way
 * ({@link ./sanitizeForDisplay.renderOperatorSuppliedText}). No parse produces
 * the symbol key the brand uses. See
 * docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
 */
export interface OperatorSuppliedText {
  readonly [operatorSuppliedBrand]: string;
}

const OPERATOR_SUPPLIED_VALUE = Symbol("alcove.display.operatorSuppliedText");

/** Mark one string the operator supplied as {@link OperatorSuppliedText}. */
export const operatorSuppliedText = (value: string): OperatorSuppliedText =>
  ({ [OPERATOR_SUPPLIED_VALUE]: value }) as unknown as OperatorSuppliedText;

/** One span of a composed message, with the treatment its origin takes. */
export interface DisplaySpan {
  /** The span's raw bytes, escaped or rendered where the message is shown. */
  readonly text: string;
  /** Whether the operator supplied these bytes; unmarked spans are escaped. */
  readonly operatorSupplied: boolean;
}

/**
 * A message with the spans the operator supplied marked. `text` is the raw
 * interpolation, what an `Error` built from it takes as its message. Build one
 * through {@link messageWithOperatorText}: a hand-built value of this shape
 * has no brand and interpolates as its own `text`, escaped.
 */
export interface MessageWithOperatorText {
  readonly text: string;
  readonly spans: ReadonlyArray<DisplaySpan>;
}

/**
 * The symbol key that stores a partitioned message's spans, on a composed
 * message and on a marked error. Registered rather than module-private, so a second
 * copy of this module in the process reads the mark.
 */
const OPERATOR_SUPPLIED_SPANS = Symbol.for(
  "alcove.errorDisplay.operatorSuppliedSpans",
);

/**
 * Compose a message as a tagged template, keeping each fragment's origin:
 * ``messageWithOperatorText`could not read ${operatorSuppliedText(path)}: ${detail}` ``.
 * Fixed spans and unmarked values take the escape; a marked value is rendered
 * as given. A message this function composed interpolates as its own spans
 * (as a {@link ../sensitiveFile.SensitiveFileLabel} does). The result reaches
 * the renderer only through {@link keepOperatorSuppliedText}.
 */
export function messageWithOperatorText(
  fixedSpans: TemplateStringsArray,
  ...values: ReadonlyArray<
    OperatorSuppliedText | MessageWithOperatorText | string | number
  >
): MessageWithOperatorText {
  const spans: DisplaySpan[] = [];
  const push = (text: string, operatorSupplied: boolean): void => {
    if (text !== "") spans.push({ text, operatorSupplied });
  };
  push(fixedSpans[0]!, false);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const composed = composedSpans(value);
    if (composed !== undefined) {
      for (const span of composed) push(span.text, span.operatorSupplied);
    } else {
      const supplied = operatorSuppliedValue(value);
      push(supplied ?? unmarkedText(value), supplied !== undefined);
    }
    push(fixedSpans[index + 1]!, false);
  }
  const message: MessageWithOperatorText = {
    text: spans.map((span) => span.text).join(""),
    spans,
  };
  Object.defineProperty(message, OPERATOR_SUPPLIED_SPANS, {
    value: spans,
    enumerable: false,
    configurable: true,
  });
  return message;
}

/**
 * An unmarked value's text: its own `text` where it has one, so a
 * message-shaped value {@link composedSpans} refuses does not render as
 * `[object Object]`, and the value as a string otherwise.
 */
function unmarkedText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const { text } = value as { text?: unknown };
    if (typeof text === "string") return text;
  }
  return String(value);
}

/**
 * The spans of a value {@link messageWithOperatorText} composed, told by its
 * own {@link OPERATOR_SUPPLIED_SPANS} property, or `undefined`. The shape is
 * checked as {@link operatorSuppliedSpans} checks it: own `text` and `spans`,
 * every span well-formed, and the spans joining back to `text`.
 */
function composedSpans(value: unknown): ReadonlyArray<DisplaySpan> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, OPERATOR_SUPPLIED_SPANS)) return undefined;
  if (!Object.hasOwn(value, "text") || !Object.hasOwn(value, "spans"))
    return undefined;
  const { text, spans } = value as Partial<MessageWithOperatorText>;
  if (typeof text !== "string" || !Array.isArray(spans)) return undefined;
  const checked: DisplaySpan[] = [];
  for (const span of spans as unknown[]) {
    if (typeof span !== "object" || span === null) return undefined;
    const { text: spanText, operatorSupplied } = span as Partial<DisplaySpan>;
    if (typeof spanText !== "string" || typeof operatorSupplied !== "boolean")
      return undefined;
    checked.push({ text: spanText, operatorSupplied });
  }
  return checked.map((span) => span.text).join("") === text
    ? checked
    : undefined;
}

/**
 * The spans of `message` where {@link messageWithOperatorText} composed it, and
 * otherwise its `text` as one span nobody marked, which the sink escapes.
 */
export function spansOfMessage(
  message: MessageWithOperatorText,
): ReadonlyArray<DisplaySpan> {
  return (
    composedSpans(message) ??
    (message.text === ""
      ? []
      : [{ text: message.text, operatorSupplied: false }])
  );
}

/**
 * The string inside an {@link OperatorSuppliedText}, or `undefined` for a
 * value with no mark. The key is module-private, so a mark another copy of
 * this module made is treated as no mark and stringifies to `[object Object]`.
 */
export function operatorSuppliedValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const held = (value as Record<symbol, unknown>)[OPERATOR_SUPPLIED_VALUE];
  return typeof held === "string" ? held : undefined;
}

/**
 * Mark `error` with the spans of the message its `message` was built from, so
 * {@link ./sanitizeErrorForDisplay.sanitizeErrorForDisplay} renders the
 * operator's spans as given; spans that do not join back to the message are
 * ignored. Returns `error`, left unmarked when no span is the operator's.
 */
export function keepOperatorSuppliedText<E extends Error>(
  error: E,
  message: MessageWithOperatorText,
): E {
  if (!message.spans.some((span) => span.operatorSupplied)) return error;
  Object.defineProperty(error, OPERATOR_SUPPLIED_SPANS, {
    value: message.spans,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/**
 * The spans {@link keepOperatorSuppliedText} left on `link` whose text joins
 * back to `message`, or `undefined`, so the message is escaped whole. Read by
 * shape, not identity: any well-shaped array under the registered symbol is
 * accepted, which trusts only code running in the process.
 */
export function operatorSuppliedSpans(
  link: unknown,
  message: string,
): ReadonlyArray<DisplaySpan> | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  // Own property only, so a prototype does not lend the mark.
  if (!Object.hasOwn(link, OPERATOR_SUPPLIED_SPANS)) return undefined;
  const marked = (link as Record<symbol, unknown>)[OPERATOR_SUPPLIED_SPANS];
  if (!Array.isArray(marked)) return undefined;
  const spans: DisplaySpan[] = [];
  for (const span of marked as unknown[]) {
    if (typeof span !== "object" || span === null) return undefined;
    const { text, operatorSupplied } = span as Partial<DisplaySpan>;
    if (typeof text !== "string" || typeof operatorSupplied !== "boolean")
      return undefined;
    spans.push({ text, operatorSupplied });
  }
  return spans.map((span) => span.text).join("") === message
    ? spans
    : undefined;
}
