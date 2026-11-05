---
title: "Accessibility Self-Assessment"
---

# Accessibility self-assessment

This document maps each WCAG 2.1 Level A and Level AA success criterion to the evidence the project holds for the public web application.
It is a self-assessment record kept by the project.
It is not a conformance claim, an audit, or a Voluntary Product Accessibility Template (VPAT).
The screen-reader passes and the VPAT come after the 1.0 release ([ROADMAP.md](ROADMAP.md)).

## Scope

The assessment covers the public web application (`apps/web`, hosted build) and every screen it serves.
Screens the console shares with the web application are covered, because the code is shared.
The console's own screens (its working-folder, SFTP, and run views) are out of scope.

## How to read the mapping

Each criterion has one of four kinds of evidence:

- **Test**: a test that existed before this assessment decides the criterion, or the part of it a machine can decide.
- **New check**: a check added with this assessment. Each one fails when the property it holds regresses.
- **Judgment**: a written reason, for a criterion no check can decide. A judgment names the code or test it rests on.
- **Not applicable**: the app has none of the content the criterion governs. Where that claim is about code, a source check holds it.

Automated checks find only part of what a criterion asks.
A passing check is evidence for the criterion, not proof that a person using assistive technology can complete the task.

Test paths below are relative to `apps/web/test/` unless they start with `apps/`.

## Screens and states

The browser checks mount every route the router declares, at the states `browser/routeStates.ts` lists, and fail when a declared route has no state.
The keyboard-only journeys reach the states that need a run, and scan each one.

| Screen | States checked | Reached by |
| --- | --- | --- |
| Home (`/`) | no saved exchanges; a saved exchange | route states |
| Start page (`/quick`) | landing | route states |
| Create an invitation (`/exchange`) | your file; matching and sharing; review; invitation ready; result; failed run | route states, invite journey |
| Accept an invitation (`/accept`) | terms review; unreadable invitation; consent and your file; columns; result | route states, accept journey |
| Verify an exchange record (`/verify`) | nothing loaded; record and keys loaded; verified; failed verdict | route states, verify journey |
| Quick exchange (`/direct`) | not offered by this deployment | route states |
| Recurring exchanges (`/saved`) | a saved exchange | route states |
| A recurring exchange (`/saved/$id`) | ready to run; recorded runs and a relay; on a schedule; not stored; after saving from an accepted exchange | route states, accept journey |
| Page not found | an address no route matches | route states |
| Confirm dialogs | open, then closed with Escape | `browser/dialogKeyboard.test.ts` |

## The checks

| Check | What it decides | Where |
| --- | --- | --- |
| axe-core, WCAG 2.1 A and AA rules | the rules axe tags for each criterion, run over the mounted page | `browser/axeScan.ts`, run by `browser/accessibilityRuleScan.test.ts` and the three keyboard journeys |
| In-house rule scan | unique ids, resolving references, named controls and images, nesting, tab order, heading order, list structure, one h1 and one main landmark per page | `browser/accessibilityRules.ts`, run with axe |
| Contrast sweep | every rendered text element against the AA floor, light and dark schemes | `browser/contrastSweep.ts`, `browser/themeContrastSweep.test.ts`, `browser/verifyReceiptContrast.test.ts` |
| Theme contrast | filled controls, glyphs, checkmark, status tokens, dropzone border | `browser/themeContrast.test.ts`, `unit/themeContrast.test.ts` |
| Keyboard-only journeys | invite, accept, verify, and recurring setup by Tab, Enter, and Space alone; where focus lands; a focus indicator at every Tab stop | `browser/keyboardInviteJourney.test.ts`, `browser/keyboardAcceptJourney.test.ts`, `browser/keyboardVerifyJourney.test.ts`, `browser/keyboardOnly.ts` |
| Focus indicator | the journeys' focus-indicator check against fixtures | `browser/focusIndicator.test.ts` |
| Reflow and text spacing | no content past the viewport edge and no clipped text, at 320 CSS pixels and under the WCAG text-spacing overrides | `browser/reflowChecks.ts`, `browser/reflow.test.ts`, `browser/textSpacing.test.ts` |
| Hover and focus content | tooltips dismiss with Escape and take the pointer | `browser/hoverContent.test.ts` |
| Dialogs | a confirm opened from the keyboard holds focus, passes both scans, and closes with Escape back to its trigger | `browser/dialogKeyboard.test.ts` |
| Source checks | page titles, page language, zoom, and what the app does not have (media, shortcuts, motion input, dialogs Escape cannot close) | `unit/wcagSourceChecks.test.ts` |

