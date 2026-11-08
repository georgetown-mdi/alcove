---
title: "Accessibility Self-Assessment"
---

# Accessibility self-assessment

This document maps each WCAG 2.1 Level A and Level AA success criterion to the evidence the project holds for the public web application and the console.
It is a self-assessment record kept by the project.
It is not a conformance claim, an audit, or a Voluntary Product Accessibility Template (VPAT).
The screen-reader passes and the VPAT come after the 1.0 release ([ROADMAP.md](ROADMAP.md)).

## Scope

The assessment covers both builds of `apps/web`:

- The public web application (the hosted build) and every screen it serves.
- The console, the same code built with the console profile and served by the container image ([CONSOLE.md](CONSOLE.md)).
  Its checks run with the console's cards configured: the client reads the console profile, and the console server's job API answers from a stub (`browser/consoleStates.ts`).

The console's own screens are the working folder's file picker and configuration, the SFTP connection form, the coordination server card, the cards on Review & create, the quick exchange, and the views of a run the console conducts.
On the console the browser runs no exchange, so the in-browser transport is withheld and the recurring exchange pages redirect.
Each criterion below covers both builds unless its entry says otherwise.

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
The keyboard-only journeys reach the states that need a run or a loaded file, and run the rule scan, axe, the control boundary sweep, and the layout checks on each one (`browser/stepChecks.ts`).

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

### Console screens and states

The console checks mount every route the router declares except the recurring exchange pages, at the console states `browser/consoleStates.ts` lists, and fail when a declared route has no state.
That file also lists the empty, error, and running states a console card shows from what the console answers alone.
The console keyboard-only journeys reach the states that need input, and run the same step checks on each one.

| Card or screen | Empty | Error | Running and other states | Reached by |
| --- | --- | --- | --- | --- |
| Working folder file picker (`ServerFilePicker`) | no usable files; no input folder configured; console started without a folder | folder cannot be read; listing failed | one file listed; a file's confirm stage; a file selected | console states, invite, quick exchange and accept journeys |
| An exchange from an earlier visit (`RecoveredExchangePanel`) | nothing to recover | stopped | still running; finished | console states |
| Configuration in the working folder (`MountedConfigurationCard`) | not yet opened | refused by the console | opened, with its notices | console states, invite journey |
| SFTP connection (`SftpConnectionCard`, `SftpAuthoringForm`) | none set up | a field error; a save the console refused | form open; authored and ready | invite journey |
| The partner's SFTP server, accepting (`AcceptorSftpConnectionCard`) | not set up | not reached | form open | accept journey |
| Coordination server (`SignalingServerCard`) | no address | not reached | address set | invite journey |
| How files are handled, connection tuning, diagnostics and recovery, receipts and record keeping | collapsed | a tuning value the run cannot use; a sweep not confirmed | open | invite journey |
| How a WebRTC invitation connects, accepting (`AcceptorSignalingServerNotice`) | not applicable | not applicable | terms review of a WebRTC invitation | console states |
| Accepting over the partner's SFTP server | not applicable | not reached | terms review; consent and your file; columns | console states, accept journey |
| Quick exchange (`/direct`) | file step | stopped, with Start over | the agreed server; confirm and run; in progress; complete | console states, quick exchange journey |
| A run the console conducts, inviting | not applicable | failed, with Try again | invitation ready; in progress; complete | invite journey |

## The checks

