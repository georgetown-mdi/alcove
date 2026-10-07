import {
  keepFirstPartyLineBreaks,
  MAX_ERROR_CAUSE_DEPTH,
  redactPrivateKeyMaterial,
  renderedDisplayCostKeepingLineBreaks,
} from "./sanitizeErrorForDisplay";
import {
  clipToRenderedCost,
  clipToRenderedCostKeepingEnd,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  replaceControlCharactersForDisplay,
} from "./sanitizeForDisplay";

declare const partnerOriginBrand: unique symbol;

/**
 * One string whose bytes the partner chose, as it leaves a wire-frame decode. Not
 * assignable to `string`, so assignment, `+`, template interpolation and (on the
 * list) `join` are compile errors; {@link errorWithPartnerCauseLinks} is the one
 * way out, and a second way out removes the guarantee. `String(value)` and
 * `.toString()` still compile (pinned by `test/utils/partnerOriginText.test.ts`).
 * The brand is over `symbol`, since a `string`-based brand leaves `+` and
 * interpolation compiling. A schema-pinned protocol token is not branded.
 * Design: docs/spec/CHANNEL_SECURITY.md, Display sanitization escape format.
 */
export type PartnerOriginText = symbol & {
  readonly [partnerOriginBrand]: "one";
};

/**
 * An ordered list of {@link PartnerOriginText} (the terms exchange's abort
 * reasons). Not `readonly PartnerOriginText[]`, whose `join` would compile.
 */
export type PartnerOriginTextList = symbol & {
  readonly [partnerOriginBrand]: "many";
};

/**
 * Brand one decoded string as partner-chosen. Call at the decode chokepoint (a
 * wire schema's `.transform`, or the read off a stream another party fills),
 * never at a consumer.
 */
export const partnerOriginText = (value: string): PartnerOriginText =>
  value as unknown as PartnerOriginText;

/** {@link partnerOriginText} for a wire field holding several values. */
export const partnerOriginTextList = (
  values: readonly string[],
): PartnerOriginTextList => values as unknown as PartnerOriginTextList;

/** What one whole cause link may render to: the renderer's per-link cap. */
const PARTNER_LINK_BUDGET = COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH;

/**
 * What the label before each value may render to: a floor under the values' room,
 * so no label can spend a value's budget or push a link past
 * {@link PARTNER_LINK_BUDGET}. A longer label is clipped visibly.
 */
const PARTNER_LABEL_BUDGET = 64;

/** What one partner value may render to, the per-value budget every chooser's
 * fragment is fitted to. */
const PARTNER_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * What one labelled value may render to, label included; exported so a site can
 * assert its link's cost against the number the composition uses.
 */
export const PARTNER_LABELLED_VALUE_BUDGET =
  PARTNER_LABEL_BUDGET + PARTNER_VALUE_BUDGET;

/**
 * The separator between labelled values on one link. No value can forge it: each
 * value is control-replaced before packing, and the link is marked with its lines
 * ({@link keepFirstPartyLineBreaks}), so every line the renderer emits opens
 * on a first-party label, and none on the renderer's `caused by: ` boundary.
 */
const PARTNER_VALUE_SEPARATOR = "\n";

/**
 * How many labelled values one link holds whole (three at today's budgets).
 * Packing, rather than a link per value, keeps a real terms refusal (eighteen
 * reason sites) inside the renderer's {@link MAX_ERROR_CAUSE_DEPTH}. Derived so
 * the renderer's per-link clip never cuts a link built here; the floor of one
 * covers a budget no single value fits.
 */
const PARTNER_VALUES_PER_LINK = Math.max(
  1,
  Math.floor(
    (PARTNER_LINK_BUDGET +
      renderedDisplayCostKeepingLineBreaks(PARTNER_VALUE_SEPARATOR)) /
      (PARTNER_LABEL_BUDGET +
        PARTNER_VALUE_BUDGET +
        renderedDisplayCostKeepingLineBreaks(PARTNER_VALUE_SEPARATOR)),
  ),
);

/**
 * How many values reach the operator before the counted tail link: every link
 * the renderer's depth admits, less the first-party message and the tail. Sized
 * to show a whole terms refusal (eighteen reason sites), not by the wire's
 * `MAX_ABORT_REASONS`.
 */
export const MAX_PARTNER_VALUES_SHOWN =
  PARTNER_VALUES_PER_LINK * (MAX_ERROR_CAUSE_DEPTH - 2);

