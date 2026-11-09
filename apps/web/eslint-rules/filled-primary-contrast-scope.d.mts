import type { Rule } from "eslint";

export { STATUS_COLOURS } from "../src/styles/statusColours.ts";

/** Mantine's own name for secondary text, allowed as a `c` value. */
export const SECONDARY_TEXT_ALIAS: "dimmed";

/** True when `value` names a status. */
export function isStatusColour(value: string): boolean;

/** True when `value` is a status or the secondary-text alias. */
export function isStatusTextColour(value: string): boolean;

/** The theme's filled-primary predicate, held equal to `isFilledPrimary` in
 * apps/web/src/theme.ts by the rule's unit test. */
export function isFilledPrimary(
  variant: string | undefined,
  color: string | undefined,
): boolean;

/** Audited secondary / status (variant, color) shapes the rule allows past the
 * filled-primary core. */
export const AUDITED_SECONDARY: ReadonlyArray<{
  variant: string;
  color: string | undefined;
}>;

/** True when a resolved (variant, color) pair is filled-primary or audited. */
export function isAudited(
  variant: string | undefined,
  color: string | undefined,
): boolean;

export const rule: Rule.RuleModule;

declare const plugin: { rules: Record<string, Rule.RuleModule> };
export default plugin;