| Check | What it decides | Where |
| --- | --- | --- |
| axe-core, WCAG 2.1 A and AA rules | the rules axe tags for each criterion, run over the mounted page | `browser/axeScan.ts`, run by `browser/accessibilityRuleScan.test.ts`, `browser/consoleAccessibility.test.ts`, and the keyboard journeys |
| In-house rule scan | unique ids, resolving references, named controls and images, nesting, tab order, heading order, list structure, one h1 and one main landmark per page | `browser/accessibilityRules.ts`, run with axe |
| Contrast sweep | every rendered text element against the AA floor, and the resting boundary of each enabled text field, text area, select, checkbox, radio, and switch track against 3:1, light and dark schemes; the boundary part also at each journey step | `browser/contrastSweep.ts`, `browser/themeContrastSweep.test.ts`, `browser/themeContrastSweepConsole.test.ts` (the console states), `browser/verifyReceiptContrast.test.ts` |
| Console state checks | the rule scan, axe, the control boundary sweep, and the layout checks on each console state | `browser/consoleAccessibility.test.ts`, `browser/consoleStates.ts`, `browser/stepChecks.ts` |
| Console keyboard-only journeys | invite (the working folder, the configuration, the SFTP connection, the coordination server, the Review & create cards, and the run), quick exchange, and accept over SFTP, held to the same checks as the keyboard-only journeys | `browser/keyboardConsoleInviteJourney.test.ts`, `browser/keyboardConsoleDirectJourney.test.ts`, `browser/keyboardConsoleAcceptJourney.test.ts` |
| Theme contrast | filled controls at rest, hovered, and pressed, glyphs, checkmark, status tokens, dropzone border | `browser/themeContrast.test.ts`, `unit/themeContrast.test.ts` |
| Keyboard-only journeys | invite, accept, verify, and recurring setup by Tab, Enter, and Space alone; where focus lands; a focus indicator at every Tab stop; the rule scan, axe, the control boundary sweep, and the layout checks at each step | `browser/keyboardInviteJourney.test.ts`, `browser/keyboardAcceptJourney.test.ts`, `browser/keyboardVerifyJourney.test.ts`, `browser/keyboardOnly.ts`, `browser/stepChecks.ts` |
| Focus indicator | the journeys' focus-indicator check against fixtures | `browser/focusIndicator.test.ts` |
| Reflow and text spacing | no content past the viewport edge and no clipped text, at 320 CSS pixels and under the WCAG text-spacing overrides, on every route state, each console state, and each journey step | `browser/reflowChecks.ts`, `browser/reflow.test.ts`, `browser/textSpacing.test.ts`, `browser/consoleAccessibility.test.ts`, the keyboard journeys |
| Hover and focus content | tooltips dismiss with Escape and stay open while the pointer moves onto them; the cleaning preview's badges open their detail on focus | `browser/hoverContent.test.ts` |
| Dialogs | a confirm opened from the keyboard holds focus, passes both scans, and closes with Escape back to its trigger | `browser/dialogKeyboard.test.ts` |
| Source checks | page titles, page language, zoom, and what the app does not have (media, shortcuts, motion input, dialogs Escape cannot close) | `unit/wcagSourceChecks.test.ts` |

axe runs inside the mounted page, not the whole document, because the test runner owns the document.
The document-level facts axe would check there (title, language, viewport) are read from source by `unit/wcagSourceChecks.test.ts` instead.
Those source checks read every file under `apps/web/src`, the console's cards included, so a criterion they decide holds for both builds.

