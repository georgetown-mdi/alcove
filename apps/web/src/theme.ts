import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Container,
  Modal,
  Paper,
  Select,
  Tooltip,
  colorsTuple,
  createTheme,
  rem,
} from "@mantine/core";

import { STATUS_COLOURS } from "./styles/statusColours.ts";

import type {
  CSSVariablesResolver,
  MantineColorScheme,
  MantineThemeOverride,
} from "@mantine/core";

/**
 * A status colour: a name in the status table the colour lint rule holds
 * (STATUS_COLOURS in styles/statusColours.ts), each a
 * Mantine colour this theme paints from its --app-* token. The layer map:
 * docs/STATUS_COLOURS.md.
 */
export type StatusColour = keyof typeof STATUS_COLOURS;

const statusEntries = Object.entries(STATUS_COLOURS) as Array<
  [StatusColour, string]
>;

/**
 * The color scheme every `MantineProvider` and the documents' pre-paint
 * color-scheme script (utils/colorSchemeScript.ts) start from: the operating
 * system's setting. The app offers no control of its own.
 */
export const APP_COLOR_SCHEME: MantineColorScheme = "auto";

/**
 * True for a filled surface rendered in the primary color -- the default
 * (`filled`, no explicit `color`) Button / ActionIcon / Checkbox. Used to scope the
 * per-scheme contrast-text overrides below so they touch only the primary-filled
 * surfaces, leaving `default`/`subtle`/`light` variants and any future non-primary
 * filled surface on their own text color. See {@link FILLED_PRIMARY_CONTRAST}.
 */
const isFilledPrimary = (
  variant: string | undefined,
  color: string | undefined,
) => (variant === undefined || variant === "filled") && color === undefined;

/**
 * Route a filled-primary surface's text/icon color through Mantine's
 * per-scheme `--mantine-primary-color-contrast` variable instead of the
 * static white its own varsResolver emits.
 *
 * Mantine resolves a filled theme-color surface's text color
 * color-scheme-blind: the Button/ActionIcon/Checkbox `varsResolver`s call
 * the variant resolver with no color scheme, so `autoContrast` parses the
 * primary against its LIGHT shade and picks white for BOTH schemes, leaving
 * the dark filled-primary text at 2.79:1 on the brighter cyan-6 dark fill --
 * below the 1.4.3 floor. `--mantine-primary-color-contrast` is the one
 * value Mantine computes per scheme (white on light, black on dark), so
 * routing the filled-primary text through it yields 7.53:1 in dark while
 * staying byte-identical white in light. Each component names this color
 * through a different CSS variable, hence three near-identical overrides.
 *
 * Ratios enforced by test/unit/themeContrast.test.ts; rendered colors by
 * test/browser/themeContrast.test.ts.
 */
const FILLED_PRIMARY_CONTRAST = "var(--mantine-primary-color-contrast)";

const CONTAINER_SIZES = {
  xxs: rem("200px"),
  xs: rem("300px"),
  sm: rem("400px"),
  md: rem("500px"),
  lg: rem("600px"),
  xl: rem("1400px"),
  xxl: rem("1600px"),
};

/**
 * A named content width in the {@link CONTAINER_SIZES} scale: the single
 * vocabulary the content-width boundary between a route and the shell
 * speaks. A route declares one of these and the shell sizes both its chrome
 * and the route's content to it, so neither side names a raw pixel width.
 */
type ContainerWidth = keyof typeof CONTAINER_SIZES;

/**
 * The role an Alert takes when its call site sets none: a polite live region,
 * not Mantine's assertive `alert`.
 */
export const ALERT_DEFAULT_ROLE = "status";

/**
 * The role for an Alert whose color is chosen at runtime: an error interrupts
 * with `alert`; any other status takes {@link ALERT_DEFAULT_ROLE}.
 */
export function alertRoleFor(color: StatusColour): "alert" | undefined {
  return color === "error" ? "alert" : undefined;
}

