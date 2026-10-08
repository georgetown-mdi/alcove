import { z } from "zod";

/**
 * A string length ceiling counted in UTF-16 code units (`value.length`), the
 * unit every length bound on partner-supplied content counts, as the
 * hand-written predicates sharing these ceilings do (`payloadExchange.ts`,
 * `overlongDisclosedColumnPositions`). Zod's `.max()` counts code points from
 * 4.5.0 on, so this replaces it on every string bound;
 * `test/config/lengthBoundUnitParity.test.ts` keeps the two sides in step and
 * `eslint.boundaries.mjs` refuses a bare bound.
 *
 * It is Zod's own `max_length` check with the comparison replaced, so the
 * issue, its text, and a non-string value's handling are Zod's
 * (`test/utils/maxCodeUnits.test.ts`). A named `message` goes in the check's
 * `error` rather than the pushed issue, so its keys serialize in the order
 * `.max(n, { message })` produces.
 */
export const maxCodeUnits = (
  maximum: number,
  message?: string | ((issue: z.core.$ZodRawIssue) => string),
): z.core.$ZodCheck<string> => {
  const check = new z.core.$ZodCheckMaxLength({
    check: "max_length",
    maximum,
    ...(message === undefined
      ? {}
      : { error: typeof message === "string" ? () => message : message }),
  });
  const zodLengthComparison = check._zod.check;
  check._zod.check = (payload) => {
    if (typeof payload.value !== "string") {
      zodLengthComparison(payload);
      return;
    }
    if (payload.value.length <= maximum) return;
    payload.issues.push({
      origin: "string",
      code: "too_big",
      maximum,
      inclusive: true,
      input: payload.value,
      continue: true,
      inst: check,
    });
  };
  return check;
};