## Principle 1: Perceivable

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | The rule scan's `image-name` and `control-name` rules and axe's `image-alt`, `svg-img-alt`, and `role-img-alt` on every state, the console states included. Decorative icons are `aria-hidden`, the alert icons on the console's folder listing and server file picker among them (`apps/web/src/console/mountListing.tsx`, `apps/web/src/console/ServerFilePicker.tsx`); badges that carry meaning have a text name. | Test |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | The app has no audio or video. `unit/wcagSourceChecks.test.ts` fails if an `audio` or `video` element is added. | Not applicable |
| 1.2.2 Captions (Prerecorded) | A | No audio or video, as 1.2.1. | Not applicable |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | No audio or video, as 1.2.1. | Not applicable |
| 1.2.4 Captions (Live) | AA | No live audio or video. | Not applicable |
| 1.2.5 Audio Description (Prerecorded) | AA | No audio or video, as 1.2.1. | Not applicable |
| 1.3.1 Info and Relationships | A | The rule scan's `duplicate-id`, `broken-reference`, `heading-skip`, and `list-children` rules; axe's list, definition-list, ARIA parent and child, and table rules; `browser/inputDescriptionA11y.test.ts` for option descriptions. | Test |
| 1.3.2 Meaningful Sequence | A | Judgment: the DOM order is the reading order. The layout places columns with CSS grid in source order, and at a narrow width the share bar comes first in both the DOM and the view. The keyboard journeys move through each screen in that order. | Judgment |
| 1.3.3 Sensory Characteristics | A | Judgment: instructions name a control by its label ("use the Customize list in the This exchange panel"), never by shape, color, position, or sound alone. | Judgment |
| 1.3.4 Orientation | AA | `unit/wcagSourceChecks.test.ts` fails on an orientation lock in the code or the web app manifest. | New check |
| 1.3.5 Identify Input Purpose | AA | Judgment: the one field about the user, "Your name or agency", takes either a person's name or an organization's, so no single input purpose from the WCAG list applies to it. The relay registration secret is a shared credential, not the user's own password. The console's SFTP form asks for the server address, a username, and a key file reference; whether its Username field should name the `username` purpose is open (Open gaps). | Judgment |
| 1.4.1 Use of Color | A | axe's `link-in-text-block` on every state, which found links in body text marked by color alone; every link is underlined (`apps/web/src/theme.ts`). Status lines and alerts state their meaning in text and icon as well as color. | New check |
| 1.4.2 Audio Control | A | The app plays no audio (`unit/wcagSourceChecks.test.ts`). | Not applicable |
| 1.4.3 Contrast (Minimum) | AA | The contrast sweep over every state in both schemes, the console states included (`browser/themeContrastSweepConsole.test.ts`), `browser/verifyReceiptContrast.test.ts` for the verify screen's loaded states, the theme contrast tests, and axe's `color-contrast`. `browser/themeContrast.test.ts` reads the filled primary button label and action-icon glyph at rest, hovered, and pressed in both schemes, which found the light hover fill at 4.35:1; it takes a darker hover fill (`apps/web/src/theme.ts`, 7.09:1). | New check |
| 1.4.4 Resize Text | AA | `browser/reflow.test.ts` at 320 CSS pixels, the width of a 1280-pixel window zoomed to 400%; `unit/wcagSourceChecks.test.ts` holds a viewport setting that leaves zoom on. | New check |
| 1.4.5 Images of Text | AA | Judgment: the app shows no images of text. The wordmark is text and the icons are glyphs. | Judgment |
| 1.4.10 Reflow | AA | `browser/reflow.test.ts` on every route state and the keyboard journeys at each step (`browser/stepChecks.ts`). They found the step buttons clipping their labels at 320 pixels, the save-as-recurring button running past the edge, and the review table's hidden text widening the page; the labels wrap (`.workFoot`, `.wrapLabel`) and the table's scroll box holds its text (`.tableScroll`, both in `apps/web/src/styles/app.module.css`). A code block with a long line scrolls on its own, and is a tab stop so the keyboard can scroll it. `browser/consoleAccessibility.test.ts` and the console journeys run the same layout checks on each console state; the console cards' long button labels wrap (`.wrapLabel`, in `apps/web/src/console/`), the server file picker's listing scrolls in `.tableScroll`, and the folder listing's command block is a tab stop. | New check |
| 1.4.11 Non-text Contrast | AA | `sweepControlBoundaries` (`browser/contrastSweep.ts`) measures the resting boundary of each enabled text field, text area, select, checkbox, radio, and switch track against 3:1, on every route state in both schemes, on each console state, and at each keyboard journey step (`browser/stepChecks.ts`); a control whose background it cannot resolve fails. It found unchecked checkboxes at 1.3:1 (light) and 1.5:1 (dark), and unchecked radios at 1.49:1 (light) and 1.67:1 (dark); both take `--app-field-border` (`apps/web/src/styles/app.module.css`), held in both schemes by `browser/themeContrast.test.ts`. The theme contrast tests cover the checkmark, action-icon glyphs, dropzone border, and the focus ring and focused input border colors. | New check |
| 1.4.12 Text Spacing | AA | `browser/textSpacing.test.ts` applies the WCAG spacing overrides to every route state, and `browser/consoleAccessibility.test.ts` and the keyboard journeys to each console state and step (`browser/stepChecks.ts`); axe's `avoid-inline-spacing`. | New check |
| 1.4.13 Content on Hover or Focus | AA | `browser/hoverContent.test.ts`: a tooltip closes on Escape, and stays open while the pointer moves from its trigger onto it, from the theme default (`apps/web/src/theme.ts`); the same move closes a tooltip without that setting. The cleaning preview's badges open their detail on keyboard focus (`apps/web/src/components/StandardizationPreview.tsx`). | New check |

