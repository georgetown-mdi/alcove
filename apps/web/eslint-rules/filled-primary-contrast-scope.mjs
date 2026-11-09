/**
 * Local ESLint rule guarding the web app's colour choices at authoring time.
 * It holds two tables, and docs/STATUS_COLOURS.md is the layer map behind them
 * (tokens, theme, component).
 *
 * Status colours. STATUS_COLOURS is the one table of status colours: each
 * status name maps to the --app-* token in apps/web/src/styles/tokens.css that
 * paints it, and apps/web/src/theme.ts builds a Mantine colour of the same name
 * from it. The table is this rule's data, kept in apps/web/src/styles so the
 * app's build reads it from its own source tree. An Alert or Badge `color`, and
 * any Mantine component's `c` prop, must name a status (or `dimmed`, Mantine's
 * name for the secondary-text colour, which the theme points at the secondary
 * token). A colour given as a non-literal expression is not judged here:
 * `alertRoleFor` and the wrappers that pass a colour to an Alert type it
 * `StatusColour`, and any other non-literal colour is unchecked.
 *
 * Filled-primary contrast. The theme routes a filled-primary Button / ActionIcon
 * / Checkbox's text and icon color through `--mantine-primary-color-contrast`
 * (FILLED_PRIMARY_CONTRAST) so it clears AA in both color schemes. That override
 * is scoped by the theme's `isFilledPrimary(variant, color)` predicate: it
 * reaches only the default (`filled`, no explicit `color`) surface. A surface
 * authored with an explicit `color` or a non-`filled` `variant` leaves that scope
 * and paints on its own color's shade with Mantine's color-scheme-blind text
 * pick, which can fall below the contrast floor without failing either the
 * arithmetic theme test or the render harness (neither samples call sites). Such
 * a surface passes only when its (variant, color) pair is one of the audited
 * secondary / status shapes below -- each a shape whose text does not ride the
 * primary fill (a `default` / `outline` / `subtle` control carries body text; a
 * `light` / `subtle` status control carries its status color's own AA-tuned
 * text).
 */

import { STATUS_COLOURS } from "../src/styles/statusColours.ts";

const SURFACES = new Set(["Button", "ActionIcon", "Checkbox"]);
const STATUS_SURFACES = new Set(["Alert", "Badge"]);
const MANTINE_MODULE = "@mantine/core";
const LAYER_MAP = "docs/STATUS_COLOURS.md";

export { STATUS_COLOURS };

/** Mantine's own name for secondary text, which the theme points at the
 * `secondary` status token; allowed as a `c` value beside the status names. */
export const SECONDARY_TEXT_ALIAS = "dimmed";

const STATUS_NAMES = new Set(Object.keys(STATUS_COLOURS));

/** True when `value` names a status, the colour an Alert / Badge `color` takes. */
export const isStatusColour = (value) => STATUS_NAMES.has(value);

/** True when `value` is an allowed `c` prop: a status or the secondary-text alias. */
export const isStatusTextColour = (value) =>
  isStatusColour(value) || value === SECONDARY_TEXT_ALIAS;

/**
 * The theme's filled-primary predicate, kept byte-identical to
 * `isFilledPrimary` in apps/web/src/theme.ts (the ESLint runtime cannot import
 * theme.ts, which pulls in @mantine/core, so the two are locked equal by the
 * rule's unit test rather than by a shared import).
 */
export const isFilledPrimary = (variant, color) =>
  (variant === undefined || variant === "filled") && color === undefined;

/**
 * Audited secondary / status (variant, color) shapes whose text does not ride
 * the primary fill, so they need no filled-primary contrast route. A `color` of
 * `undefined` means "no explicit color". Extend only with a shape whose text
 * clears WCAG AA on its own; never add a filled surface with a color (its text
 * would ride that color's fill, the exact scope this rule guards).
 */
export const AUDITED_SECONDARY = [
  { variant: "default", color: undefined },
  { variant: "outline", color: undefined },
  { variant: "subtle", color: undefined },
  { variant: "subtle", color: "error" },
  { variant: "light", color: undefined },
  { variant: "light", color: "error" },
];

/**
 * Classify one resolved (variant, color) pair: `true` if it is filled-primary or
 * an audited secondary shape (allowed), `false` if it leaves the guarded scope.
 */
