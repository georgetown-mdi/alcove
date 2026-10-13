---
title: "Key Redaction and Message Budgets on Operator Displays"
---

# Key redaction and message budgets on operator displays

This document specifies what is removed from text shown to an operator and how much of it is shown, with its constant values and enforcement points: the private-key redaction with its sinks and the limits of its reach, the per-link and per-value message budgets with their partition by chooser and the cause-depth bound, and the display types of the invitation consent summary.
It is the implementation-level complement to the **Console and log hygiene** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#console-and-log-hygiene), which covers the threat and the display boundary's rules.
It does not cover the display sanitization escape format or the compatibility diagnostic value delimiting (see [DISPLAY_ESCAPE.md](DISPLAY_ESCAPE.md)).
Intended readers are security auditors, implementors, and anyone writing an error, a log line or a prompt.

Every net-new control specified here is subject to the explicit pre-release security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy).

## Private-key redaction

The private-key strip has an assignment separate from the escape's [single altitude](DISPLAY_ESCAPE.md#display-sanitization-escape-format), because it is not escaping and does not double.
A whole `BEGIN`..`END` block is replaced where it sits; a truncated block -- a `BEGIN` with no `END`, which is what a key sliced into an error looks like -- is replaced from the marker to the end of the unit the pass runs over: a cause-chain link at the error renderer, one log argument at the log sink.
That reach is fail-closed: a key that reaches an error has whatever structure the thing that held it left behind, and the separators are not predictable -- real line breaks from a file read, single spaces from a folded or plain multi-line YAML scalar, backslash escapes from a JSON scalar, or no separator at all.
So a rule that consumes only armor organised into lines leaks the entire body of every other delivery.
The reach stops at that unit's boundary: each cause-chain link, and each log argument, is redacted independently, so a marker in one cannot reach the next.
The cost of failing closed is that the replacement also consumes first-party text composed after the marker in the same link.
That cost is paid off at the composition site rather than by narrowing the reach: a partner- or server-controlled fragment is passed through `redactPrivateKeyMaterial` where it is interpolated, so a planted marker is replaced inside its own fragment and no longer exists when the link is rendered.
The function is idempotent and never lengthens its input, so the later per-link pass is a no-op on an already-redacted fragment and a display budget fitted over raw fragments still holds.

Redacting per fragment narrows the reach in one measured case, recorded here rather than left implicit: where two adversary-controlled fragments are adjacent in one link, a `BEGIN` marker ending the first and the key body opening the second are no longer one string when the rule runs, so that body survives where the per-link pass alone would have consumed it.
Adjacent fragments under different parties do occur - a partner-derived peer id beside this party's own configured id, a partner-seedable inbound path beside the operator's outbound path.
So what bounds the loss is not common provenance but what the surviving bytes are: in every composition reachable today they are that party's own or the operator's own path or id, never an Alcove secret.
Adjacency under ONE party is the other shape, and a joined list is where it occurs: the sorted received column list of `assertNoPayloadReceived` and the joined key-name enumerations of the satisfiability refusal.
Per-fragment redaction confines a marker to the fragment holding it there too, so a body the same chooser placed in a neighbouring column name or key name survives as ordinary text.
Those bytes are that chooser's own, so what the strip lets through is text they already held rather than an Alcove secret.
The safety check exists for an unanticipated sink, and a key split across two fragments of one link is where its reach stops.
Applying it at a composition site is redaction, not a second escaping altitude: the fragment is still interpolated raw and still escaped exactly once, at the sink.