## Principle 2: Operable

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | The keyboard-only journeys complete invite, accept, verify, and recurring setup without the pointer, and the console journeys the console's invite, quick exchange, and accept over SFTP; axe's `scrollable-region-focusable`, which found a code block only the pointer could scroll. The cleaning preview's badges, whose detail only a tooltip shows, are Tab stops that open it (`browser/hoverContent.test.ts`). | Test |
| 2.1.2 No Keyboard Trap | A | `browser/dialogKeyboard.test.ts`: Escape leaves a confirm dialog and focus returns to its trigger. `unit/wcagSourceChecks.test.ts` fails on a dialog that turns Escape off. The journeys tab past every stop on each screen. | New check |
| 2.1.4 Character Key Shortcuts | A | The app defines no keyboard shortcuts (`unit/wcagSourceChecks.test.ts`). | Not applicable |
| 2.2.1 Timing Adjustable | A | Judgment: the inviter chooses how long an invitation lasts, up to a year, before it is sent. The wait for the partner is bounded at 10 minutes on a live exchange between two parties, and a failed run offers Try again without losing the setup (`browser/keyboardInviteJourney.test.ts`). | Judgment |
| 2.2.2 Pause, Stop, Hide | A | Judgment: the only motion is a run's spinner and progress stripes, shown only while the run is live, which is the content the user waits on. Both stop when the run ends and under the reduced-motion setting (`apps/web/src/styles/app.module.css`). | Judgment |
| 2.3.1 Three Flashes or Below Threshold | A | Judgment: nothing flashes. The spinner turns once every 0.9 seconds with no change in brightness. | Judgment |
| 2.4.1 Bypass Blocks | A | The rule scan's `page-main` rule holds one main landmark per page; the exchange screens' top bar is a named navigation landmark. | New check |
| 2.4.2 Page Titled | A | `unit/wcagSourceChecks.test.ts` requires a title on every route; it found the recurring exchange page without one. | New check |
| 2.4.3 Focus Order | A | The rule scan's `positive-tabindex` rule; the journeys assert where focus lands at each step; `browser/useOpenCloseFocus.test.ts`; `browser/dialogKeyboard.test.ts`. | Test |
| 2.4.4 Link Purpose (In Context) | A | The rule scan's `control-name` rule and axe's `link-name`. A link that opens a new tab says so in its name. | Test |
| 2.4.5 Multiple Ways | AA | Each page outside an exchange's steps has more than one way in. The start page links to the verify and recurring exchange pages (`browser/accessibilityRuleScan.test.ts`). A finished run's record note (`apps/web/src/exchange/RunSurface.tsx`) and a recurring exchange's run accounting (`apps/web/src/recurring/ManagedExchangeDetail.tsx`) also link to the verify page. The confirmation after saving an exchange links to the recurring exchanges (`apps/web/src/exchange/ManageExchangeOffer.tsx`). The console has no recurring exchange pages; its start page links to the verify page and quick exchange (`apps/web/src/Lobby.tsx`). Every other page is a step of an exchange, which the criterion excepts. | New check |
| 2.4.6 Headings and Labels | AA | The rule scan's `page-h1`, `heading-skip`, and `control-name` rules. That each heading and label describes its topic is a judgment the review of each screen makes. | Test |
| 2.4.7 Focus Visible | AA | Every element a Tab press focuses in the journeys, the control a journey then activates included, must look different focused from how it looked before the press (`browser/keyboardOnly.ts`, held against fixtures by `browser/focusIndicator.test.ts`). | New check |
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
| 3.3.1 Error Identification | A | `browser/alertRole.test.ts` (an error is announced as an alert); `browser/failureReportedCause.test.ts` and `browser/cleaningErrorBoundary.test.ts` (a failure is stated in text and takes focus). On the console, `browser/keyboardConsoleInviteJourney.test.ts` reaches the SFTP form's field error, a refused save, a refused configuration, and a failed run, and the console states the folder and listing errors, each under the step checks. | Test |
| 3.3.2 Labels or Instructions | A | The rule scan's `control-name` rule; axe's `label`, `select-name`, and `form-field-multiple-labels`; `browser/inputDescriptionA11y.test.ts`. | Test |
| 3.3.3 Error Suggestion | AA | Judgment: a failure message states what happened and what to do, by the convention in `CONTRIBUTING.md` (Failure messages) and [the failure-cause catalog](notes/failure-cause-catalog.md). | Judgment |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Judgment: an exchange sends data to a partner only after a review step and, on the accepting side, an explicit consent (`browser/keyboardAcceptJourney.test.ts`, and on the console `browser/keyboardConsoleAcceptJourney.test.ts`); a console quick exchange runs only after its confirm step (`browser/keyboardConsoleDirectJourney.test.ts`). Removing a saved exchange asks first (`browser/dialogKeyboard.test.ts`). | Judgment |

