---
title: "Status Colours"
---

# Status colours

The web app paints every status - success, information, warning, error, and secondary text - from one table of colour tokens.
This page maps the three layers a status colour passes through, from the token to the component that shows it.
The colour lint rule's message links here.

## The statuses

| Status | Token | When it applies |
| --- | --- | --- |
| `success` | `--app-ok` | An operation finished or a check passed. |
| `info` | `--app-accent` | Something the operator should know that asks nothing of them. An Alert with no `color` takes it. |
| `warn` | `--app-warn` | Something the operator should look into or correct that is not a failure. |
| `error` | `--app-danger` | Something failed. An `error` Alert interrupts as an `alert` live region; every other status is a polite `status` region. |
| `secondary` | `--app-secondary` | Supporting text and neutral tags that report no status. `c="dimmed"` is the same colour. |

Warning and caution are one status, `warn`: no one sentence separated the two as the app used them.

## The layers

### Tokens

`apps/web/src/styles/tokens.css` holds each token's value for the light and the dark scheme.
A status token is tuned to WCAG 2.1 AA: its text clears 4.5:1 on the app's surfaces and on its own tint in both schemes.

### Theme

`apps/web/src/theme.ts` turns the table into Mantine colours:

- One Mantine colour per status, of the same name, every shade the status token.
- The tint behind a `light` variant (an Alert, a light Badge or Button) is the token mixed into `--app-column`, a stronger mix under the pointer.
- Mantine's `dimmed` and input placeholder colours are the `secondary` token, and its input `error` colour is the `error` token.

The table itself is `STATUS_COLOURS` in `apps/web/src/styles/statusColours.ts`, the data of the colour lint rule (`apps/web/eslint-rules/filled-primary-contrast-scope.mjs`); the theme's `StatusColour` type is the table's names.

### Component

A component names a status, never a palette colour, a shade, or a token:

```tsx
<Alert color="warn" title="...">...</Alert>
<Badge variant="light" color="secondary">advanced</Badge>
<Text c="error">...</Text>
<Text c="dimmed">...</Text>
```

The lint rule fails an Alert or Badge `color`, or any Mantine component's `c`, written as a string outside the table.
A colour chosen at runtime is typed `StatusColour`, which `alertRoleFor` and the wrappers that pass a colour to an Alert require.

## Checks

- The lint rule: `apps/web/eslint-rules/filled-primary-contrast-scope.mjs`, tested by `apps/web/test/unit/filledPrimaryContrastScope.test.ts`.
- The contrast arithmetic over every status, tint, and surface in both schemes: `apps/web/test/unit/themeContrast.test.ts`.
- The rendered colours: `apps/web/test/browser/themeContrast.test.ts`, and the route sweeps beside it.

A change to a token re-runs both contrast harnesses.

## Adding a status

Add the status and its token to `STATUS_COLOURS`, the token's light and dark values to `tokens.css`, a row to the table above, and its rendered colours to the browser harness.
