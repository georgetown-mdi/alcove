---
title: "Parsed-Input Bounds"
---

# Parsed-input bounds

This document specifies the application-layer bounds on the input Alcove parses, with their constant values and enforcement points: the count, length, width and depth bounds on partner-parsed collections and the JSON-decode chokepoint beneath them, the operator-local CSV-read single-line byte ceiling, the CSV header sanitation at ingestion, the linkage-terms name-class character rule, and the web linkage-terms import bounds.
It is the implementation-level complement to the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), which covers what each control protects against and why the design is sufficient.
It does not cover the memory bounds on what a transport reads (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md)), the regular-expression dialect a transform pattern runs under (see [TRANSFORM_REGEX_DIALECT.md](TRANSFORM_REGEX_DIALECT.md)), the bounds on transform-parameter values (see [TRANSFORM_PARAMETER_BOUNDS.md](TRANSFORM_PARAMETER_BOUNDS.md)), or the display sanitization escape format (see [DISPLAY_ESCAPE.md](DISPLAY_ESCAPE.md#display-sanitization-escape-format)).
Intended readers are security auditors and implementors.

Every net-new control specified here is subject to the explicit pre-release security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy); the per-section notes below repeat this only where a control has an extra scope nuance (an internet-facing surface, a new security-relevant dependency, or a modification layered on an existing control).

## Application-layer parsed-input bounds

The transport bounds in [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md) stop a hostile *server admin* from exhausting memory or hanging the link; a distinct control stops the authenticated *exchange counterparty* - a mutually-distrusting peer (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model)) - from exhausting CPU or crashing the parser with a pathological-count message.
The linkage terms (held in an invitation token and re-parsed off the post-handshake wire by `protocolSetup`) and every post-handshake wire message are validated with Zod, and a frame within the ~512 MiB [frame-size cap](TRANSPORT_BOUNDS.md#inbound-frame-size-bound) can still pack millions of *invalid* elements into a partner-controlled collection.
On Zod 4.5.4 that drives one of two `RangeError`s as Zod accumulates one issue per invalid element (both measured on that version): a collection nested two or more array/record/tuple frames deep overflows the call stack while Zod spreads that issue array up through the frames (`Maximum call stack size exceeded`, at ~130k elements).
A flat collection with no such frame instead makes Zod throw `Invalid string length` while it builds the error string, exceeding V8's maximum string length at ~3.3M issues after a multi-second CPU burn -- the `ZodError` message is the issue array `JSON.stringify`-d on the first read of `message` rather than in the constructor, so that throw lands wherever the failure is rendered rather than at the parse.
A plain `z.array(element).max(N)` closes neither: Zod v4 validates every element *before* the length check, so the issues accumulate before `.max()` can fire.

Two strategies bound the complete set of partner-parsed collections, chosen per field by whether a legitimate value is large:

- A collection legitimately in the millions - the PSI association-table indices, the payload rows / row indices, a partner's original-index list - has a single-issue validator (`packages/core/src/utils/singleIssueArray.ts`): it validates the element type in one `every` pass that emits at most one issue regardless of count.
  So an arbitrarily large *valid* message still parses while a hostile one fails as a clean, bounded rejection.
  A count cap is unusable here - any bound low enough to forestall the `RangeError` would reject a real result.
- A collection whose legitimate count is small - the linkage fields and keys, each constraint's `exclude` denylist, a transform step list, a key's elements, the payload `send`/`receive` column lists, the abort-reason list - has a count gate (`packages/core/src/utils/boundedArray.ts`).
  A permissive `z.array(z.unknown())` first stage accepts the array unvalidated, a count refine rejects an over-count array with one issue *before* per-element validation runs, and a `.pipe` re-validates the now count-capped array against the real element schema, preserving every per-element check and its issue path for an in-range array.
  The refine is `abort`, so an over-count value stops rather than letting the still-raw `unknown[]` flow on to a cross-field refine (which would dereference an unvalidated element).
  The `transform.params` record's key count is bounded by the same permissive-stage + count-refine + pipe shape, but with a bare **key count** (`packages/core/src/utils/objectKeyCount.ts`, `MAX_PARAMS_ENTRIES`) in place of the array length check.
  That count is still O(n) in the record's key count - a materialized `JSON.parse` object offers no sub-linear own-key count, and `for...in` enumerates eagerly - but it is the *cheapest* O(n) pass, and `for...in` avoids the result array `Object.keys(rec).length` would allocate and stops its body once the bound is passed.
  For this record the gate also closes a distinct linear event-loop burn, not the `RangeError` class above: a millions-key `params` record otherwise burns multiple seconds *twice* before its count is even checked, once in the snake->camel `camelizeKeys` pre-pass that runs ahead of Zod (`parseLinkageTerms`) and once in the permissive record stage.
  Each of those is an expensive per-key pass (a snake->camel rewrite, a per-key Zod parse); the gate replaces both with the single cheap key count.
  `parseLinkageTerms` hands the same bound to the camelize pre-pass, which leaves an over-count `params` value verbatim (handing it to the schema's refine, which rejects it) instead of rewriting every key.
  So the over-count record is counted but neither rewritten by the camelize pass nor per-key-validated by the record stage - cutting the multi-second burn to roughly one key enumeration rather than eliminating it (it stays O(n), bounded above by the frame cap).
  The `camelizeKeys` pre-pass walks arrays too, so the count-gated arrays above would incur an analogous pre-pass walk this per-record skip does not address; a global node budget in the walker (next paragraph) closes that, bounding the total the pre-pass rewrites rather than only this one record's width.
  The per-field count constants - 256 to 4096, each far above any real config and far below the `RangeError` thresholds - live beside their schemas in `packages/core/src/config/linkageTermsSchema.ts` and `packages/core/src/protocolSetup.ts`, except `MAX_LINKAGE_ENTRIES`, declared in `packages/core/src/config/linkageTermsBounds.ts` and re-exported by `linkageTermsSchema.ts`.

A LIST-valued `transform.params` value takes a count bound of its own, `MAX_TRANSFORM_PARAM_ENTRIES` (**4096**), on the record's value stage rather than in a per-function refine - the altitude the per-string `MAX_TRANSFORM_PARAM_LENGTH` sits at, so it holds for every function and param name at once, a param no function reads included.
Its threshold is the `exclude` denylist's because the one list a function reads is `null_if`'s `values`, which is a denylist of the values that drop a row.
The declared-type check that reads such a list emits at most ONE issue per param, naming the first entry that is not text (`packages/core/src/config/transformParamTypes.ts`), so the issue count a step raises is bounded by the params its function reads rather than by the width of a value the document declares.
That per-param bound, not the count bound, is what holds the safe-parse contract on the operator's own `standardization` block, which is not partner-controlled and takes no count gate.

A partner-supplied **signing certificate** is bounded the same way, on both frames that hold one -- the terms exchange's `certificate` field and the receipt swap's frame.
One bounded schema (`boundedWireCertificateSchema`, `packages/core/src/records/signingIdentity.ts`) length-caps every partner-controlled field of it: the `identity` at `MAX_TEXT_LENGTH`, and each base64url value (the two public-key coordinates and the self-signature) at 256 characters, far above the 43 and 86 a real one holds.
The `identity` must also be well-formed UTF-16: an unpaired surrogate has no canonical encoding, so the pin match and the self-signature check could not read it, and the parse refuses it like an over-bound value, with the abort frame the terms-time refusal sends.
The bound runs at the parse, before any fingerprint or signature work reads the value, so a frame within the frame-size cap cannot drive a hash or a curve operation proportional to a field above it.
The shared on-disk certificate schema, which parses an operator's own identity file, is unbounded by design; these two wire frames never use it.

Independently of the count/CPU-burn class above, the partner-supplied payload **column names** have a per-element length bound (`MAX_NAME_LENGTH` = 256, in `config/linkageTermsSchema.ts`), folded into the same single-pass `columns` validator (`payloadExchange.ts`) so it adds no per-element issue accumulation.
This is not a DoS control - the frame cap and the single-issue validator already bound a `columns` array of any size - but a data-hygiene one: a received column name flows verbatim into this party's local exchange-record file (the `governance.payloadReceived` categories of the audit artifact in [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)).
So the wire bounds its length to the same `MAX_NAME_LENGTH` ceiling the operator's own `terms.payload.receive` names have.
Both that upper bound and the `.min(1)` floor those local-terms names also have are enforced on the wire.
The floor is safe to enforce there because `inferMetadata` rejects an empty column name at intake (the disclosure-surface change in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)), so an honest sender never emits one -- not even from the trailing-comma CSV header that would otherwise produce a `""` column -- and the wire floor therefore cannot fail an honest exchange.
What it refuses is a partner who hand-crafts a `[""]` column to suppress this party's exchange record - an empty name would otherwise reach the non-fatal record-build guard, which skips the record while the exchange still completes and discloses, erasing the audit of a disclosure that happened.
The exchange-record schema (`RecordPayloadColumn.name`) applies both the `.min(1)` floor and the same `MAX_NAME_LENGTH` ceiling independently, so neither an empty nor an over-long name can reach the on-disk record by any path - the write path rejects it at record build (the non-fatal build guard then skips the record, leaving the exchange result unaffected) and the read path rejects it at parse.
The ceiling is safe against an honest sender for the reason the floor is, and by a matching gate rather than by luck: `assertDisclosedNamesCarriable` (`payloadExchange.ts`) refuses a disclosed column name longer than `MAX_NAME_LENGTH` at the local prepare step and again at the run boundary (`prepareForExchange` and `runExchange`), before any credential, terms, or data are sent.
So a `PreparedExchange` assembled outside prepare is refused too - gated on `output.shareWithPartner`, the same output gate `assertPayloadSendDisclosed` applies to its empty case, since a party whose partner is entitled to no result transmits no column and has no name.
That is what keeps the wire bound from being the first enforcement for a name the sender's own CSV header supplied -- inferred metadata passes through no schema -- so the ceiling refuses a crafted partner rather than failing an honest exchange mid-frame.
Both mint boundaries read the same `overlongDisclosedColumnPositions` predicate (`config/metadata.ts`) over the metadata they publish a disclosed set from, so neither `alcove invite` nor the web inviter mints a token naming a column the exchange it commits to could not hold.
Both counts are UTF-16 code units (`maxCodeUnits`, `packages/core/src/utils/maxCodeUnits.ts`, the check the string length bounds under `packages/core/src` and `apps/web/src` are written with -- Zod's own `.max()` counts code points from Zod 4.5.0 on, and `packages/core/test/config/lengthBoundUnitParity.test.ts` holds the schema bounds and the hand-written predicates to the one unit; which bounds use it is held by an ESLint selector over `packages/core/src` and the web app's `src` and `server` trees, refusing a bare `.max()`, `.length()`, or `.min()` above 1 on a `z.string()` chain -- it reaches a bound written on the chain itself, through up to the intermediate calls its own header in `eslint.boundaries.mjs` states, and not one applied to a schema held in a variable, so what it holds is the shape it can recognize by text and not every string bound), on the wire, in the record, and at that send-side gate, so the three cannot disagree about which names are carryable; the web app's display cut on a column name counts code points and bounds only what paints (`apps/web/src/components/ColumnName.tsx`).

Three acceptance surfaces bound a partner-declared name list by count as well as by length.
The acceptor's confirm-columns step states a payload-declaration conflict by listing the columns the invitation declares that the operator's marks do not send.
The acceptor's consent screen renders the invitation's declared `payload.send` and `payload.receive` lists one item per entry behind its details disclosure.
The CLI accept prompt emits those same two declared directions one indented line per name, above the consent decision it stops at.
Every one of those lists is the partner's: `MAX_PAYLOAD_ENTRIES` (**4096**) names, each escaping to `DEFAULT_MAX_DISPLAY_LENGTH` (**256**) plus the truncation marker, is roughly a megabyte of printable text.
That text sits above the metadata grid and the launch control on the one screen that holds the gate, behind the details disclosure on the one screen that holds the consent decision, and between the operator and the question on the terminal that asks it.
The result is usability denial rather than injection, the names being escaped.
That megabyte is the ceiling's arithmetic rather than a delivered size.
All three surfaces take their declaration from `decodeInvitation`, which refuses an encoded invitation above `MAX_ENCODED_INVITATION_LENGTH` (**64 KiB**) before it parses, so a declaration that arrives at any of them reaches roughly 346 such names - about 93 KB of painted text and a thousand-odd terminal rows, measured through the CLI prompt.
The cap is sized to the schema ceiling because the schema admits it; what it forecloses in practice is that 93 KB.
Each surface therefore paints at most `MAX_DECLARED_NAMES_SHOWN` (**10**) names per list and closes a bounded list on the sentence stating how many it did not paint, all three reading that constant and that sentence from one module (`packages/core/src/consent/declaredNameBound.ts`), applied in `apps/web/src/exchange/AcceptorColumnsStep.tsx`, `apps/web/src/components/InvitationTerms.tsx`, and `apps/cli/src/invitationDisplay.ts`.
The module sits in `@alcove/core` rather than in either app because `apps/` consumes `packages/` and never the reverse, so a bound two app workspaces share has no home inside one of them.

The cap is on what is painted only.
The remedies the conflict notice offers, the refusal itself, the direction labels with the declared total each of them states and their `(none)` cases, the count-only cross-check the CLI prompt runs over both declared directions, and the always-visible direction counts the consent screen states beside its lists are all derived from the whole declared set.
On the CLI the bound is applied at the two declared-payload call sites rather than inside the shared `logList` renderer, which also emits the already-bounded `transform.params`, the declared data standards, and this party's own outbound-send columns - none of them a partner-reachable `MAX_PAYLOAD_ENTRIES` list.
The count bound closes the declared-payload vector only: every other list on these surfaces is bounded at its schema source rather than capped at the render, and the linkage-key block - `MAX_LINKAGE_ENTRIES` (**256**) keys of up to `MAX_KEY_ELEMENTS` (**256**) elements, each element painting several lines through the uncapped `logList` path - stays the larger partner-controlled render on the same surface.
Each rendered bound is driven at `MAX_PAYLOAD_ENTRIES` with every name at the escape's own cut (`apps/web/test/browser/acceptDeclaration.test.ts`, `apps/web/test/browser/invitationTerms.test.ts`, `apps/cli/test/unit/commands/accept.test.ts`).

One residual is distinguished rather than removed: `sanitizeForDisplay` passes printable ASCII verbatim, so a declared name can read exactly as the unshown-count sentence for its direction, and what tells the first-party line apart from such a name differs by surface.
On the web it is list placement - the name paints as a bulleted item inside that direction's list container while the count line renders outside it, and the always-visible direction counts state the whole declared magnitude either way (`apps/web/test/browser/invitationTerms.test.ts`).
A line-oriented terminal has no such container, so on the CLI it is the bullet prefix, and the claim is at the level of the lines the prompt emits.
Every painted name is emitted as `- <name>` at the list indent and cannot break its own line to shed that prefix (the escape neutralizes every control code point), while the count line is emitted at the same indent with no bullet (`apps/cli/test/unit/commands/accept.test.ts`).
What the terminal's rows show is a stated limit rather than a claim: soft wrap starts a continuation row at column 0 and `sanitizeForDisplay` passes an ASCII space verbatim, so a name padded to the wrap boundary reproduces the bare count row byte for byte at a matching width (measured at 80 columns).
That residual is left open - any printable prefix would be equally fakeable, the renderer cannot know the terminal's width, and the genuine count line still prints exactly once per bounded direction, which is the signal the true remainder is recoverable from.
The CLI's heading for each declared direction states that direction's whole declared count beside the label's basis marker - first-party text no partner string precedes, read from the declared set rather than from the painted subset - so the magnitude the count line states is corroborated from a position the wrap residual does not reach (`apps/cli/test/unit/commands/accept.test.ts`).

The `camelizeKeys` pre-pass has its own global width bound, the running-total analogue of the per-record `params` skip and of the pre-pass's existing `MAX_NESTING_DEPTH` = 256 depth bound.
The snake->camel rewrite is O(total nodes) and runs ahead of all Zod validation, so a partner payload wide enough - within the frame and decode-layer caps - would burn multiple seconds before any count gate fires.
For a wide object placed under an unknown top-level key the non-strict schema then silently strips it, so the parse succeeds after the burn rather than rejecting (worse than a rejection, since nothing is reported).
A single node counter threaded across the whole walk - `MAX_NODE_COUNT` = 262144, one object member or one array element per node - rejects such a payload with a clean, terminal `NodeCountExceededError` (a `UsageError` like the depth bound, fixed message with no input bytes) before the rewrite completes.
An over-wide array is refused by its O(1) length before `.map`, and an over-wide object by a streaming own-key count before `Object.entries` materializes it, so neither the burn nor the materialization runs.
A running total, not a per-container cap, is required to catch both a single wide object (path a) and width spread across many small ones - the count-gated arrays of objects, each walked in full before its `boundedArray` refine could fire (path b).
262144 (2^18) sits far above any realistic operator `ExchangeSpec` - low tens of thousands of nodes at most (the single widest object is a `transform.params` record at `MAX_PARAMS_ENTRIES` = 256, collections cap at 256 to 4096 entries) - and far below the burn, which reaches a multi-second cost only past ~1M nodes (measured).
Rejecting at this budget caps the wasted walk well under a second.
Like the rest of this family it is defense-in-depth, not a semantic limit: the per-collection caps do compose to a schema-valid maximum above the budget (256 `linkageFields`, each with a 4096-entry `exclude`, is ~1M nodes), so a pathological-but-schema-valid config could trip it - but no real operator config comes within an order of magnitude.
It composes with the per-record `params` skip without double-counting - a skipped subtree (an opaque value, or an over-count width-bounded value) is not recursed into and so never counts toward the budget.
A massively over-count partner collection is therefore refused by this budget before Zod (the boundedArray count gate still rejects a moderate over-count that stays under the budget), and the throw is caught by the same `parseLinkageTerms` parse-error path that already handles the depth bound.

The `MAX_NESTING_DEPTH` = 256 depth bound the `camelizeKeys` pre-pass applies is enforced on all four linkage-terms parse paths, the invitation decode path and the signed receipt's carried `partnerTerms` included.
`decodeInvitation` normalizes the keys of `linkageTerms`, `transform.params` among them, to camelCase through the bounded `camelizeKeys` chokepoint (the camelize pre-pass in `packages/core/src/config/invitation.ts`) as it validates the token against `InvitationTokenSchema` -- folding before the per-step length and dialect screens so they run on the normalized form.
A partner-controlled one-key-per-level `params` - bounded otherwise only by the 64 KiB `MAX_ENCODED_INVITATION_LENGTH` cap and `parseBoundedJson`'s `MAX_JSON_NESTING_DEPTH` = 4096 decode ceiling, both above the ~2000-level native call-stack limit - is rejected at decode with a terminal `NestingDepthExceededError` (a `UsageError`, CLI exit 64 / a clean web decode error via `describeDecodeError`) before it reaches any downstream consumer.
The normalization MUST use the bounded `camelizeKeys` walk for exactly this reason: a raw snake->camel recursion over the schema-opaque (`z.unknown()`, decode-unbounded) `params` value would itself overflow the stack.
Because the field is normalized at the decode chokepoint, every consumer of a decoded invitation's terms - the canonical comparison, the reconcile, the agreed-terms hash, the standardization runtime - inherits both the camelCase form and this depth bound, rather than each having to re-impose it.
The CLI's invitation-vs-config reconcile (`apps/cli/src/config/reconcileDiffs.ts`, `withoutUndefinedDeep` reached via `diffLinkageTerms`) nonetheless threads its own depth counter and rejects at the same 256 as a safety check.
`withoutUndefinedDeep` is an independent recursive walk that must not couple its safety to its callers having pre-bounded the input, and an unguarded deep value would otherwise overflow it with a `RangeError` the CLI command boundary maps to a generic internal-error exit (69) - catchable and non-fatal, but ungraceful, and distinct from the uncatchable `JSON.parse` aborts the decode-layer bound below guards.
With decode and config load both bounding their own side, that safety check is not normally reachable; it stays as defense-in-depth.
The bound fires far below the overflow and far above any real config (the deepest schema path is under a dozen levels, and `params` legitimately holds shallow scalars).

A further bound sits *upstream* of the entire Zod/`camelizeKeys` family above, at the JSON-decode layer, and is enforced as a single chokepoint.
Every parse of untrusted JSON in the core routes through `parseBoundedJson` (`packages/core/src/utils/boundedJson.ts`), which checks the body's structure against a per-object key ceiling, a per-array element ceiling, and a nesting-depth ceiling (`MAX_JSON_OBJECT_KEYS` = 65536, `MAX_JSON_ARRAY_ELEMENTS` = 16777216, `MAX_JSON_NESTING_DEPTH` = 4096) *before* handing it to `JSON.parse`.
A lint rule forbids a raw `JSON.parse` elsewhere in the package, so a new parse site cannot silently reopen the hole.
Unlike the rest of the family this is not a CPU-burn or `RangeError` guard.
A single object made wide enough, or a single array made long enough, drives `JSON.parse` into a process-terminating internal limit of the JSON engine - a per-object property ceiling, or the array backing-store length limit - that is *not* a thrown exception, so a `try`/`catch` around the parse cannot intercept it (the engine's per-object and array-length limits are V8 behavior that was unverified as of 2026-09-29, and the ceilings named here are chosen to sit well inside them).
The only defense is to refuse the body before the parse can reach either limit, not to catch its failure.
The check is a single O(n) pass over the raw UTF-8 bytes (or the already-decoded string a transport hands over) - the JSON structural markers are unambiguous ASCII in either representation (a single byte in UTF-8, a single non-surrogate code unit in UTF-16).
It counts each object's members (by colon) and each array's elements (by separating comma, one fewer than the elements, so an array admits one element past its ceiling) against its own ceiling, with early exit.
On the byte path an over-budget body is refused without even allocating the decoded string.

This chokepoint covers both threat-model adversaries, not only the counterparty.
The post-handshake `TYPE_JSON` frame is decoded through it after AEAD decryption (the *counterparty*'s reach); but the file-sync transport's own reads - the peer-hello control file and every message body - are JSON-parsed off the raw inbound file *before* decryption, so they are shaped by the hostile *server admin*, and the invitation token is parsed from attacker-influenced bytes a victim opens.
All route through the same chokepoint, so a wide-object or long-array body from any source is refused rather than crashing the process.
Each caller maps the refusal to its own terminal error - a `ConnectionError("security")` on the wire, a `UsageError` on a transport file, a rejected invitation - with no attacker bytes.

The unit is per *container*, not per byte or per total count, because that is what fits the data *at this layer*: a decoded-byte or total-count budget here would have to sit below the largest legitimate message and so would reject it, yet no single legitimate container is pathological.
(The `camelizeKeys` total-node budget above *can* be a running total precisely because it sees only the small parsed-config family - linkage terms and the like - never these large set frames, which are parsed by other schemas the pre-pass does not touch.)
The widest legitimate object is the `transform.params` record at `MAX_PARAMS_ENTRIES` = 256; the longest legitimate array is an association-index, payload-row, or mapped-pair list, one entry per matched record; a list that can pass this cap is sent in parts, each a message of its own held to it ([PROTOCOL.md, A list of matched records is sent in parts](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts)).
So `MAX_JSON_OBJECT_KEYS` sits far above any real object and far below the per-object engine limit, and `MAX_JSON_ARRAY_ELEMENTS` sits above any real array and well below the array-length limit - each fires only on a pathological container and never pre-empts a schema-layer rejection or a legitimate large message.
The depth ceiling sits far above any real nesting (the parsed-config ceiling is `camelizeKeys`' `MAX_NESTING_DEPTH` = 256) and exists chiefly to bound the scan's own per-container stack against a degenerate all-`{`/`[` body, which would otherwise exhaust memory in the pre-pass.
This bound composes with rather than overlaps the post-parse `camelizeKeys` bounds.
It caps any single container's width before the walker ever sees it, while the walker's own `MAX_NODE_COUNT` budget (above) caps the total it then rewrites - a width the per-container ceiling does not bound (a body within every per-container limit can still hold far more nodes in aggregate than the walker should rewrite).

The severity is defense-in-depth, not a live vulnerability: the counterparty is authenticated and can already abort the exchange trivially, and most of these sites already report a clean refusal rather than an ungraceful throw - a `receiveParsed` / `parseOrProtocolError` wrap reports a `ConnectionError("protocol")` from whatever `schema.parse` throws, and the linkage-terms parse-error catch aborts the same way.
The stack-overflow `RangeError` is what `parse` throws, so the wrap catches it directly; the string-length `RangeError` is not, since the `ZodError` message builds lazily - the wrap sees only the unread `ZodError`, and that `RangeError`, if the issue list is that large, fires only where the cause's message is first read.
Both read sites already guard that read: `sanitizeErrorForDisplay` reads each link's message inside its own `try`/`catch`, and the linkage-terms parse-error catch reads `issues[0].message` rather than `err.message`.
So the bound turns an ungraceful internal exception and a one-shot CPU burn into a clean, bounded rejection rather than closing a memory or correctness break.
The decode-layer chokepoint is the sharper of the set - it forestalls an uncatchable process crash, an availability loss the others do not reach, rather than a recoverable burn - but rests on the same reasoning.
The crash kills only a session its instigator already controls - the counterparty it is party to, or the transport a hostile server admin already mediates and can disrupt at will - so it too is defense-in-depth against a self-limited adversary, not a live vulnerability.
The set of accepted messages is unchanged: each single-issue predicate mirrors the element schema it replaces, and each count gate's `.pipe` re-runs the original element schema, so a legitimate exchange parses to a byte-identical structure (the cross-party receipt hash is preserved).

## CSV-read single-line byte ceiling

`CSV_LINE_BYTE_CEILING` (8 MiB, `packages/core/src/file.ts`) is the one bound in this application-layer parsed-input family with no adversary.
Every bound above answers a specific attacker -- the authenticated counterparty or a hostile server admin -- and the section's framing turns on which one.
This bound answers none of them: it guards the operator's own local CSV, an input no partner or transport supplies, so it is operator-local input robustness, low severity and non-gating, not a partner- or transport-reachable bound and not a threat-model control like the partner-parsed bounds it sits among.
It is recorded here only so a parse-surface audit finds it beside the input bounds it belongs with rather than as the lone undocumented one; read it as defense-in-depth on the operator's own file, not as a control any threat-model adversary reaches.
The two streamed CSV reads share the one constant: `loadCSVColumnSample` (the `init` column- and date-format inference read) and `loadCSVFile` (the whole-row invite/accept/exchange read).
PapaParse must buffer one whole logical line -- a data row, or the entire header -- before it can yield a chunk, so an input whose first terminator is far from the start (a no-newline file, one enormous field, or a multi-megabyte header) would drive memory, and CPU quadratically via repeated re-splitting of that partial line, with the span.
The ceiling bounds the bytes pulled between row terminators so those shapes fail fast with a clear, operator-readable error.
**8 MiB** sits above any realistic operator CSV's single line -- even a pathologically wide file of tens of thousands of columns is a header of low single-digit MiB and a data row far smaller -- and below the hundred-MiB-plus spans that drove the gigabyte-scale memory growth it guards against.

The enforcement mechanics stay in the code and are not reproduced here: the JSDoc on `loadCSVFile`, `guardStreamLineByteCeiling`, and `assertLeadingLineWithinByteCeiling` (all `packages/core/src/file.ts`) describes the split.
The Node stream's `data`-event byte counter (`guardStreamLineByteCeiling`) bounds every line by destroying the source past the ceiling; the browser-`File` pre-read (`assertLeadingLineWithinByteCeiling`) bounds only the leading line before parsing because a `File` exposes no `data` events to scan.

What the spec states, because it is classification rather than mechanics, is the one shape this bound does not cover.
Both enforcement points scan raw bytes and treat any LF or CR (`0x0a`/`0x0d`) as a line terminator -- including a byte inside an RFC 4180 quoted field.
That is the deliberate fail-safe direction: ignoring quoting can only let a pathological line slip past (a false negative), never wrongly reject a valid file (the false positive a quoting-aware scan could produce on a legitimate quoted newline).
The cost is one unbounded shape -- a single logical CSV row that is one enormous quoted field containing embedded newlines: the scan resets its run at each embedded newline and never trips, while PapaParse buffers that whole quoted field as one logical row, memory proportional to the field with quadratic re-split CPU.
That shape is bounded not by this ceiling but by the input being operator-local (the CLI sets no file-size cap) or, on the web, by the web app's `MAX_CSV_FILE_BYTES` intake cap; it is not a regression, since the read was unbounded for that shape before this ceiling existed too.
Being operator-local and non-gating rather than a partner- or transport-reachable vulnerability, it is recorded openly here, not withheld.
The caveat also lives in the code (the `guardStreamLineByteCeiling` JSDoc and an inline comment in `assertLeadingLineWithinByteCeiling`); this note exists so spec and code agree on what the bound does not cover.
Unlike the partner-parsed bounds in this family, the ceiling is not net-new security behavior gated on the explicit security review -- it is operator-local robustness, so it has no such gate.

## CSV header sanitation at ingestion

Every CSV read in `packages/core/src/file.ts` applies one header transform: each column name loses every character `NAME_CONTROL_CHAR_PATTERN` (`packages/core/src/utils/nameControls.ts`) holds, and the 1-based positions of the names that lost one are reported on the parse metadata (`CSVParseMeta.sanitizedColumnPositions`).
The class has two halves.
The control characters: C0 including NUL, tab, LF and CR (`U+0000-001F`), and DEL with the C1 controls (`U+007F-009F`).
And the nine Unicode bidirectional formatting characters -- `U+202A` LRE, `U+202B` RLE, `U+202C` PDF, `U+202D` LRO, `U+202E` RLO, `U+2066` LRI, `U+2067` RLI, `U+2068` FSI, `U+2069` PDI (Unicode UAX #9).
The implicit marks `U+200E` LRM, `U+200F` RLM and `U+061C` ALM are outside the class: they open no scope that outlives the name they sit in.
Letters are untouched, so an accented, CJK, or emoji header passes through whole.

The class is exactly what the [name-class rule](#linkage-terms-name-class-character-rule) below refuses, held so by a sweep over every BMP code point (`packages/core/test/config/nameShapeParity.test.ts`) that fails if either moves without the other.
So a name this read derives from a header never meets that refusal, and no character a name may keep is taken out of a header.

Like the byte ceiling above, this guards the operator's own local CSV rather than partner- or transport-supplied input, so it is operator-local robustness rather than a threat-model control.
What it removes is a name that reorders the copy it is placed beside -- a consent or disclosure sentence composed around such a name can be made to read as naming a different column from the one it acts on -- and a name holding a character that ends the line a diagnostic or a CSV row is composed of.
Nothing legitimate in a name needs either: a right-to-left or mixed-direction label lays out correctly from its own characters.

Two properties are what the spec fixes rather than the mechanics.
It is at the **parse boundary**, so every name a consumer derives from the header is the sanitized one: metadata inference, the linkage terms derived from it, the disclosed payload column list those produce, and the invitation the partner receives.
A name a document declares rather than derives -- an explicit `metadata` block, a linkage field, a standardization output -- is outside the boundary, since no read of the CSV produces it; refusing the first two belongs to the [name-class rule](#linkage-terms-name-class-character-rule) below.
PapaParse keys each row object by the header string the transform returns, so no re-keying pass follows and no column's values are lost.
And it is in **core**, the one boundary the browser read, the console server's profiling pass, and the CLI's own read all cross, so both parties describe a column the same way whichever seat read the file.

It removes rather than refuses.
The header is the operator's own, an operator who cannot edit a vendor export would lose the exchange over a character that carries no meaning in a name, and the removal has already made the name safe to show and to send.
The web intake seats, the CLI's shared input loader, and init's column-sample read state which column positions changed, never echoing the header -- echoing it would put the removed characters back into the copy the notice exists to keep readable.
The web intake surfaces show a notice on the screen; both CLI reads of an operator CSV -- the shared input loader (`loadInputRows`) and the bounded header-and-sample read `init` authors a configuration from (`loadCSVColumnSample`) -- write that warning line through one function (`warnSanitizedColumns`, `apps/cli/src/onlineBootstrap.ts`), so an operator on either seat is told before the changed name is matched on, sent, or written into a configuration.

What the removal changes, measured by driving the pinned parser rather than modeled (`packages/core/test/file.test.ts` for the columns each shape yields, `packages/core/test/config/metadata.test.ts` and `apps/cli/test/unit/onlineBootstrap.test.ts` for what the refusal and the notice then state), is exactly the files it targets.
A header made only of these characters becomes an unnamed column, refused by the unnamed-column refusal every intake already applies, which states the removal as the cause.
Two headers differing only by these characters collapse to one name and reach PapaParse's own duplicate-header renaming -- `name` and `name_1`, the pair a header holding two identical names already reaches -- so both columns' values stay reachable under a header.
Every other file yields the columns its header spells with these characters taken out, and is accepted or refused on the terms a header that holds none of them meets.

A document that names a column by the header as typed is refused where it is parsed rather than reconciled against the header.
A terms name meets the [name-class rule](#linkage-terms-name-class-character-rule) below; an explicit `metadata` block's column `name` meets the same shape under a message naming that block (`packages/core/src/config/metadata.ts`).
Either way the load fails, naming the field by its issue path and printing none of the value, so no name a configuration declares reaches matching, disclosure, or a record with this class in it.
A `standardization` `output` or `input` is outside both rules: it names a linkage field and a column of this party's own input, neither of which is sent to the partner.
It is inside a length bound: `StandardizationTransformationSchema` (`packages/core/src/config/standardizationSchema.ts`) requires a non-empty string of at most `MAX_NAME_LENGTH` characters, the same ceiling every other name a configuration declares has.
A header inferred from this party's own file is under no length bound (`inferMetadata` applies none), so a configuration naming a longer header as an `input` is refused at load where it parsed before -- a stated limit, taken so the pair carries the bound every declared name has.
The web job intent holds both to the same bound at its own boundary (`apps/web/src/jobContract/intentSchemas.ts`).
A record minted from such a header holds the name the mint recorded, so verifying it against a read of the same file is the same shape; that one is stated from the mechanism rather than measured.
`verify-receipt`'s two reads of the operator's input and result CSVs (`loadCSVFile`, `apps/cli/src/commands/verifyReceipt.ts`) strip these characters too but report nothing, so a record minted before this change from a header holding them reconstructs against the header these reads now strip and fails as a reproduction mismatch that never names the removal as its cause -- unmeasured, the same shape as the case just above.

A partner-supplied name is not this boundary's: it reaches no CSV header of this party's.
The [name-class rule](#linkage-terms-name-class-character-rule) below is what covers it, refusing a linkage field's name or a terms payload column name where the terms are parsed, rather than repairing it.
That division is the trust boundary -- the operator's own header is repaired, a partner's name is refused -- not a disagreement about the class, which is the same on both sides.

Between the two boundaries, no column name this party holds can carry the class to the partner: a name derived from the header loses it, and a name a document declares -- in the terms or in the `metadata` block -- is refused where the document is parsed, so the invitation's `payload.send` is built from names already held to the shape (driven against the built CLI: `alcove init` and `alcove invite` over a header holding a tab exit 0 with the notice, and a configuration whose `metadata` declares a name holding one exits 64 at load, naming the field).
The inbound direction is closed by the same shape rather than by this boundary: a partner's `payload.send` is a column-name list the token schema holds, so the `payload.receive` an acceptance mirrors from it cannot write one into this party's configuration.
What stays outside the name rule, and why, is stated with the rule below.

## Linkage-terms name-class character rule

The name-class fields of a linkage-terms document -- a linkage field, key, or element `name`, an element `field` or `swap` reference, a transform `function` name and a transform `params` record key, a payload column `name`, a legal-agreement `reference`, and a rule-set set `name` -- match `NAME_SHAPE_PATTERN` (`packages/core/src/config/linkageTermsSchema.ts`) beside their `MAX_NAME_LENGTH` cap.
It admits everything but two classes: the control characters `TEXT_CONTROL_CHAR_PATTERN` refuses in the document's four free-text fields (C0 with NUL, DEL, C1, and no exception for tab, LF, or CR), and the nine bidirectional formatting characters of Unicode UAX #9.
Together they are the class the header sanitation above removes.
Letters are untouched.
Unlike the header sanitation, this is a partner-reachable control rather than operator-local robustness: the terms arrive in an invitation token from an unauthenticated counterparty and again off the post-handshake wire, so it belongs with the parsed-input bounds above.

The rule is applied at each FIELD, in its own shape, as the `version` semver regex already is -- not as a pass over the class.
So it holds on every path that parses terms, each embedding the same schema: the operator's own config load, the post-handshake re-parse, the invitation-token decode, and the exchange-file and job-intent schemas.
A document holding such a character is refused before any row runs, and the refusal locates the field by Zod issue path with a fixed message that echoes no submitted value, exactly as the free-text refusal does.

**The operator's own metadata block.**
An explicit `metadata` block's column `name` takes the same shape, under a message naming that block (`packages/core/src/config/metadata.ts`).
That block is the operator's own input rather than a partner's, so the rule is not a threat-model bound there; it is the same notion of a name at the third boundary one crosses.
The block names the columns matched on, and each disclosed one reaches the partner in the invitation's `payload.send` and both parties' records, so a name it declares is a name rather than a data value.
The BMP sweep holds the block's schema to this same class.

**The payload column lists.**
A terms `payload.send` and `payload.receive` name columns rather than terms, and they cross the boundary in both directions: an inviter mints its `payload.send` from its own metadata, and an acceptance mirrors it into `payload.receive` in the operator's configuration file, which the operator's editor and tooling that is not Alcove both read.
Holding the token's terms to the shape (`PayloadColumnSchema`) is what keeps a partner's control or text-direction character out of that file, and holding the configuration's own terms to it keeps a hand edit from putting one there.
The `linkage_terms.payload.receive` a first run fills into the configuration takes the partner's stated `payload.send`, whose parse at the terms exchange already holds each name to this shape (`PayloadColumnSchema`), so a configuration the fill writes reloads.

**The alignment with the header read.**
The class this shape refuses is exactly the class the [header sanitation](#csv-header-sanitation-at-ingestion) above removes, so the two boundaries do not disagree about what a column may be called: a name derived from a header never meets this refusal, and nothing a name may keep is taken out of a header.
A BMP sweep holds the equality in both directions (`packages/core/test/config/nameShapeParity.test.ts`), so a range added to one without the other fails.
The direction differs by whose input it is -- the operator's own header is repaired (removed and reported), a partner's name is refused -- and that is the trust boundary, not an inconsistency about the character class.

**What stays out, and why.**
A transform `params` string value (bounded at `MAX_TRANSFORM_PARAM_LENGTH`) and a name-constraint `allowedCharacters` class (bounded at `MAX_NAME_LENGTH`) are length-bounded only: each is data a step matches or substitutes with rather than a name, so a tab is a plausible delimiter and a line feed a plausible replacement, and a character rule there would refuse legitimate terms.
A `params` record KEY is not: it is the parameter's name -- the label a step's implementation is looked up by -- so it matches `NAME_SHAPE_PATTERN` beside its `MAX_NAME_LENGTH` cap, like the `function` name beside it.
`version` needs no rule of its own, its semver regex admitting neither class already.
And the exchange-record reader (`records/exchangeRecord.ts`) and the wire-certificate schema (`boundedWireCertificateSchema` in `records/signingIdentity.ts`) stay permissive toward what a possibly different-version writer recorded, relying on display escaping at their render sites, as [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#record-fields) states.

**Not redundant with the display escaping.**
The escaping at each render site neutralizes a name on its way to this implementation's own screens, logs, and errors.
A name also reaches each party's exchange record verbatim -- the matching-basis account names each field and type, the payload accounts each column -- and a record is read by tooling that is not Alcove, where no display boundary of ours stands.
The schema rule is what keeps such a name out of the artifact rather than out of one rendering of it.

**The three free-text fields a record holds.**
That argument reaches three fields that are not names as well: the party `identity`, the legal agreement's `purpose`, and a payload column's `description`.
Each is written into both parties' exchange records as the document states it (`packages/core/src/records/exchangeRecord.ts`), where a layout scope opened in one of them reorders the copy a reader outside Alcove sees.
So each refuses the nine bidirectional characters beside the Cc controls every free-text field refuses, reported at the field's issue path under a fixed message of its own (`TEXT_DIRECTION_MESSAGE`) that echoes no submitted value.
The implicit marks `U+200E`, `U+200F` and `U+061C` stay admitted, as they do in a name.
The refusal holds on the same paths the name-class rule holds on.
Two operator-side intakes bind a party `identity` into a signing certificate without parsing a terms document -- `alcove fingerprint` and the console's shared label contract (its browser guard, the zero-setup intent, and the signing-fingerprint route) -- so each holds the label to this class and the Cc one at its own boundary, and a certificate cannot bind a label holding a character the terms can never hold.

**Private-key material in a party identity.**
The `identity` refuses one thing beyond those two character classes: text the display's private-key redaction would replace (`PRIVATE_KEY_IDENTITY_MESSAGE`, `packages/core/src/config/linkageTermsSchema.ts`, reading the same `holdsPrivateKeyMaterial` detector the [transform-step refusals](TRANSFORM_PARAMETER_BOUNDS.md#transform-parameter-declared-types) read).
The field is the one line of an invitation a reader reads as the partner naming itself, so a `[redacted private key]` standing there is indistinguishable from a marker Alcove placed over a key it found; refusing the document is what keeps the marker on the consent summary meaning what Alcove puts it there to mean.
The rule is the field's, not the free-text class's: a legal-agreement `purpose`, a payload column `description` and a constraint `exclude` value keep the redaction alone.
It holds on the same paths the two character rules hold on, and the acceptor's own name meets it before substitution (`deriveAcceptedLinkageTerms`, `packages/core/src/linkageTermsNegotiation.ts`), so an operator is told about the name it typed rather than about an invitation it cannot accept.
The two certificate-label intakes above apply the same private-key rule themselves (`alcove fingerprint` and the console's label contract, each reading `holdsPrivateKeyMaterial` beside its character rules), so a label holding key material is refused at the intake and again when the terms that hold it are parsed.

**What the direction rule leaves out.**
It is applied at those three fields rather than to free text as a class.
A constraint `exclude` value keeps the Cc-control rule alone, standing where a transform `params` string value and a name-constraint `allowedCharacters` class stand: each is data a step matches or substitutes a field's contents with, so what it may hold is what the data may hold, and none of the three reaches a record -- a record holds names, descriptions and references, never a value ([EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#record-fields)).
The class is measured over every BMP code point with all three record-bound fields set to the swept value in one document (`packages/core/test/config/nameShapeParity.test.ts`), so that sweep pins the class, not each field's reach; each field's own refusal is measured over the nine direction characters and the control-class representatives (`packages/core/test/config/linkageTermsSchema.test.ts`).
Display escaping is unchanged and still runs at every render site, `sanitizeForDisplay` writing `U+202E` as `\u202e`; the schema rule is what keeps the character out of the record artifact, where no display boundary of ours stands.

## Web linkage-terms import bounds

The web editor's expert tier lets an operator paste a JSON or YAML linkage-terms document to load the editor (`importLinkageTerms` in `apps/web/src/psi/linkageTermsIO.ts`).
That document is untrusted free text - an operator could paste a credential into it by mistake, and a partner-supplied terms file could be hostile - so it has the same parsed-input bounds as the core wire paths, plus two import-specific ones.
The raw parse routes through the shared secret-redacting chokepoint (`parseSensitiveJson` / `parseSensitiveYaml` in `packages/core/src/sensitiveFile.ts`), never a raw parser, so a parse error reports a path-only label and never echoes the document's bytes (the leak channels are enumerated in that module's header).
The JSON path runs through `parseBoundedJson`, so the structural ceilings above (`MAX_JSON_OBJECT_KEYS` / `MAX_JSON_ARRAY_ELEMENTS` / `MAX_JSON_NESTING_DEPTH`) apply.
The parsed value is validated only by `safeParseLinkageTerms` - the same schema, with the same `camelizeKeys` depth/node bounds, that the Generate gate runs - so an import cannot smuggle a value past the schema into a minted invitation.

The two import-specific bounds:

- A pre-parse length cap, `MAX_IMPORT_CHARS` = 1000000 (UTF-16 code units, in `linkageTermsIO.ts`), refuses an oversized paste before either parser runs, so a pathological document cannot drive the parser ahead of the schema's own structural bounds.
  It sits far above any real linkage-terms document - the invitation token path itself caps at 64 KiB, and a GUI-exported document with every key and transform is well under this - and is sized for an operator workstation, not a constrained tab; tunable.
- The YAML parser's alias-expansion bound, `maxAliasCount` = 100, is pinned explicitly in the chokepoint's parse options (`SAFE_YAML_OPTIONS` in `packages/core/src/sensitiveFile.ts`) rather than left to the `yaml` library default.
  100 is the library's current default, so pinning is behavior-preserving; pinning it makes the alias-bomb (billion-laughs) bound an enforced constant here rather than an implicit reliance on a default a future `yaml` release could raise.
  It would only need revisiting if a legitimate document required more than 100 alias references - none does.