export const isAudited = (variant, color) =>
  isFilledPrimary(variant, color) ||
  AUDITED_SECONDARY.some(
    (shape) => shape.variant === variant && shape.color === color,
  );

/**
 * The set of string values an attribute's JSX value can take, or `undefined`
 * when it cannot be resolved to string literals (a non-literal expression).
 * An absent attribute is caller-supplied as the single value `undefined`.
 */
function resolvableValues(node) {
  if (node === null) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return [node.value];
  }
  if (node.type === "JSXExpressionContainer") {
    return resolvableValues(node.expression);
  }
  if (node.type === "ConditionalExpression") {
    const consequent = resolvableValues(node.consequent);
    const alternate = resolvableValues(node.alternate);
    if (consequent === undefined || alternate === undefined) return undefined;
    return [...consequent, ...alternate];
  }
  return undefined;
}

const UNSCOPED_MESSAGE =
  "This {{name}} leaves the filled-primary contrast scope (isFilledPrimary in " +
  "apps/web/src/theme.ts): its text no longer routes through " +
  "FILLED_PRIMARY_CONTRAST and can fall below WCAG AA. Keep it filled-primary " +
  "(drop the explicit color / non-filled variant), or use one of the audited " +
  "secondary shapes. A new secondary/status shape whose text clears AA on its " +
  "own goes in AUDITED_SECONDARY in " +
  "apps/web/eslint-rules/filled-primary-contrast-scope.mjs.";

const OFF_TABLE_MESSAGE =
  '{{name}} {{attribute}}="{{value}}" is not a status colour. Use one of ' +
  "{{allowed}}; " +
  `${LAYER_MAP} says which status applies when and where its token lives.`;

/** @type {import("eslint").Rule.RuleModule} */
export const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep a primary-action Button / ActionIcon / Checkbox inside the theme's filled-primary WCAG-AA contrast scope, and every Alert / Badge colour and `c` prop on the status colour table.",
    },
    schema: [],
    messages: { unscoped: UNSCOPED_MESSAGE, offTable: OFF_TABLE_MESSAGE },
  },
  create(context) {
    const mantineNames = new Map();
    const reportOffTable = (name, attr, allowed, isAllowed) => {
      const values = resolvableValues(attr.value);
      if (values === undefined) return;
      for (const value of values) {
        if (isAllowed(value)) continue;
        context.report({
          node: attr,
          messageId: "offTable",
          data: {
            name,
            attribute: attr.name.name,
            value,
            allowed: allowed.join(", "),
          },
        });
      }
    };
    return {
      ImportDeclaration(node) {
        if (node.source.value !== MANTINE_MODULE) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            mantineNames.set(spec.local.name, spec.imported.name);
          }
        }
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const name = node.name.name;
        const imported = mantineNames.get(name);
        if (imported === undefined) return;

        let variantAttr;
        let colorAttr;
        let textColorAttr;
        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name.name === "variant") variantAttr = attr;
          if (attr.name.name === "color") colorAttr = attr;
          if (attr.name.name === "c") textColorAttr = attr;
        }

        if (textColorAttr !== undefined) {
          reportOffTable(
            name,
            textColorAttr,
            [...STATUS_NAMES, SECONDARY_TEXT_ALIAS],
            isStatusTextColour,
          );
        }
        if (STATUS_SURFACES.has(imported) && colorAttr !== undefined) {
          reportOffTable(name, colorAttr, [...STATUS_NAMES], isStatusColour);
        }

        if (!SURFACES.has(imported)) return;
        if (variantAttr === undefined && colorAttr === undefined) return;

        const variants =
          variantAttr === undefined
            ? [undefined]
            : resolvableValues(variantAttr.value);
        const colors =
          colorAttr === undefined
            ? [undefined]
            : resolvableValues(colorAttr.value);

        const unresolved = variants === undefined || colors === undefined;
        const escapes =
          unresolved ||
          variants.some((variant) =>
            colors.some((color) => !isAudited(variant, color)),
          );
        if (escapes) {
          context.report({
            node,
            messageId: "unscoped",
            data: { name },
          });
        }
      },
    };
  },
};

export default {
  rules: { "filled-primary-contrast-scope": rule },
};