Outside the reach of the [branded type](DISPLAY_ESCAPE.md#display-sanitization-escape-format), the assignment is a convention over composition sites rather than a mechanism that enforces itself -- the renderer cannot tell a first-party span from a partner one -- so there it is stated here rather than checked.
How much of it a test can hold varies by site, and at the two refusals of the CLI first-use host-key flow (`establishHostKeyTrust` in `apps/cli/src/hostKeyTrust.ts`) it is not pinnable at all.
Each chooser's fragment is last on a labelled cause link of its own and the renderer redacts every link before truncating, so removing either of those composition-site calls changes no rendered byte and reddens no test.
Fitting a fragment at its composition site takes it out of that unpinnable class, because the clip is what makes the order of the two transforms observable.
The stalled-transport builder (`transportOperationStalledError` in `apps/cli/src/connection/sftpLivenessGuard.ts`) fits each of its three fragments -- its stall detail, its path, and the dead-session arm's server-reported one -- to its link's budget after redacting it, so a key block wider than that budget renders as the replacement plus whatever followed it.
Dropping the redaction leaves the clip cutting the block's `END` off, and the renderer's own per-link pass then consumes the dangling remainder to the end of the link, taking the truncation marker and the bytes composed behind it with it.
`apps/cli/test/unit/connection/transportRefusalBudget.test.ts` pins that ordering at the rendered boundary.

What a test does hold is five sites, each pinned at its rendered sink by a marker planted in the fragment its adversary chooses: the cross-party host-key divergence warning, the same flow's trust warning, confirm prompt, and its `write-now` and `ephemeral` pin lines, and the `probe-host-key` summary.
That is a sample of the composition sites the assignment governs, not a roster of them -- the sweep covers the log-bound fragments that already ran through the display escape in `packages/core/src` and `apps/cli/src`, and the rest are held by the convention plus the sink pass behind it rather than by a marker test of their own.
Those are not every fragment a log line interpolates.
An operator's own configuration, key-file and signing-identity paths reach the CLI's log calls through `redactAndRenderOperatorSuppliedText`, which redacts each path where it is composed, so a `BEGIN` marker an operator spelled in their own path costs the path and not the guidance composed behind it on the same argument: the post-exchange summaries (`apps/cli/src/onlineBootstrap.ts`), the keys-file warning naming the material to delete or protect (`apps/cli/src/recordFile.ts`), the key-file permission and access-list warnings (`apps/cli/src/fileUtils.ts`), the host-key flow's own `persistence.configPath` (`apps/cli/src/hostKeyTrust.ts`), and the two warnings about the configured signing identity (`apps/cli/src/commands/verifyReceipt.ts`), which `apps/cli/test/unit/commands/operatorPathMarks.test.ts` holds by planting a marker in the path and reading the guidance off what the sink wrote.
What identifies the class is an operator-chosen path reaching a log call unredacted, and a site that acquires one later joins it silently: the [ban](DISPLAY_ESCAPE.md#display-sanitization-escape-format) reports the shape where the name is one of the three it matches, and nothing reports it where the name is not.
A site with no marker test of its own, whose fragment is composed ahead of first-party text, reddens nothing when its composition-site call is dropped; that is the cost of the assignment being a convention, and it is why the sweep is uniform rather than fitted to where text happens to follow today.

**A window redacts its stream, not its contents.**
A sink that keeps a rolling WINDOW of what a run wrote clips before anything renders it, so a key wider than the window lands in that window as body alone -- the `BEGIN` marker already evicted, the `END` not yet written -- and neither the block rule nor the truncated-block rule above sees that shape.
Alcove owns one such sink, the console's retained CLI stderr tail (`attachStderrTail` in `apps/web/src/jobs/cliDriver.ts`), and it redacts the STREAM in front of the window rather than the window's contents.
`createPrivateKeyStreamRedactor` (beside the marker patterns in `packages/core/src/utils/sanitizeErrorForDisplay.ts`) holds "inside a block" across deliveries: it replaces once on a `BEGIN` marker, emits nothing further until an `END` marker is consumed, holds back a marker's worth of each delivery so a marker split across two is scanned whole, and leaves a block still open at close redacted to the end.
The reach is forward only there as at the render boundary, so an `END` with no `BEGIN` of its own is ordinary text and no delivery deletes what an earlier one already emitted.
The console's other spawn boundary drains its child's stderr and discards it, which makes "no other reader of the raw stream" a checkable claim rather than a stated one: `apps/web/test/unit/jobs/stderrTailRedaction.test.ts` holds it alongside the window's own content, and the chunk-split, split-marker, lone-`BEGIN`, lone-`END` and long-body properties are held over the redactor itself in `packages/core/test/utils/sanitizeErrorForDisplay.test.ts`.
What the streaming form gives up against the whole-text one is a marker whose label runs past 64 characters AND falls across a delivery boundary, a shape no PEM or OpenSSH label takes.
A second gap is measured too: when a second `BEGIN` marker arrives before the first block's `END`, the whole-text pass refuses to match across it, and its truncated-block rule redacts from the first `BEGIN` to the end of the unit -- while the stream closes its suppressed region at the first `END` it meets and passes the text after it through.
No key byte reaches the tail either way; the difference is only how much of the ordinary text after the nested block the operator still sees, and the stream's reading keeps more of the run's own words.
An unterminated `BEGIN` costs more at a stream than at a link.
The truncated-block reach stops at the end of the unit the pass runs over, and here that unit is the rest of the run: a `BEGIN` the child never closes suppresses every later byte through the close, so the retained tail ends at the replacement and the operator reads nothing the run wrote after it, with no second copy of it where the run was given no `--log-file`.
Redacting to the end is the fail-closed direction, and the property is pinned as `a BEGIN marker with no END stays redacted through the close`.

**Two limits stand behind the strip in either form**, recorded here rather than left to be discovered.
A key body that arrives with NEITHER marker on it, from outside any window Alcove owns -- spliced by a library, truncated upstream -- is redacted by nothing and cannot be: scrubbing by secret SHAPE is refused on purpose, because a host-key fingerprint and a shared secret share that shape and fingerprints are shown to the operator by design.
And `[redacted private key]` is printable, unauthenticated text that any chooser can spell, so its presence in a rendered string is not evidence that a redaction ran; only its absence is meaningful, and reading it as a guarantee that the bytes it replaced were a key is reading more than the strip states.

Uniformity costs something of its own at two operator surfaces that run no sink pass, and so had nothing needing containment: the interactive host-key trust prompt (`apps/cli/src/hostKeyTrust.ts`, through `promptConfirm` in `apps/cli/src/util/prompt.ts`, written by readline rather than through a prefixed logger), and the browser consent screen the web app renders from `invitationSummary.ts`.
A partner-seeded host, a partner-declared identity or column name, or one of this party's own header columns, shaped like armor displays as `[redacted private key]` at the very surface where the operator decides whether to trust a host key or accept the terms, where the escape alone would show it whole.
Each composition also takes a log route, which is what the redaction is there for; showing the operator one string on both routes is the trade.
The cost is display fidelity at a decision point, recorded here rather than left to be discovered at the prompt.
Rendering a raw error at a sink is banned by an ESLint rule over `packages/core/src` and `apps/cli/src` (excepting the three parse chokepoints those blocks already ignore, which have no display sink).
The sinks it reads are the `console` methods, a prefixed logger's levels, and the CLI's terminal prompts (`writePromptLine`, `promptConfirm`, `promptFreeText`), which write what they are handed.
The CLI integration console sentinel fails on any captured line with a byte outside printable ASCII once the `\ncaused by: ` framing the cause-chain renderer emits between links is removed - the framing is removed before the test rather than exempted from it, so a forged log line of printable ASCII plus a bare newline still fails.
Both halves are bounded.
The rule matches the raw error where it sits directly in a sink argument and does not follow it through an intermediate local, a method call on the message, or a container the sink unpacks, since that would need taint analysis TypeScript cannot run.
The sentinel observes only `console` calls, so a direct `process.stderr.write` is outside it, as is a dependency that writes the file descriptor itself.
The sentinel's framing strip is also a literal one with no notion of who emitted the sequence, so a line whose unescaped payload itself contains `\ncaused by: ` passes the byte test.
Neither is a claim about every byte that lands on the terminal.
The composition side of the [single-altitude assignment](DISPLAY_ESCAPE.md#display-sanitization-escape-format) is banned by a second rule, over `packages/` and `apps/cli/` and their test sources: a call returning `Displayable` -- the brand below -- or a `displayText` template may not sit in an argument, a template interpolation, a concatenation, a ternary branch, an arrow body, an array element, or the `cause` property of a `...Error` construction or of the two cause-chain composers (`chainDetailCauses`, `fittedCauseLink`), since an `Error` is not a sink and that fragment is escaped again where the chain is rendered.
It is syntactic in the same way: a value reaching an `Error` through an intermediate -- a local, a property, a function returning `string` -- is outside it.
And it has no runtime half, the sentinel failing on a byte outside printable ASCII while a fragment escaped twice is printable ASCII throughout, so what stands behind it is a check over the governed sources instead (`scripts/eslint-displayable-error-argument-ban.test.mjs`), holding the producing calls the rule names to every exported function that declares a `Displayable` return type.

The strip therefore has three sinks, and the unit it runs over differs at each.
At the error renderer it runs per cause-chain link (`sanitizeErrorForDisplay`).
At the diagnostic log it runs per argument, in core's log prefixer (`setLogPrefixer` in `packages/core/src/utils/logger.ts`) rather than in a consumer's diagnostic sink.
The prefixer sits upstream of both CLI routings (stderr and `--log-file`) and of the browser console the web app keeps, and it also covers a line logged before a consumer installs its sink, which a sink-side pass would miss entirely.
The prefixer is handed raw `unknown[]` and the sink owns its own formatting, so the pass rewrites only the members that are already strings and passes every other member through by reference - an object argument prints exactly as it would without the pass.
The CLI's fd-3 warning event is the third (`buildWarningEvent` in `apps/cli/src/eventStream.ts`), because that stream is a persisted machine sink whose terminal error event is already redacted through `sanitizeErrorForDisplay`; leaving its one other free-text field unredacted would make the stream the exception.
That event's display cap is sized for a composition rather than for one value: the host-key divergence warning is the whole reason a supervisor that discards stderr reads the stream, and the per-value default cuts that warning mid-explanation, taking its re-pin instruction with it.

Each unit boundary is also a reach limit, stated rather than closed.
Key material split across two cause-chain links is not seen by the per-link pass, and key material split across two arguments of one `log.warn(a, b)` call is not seen by the per-argument one.
Joining first would close either, at the cost this whole assignment exists to avoid: a dangling marker in the first unit would then consume every unit behind it, which is how the party a warning is about deletes the warning about itself.
The composition-site rule is what makes that trade the right one - a fragment redacted where it is interpolated holds no marker by the time either pass runs, so the wider reach of a sink pass costs nothing that the composition sites have not already paid.
The third limit is which sinks have a pass at all: the three above are the error renderer, the diagnostic logger, and the fd-3 warning event, so an operator-facing sink that does not route through the prefixed logger runs none of them.
The receipt-verification report (`apps/cli/src/commands/verifyReceipt.ts`) and the argument-parser rejection (`apps/cli/src/cliParser.ts`) write `console.log` and `console.error` themselves, and are escaped at composition without being redacted.
None of them can suppress first-party text, because no pass runs there to fail closed; what they lack is the safety check, and closing that means moving them onto a logger or giving each its own pass.
The CLI's plain-line sink (`LogSink.writePlain` in `apps/cli/src/util/logging.ts`) belongs to that class for a different reason and is the one that reaches a persisted destination: it feeds the same writer the prefixed lines go through, so a `--log-file` captures it, but it bypasses the prefixer and therefore the per-argument strip.
Its only caller is the `doctor` verdict rendering (`apps/cli/src/commands/doctor.ts`), which includes an NT_STATUS token and `smbclient`'s own output.
For that sink the composition is the only place a pass can run, and the rendering runs three of them, with the unit differing between them as it differs across the three sinks above.
The first runs on the whole tool output before the rendering splits it into lines (`clampDetail` in `apps/cli/src/doctor/verdict.ts`): a tool hands a key block over in its canonical multi-line form, so a pass over the lines that come out matches its `BEGIN` line alone and renders every body line verbatim.
The second runs on the whole of a check's meaning or action text before the rendering re-flows it under its label (`wrapLabelled`, below).
The third runs per rendered line, where the rendering escapes (`emit`), and the first two are what make it a no-op over the tool output and the wrapped blocks.
That third pass is not free: a summary line composes an operator-supplied value -- the SMB server name, or the mounted directory -- ahead of its own predicate, so an operator who names one with a `BEGIN` marker reads `OK: [redacted private key]` and loses the predicate to the fail-closed rule.
The marker filename is composed the same way but cannot reach it: `MARKER_PATTERN` admits no space, and every redaction pattern requires one, so a marker-shaped `SMB_MARKER` is refused as a usage error before any check runs.
Those bytes are the operator's own and no partner reaches them, which is why the cost is recorded here rather than closed by redacting each fragment before composition; all three passes are pinned by marker tests rather than resting on the convention.

The wrap is why the second of those passes exists, and it is the one shape in this assignment where the strip could fail OPEN rather than closed.
`wrapLabelled` re-flows a check's meaning and action text on whitespace at 76 columns, and every marker the rule matches contains spaces, so a `BEGIN` straddling a wrap would reach the per-rendered-line pass as two lines, neither matching a pattern that requires the whole marker, leaving the material behind it to render verbatim.
Redacting the whitespace-normalized text ahead of the re-flow closes that, exactly as `clampDetail` closes the same shape ahead of its split -- and normalizing before redacting is critical: the re-flow collapses every whitespace class to ASCII spaces, so a marker whose internal separators are non-ASCII whitespace would otherwise be re-formed by the normalization after a raw-text redaction had run.
The unit is one labelled block -- meaning and action are wrapped separately -- and the label is composed outside the redacted text, so a dangling marker takes the rest of its own block and reaches neither the label nor the sibling block.
What the wrap holds is the operator's own `SMB_SERVER`, `SMB_SHARE`, and `SMB_PATH`, the `SMB_MARKER` filename `MARKER_PATTERN` already confines to a space-free charset, and smbclient's own NT_STATUS token, whose `NT_STATUS_[A-Z_]+` shape admits no space either; the server-controlled `detail` is redacted whole before the split and its lines are never wrapped.
The replacement is prose to the wrap like any other phrase and can itself be broken across two rendered lines, a legibility cost of the ordering rather than a disclosure one.
The property is pinned at the rendered boundary by a marker planted so the wrap splits it, alongside a marker-shaped control string rendered at the same offset, which is what establishes that the wrap falls inside such a run rather than leaving it whole.

## Message display budgets

The per-link cap is a second bound on the same output, independent of redaction, and it falls wherever it lands: on a link that mixes first-party text with a fragment somebody else chose, the chooser spends the budget and the operator loses the instruction.

That per-link budget is **not** the per-value default.
A cause-chain link is a composition -- first-party explanation and recovery text with fragments interpolated raw into it, by the [single-altitude assignment](DISPLAY_ESCAPE.md#display-sanitization-escape-format) -- where `DEFAULT_MAX_DISPLAY_LENGTH` (**256**) is sized for one value.
So charging a whole link to it cuts the composition's own instruction with no fragment involved at all: the connection-endpoint locator rejection in `packages/core/src/config/invitation.ts` is 394 characters of fixed guidance before its prefix and its list of rejected keys.
`sanitizeErrorForDisplay` therefore caps each link at `COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH` (**1024**, `packages/core/src/utils/sanitizeForDisplay.ts`), sized to admit the longest fixed guidance Alcove composes into one message together with the bounded values that message names, and left well under the **4096** of `WARNING_MESSAGE_MAX_DISPLAY_LENGTH`, whose four re-escaped fragments crossing three boundaries are a larger shape.
The whole rendered chain stays bounded without a separate total-length cap: at most `MAX_ERROR_CAUSE_DEPTH` (**8**) links at that budget each.
The budget bounds what any single link can spend; whose bytes spend it is decided by the partition below, which is why a wider link is not a wider flood allowance.
The two SFTP host-key refusals (`installEnforcingVerifier` in `packages/core/src/connection/sftpSession.ts`) are therefore composed as a partition by provenance - one link per party that chose the bytes on it - rather than as one string, the same remedy `entryGuardRefusal` applies in `packages/core/src/connection/fileSyncRendezvous.ts`.
The refusal itself, the presented fingerprint (base64, of fixed length), and the operator's pin or re-pin instruction ride the error's own message plus, where they exceed one budget, further first-party cause links.
Each fragment somebody else chose then takes a labelled cause link of its own - the configured host and the presented key type on the no-pin refusal, the pinned set and the presented key type on the pinned-mismatch one.
`FileSyncConnection.open` folds those links in ahead of the transport error the connect rejected with, so the cause-depth bound can never drop a detail in favour of ssh2's opaque `Host denied`.

Splitting by chooser rather than into refusal-plus-detail is what keeps the fix from reproducing the defect one level down.
The host and the key type are chosen by different parties: on the acceptor route the host is the partner's, copied verbatim out of the invitation endpoint into the written config (`connectionFromEndpoint` in `apps/cli/src/onlineBootstrap.ts`), and `SFTPServerSchema` bounds `connection.server.host` neither in length nor in format, while the key type is decoded from the server's blob under no bound at all.
So a shared trailing link would let either delete the other's disclosure.
The pinned set is the operator's own rather than an adversary's, but `SFTPServerSchema` bounds each pin's format and not the array's length, so a many-pin config would eat the re-pin instruction from a shared link; its own link is the right place for it.
The property this buys is that the cap can only ever consume a chooser's own bytes, and it is pinned by test at the rendered boundary.
Each refusal renders its fingerprint in full and its instruction whole under a benign key type, an over-length one, one holding a PEM `BEGIN` marker, a configured host at the full 256 characters the invitation schema admits (which the link budget delivers whole), and one past that budget, where the cut falls on the host's own link and no other.
Reachability differs between the two refusals and the partition does not rest on it: the pinned-mismatch form is reachable from any CLI run, while the no-pin form is core's fail-closed safety check for a direct library caller, ahead of which the CLI's own first-use trust flow normally pins.
Nothing enforces that ordering, so the no-pin refusal is composed to the same standard as its sibling rather than treated as unreachable.

The cap is not removed, only kept off first-party text: a fragment that overruns still truncates on its own link, and the whole rendered chain stays within the cause-depth bound times the per-link budget plus the separator the renderer emits between links - also pinned by test, with each branch's live fragments flooded at once.
Enforcement is untouched throughout: the connection is refused and a changed key is never auto-accepted.
One residual bound remains: each first-party link fits its budget by measurement, not by construction, so growing the fixed copy past the cap would put the cap back on the operator's text.
That residual is held by a check rather than by this paragraph - rendered with every variable fragment at its ordinary size, no link of either refusal truncates at all, so any growth past a budget fails there.

The receipt verification notes reach the operator on neither of those routes: no error, no chain, and no sink pass of their own.
A note is a composition of the same shape as a cause link -- Alcove's own sentence, with any column name drawn from the files the operator re-supplied escaped where it is interpolated (`reconstructCommittedData` and `reproductionMismatchCauses`, `packages/core/src/records/recordVerification.ts`) -- so charging the whole note to the per-value default cuts the sentence rather than the fragment: the reproduction-limitation note is 403 characters, of which the operator loses the half stating what a mismatch can and cannot mean.
Each note is therefore composed as a `Displayable` where it is written (`firstPartyNote`, `packages/core/src/utils/sanitizeForDisplay.ts`) with the column name escaped and capped at `DEFAULT_MAX_DISPLAY_LENGTH` where it is interpolated, and the two sinks that render one -- `alcove verify-receipt` and the browser verify page -- show what they are handed instead of escaping and capping it again.
The slot is what holds the arrangement: both note lists are declared `Displayable[]`, so neither sink can be reached by a raw `string`.
What `firstPartyNote` accepts is checked rather than taken -- a note holding any code point outside printable ASCII is escaped and capped as an ordinary value instead, that being the class first-party copy and an already-escaped fragment both sit inside -- so the exemption is from the length cap alone, and a fragment rendered with non-ASCII kept as the operator typed it (`renderOperatorSuppliedText`) is not composable into a note.
What the mark claims about provenance is checked where the note is written, since the runtime guard reads the note's characters rather than who chose them: `scripts/first-party-note-argument-shape.test.mjs` refuses a `firstPartyNote` call under `packages/core/src` whose argument is not literal text with every interpolation wrapped in a direct `sanitizeForDisplay(...)`
call, and refuses any such call in another shipped source tree, where a consumer is handed a note already composed.
It reads `.ts` and `.tsx` files and the direct import name only, so an aliased or namespace import, a second argument that raises the cap, and an `.mts` source are outside it and are review's to catch (the script's header lists the alias and namespace limits).

The cause-depth bound is the same kind of bound one level up -- over links rather than characters -- and it discloses its cut the same way.
A walk that stops at `MAX_ERROR_CAUSE_DEPTH` with the chain still running appends `CAUSE_DEPTH_ELISION_MARKER` (`...[further causes elided]`) to the last link it renders, so a chain the bound cut displays as cut rather than as the whole failure; a chain that ends on its own, or that the cycle guard stops on a link already rendered, holds no marker.
Neither marker is authenticated, and neither can be: both are plain printable ASCII the escape passes through unchanged.
So a link whose own message ends with the marker's text renders byte-identically to one the bound really cut -- the same shape the transport-refusal checks work around for `DISPLAY_TRUNCATION_MARKER` by expressing "this link truncated" as a length comparison against the cap rather than as a marker search.
The cost is one-directional and bounded: a copy of the marker claims a loss that did not happen, and cannot conceal one that did, because the renderer appends its own after the escape whatever the link held.
So what an operator can rely on is the marker's absence, its presence saying detail MAY be missing rather than that it is.
Both directions are pinned by test at the rendered boundary, a partner message holding the marker's text driven alone, at the depth cut, and against a genuinely cut chain it renders identically to.
The marker has no count, because counting the remainder means walking the rest of the chain -- the walk this bound exists to refuse, and unbounded in exactly the adversarial case it is defensive against.
A composition site whose link count is driven by a list length therefore states its own overflow, where the count is free: `checkLinkageSatisfiability` (`apps/cli/src/commands/linkagePreflight.ts`) gives each dead key, unsatisfiable key, and unsatisfied field a labelled link, and `LinkageTermsSchema` bounds `linkageFields` and `linkageKeys` only at `MAX_LINKAGE_ENTRIES` (**256**).
So it fits the enumeration to the links the renderer reaches -- the summary and the remedy chained ahead of the names take one each -- and spends the last of them on `and N more details of the terms this CSV cannot satisfy (M in total)` rather than on one more name.
What puts a site in that class is the count of links it asks for, not the length of any one of them: a many-valued fragment on one link (the pinned-fingerprint set a [host-key mismatch](SFTP_CONNECTION.md#sftp-host-key-verification) names) spends that link's character budget and truncates where an operator sees it, while a list given a link per element runs off the end of the walk.
Both are pinned by test at the rendered boundary, the enumeration at more names than the walk admits and at the widest count that needs no overflow link at all.

The CLI's own first-use trust flow (`establishHostKeyTrust` in `apps/cli/src/hostKeyTrust.ts`) composes its two refusals to the same partition, and reaches the operator through the same renderer: `exitWithError` and `runOrExit` (`apps/cli/src/util/exit.ts`) and the last-resort catch in `apps/cli/src/index.ts` all call `sanitizeErrorForDisplay`.
The partition moves the recovery step off the error's own message, so that routing is what delivers it, and the routing is held by a check of its own (`apps/cli/test/unit/util/errorSinkCauseChain.test.ts`).
A table drives a synthesized error of this shape - a summary wide enough to truncate on its own link, the recovery sentence on a cause link - through each CLI error sink and fails unless that whole sentence reaches the sink's captured output.
The table names five sinks rather than the three this flow reaches: `parseOrExit` (`apps/cli/src/util/flags.ts`), `exitWithError` and `runOrExit` (`apps/cli/src/util/exit.ts`), the last-resort catch in `apps/cli/src/index.ts`, and the `--event-stream` terminal error event (`apps/cli/src/eventStream.ts`).
Each is driven through its real route - `console.error` and the injected logger read directly, `runOrExit`'s lazily built logger through the loglevel capture interceptor, `index.ts` by importing the module with its parser replaced so its own module-level catch runs, and the error event through the real emitter and NDJSON writer with only the fd-3 `writeSync` stubbed.
So what is asserted is the serialized line rather than the built event.
Two limits are the check's, not the property's: it covers the sinks that terminate a run, so the mid-run diagnostics that render a caught error into a log line (`apps/cli/src/protocol.ts`, the SFTP adapter) are outside it.
And nothing enumerates the sinks from source, so a sixth terminal sink is covered when it is added to that table and not before.
The non-interactive refusal puts the fail-closed sentence on the error's own message, and the recovery step - run once from an interactive terminal to review and pin the presented key, or pin it out-of-band by setting `connection.server.host_key_fingerprint` - on a first-party link of its own.
It then puts one labelled link each for the configured host and, in the persistence shapes that name one, the operator's config-file path.
The declined-trust refusal keeps its recovery step on the error's own message, after the refusal, with the configured host as its only link.
Three choosers rather than two is what the fixed copy had to be shortened for, not only re-partitioned: the host is the partner's on the acceptor route exactly as it is in core, and the config path is the operator's own and equally unbounded.
So a link with either one beside the recovery would delete it - and the link with both did, at every host, because the recovery sentence alone filled a whole budget.
The ephemeral shape (a `zero-setup` run without `--save`) names no path and grows no link for one; its recovery points at a saved configuration instead.
Both refusals and both shapes are pinned by test at the rendered boundary - under an ordinary host, a partner-supplied host at the full length the invitation schema admits, and one longer than that (`MAX_ENDPOINT_HOST_LENGTH` bounds what an invitation can hold, while `SFTPServerSchema` admits any non-empty `connection.server.host`, so a hand-written or partner-derived config reaches the band between the two).
Testing also spans a host and a config path each past every budget.
They also have the same residual check core's pair does: with every fragment at its ordinary size, no link truncates at all.
Both chooser fragments - the partner-reachable host and the operator's own config path - pass through `redactPrivateKeyMaterial` where they are interpolated, as the assignment above directs, and each is delivered a PEM `BEGIN` marker, alone and with text around it, to pin what the operator gets.
That pin is the armor replaced on that fragment's own link, the label and the first-party links intact, and the reach stopping at the link boundary rather than consuming the link behind it.
What those deliveries pin is that rendered outcome, not the composition-site calls: in this composition each chooser fragment is last on its own link and the sink redacts every link before it truncates, so removing either call changes no rendered byte and reddens no test - measured across every host and config-path delivery this flow admits.
The calls are kept as the assignment above directs, against a future edit that appends first-party text after a fragment in the same link; at this site, and unlike the rendered outcome, they are held by that convention rather than by a check.
Escaping stays at the sink alone: a host with ESC, CR, LF, NUL, a bidi override, and a literal `caused by: ` renders each as an escape on its own link and adds no link, so the renderer's framing cannot be forged from a fragment.

The three bounded-transport refusals (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md#inbound-frame-size-bound) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md#per-operation-liveness-bounds)) -- `FrameSizeExceededError`, `DirectoryListingBoundsError`, and `TransportOperationStalledError` (`packages/core/src/errors.ts`) -- have the same partition, and reach it from the other direction: what a shared link deletes here is not a chooser's victim but first-party text that simply does not fit.
A class-uniform recovery step appended to the call site's message would share one capped link with that site's prose and with whatever path the prose names, and the cap would delete the step at every site.
Shortening the copy is not an alternative: with every variable fragment at its ordinary size -- the rendezvous path this documentation's own configuration examples use, a `uuidv4` peer id, a protocol message filename -- the call-site prose alone runs past the 256-character budget at seven of the sites.
At the whole-exchange budget's `rename` it reaches 393 characters, of which 204 are the two transport paths themselves (the full rename label runs 218).
A summary cut back to that label and the budget number renders 181 on its own and 268 once the recovery step it must include is appended -- still past the budget.
So the recovery step takes a first-party cause link of its own, chained ahead of every fragment link so the depth bound reaches it first.
Each value a partner, a server, or an unbounded config chose then takes a labelled link of its own, one such value per link: the stalled operation's label, and each of the two paths a `rename` names, at the whole-exchange budget.
The remaining labelled links are the message file, its writing peer, and the rendezvous directory at the file-sync frame gate, and the inbound path at the CLI frame-size guard.
They also include the stalled operation's path and, on the dead-session arm, the fatal error the server itself reported, at the CLI liveness guard, and the directory and the offending entry name at the CLI directory-listing guard.
A labelled link of one's own bounds whose bytes may fill it, not how many.

The three CLI guards fit each adversary-chosen value -- the directory-listing guard's directory path, the frame-size guard's inbound path, and the liveness guard's path and, on its dead-session arm, the server-reported error, none of them bounded anywhere upstream -- to `DEFAULT_MAX_DISPLAY_LENGTH` (**256**), label included, where they compose it (`clipToRenderedCost`).
The liveness guard fits its first-party stall detail the same way, so its three links share one rule.
The fragment is thus cut to a value's budget before it reaches a renderer whose own cap is sized for a whole composed message.
The three share one definition of that composition (`fittedCauseLink` in `apps/cli/src/connection/causeLink.ts`), so the order of its two transforms is stated once rather than re-derived per guard, which is the way it silently comes out wrong.
The clip measures the rendered cost of a raw fragment and appends the truncation marker itself, so the fragment still takes its single escape at the sink and a planted `BEGIN` marker cannot consume the marker that says it was cut.
One recorded limit: the clip measures the whole raw fragment before cutting it, so a server-chosen error of extreme width costs one full-length escape pass at composition -- measured at 578 ms and roughly 235 MB transient for 8 MB of worst-expansion input -- on a path that then terminates the exchange.
The fragment is bounded after that measurement, not before it.

One value per link is the critical half of that assignment, not a tidiness rule: two values with first-party glue between them share one budget.
So the cap deletes the second outright at any width the first fills, and the first is then free to compose the very glue that would have introduced it -- a chooser forging the framing of a value the operator never received.
What stays on each summary is first-party copy and the bound's own numbers, at every site.
The CLI liveness guard's summary names the stalled operation and the refusal alone: how the operation stalled takes a labelled link of its own, so no width of it reaches the trailing first-party clause.
The one call site whose stall detail is not this side's prose -- the adapter's dead-session error, which relays the fatal error the server reported -- hands those bytes to a further labelled link instead of composing them into the first-party sentence that names them.
A link they shared with that sentence is one they could spend and then re-compose the framing of.
Classification is untouched: each stays a `UsageError` subclass, terminal in the poll loop under the [consumer-side terminal-error rule](TRANSPORT_LIVENESS.md#consumer-side-terminal-error-rule) and exit 64 at the CLI, and each keeps its `markStatesItsOwnNextStep` mark, which the CLI's hint-walker reads beside the error object rather than off its message.
One diagnostic residue is new with this composition: `FileSyncConnection.emit()` chains a superseded buffered error onto a terminal error only when that error has no `cause` of its own, and these refusals now always do, so a refusal that supersedes a buffered error still names it in the warn line but no longer shows it on the rendered chain.

That partition's residual is the host-key pair's residual, held the same way -- by a check rather than by this paragraph (`packages/core/test/connection/transportRefusalBudget.test.ts`, `apps/cli/test/unit/connection/transportRefusalBudget.test.ts`).
Every site is driven and rendered through `sanitizeErrorForDisplay`: the whole-exchange budget's five bounded operations through the real bound transport, the frame gate through a real poll cycle against a listing that declares an over-cap frame, and the CLI guards through the builders that compose them.
Each is asserted to hold the whole recovery sentence on a link of its own with no link truncating at all, so growing any fixed copy past a budget fails there rather than silently deleting the next step.
Ordinary sizes cannot see a link with two choosers, so every site naming more than one is driven again at a width where one link could not hold both.
Those sites are the frame gate at a message filename of 255 characters -- the bound the CLI's directory-listing guard enforces on every entry it enumerates, and the only bound such a name has, since neither core nor the SFTP protocol imposes one.
They also include the whole-exchange budget at a `rename` over a rendezvous directory nested one run deeper than the configuration examples.
They also include the directory-listing guard from either side, flooding one chooser and then the other, and the liveness guard from each of its three fragments -- its stall detail, its path, and the dead-session arm's server-reported error -- alone and in pairs, driven through the adapter's own dead-session composition rather than a restatement of it.
Each asserts the chooser that did not fill the budget arrives whole on its own labelled link, so folding two of them back together fails there rather than deleting one of the two; at the liveness guard the summary is asserted alongside them, since its trailing first-party clause is what a detail composed into it would cut.
The same deliveries also assert that no link truncates at the renderer and that the flooded link holds the truncation marker inside the per-value budget, so a fit dropped from a builder fails there rather than quietly moving the cut back to the renderer.
The frame-size guard's inbound path is driven that way from each of the two arms that raise the refusal, the streamed one and the fstat one whose summary also reports an observed size, since only one of them would fail a change that moved the path back onto that summary.
Both checks read the expected sentence off a minimal construction of the class instead of restating it, so an edit to the sentence cannot leave a stale copy passing.
Both also express "this link truncated" as a length comparison against the cap rather than as a marker search, because one first-party fragment -- the over-long filename's preview -- ends with that marker by construction.
Two limits are recorded rather than closed.
The site tables are enumerated, so a site added later is covered by the class-level half instead: constructed with its summary and each of its fragments flooded past every budget, the step still renders whole, which holds for any site without naming one.
And two constructions in `FileSyncConnection.close()` are outside both tables because neither reaches this renderer -- the terminal-frame drain's rejection is swallowed by its own catch, and the bounded `end()`'s is written to a debug log by message, which is the log path this cap does not govern.
The stalled-transport refusal's partition shares that log-path residual: its stall detail, path, and server-reported fragments ride cause links, so a diagnostic sink that prints only the error's message -- the superseding-buffered-error warn line and the close()-path debug lines among them -- holds the first-party summary alone, while every operator-facing renderer walks the chain and shows the links.

The accept-time reconcile refusal (`reconcileConflictMessage` in `apps/cli/src/config/reconcileDiffs.ts`) takes the same partition on one link rather than on a chain, because what a cut deletes there is a single recovery sentence rather than a step several links down.
Two things ensure it.
The recovery step is composed ahead of the conflict block, so the cap can only ever eat conflict detail -- which an operator can still read out of their own configuration and the invitation, unlike the sentence telling them what to do about it.
And the link's budget is shared out by provenance before any value is rendered: the fixed copy is measured where it stands, and the operator's own configuration path is fitted to a budget of its own (**128** rendered characters).
The conflict block is handed exactly what `COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH` leaves, inside which every line is charged the first-party skeleton it is named by and what remains is shared out among the value slots by need.
Each side is measured at what it would actually render to, a side takes only that, and what a short value leaves is available to a long one beside it.
A constraint therefore falls only on the sides too wide for the room -- eight ordinary disagreements are eight lines with both their values, however many of them there are, because the count of disagreeing fields is not what decides it.
A slot whose side is a clause of several values -- the rule-set citation's two names and two versions, the legal agreement's reference and expiry, or the directory-form hint's inbound and outbound locators -- shares its slot out among those values by the same rule, its own connectives measured and kept.
So a slot too small to hold everything degrades a value rather than deleting the clause structure behind it, and a partner-chosen set name at the schema's length cannot take the version, the ` over `, and the whole second half off both sides of the line.
So neither a chooser nor any one conflict line can spend another's room, and every disagreeing field is named whatever becomes of its values -- a field the operator is never told about is a difference they cannot go and resolve.
A side that cannot be given the least it displays as -- a delimited run showing some of its own bytes (**32** rendered characters), or a clause showing some of every value it names inside its own connectives (the truncation marker's own cost plus **8** per value) -- does not render cut back to punctuation and markers.
That line is named without its values, under a first-party line saying so, whether it is one wide line among short ones or a field list long enough to leave nothing for any of them.
A pair of sides that fit to the same text -- what redaction, or a clip, can make of two values that genuinely differ -- is shown as both sides fitted, under one explanatory line for the whole block, whose cost is taken out of the values' share before they are re-fitted.
So saying it never costs the line that needed it.
What the two sides share is the operator's whole reading of a value the display cannot show them, which a standin on the second side would delete.
Each value is redacted where it is interpolated, as the composition-site rule above directs, so a planted marker is replaced inside its own fragment rather than consuming the conflict lines behind it on the one link they all share.
Its control characters are replaced at that same site, which is what makes the `\n` this block separates its lines with structure only the block can place: the refusal is raised through `reconcileConflictError`, which states those lines to the display boundary, and the boundary escapes each on its own and joins them with the break -- so the operator reads the conflict list and the recovery step on the lines the block was written as, while a value's own line break stays inside a line as the `<0a>` marker.
The operator's own configuration path takes both treatments in the same order as a chosen value does, though it is not a chooser this message defends against -- a fragment exempted for its provenance is an assumption no check holds and a later caller silently breaks.

That budget's residuals are two, recorded rather than closed.
The cut lands where the budget falls, and where that is inside a delimited run what it cuts is the run's value: the fit keeps a prefix of the value and delimits that prefix again, truncation marker inside, so the run closes -- and closes on a delimiter Alcove composed.
The cut therefore cannot fall between the two characters of a doubled delimiter, which is the one place a partner's own quote could take over the closing of a run.
It also cannot leave a run open for what the composition placed after it to be read inside: the clause's own next value, or the other side of the line across its ` vs required `.
A fitted line's runs are the runs it was composed with, whatever budget it was fitted to and whatever widths the partner chose for the values that place the cut -- so a value the partner sized still cannot compose a boundary of its own, and every delimiter inside one is still doubled.
The treatment's markers are the other unit the cut may not fall inside: a cut landing between a marker's four characters backs off to before its opening `<` (`trimPartialControlCharacterMarker`, `packages/core/src/utils/sanitizeForDisplay.ts`, which the display boundary's own two cuts take as well).
So a fitted line holds whole markers or none, and its budget is an upper bound each cut can undershoot by up to three characters, and a line by up to that much per cut it takes, rather than a width it meets.
The back-off is one marker wide and taken once, which is what bounds that undershoot: a whole marker ends in `>`, which no proper prefix of one holds, so a single back-off removes the split marker's prefix and cannot expose another behind it.
A back-off repeated would walk over a run of the marker's shape spelled in a value's own printable bytes and delete them without bound, taking a shown side below the floor of its own bytes above.
So a fitted value can end in marker-shaped bytes of its own, which is the reading a value spelling a whole marker already admits.
That is held by a check rather than by this paragraph (`apps/cli/test/unit/config.test.ts`).

The block is driven at every budget from nothing to what the whole block needs, over values built to hold the module's delimiter throughout and to spell the line's own connectives.
Those values also spell the marker's own shape end to end, and spell a whole line of the block's own behind a line break, a carriage return, and the copy a notice opens with.
The printable domain and the control one together are what this sweep measures.
Each rendered line is read back as a clause skeleton under the module's own grammar, both over the raw block and over the whole refusal as the display boundary escapes it, pinned against the constructor in the same suite, as core's copy of that walk is.
The check fails if any line leaves a run open, and fails if a cut left a fragment of a marker standing where the truncation marker follows.
It fails if a hostile line rendered less of its own bytes than its inert twin by more than its cuts' back-offs, and fails if its clause skeleton differs at all from the skeleton the same widths render with inert values in place of the hostile ones.

What the operator is not given is the boundary between a cut value and the clause around it: the marker is plain printable ASCII the escape passes through, and it stands inside the cut value's own run, which is where a value spelling its text would put it, so such a value can claim a cut that did not happen.
What an operator can rely on is the marker's ABSENCE.
And the fixed copy fits its budget by measurement rather than by construction, which is held by a check rather than by this paragraph (`apps/cli/test/unit/config.test.ts`).
One case drives every fragment at once at the widest the linkage-terms schema admits of that fragment.
For a value the schema bounds only in length, that is a run of BMP code points at or above U+0100, which escape to six characters each against an astral code point's ten over two of the schema's UTF-16 units.
Where the schema also constrains a value's shape, it is the same bound in that shape's own characters, so a citation version is a semver spelled out to the full **256** characters that bound admits, past the ceiling core renders a value bare under and so a delimited run the fit divides its share with.
That case covers both names and both versions of the citation on each side, both legal-agreement references, the linkage-key list in the full-JSON form it falls back to and the linkage-field list as the delimited name list a by-name difference renders, a payload description at the free-text bound, and the connection locators.
It fails unless the recovery step and every field name arrive under the cap, unless the notice explaining a field named without its values is shown exactly when the block holds one, and unless every line that kept its values kept both of them.
Another case drives an ordinary refusal and fails if any part of it is cut at all, and a third drives eight ordinary disagreements and fails unless all sixteen of their values render whole.

## Consent summary display types

The invitation consent summary has a static half of its own, over the display structs rather than over sink call sites.
Both acceptance surfaces render that one summary - the web consent screen and the CLI accept prompt - so the half below covers each.
`sanitizeForDisplay` returns a branded string type - `Displayable`, a `string` intersected with a phantom property keyed by a `unique symbol` private to `packages/core/src/utils/sanitizeForDisplay.ts` - and every field of the invitation display structs that a partner-controlled value can reach and that is rendered is declared as that brand instead of `string` (`packages/core/src/consent/invitationSummary.ts`).
The one partner-controlled field left unbranded is a linkage key's raw name, which is held only as a React list key and never rendered - a runtime claim checked by the render-side walks described below, not one this section asserts.
Filling a branded field from an un-sanitized value is then a type error.
The guarantee runs in that direction only: the brand rejects a plain `string` assigned into a field already declared as the brand, and nothing forces a newly added field to be declared that way, so a new field declared `string` and filled from a partner value still compiles.
The runtime half covers what the type half cannot: a test builds the summary from linkage terms whose every partner-controlled string holds a control, bidi, or non-ASCII byte, walks the whole returned value recursively, and fails on any string outside printable ASCII - the raw key name is its single exempted position.
The same walk, run over the mounted consent screen and over the CLI prompt's emitted lines, catches a value that reaches an operator past the display structs entirely.
What the brand adds over that is the compile-time half: an existing field cannot silently lose its escape.
The brand is one-directional: a `Displayable` is still a `string`, so renderers, logs, and JSX text consume it with no cast, and it exists only in the type system - the sanitized bytes are identical with and without it.
Fixed first-party copy (a semantic-type label) and composed entries (a compact label plus its breadth marker) enter through `displayText`, a tagged template whose literal spans are necessarily the call site's own text and whose interpolations must themselves be branded or numeric.
What it bounds is the accidental omission: a deliberate `as Displayable` assertion, or a hand-built `TemplateStringsArray` passed to `displayText` as an ordinary argument, bypasses it.
One value on the CLI prompt is outside the brand's reach because it never enters the summary: the acceptor's own outbound-send column names, read from its operator's input file rather than from the partner's token, are escaped inline where the prompt's renderer emits them, which is their sink.
On the confirmation path, that emit reaches the prompt's own stream as well as the log.

That walk sees only the summary positions a fixture populates, so an optional field no fixture reaches holds nothing to inspect and passes it vacuously.
What closes that, without reintroducing a per-field list, is a companion check that reads the optional property paths off the `InvitationSummary` declaration and the summary structs nested under it - with the TypeScript compiler API, at test time, array and tuple indices collapsed so a path reads `linkageKeys[].elements[].transforms[].effect`.
The check collects the paths the fixtures populate, and fails naming any declared optional position none of them reaches.
An optional field added to a summary struct therefore fails the check until a fixture reaches it, with nothing to add to a list.
The reverse direction is asserted alongside it: a populated position the type walk never named fails as a derivation that stopped short of where values go.
A summary position one terms document cannot hold alongside the others is reached by a hostile-terms variant of its own rather than left uncovered, and each variant is both summarized by the object walk and rendered by the render walks (the mounted web screen and the CLI prompt), so every half covers the same fixtures.
A position no valid decoded token can populate is listed as an individually named exemption in that check with its reason recorded here, never as a blanket allowance that would swallow a newly unreached field; there is no such position - every optional position the summary declares is reached by a fixture.
