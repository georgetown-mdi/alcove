import { snakeizeKey } from "../utils/camelizeKeys.js";
import { holdsPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";

/**
 * The most parameters one step may declare, and the most the consent summary
 * shows per step, so the summary never states a count where the run applies
 * values. Far below `MAX_PARAMS_ENTRIES` (`linkageTermsSchema.ts`).
 */
export const MAX_DISPLAYED_PARAMS = 16;

/**
 * The parameters a step declares, in declaration order, for both the count
 * refusal and the consent summary. An own key whose value is `undefined`
 * counts; a `params` that is not a plain object declares none.
 */
export function declaredParamEntries(
  params: unknown,
): Array<[string, unknown]> {
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return [];
  return Object.entries(params);
}

/**
 * A transform parameter value as display text: primitives in plain form,
 * anything else JSON-encoded, `""` when that throws. The caller sanitizes and
 * bounds the result.
 */
export function describeTransformParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * The `key: value` line the consent summary shows for one parameter, shared
 * so a refusal judges the characters the display sanitizer reads. The key is
 * in its snake_case document spelling, except a key holding private key
 * material, which keeps its authored spelling so the redaction still matches
 * it. A line too long for the engine renders `""`, so the RangeError cannot
 * escape `safeParse`. See
 * docs/spec/CHANNEL_SECURITY.md#transform-parameter-declared-types.
 */
export function describedTransformParamEntry(
  param: string,
  value: unknown,
): string {
  const rendered = describeTransformParamValue(value);
  try {
    const key = holdsPrivateKeyMaterial(param) ? param : snakeizeKey(param);
    return `${key}: ${rendered}`;
  } catch {
    return "";
  }
}

/**
 * Refusal message for a `null_if` step declaring both `value` and `values`;
 * the run applies only `values` (`nullIfFactory`, `standardization.ts`).
 */
export const NULL_IF_BOTH_VALUE_PARAMS_MESSAGE =
  "null_if must declare value or values, not both";

/**
 * Refusal message for a parameter whose displayed line the private-key
 * redaction would replace. Like the two below, it echoes no part of the
 * offending text; the issue path locates it.
 */
export const PRIVATE_KEY_PARAM_MESSAGE =
  "a transform param must not contain private key material";

/** Refusal message for a function name the redaction would replace. */
export const PRIVATE_KEY_FUNCTION_MESSAGE =
  "a transform function name must not contain private key material";

/** Refusal message for a parameter name the redaction would replace. */
export const PRIVATE_KEY_PARAM_NAME_MESSAGE =
  "a transform param name must not contain private key material";

/** Refusal message for a step declaring more parameters than are displayed. */
export const TRANSFORM_PARAM_COUNT_MESSAGE = `a transform step must not declare more than ${MAX_DISPLAYED_PARAMS} params`;

/** What the calling schema already refuses, so the scan here can skip it. */
export interface TransformParamDisplayOptions {
  /**
   * The length past which the caller refuses a string param, or `undefined`
   * where it bounds none. The key-material scan skips such a string, whose
   * rendering would cost work linear in its length.
   */
  refusesStringParamsPast: number | undefined;
}

/** One parameter shape a consent summary cannot state as the run applies it. */
export interface TransformParamDisplayRefusal {
  /** Path to the offending value, relative to the step. */
  path: Array<string | number>;
  /** The fixed message stating which shape was declared. */
  message: string;
}

/**
 * Every shape of `step` a consent summary would state as something other
 * than what the run applies; empty when the summary states it as it runs.
 * An over-count step yields no per-parameter refusal, which keeps the issues
 * one step raises bounded
 * (docs/spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds).
 * Lookups are own-property only, since names are partner-authored. See
 * docs/spec/CHANNEL_SECURITY.md#transform-parameter-declared-types.
 */
export function transformParamDisplayRefusals(
  step: {
    function: string;
    params?: Record<string, unknown>;
  },
  options: TransformParamDisplayOptions,
): TransformParamDisplayRefusal[] {
  const refusals: TransformParamDisplayRefusal[] = [];
  if (holdsPrivateKeyMaterial(step.function))
    refusals.push({
      path: ["function"],
      message: PRIVATE_KEY_FUNCTION_MESSAGE,
    });
  const params = step.params;
  // Repeats the guard in declaredParamEntries to narrow `params`.
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return refusals;
  const entries = declaredParamEntries(params);
  if (entries.length > MAX_DISPLAYED_PARAMS) {
    refusals.push({ path: ["params"], message: TRANSFORM_PARAM_COUNT_MESSAGE });
    return refusals;
  }
  // An undefined value is not declared, matching how `nullIfFactory` reads it.
  const declares = (param: string): boolean =>
    Object.hasOwn(params, param) && params[param] !== undefined;
  if (step.function === "null_if" && declares("value") && declares("values"))
    refusals.push({
      path: ["params"],
      message: NULL_IF_BOTH_VALUE_PARAMS_MESSAGE,
    });
  for (const [param, value] of entries) {
    // Scanned apart from the line, so the length skip below cannot skip a name.
    if (holdsPrivateKeyMaterial(param)) {
      refusals.push({
        path: ["params", param],
        message: PRIVATE_KEY_PARAM_NAME_MESSAGE,
      });
      continue;
    }
    // Only a string value is length-bounded by the caller; key material nested
    // in a list entry is scanned however long the entry is.
    if (
      typeof value === "string" &&
      options.refusesStringParamsPast !== undefined &&
      value.length > options.refusesStringParamsPast
    )
      continue;
    if (holdsPrivateKeyMaterial(describedTransformParamEntry(param, value)))
      refusals.push({
        path: ["params", param],
        message: PRIVATE_KEY_PARAM_MESSAGE,
      });
  }
  return refusals;
}