axe runs inside the mounted page, not the whole document, because the test runner owns the document.
The document-level facts axe would check there (title, language, viewport) are read from source by `unit/wcagSourceChecks.test.ts` instead.

## Principle 1: Perceivable

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | The rule scan's `image-name` and `control-name` rules and axe's `image-alt`, `svg-img-alt`, and `role-img-alt` on every state. Decorative icons are `aria-hidden`; badges that carry meaning have a text name. | Test |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | The app has no audio or video. `unit/wcagSourceChecks.test.ts` fails if an `audio` or `video` element is added. | Not applicable |
| 1.2.2 Captions (Prerecorded) | A | No audio or video, as 1.2.1. | Not applicable |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | No audio or video, as 1.2.1. | Not applicable |
| 1.2.4 Captions (Live) | AA | No live audio or video. | Not applicable |
| 1.2.5 Audio Description (Prerecorded) | AA | No audio or video, as 1.2.1. | Not applicable |
| 1.3.1 Info and Relationships | A | The rule scan's `duplicate-id`, `broken-reference`, `heading-skip`, and `list-children` rules; axe's list, definition-list, ARIA parent and child, and table rules; `browser/inputDescriptionA11y.test.ts` for option descriptions. | Test |
| 1.3.2 Meaningful Sequence | A | Judgment: the DOM order is the reading order. The layout places columns with CSS grid in source order, and at a narrow width the share bar comes first in both the DOM and the view. The keyboard journeys move through each screen in that order. | Judgment |
| 1.3.3 Sensory Characteristics | A | Judgment: instructions name a control by its label ("use the Customize list in the This exchange panel"), never by shape, color, position, or sound alone. | Judgment |
| 1.3.4 Orientation | AA | `unit/wcagSourceChecks.test.ts` fails on an orientation lock in the code or the web app manifest. | New check |
| 1.3.5 Identify Input Purpose | AA | Judgment: the one field about the user, "Your name or agency", takes either a person's name or an organization's, so no single input purpose from the WCAG list applies to it. The relay registration secret is a shared credential, not the user's own password. | Judgment |
| 1.4.1 Use of Color | A | axe's `link-in-text-block` on every state, which found links in body text marked by color alone; every link is underlined (`apps/web/src/theme.ts`). Status lines and alerts state their meaning in text and icon as well as color. | New check |
| 1.4.2 Audio Control | A | The app plays no audio (`unit/wcagSourceChecks.test.ts`). | Not applicable |
| 1.4.3 Contrast (Minimum) | AA | The contrast sweep over every state in both schemes, `browser/verifyReceiptContrast.test.ts` for the verify screen's loaded states, the theme contrast tests, and axe's `color-contrast`. | Test |
| 1.4.4 Resize Text | AA | `browser/reflow.test.ts` at 320 CSS pixels, the width of a 1280-pixel window zoomed to 400%; `unit/wcagSourceChecks.test.ts` holds a viewport setting that leaves zoom on. | New check |
| 1.4.5 Images of Text | AA | Judgment: the app shows no images of text. The wordmark is text and the icons are glyphs. | Judgment |
| 1.4.10 Reflow | AA | `browser/reflow.test.ts`, which found the step buttons clipping their labels at 320 pixels; their labels wrap (`apps/web/src/styles/app.module.css`, `.workFoot`). A code block with a long line scrolls on its own, and is a tab stop so the keyboard can scroll it. | New check |
| 1.4.11 Non-text Contrast | AA | The theme contrast tests for the checkmark, action-icon glyphs, dropzone border, and the focus ring and focused input border colors. Resting field borders take `--app-field-border` (`apps/web/src/styles/app.module.css`), which no rendered test measures (see [Open gaps](#open-gaps)). | Test |
| 1.4.12 Text Spacing | AA | `browser/textSpacing.test.ts` applies the WCAG spacing overrides to every state; axe's `avoid-inline-spacing`. | New check |
| 1.4.13 Content on Hover or Focus | AA | `browser/hoverContent.test.ts`: a tooltip closes on Escape and takes the pointer, from the theme default (`apps/web/src/theme.ts`). | New check |

## Principle 2: Operable

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | The keyboard-only journeys complete invite, accept, verify, and recurring setup without the pointer; axe's `scrollable-region-focusable`, which found a code block only the pointer could scroll. | Test |
| 2.1.2 No Keyboard Trap | A | `browser/dialogKeyboard.test.ts`: Escape leaves a confirm dialog and focus returns to its trigger. `unit/wcagSourceChecks.test.ts` fails on a dialog that turns Escape off. The journeys tab past every stop on each screen. | New check |
| 2.1.4 Character Key Shortcuts | A | The app defines no keyboard shortcuts (`unit/wcagSourceChecks.test.ts`). | Not applicable |
| 2.2.1 Timing Adjustable | A | Judgment: the inviter chooses how long an invitation lasts, up to a year, before it is sent. The wait for the partner is bounded at 10 minutes on a live exchange between two parties, and a failed run offers Try again without losing the setup (`browser/keyboardInviteJourney.test.ts`). | Judgment |
| 2.2.2 Pause, Stop, Hide | A | Judgment: the only motion is a run's spinner and progress stripes, shown only while the run is live, which is the content the user waits on. Both stop when the run ends and under the reduced-motion setting (`apps/web/src/styles/app.module.css`). | Judgment |
| 2.3.1 Three Flashes or Below Threshold | A | Judgment: nothing flashes. The spinner turns once every 0.9 seconds with no change in brightness. | Judgment |
| 2.4.1 Bypass Blocks | A | The rule scan's `page-main` rule holds one main landmark per page; the exchange screens' top bar is a named navigation landmark. | New check |
| 2.4.2 Page Titled | A | `unit/wcagSourceChecks.test.ts` requires a title on every route; it found the recurring exchange page without one. | New check |
| 2.4.3 Focus Order | A | The rule scan's `positive-tabindex` rule; the journeys assert where focus lands at each step; `browser/useOpenCloseFocus.test.ts`; `browser/dialogKeyboard.test.ts`. | Test |
| 2.4.4 Link Purpose (In Context) | A | The rule scan's `control-name` rule and axe's `link-name`. A link that opens a new tab says so in its name. | Test |
| 2.4.5 Multiple Ways | AA | `browser/accessibilityRuleScan.test.ts`: the start page links to the verify and recurring exchange pages, which no exchange step leads to. Every other page is a step of an exchange, which the criterion excepts. | New check |
| 2.4.6 Headings and Labels | AA | The rule scan's `page-h1`, `heading-skip`, and `control-name` rules. That each heading and label describes its topic is a judgment the review of each screen makes. | Test |
| 2.4.7 Focus Visible | AA | Every element a Tab press focuses in the journeys must look different while focused (`browser/keyboardOnly.ts`, held against fixtures by `browser/focusIndicator.test.ts`). | New check |
| 2.5.1 Pointer Gestures | A | Judgment: no control needs a path or multipoint gesture. The file drop target also opens a file chooser, which the journeys reach by Tab. | Judgment |
| 2.5.2 Pointer Cancellation | A | Judgment: controls act on click, when the pointer is released. The one down-event handler, on the number field's step buttons, only keeps focus in the field (`apps/web/src/components/NamedStepNumberInput.tsx`). | Judgment |
| 2.5.3 Label in Name | A | axe's `label-content-name-mismatch`, enabled in `browser/axeScan.ts`. | New check |
| 2.5.4 Motion Actuation | A | No device motion or orientation input (`unit/wcagSourceChecks.test.ts`). | Not applicable |

## Principle 3: Understandable

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 3.1.1 Language of Page | A | `unit/wcagSourceChecks.test.ts`: each document declares `lang="en"`. | New check |
| 3.1.2 Language of Parts | AA | Judgment: the interface is English throughout. Text a partner supplies, such as an agency name or column label, is shown as data in whatever language the partner wrote it, which the app cannot know. | Judgment |
| 3.2.1 On Focus | A | Judgment: focus never navigates or submits. The journeys tab across every stop of each screen, and would leave the screen if one did. | Judgment |
| 3.2.2 On Input | A | Judgment: choosing a file or an option updates the current step in place. A step changes only when the user presses its Continue button. | Judgment |
| 3.2.3 Consistent Navigation | AA | Judgment: every exchange screen draws its top bar (wordmark, steps, Help) and the site footer from the same components (`apps/web/src/exchange/TopBar.tsx`, `apps/web/src/components/SiteFooter.tsx`), in the same order. | Judgment |
| 3.2.4 Consistent Identification | AA | Judgment: a function shared across screens comes from one component with one name, such as the copy button (`apps/web/src/components/CopyableCode.tsx`) and the confirm button (`apps/web/src/components/ConfirmedActionButton.tsx`). | Judgment |
| 3.3.1 Error Identification | A | `browser/alertRole.test.ts` (an error is announced as an alert); `browser/failureReportedCause.test.ts` and `browser/cleaningErrorBoundary.test.ts` (a failure is stated in text and takes focus). | Test |
| 3.3.2 Labels or Instructions | A | The rule scan's `control-name` rule; axe's `label`, `select-name`, and `form-field-multiple-labels`; `browser/inputDescriptionA11y.test.ts`. | Test |
| 3.3.3 Error Suggestion | AA | Judgment: a failure message states what happened and what to do, by the convention in `CONTRIBUTING.md` (Failure messages) and [the failure-cause catalog](notes/failure-cause-catalog.md). | Judgment |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Judgment: an exchange sends data to a partner only after a review step and, on the accepting side, an explicit consent (`browser/keyboardAcceptJourney.test.ts`). Removing a saved exchange asks first (`browser/dialogKeyboard.test.ts`). | Judgment |

## Principle 4: Robust

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 4.1.1 Parsing | A | The rule scan's `duplicate-id` rule; React writes the DOM, so no markup is hand-parsed. | Test |
| 4.1.2 Name, Role, Value | A | The rule scan's `control-name`, `nested-interactive`, and `hidden-focusable` rules; axe's ARIA, `button-name`, and field-name rules. `browser/dialogKeyboard.test.ts` found the dialogs' close button unnamed; it is named Close (`apps/web/src/theme.ts`). | Test |
| 4.1.3 Status Messages | AA | `browser/alertRole.test.ts` (a status is polite, an error is an alert); `browser/psiProgressLine.test.ts` (the run's progress line). | Test |

## Totals

| Kind | Criteria |
| --- | --- |
| Test | 13 |
| New check | 13 |
| Judgment | 16 |
| Not applicable | 8 |
| All A and AA criteria | 50 |

## Open gaps

These are known and not yet closed:

- **Hover-only badges.** The cleaning preview's "empty value" and constraint-warning badges show their detail in a tooltip that only the pointer opens. The detail is in each badge's accessible name, so a screen reader reads it, but a sighted keyboard user cannot see it (2.1.1, 1.4.13).
- **Control boundaries.** No rendered sweep measures every control's boundary, resting field borders included, against its background at 3:1 across the route states (1.4.11).
- **Text-spacing and reflow states.** The layout checks mount each route's first state; the states a run reaches are not measured at 320 pixels or under text spacing (1.4.10, 1.4.12).
- **Pointer movement onto a tooltip.** The test runner moves the pointer in one jump, so `browser/hoverContent.test.ts` holds the setting that lets the pointer rest on a tooltip rather than moving the pointer across to it (1.4.13).
- **Screen-reader passes.** Each criterion above that rests on an accessible name or announcement is checked in the DOM, not heard through NVDA or VoiceOver. Those passes come after 1.0.

## Keeping this current

- A route added to the router fails the route-state checks until `browser/routeStates.ts` gives it a state, and every check above then runs on it.
- A change to what a criterion rests on updates its row here.