export const mantineTheme: MantineThemeOverride = createTheme({
  fontSizes: {
    xs: rem("12px"),
    sm: rem("14px"),
    md: rem("16px"),
    lg: rem("18px"),
    xl: rem("20px"),
    "2xl": rem("24px"),
    "3xl": rem("30px"),
    "4xl": rem("36px"),
    "5xl": rem("48px"),
  },
  spacing: {
    "3xs": rem("4px"),
    "2xs": rem("8px"),
    xs: rem("10px"),
    sm: rem("12px"),
    md: rem("16px"),
    lg: rem("20px"),
    xl: rem("24px"),
    "2xl": rem("28px"),
    "3xl": rem("32px"),
  },
  primaryColor: "cyan",
  // One colour per status, every shade the status token: the light-variant
  // tints Mantine would derive from the shades are set by cssVariablesResolver.
  colors: Object.fromEntries(
    statusEntries.map(([status, token]) => [
      status,
      colorsTuple(`var(${token})`),
    ]),
  ),
  // Enabled so Mantine computes `--mantine-primary-color-contrast` per scheme (white
  // on the light cyan-9 fill, black on the dark cyan-6 fill), the variable the
  // filled-primary overrides below route their text/icon color to; without it that
  // variable is white in both schemes and the dark text fix would not hold.
  // autoContrast does NOT by itself recolor filled theme-color text per scheme -- see
  // FILLED_PRIMARY_CONTRAST above for why the overrides, not autoContrast, are the fix.
  autoContrast: true,
  // Honors the OS `prefers-reduced-motion` setting: Mantine skips
  // transition animations for components that read the flag (Collapse,
  // Transition, the Menu/Tooltip/Popover overlays), and arms the
  // `[data-respect-reduced-motion] [data-reduce-motion]` CSS rule for
  // components that opt in through that attribute. A disclosure using the
  // Collapse pattern keeps its toggle's aria-controls/focus target on an
  // always-mounted wrapper, never the Collapse panel itself, so a
  // reduced-motion user does not lose the target when the panel unmounts
  // (pinned by the reduced-motion render tests). Motion this flag does not
  // reach -- the hand-rolled chevron transitions, the Status progress bar's
  // `animated` stripe, and the Loader spinner -- gates on
  // useReducedMotion() directly at its own source.
  respectReducedMotion: true,
  // Per-scheme primary shade, each tuned to WCAG 2.1 AA (1.4.3 text 4.5:1,
  // 1.4.11 non-text 3:1) against its own surfaces; enforced by
  // test/unit/themeContrast.test.ts.
  //
  // Light is 9 (#0b7285): clears every primary use at 5.59:1 (white-on-fill
  // and fill-on-white). Its filled hover is FILLED_PRIMARY_HOVER (7.09:1).
  //
  // Dark is 6 (#15aabf): filled-primary text routes through
  // --mantine-primary-color-contrast (black on cyan-6, 7.53:1); the focus
  // ring and input focus border reach 5.57:1 / 4.87:1. No single shade
  // clears all three bars with plain white text, which is why the filled
  // text is routed through the contrast variable instead.
  primaryShade: { light: 9, dark: 6 },
  components: {
    // Filled-primary text/icon -> per-scheme contrast color (see
    // FILLED_PRIMARY_CONTRAST). Each names the color through its own CSS variable;
    // the merge keeps the rest of each component's vars (background, sizing).
    Button: Button.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--button-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    ActionIcon: ActionIcon.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--ai-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    Checkbox: Checkbox.extend({
      vars: (_, { variant, color }) => ({
        root: isFilledPrimary(variant, color)
          ? { "--checkbox-icon-color": FILLED_PRIMARY_CONTRAST }
          : {},
      }),
    }),
    Container: Container.extend({
      vars: (_, { size, fluid }) => ({
        root: {
          "--container-size": fluid
            ? "100%"
            : size !== undefined && size in CONTAINER_SIZES
              ? CONTAINER_SIZES[size as ContainerWidth]
              : rem(size),
        },
      }),
    }),
    Paper: Paper.extend({
      defaultProps: {
        p: "md",
        shadow: "xl",
        radius: "md",
        withBorder: true,
      },
    }),

    Card: Card.extend({
      defaultProps: {
        p: "xl",
        shadow: "xl",
        radius: "var(--mantine-radius-default)",
        withBorder: true,
      },
    }),
    Select: Select.extend({
      defaultProps: {
        checkIconPosition: "right",
      },
    }),
    Alert: Alert.extend({
      defaultProps: {
        role: ALERT_DEFAULT_ROLE,
        color: "info" satisfies StatusColour,
      },
    }),
    // A link inside a sentence must differ from its text by more than color
    // (WCAG 1.4.1), so every Anchor is underlined, not only on hover.
    Anchor: Anchor.extend({
      defaultProps: {
        underline: "always",
      },
    }),
    // The close button draws only an icon, so it takes its name here (WCAG
    // 4.1.2).
    Modal: Modal.extend({
      defaultProps: {
        closeButtonProps: { "aria-label": "Close" },
      },
    }),
    // A tooltip stays open while the pointer moves onto it (WCAG 1.4.13).
    Tooltip: Tooltip.extend({
      defaultProps: {
        interactive: true,
      },
    }),
  },
  other: {
    style: "mantine",
  },
});