## Principle 4: Robust

| Criterion | Level | Evidence | Kind |
| --- | --- | --- | --- |
| 4.1.1 Parsing | A | The rule scan's `duplicate-id` rule; React writes the DOM, so no markup is hand-parsed. | Test |
| 4.1.2 Name, Role, Value | A | The rule scan's `control-name`, `nested-interactive`, and `hidden-focusable` rules; axe's ARIA, `button-name`, and field-name rules. `browser/dialogKeyboard.test.ts` found the dialogs' close button unnamed; it is named Close (`apps/web/src/theme.ts`). | Test |
| 4.1.3 Status Messages | AA | `browser/alertRole.test.ts` (a status is polite, an error is an alert); `browser/psiProgressLine.test.ts` (the run's progress line). | Test |

## Totals

| Kind | Criteria |
| --- | --- |
| Test | 11 |
| New check | 15 |
| Judgment | 16 |
| Not applicable | 8 |
| All A and AA criteria | 50 |

## Open gaps

These are known and not yet closed:

- **Screen-reader passes.** Each criterion above that rests on an accessible name or announcement is checked in the DOM, not heard through NVDA or VoiceOver. Those passes come after 1.0.
- **Console states no check reaches yet.** The relay check panel, the recovery from changed terms, browsing the secrets file picker, the notice that the shared folder is exposed, the working folder's command lines and the recurring hand-off, the coordination server card's refusal, the file-handling card's conflict error, a run's warning, the accept side's run views, and the accepting side's SFTP form errors. Each falls under 1.3.1, 1.4.3, 1.4.10, 1.4.11, 2.1.1, and 3.3.1 until a state or journey step renders it.
- **1.3.5 on the console's SFTP form.** Whether the Username field, the operator's account on the SFTP server, should carry `autocomplete="username"` is not yet decided.

## Keeping this current

- A route added to the router fails the route-state checks until `browser/routeStates.ts` gives it a state, and every check above then runs on it.
- A route the console renders fails the console state checks until `browser/consoleStates.ts` gives it a state; a console card's new empty, error, or running state is added to its card states there.
- A change to what a criterion rests on updates its row here.
