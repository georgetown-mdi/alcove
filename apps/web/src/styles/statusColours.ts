/**
 * The status colour table: status name -> the --app-* token in tokens.css that
 * paints it. The colour lint rule
 * (eslint-rules/filled-primary-contrast-scope.mjs) holds every Alert, Badge and
 * `c` colour to these names, and theme.ts makes one Mantine colour per entry.
 * The layer map: docs/STATUS_COLOURS.md.
 */
export const STATUS_COLOURS = {
  success: "--app-ok",
  info: "--app-accent",
  warn: "--app-warn",
  error: "--app-danger",
  secondary: "--app-secondary",
} as const;