/**
 * The light filled-primary hover fill, also painted while pressed on a touch
 * screen. Mantine's cyan-8 hover holds white text at 4.35:1, under 1.4.3's
 * 4.5:1; cyan-9 darkened by 15% holds it at 7.09:1, 1.27:1 from the resting
 * fill. Dark keeps Mantine's cyan-7 hover, black text at 6.12:1. Measured in
 * each state by test/browser/themeContrast.test.ts.
 */
const FILLED_PRIMARY_HOVER = {
  light: "#096171",
} as const;

/**
 * The share of a status token in the tint behind its `light` variant (an
 * Alert, a light Badge or Button), mixed over the --app-column work surface,
 * at rest and under the pointer. Mantine would derive the tint from the
 * colour's shades, which are all the token here. Every status text clears
 * 4.5:1 on both tints in both schemes, measured by
 * test/unit/themeContrast.test.ts and test/browser/themeContrast.test.ts.
 */
const STATUS_TINT_PERCENT = { rest: 10, hover: 15 } as const;

const statusTint = (token: string, percent: number) =>
  `color-mix(in srgb, var(${token}) ${percent}%, var(--app-column))`;

/** The `light`-variant tint variables of every status colour. */
const statusTintVariables = Object.fromEntries(
  statusEntries.flatMap(([status, token]) => [
    [
      `--mantine-color-${status}-light`,
      statusTint(token, STATUS_TINT_PERCENT.rest),
    ],
    [
      `--mantine-color-${status}-light-hover`,
      statusTint(token, STATUS_TINT_PERCENT.hover),
    ],
  ]),
);

/**
 * Points Mantine's secondary-text (`dimmed`), input `placeholder` and input
 * `error` colours at the status tokens and sets each status colour's
 * `light`-variant tint, in both color schemes, and sets the primary filled
 * hover to {@link FILLED_PRIMARY_HOVER} in the light scheme. Mantine
 * deep-merges this over the default resolver, so only the overridden variables
 * need be returned. Passed to `MantineProvider` in the root route.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => {
  const statusText = {
    "--mantine-color-dimmed": `var(${STATUS_COLOURS.secondary})`,
    "--mantine-color-placeholder": `var(${STATUS_COLOURS.secondary})`,
    "--mantine-color-error": `var(${STATUS_COLOURS.error})`,
  };
  return {
    variables: {},
    light: {
      ...statusText,
      ...statusTintVariables,
      "--mantine-color-cyan-filled-hover": FILLED_PRIMARY_HOVER.light,
    },
    dark: { ...statusText, ...statusTintVariables },
  };
};