/**
 * The first-party text opening one value: its 1-based position, then the label,
 * fitted to {@link PARTNER_LABEL_BUDGET}. The position keeps any two links
 * distinct, so the renderer's suppression of a repeated link cannot drop a
 * repeated partner value uncounted; it leads so a label clip cannot cut it. The
 * scalar form takes {@link bareLabel}.
 */
const positionedLabel = (label: string, position: number): string =>
  clipToRenderedCost(`${position}. ${label}`, PARTNER_LABEL_BUDGET);

/** {@link positionedLabel} for the scalar form: the call site's label alone. */
const bareLabel = (label: string): string =>
  clipToRenderedCost(label, PARTNER_LABEL_BUDGET);

/**
 * One value as it sits on a link: the label, then the value redacted,
 * control-replaced and fitted to {@link PARTNER_VALUE_BUDGET}, kept raw for the
 * sink's single escape. Redaction runs before the clip, so a `BEGIN` marker left
 * in a clipped prefix cannot consume the truncation marker; control replacement
 * runs before the fit. Every value has its own label, so a value spelling the
 * separator still cannot open a labelled line. `keep` moves only the clip.
 */
const labelledValue = (
  label: string,
  value: string,
  keep: PartnerValueWindow,
): string => {
  const treated = replaceControlCharactersForDisplay(
    redactPrivateKeyMaterial(value),
  );
  return `${label}${
    keep === "end"
      ? clipToRenderedCostKeepingEnd(treated, PARTNER_VALUE_BUDGET)
      : clipToRenderedCost(treated, PARTNER_VALUE_BUDGET)
  }`;
};

/**
 * The first-party link closing a chain that hit {@link MAX_PARTNER_VALUES_SHOWN},
 * counting the values it left out, which the renderer's elision marker cannot.
 */
const elidedValuesLink = (count: number): string =>
  count === 1
    ? "1 further value the partner sent is not shown"
    : `${count} further values the partner sent are not shown`;

/** Which window of an over-budget value survives the fit. */
export type PartnerValueWindow = "start" | "end";

/** What a call site may vary about {@link errorWithPartnerCauseLinks}. */
export interface PartnerCauseLinkOptions {
  /**
   * Which window of an over-budget value the operator is shown. Defaults to
   * `"start"`; `"end"` is for a value whose last bytes are the diagnosis (a
   * process's retained output). Redaction and control replacement still run
   * over the whole value.
   */
  readonly keep?: PartnerValueWindow;
}

/**
 * The one way out of {@link PartnerOriginText}: an `Error` whose message is the
 * first-party `message` alone and whose `cause` chain holds the partner's values
 * in order, each labelled and fitted, packed {@link PARTNER_VALUES_PER_LINK} to a
 * link. Returns the `Error`, not text, so no composition site can place a partner
 * byte in a message. Past {@link MAX_PARTNER_VALUES_SHOWN} a final link counts
 * what is not shown. An empty list yields the bare first-party `Error`.
 */
export function errorWithPartnerCauseLinks(
  message: string,
  label: string,
  partnerText: PartnerOriginText | PartnerOriginTextList,
  options?: PartnerCauseLinkOptions,
): Error {
  const raw = partnerText as unknown as string | readonly string[];
  const scalar = typeof raw === "string";
  const values = scalar ? [raw] : raw;
  const keep = options?.keep ?? "start";
  const links: string[][] = [];
  const shown = Math.min(values.length, MAX_PARTNER_VALUES_SHOWN);
  for (let i = 0; i < shown; i += PARTNER_VALUES_PER_LINK) {
    const packed: string[] = [];
    for (let j = i; j < Math.min(i + PARTNER_VALUES_PER_LINK, shown); j++)
      packed.push(
        labelledValue(
          scalar ? bareLabel(label) : positionedLabel(label, j + 1),
          values[j]!,
          keep,
        ),
      );
    links.push(packed);
  }
  if (values.length > shown)
    links.push([elidedValuesLink(values.length - shown)]);
  let cause: Error | undefined;
  for (let i = links.length - 1; i >= 0; i--) {
    const lines = links[i]!;
    const text = lines.join(PARTNER_VALUE_SEPARATOR);
    cause = keepFirstPartyLineBreaks(
      cause === undefined ? new Error(text) : new Error(text, { cause }),
      lines,
    );
  }
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}
