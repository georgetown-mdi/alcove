---
title: "Transform Regular-Expression Dialect"
---

# Transform regular-expression dialect

This document specifies the bounds on the partner-supplied regular expressions a linkage-terms document carries, with their constant values and enforcement points: the linear-time dialect a transform pattern executes under, with its weighted-size cap, its regex search bound and the bounds on its compile cost, and the character class a name constraint's `allowedCharacters` holds.
It is the implementation-level complement to the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), which covers what each control protects against and why the design is sufficient, and to the normative dialect definition in [PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect).
It does not cover the count and length bounds on the rest of a partner's terms (see [PARSED_INPUT_BOUNDS.md](PARSED_INPUT_BOUNDS.md)) or the bounds on transform-parameter values (see [TRANSFORM_PARAMETER_BOUNDS.md](TRANSFORM_PARAMETER_BOUNDS.md)).
Intended readers are security auditors and implementors.

Every net-new control specified here is subject to the explicit pre-release security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy); the per-section notes below repeat this only where a control has an extra scope nuance (an internet-facing surface, a new security-relevant dependency, or a modification layered on an existing control).

## Transform-regex linear-time dialect

A second control against the [same mutually-distrusting counterparty](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds) bounds the *complexity*, not the count, of one partner-supplied field: the regular-expression pattern in a linkage-key element transform.
The four regex step functions (`replace_regex`, `extract_regex`, `filter_regex`, `split_on`) compile their pattern and run it per row over the acceptor's full dataset (`packages/core/src/standardization.ts`); `parse_date` likewise *expands* its partner-controlled `inputFormat` into a per-row regex whose adjacent `(\d{1,2})` groups (one per `MM`/`DD` token) are a catastrophic-backtracking construct - a ~48-character format reaches a hang.
On the JavaScript `RegExp` engine a catastrophic-backtracking (ReDoS) pattern would hang the single, non-interruptible thread.
The pattern cannot be rewritten - PSI requires byte-identical keys and the terms are canonically hashed into the exchange-agreement receipt, so a unilateral rewrite both breaks matching and is reported as a terms mismatch.

The control is by construction: these patterns execute under a **linear-time regex engine** (re2js, an RE2-semantics Thompson NFA / lazy DFA - `packages/core/src/utils/linearRegex.ts`) instead of `new RegExp`.
Matching is linear in the input length, with a constant set by the pattern's expanded size, and has no backtracking, so the catastrophic-backtracking blow-up is *impossible*, not merely screened for.
The constant is not small for a large pattern.
Measured on 2026-09-30 (re2js 2.8.6, Node v26.10.0, a 10-CPU Linux development container), under the schema bounds alone (pattern length 1000, each repetition bound 1000, a nested product over 1000 refused): 99 capture groups `(.{0,999})` followed by one literal cost about 175 ms per row on 200-character values (about 48 h per million rows), and compiling such a pattern once costs 190-250 ms.
Re-measured on 2026-10-01 on the same host at the 4096-character value ceiling (`MAX_TRANSFORMED_VALUE_LENGTH`), `^` then 123 `.{0,999}` then `z$` cost 30-42 s per row.
The weighted-size cap below bounds that constant.
This includes `parse_date`'s expanded regex, which moves onto the same engine, so its adjacent-group construct is bounded by construction rather than by a separate analysis.
The engine is pure JavaScript, so the same build runs in the CLI (Node) and the web (browser): both parties and both build targets derive byte-identical keys, with no second engine build whose semantics could diverge on an adversarial pattern.
The permitted pattern syntax - the **dialect** - is pinned normatively in [PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect); both parties MUST evaluate patterns under it.

What remains at validation is a dialect-conformance gate: a refine on `LinkageTermsSchema` (`packages/core/src/config/transformRegexDialect.ts`), so it covers every path that parses partner terms at once - the initiator/joiner `parseLinkageTerms`, the invitation-token decode (`InvitationTokenSchema`), and `ExchangeSpecSchema`.
The refine walks every raw-pattern step (the function-to-pattern-param map `REGEX_STEP_PATTERN_PARAM`, `split_on` keying on `delimiter` rather than `pattern`, kept in parity with the `tier: "regex"` function descriptors by a test).
It reads the value the factory compiles, which is the text a step declares: a pattern of any other type is refused by the declared-type control (see [Transform-parameter declared types](TRANSFORM_PARAMETER_BOUNDS.md#transform-parameter-declared-types)) and skipped here rather than rendered to a string, so no path to a compile source runs a `toString` the document supplied.
It rejects - fail closed, before any row runs - a pattern the engine cannot compile: a backreference, a lookaround, or an unsupported escape, exactly the features RE2 drops.
`parse_date` is not screened here: it is not a raw-pattern step and its library-generated regex is always in-dialect; its safety is the engine, not the gate.
There is **no fallback to `new RegExp`** - a pattern outside the dialect is refused, never silently re-run on the backtracking engine, which would reopen the hole.
A total budget across one validation (`REGEX_DIALECT_TOTAL_BUDGET_MS`, 2000 ms), measured on the monotonic clock as the mint walk's below is, bounds the gate's own cost so a terms set packed with patterns - the [per-collection count caps](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds) still permit a large product - cannot turn validation itself into a denial of service; on exhaustion the remaining patterns reject closed.
A separate per-step length cap on the raw pattern (`MAX_TRANSFORM_PATTERN_LENGTH`, 1000) caps the source-parse and one-time compile cost (`applyElementTransform` compiles each step once per distinct transform array, memoized, rather than per row).
These constants live beside the code in `transformRegexDialect.ts` and `linkageTermsSchema.ts`.

**Weighted-size cap.**
The same walk refuses an in-dialect pattern whose weighted size exceeds `MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE` (**1000**).
The weighted size is the compiled program's instruction count times one plus its capture-group count, both read from the engine (`programSize()` and `groupCount()`, via `patternWeightedSize` in `linearRegex.ts`).
A single match costs the value length times the program the match keeps live, and each capture group adds copy work per live instruction; the engine expands a nested repetition, so it counts by the product of its bounds.
A count is the same on every machine, so both parties reach the same verdict on the same terms under the same engine build; a per-row deadline would not, and is not used.
The refusal locates the pattern by key, element and step index and states its size and the limit, echoing nothing the partner wrote.

- Calibration, measured 2026-10-01 on the host above: the worst of the engine calls the regex steps make (`test`, a first match with its groups, `replaceAll`, `split`) over random `[a-z0-9 ]` values, by a script kept outside the repository.
- Admitted: every bundled default pattern and documented example, the largest weighing 34 (`^1(\d{10})$`).
  At the cap, the worst shapes measured (an alternation of 332 two-character literals; 55 `.{0,9}` under `(?i)`) cost about 5 ms per row at 200 characters and about 50 ms at the 4096-character ceiling.
- Refused: the two worst cases above, weighing about 19,800,000 and 246,000.
- Capture-heavy shapes at the cap measured at most 8 ms at 4096 characters, below the capture-free worst, so the capture weight errs toward refusal.
- Regex search bound: the cap bounds a pattern's compiled size and the cost of a single match, which is what the calibration above measured.
  The find-all steps, `replace_regex` and `split_on`, run one search per match, each from where the last match ended, and a pattern whose preferred alternative stays live to the end of the value scans the rest of it on every search, so their cost grows with the square of the value length whatever the weighted size.
  On the element-transform path every regex step's search is charged to the per-row transform work budget (`MAX_TRANSFORM_WORK_PER_ROW`, [Unbounded transform-parameter rejection](TRANSFORM_PARAMETER_BOUNDS.md#unbounded-transform-parameter-rejection)), the single-search steps `extract_regex`, `filter_regex` and `parse_date` included: each search spans the value from the lowest code unit the engine read to the highest.
  Under a pattern of weighted size w, the first pass over the value is charged w - 3 per code unit it spans (3 being a one-character pattern's weighted size on this build), which with the step's own read of one unit per code unit makes w - 2 per code unit in all, and every rescan is charged w per code unit it spans (`ScanBudget` in `packages/core/src/utils/linearRegex.ts`).
  The first pass is discounted rather than charged at full weight because full weight would put the row the byte limb's boundary is pinned on past the budget.
  `replace_regex` also counts what it copies out of the value, the text between matches, each match or group a reference names, and each `` $` `` or `$'` expansion, against what the row has left: a `` $` `` or `$'` reference copies the value's prefix or suffix for every match, so that output grows with the square of the value length, and the copy that would take the row past the budget stops the replacement there, before the engine's string-length error.
  A replacement that returns is charged its output as produced units, as every step is.
  The charge is taken as the engine reads or copies, and the read that would take the row past the budget stops the search there.
  The crossing takes the fate that budget already has: on the exchange path the key's own, the refusal naming the step (`linkageKeys[i].elements[j].transform[k]` and its function) or, where every producer that can expand the key is a declared fan-out producer, the warned drop naming it and, as every drop line does, the key's partner-authored name escaped at that sink; in the consent header's grading pass the probe goes unread.
  Both are pinned in `standardization.test.ts` and `linkageSatisfiability.test.ts`.
- Regex search calibration, measured 2026-10-01 on the host above (Node v26.10.0, re2js 2.8.6) by `packages/core/test/stress/findAllScanBudget.stress.test.ts`, one run: the weight-87 shape `(?:[^#]*[^#]{0,40}#|.)`
  over 4096 characters ran about 12 s per row unbudgeted on either step and is stopped after 0.6 to 0.8 s; weight 817 (`{0,405}`) ran about 5.5 s at 1024 characters unbudgeted and is stopped after about 0.5 s at 1024 and 0.7 to 0.8 s at 4096; weight 7 (`(?:[^#]*#|.)`)
  ran about 0.4 s at 4096 and is stopped after about 0.2 s.
  The weight-87 shape over 200 characters spends about 1,748,500 units, about 5% of the budget, and runs to its keys.
  Ordinary patterns at 4096 characters (`[^A-Za-z0-9]+`, `\s+` and `[aeiou]` under `replace_regex`; `\s*;\s*` and `[,;]` under `split_on`) spend 11,736 to 28,672 units in all, the cell's read, the step's read, its first pass and its output included, under 0.1% of the budget, and derive the same keys as with no budget.
- Limits of the regex search bound: the operator's own standardization pipeline runs outside the budget, as it runs outside every other limb of this control, so a regex step authored there keeps the unbounded cost, and a `` $` `` or `$'` expansion there still ends in the engine's string-length error.
  The literal text of a replacement template is not counted as it is copied: it adds at most the template's length per match, where the param length cap (`MAX_TRANSFORM_PARAM_LENGTH`) is checked before NFC normalization and NFC can triple a replacement, so about 12,300,000 code units at the value and param ceilings, charged with the step's output; the step's output then stays under about 46,000,000 code units, below the engine's maximum string length.
  The bound is a volume of scanned text rather than a time, so what a row can still spend is the budget times the dearest charged unit, which the [work budget's second measurement](TRANSFORM_PARAMETER_BOUNDS.md#unbounded-transform-parameter-rejection) states.

The cap bounds one pattern: a row's total is that times the regex steps the document declares, which `TRANSFORM_COMPILE_MAX_STEPS` caps.
The verdict depends on the engine build, so an re2js upgrade that changes a program's size is a dialect change ([PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect), Versioning).
`parse_date` is outside the cap: its [format-length cap](TRANSFORM_PARAMETER_BOUNDS.md#unbounded-transform-parameter-rejection) bounds its regex, whose worst measured shape (128 `MM` tokens) costs about 5 ms per row.

**Empty-matching `split_on` delimiter.**
The same walk refuses a `split_on` delimiter that matches the empty string ([PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect), Operation semantics), read off the program the conformance check already compiled, so it adds no compile and runs inside the walk's budget.
The refusal's issue path locates the step by key, element, and step index, and its message names the function and the param, echoing nothing the partner wrote.
An operator's own `standardization` is not walked: its step schema compiles a `split_on` delimiter itself, only within `MAX_TRANSFORM_PATTERN_LENGTH`, leaving one outside the dialect or over that length to the compile at the run, and the `split_on` factory refuses the same delimiter for a step compiled without a parse.
Terms holding such a delimiter written before this refusal - in a saved web exchange, a signed receipt, or an agreed-terms file - are refused when read, with no migration.
A pending terms proposal holding one is dropped when read, and the rest of its stored entry loads without it (`managedLocalStateSchema`, `apps/web/src/psi/managed/managedLocalStateShape.ts`).

The mint and accept boundaries bound a second compile cost over the same content.
`assertTransformsCompile` (`packages/core/src/linkageSatisfiability.ts`) builds every step a document declares - each `standardization` step and each linkage-key element transform - where the terms are authored or minted, so a step whose factory refuses its parameters is refused while the author still holds the document rather than at the first row of an exchange the partner has already accepted.
The accept boundary runs the same walk over an invitation's element transforms alone, which is a PARTNER-supplied document: the two bounds below are what hold that walk's cost for an acceptor, over a document `MAX_ENCODED_INVITATION_LENGTH` already caps.
Two bounds hold that walk's own cost.
`TRANSFORM_COMPILE_MAX_STEPS` (**512**) caps the steps one document may declare in total and is checked before anything compiles, so the refusal is a property of the document and repeats on any machine and every attempt; the [per-collection count caps](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds) admit far more, and a document a party mints declares steps in the tens.
It is half the count measured to spend up to 1.9 s of the budget under a development container's ordinary load; at the cap, the same shape took 0.5-1.0 s of the 2 s budget under that load.
`TRANSFORM_COMPILE_TOTAL_BUDGET_MS` (**2000 ms**) stands behind it for a document under the count whose steps are individually expensive, refusing the unchecked remainder closed on the monotonic clock.
The compiled steps a walk produces reach the run's memo only where the walk finished, so a refused walk leaves nothing a later one resumes past.
That does not make a budget refusal repeatable: the engine's pattern cache is process-global and outlives the refusal (`packages/core/src/utils/linearRegex.ts`), so a later attempt at the same document in the same process recompiles nothing it already compiled and can be admitted within the budget.
What the budget bounds is the cost of each attempt; the count cap is the verdict that depends on neither the machine nor the attempts before it.

Both bounds hold that walk alone, at either boundary, and the budget holds it at the granularity of one steps array.
The editor's own grading compiles too: `pipelineAlwaysDrops`, which the browser editor runs on every validation pass, and the consent header's collapse verdict each measure what a `substring` run following a `parse_date` collapses that window to, under neither the count cap nor the budget.
What holds that walk instead is its own shape plus the caps on the document it walks.
Every substring run of one key element is measured in a single forward pass over that element (`parsedDateRunReadings`), carrying one running value per probe date rather than re-running the probes from the `parse_date` for each run end, so each measured step compiles once and a grading pass costs at most one compile per declared step - linear in the document, where measuring each run on its own is quadratic in each element's step count.
A pass that asks both readings of one element - the dead-pipeline verdict and the collapse verdict - takes them from one grading of it (`gradeElementPipeline`), so the consent header pays that one compile per declared step rather than one per reading: 255 compiles for an element declaring the schema's per-element maximum of 256 steps.
That is at or below what compiling the same document once already costs the party grading it, so the grading is not the dominant cost on any path that also compiles.
The document itself is capped three ways: the schema's per-element step cap (`MAX_TRANSFORM_STEPS`), the encoded-token length cap on an acceptor's partner-supplied terms (`MAX_ENCODED_INVITATION_LENGTH`), and the editor's import cap on an inviter's own imported rule set (`MAX_IMPORT_CHARS`, `apps/web/src/psi/linkageTermsIO.ts`).
The compile count the walk holds to is pinned by `packages/core/test/linkageProbeCost.test.ts`, and its verdicts are held equal to the per-run measurement by a differential sweep in `packages/core/test/linkageSatisfiability.test.ts`.
Within that walk, the clock is read before each `standardization` entry and each key element and then that whole steps array compiles with no further read, so one attempt can overrun the budget by at most one array's compile; `TRANSFORM_COMPILE_MAX_STEPS` bounds that array, and with it the overrun.

The bundled default standardization patterns - including the email filter `^[^\s@]+@[^\s@]+\.[^\s@]+$` - are all in-dialect and need no allowlist; a checked-in cross-build vector file (`packages/core/test/vectors/transform-regex-vectors.json`) pins each default pattern's output, on the inputs it covers, as byte-identical to the previous `new RegExp` engine, and asserts the Node and browser builds agree.
The few code points where RE2 and JavaScript regex semantics diverge - `\s` is ASCII-only under RE2 but Unicode-broad in JavaScript, `.`
excludes only `\n` under RE2 but also `\r` and Unicode line separators in JavaScript, and `.`
spans a code point rather than a UTF-16 code unit - are documented in [PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect) and are outside that vector domain.
They are not cross-party divergences (both parties run the same engine) and, in the bundled defaults, the email filter is preceded by `remove_non_ascii`, so no such code point reaches it.

The severity addressed is a denial of service bounded to the availability of the acceptor's own session - its browser tab or CLI process, on the acceptor's own (typically isolated, periodically-run) hardware - with no data disclosure, no code execution, and no effect on the counterparty or the privacy guarantee.
Standardization is local key-building, before and independent of the PSI rounds, so a hang neither leaks a non-intersection member nor reaches the peer, and the worst outcome is that the run produces no result and is re-run.
The realistic trigger is a mistake - a catastrophic-backtracking pattern an operator reuses from a JavaScript engine or mistakenly authors, which a human reviewing the agreed terms cannot reliably vet for cost.
The linear-time engine prevents that class by construction, and is the critical control here; because the linkage terms are agreed on once and reused, with any later modification raised for manual review, it also covers the residual hostile-or-tampered pattern (an attacker would have to subvert the one-time terms agreement for a non-escalating local hang).
An in-dialect-but-expensive pattern crafted on purpose is bounded - its source length is capped (`MAX_TRANSFORM_PATTERN_LENGTH`, applied to the declared pattern the factory compiles), RE2 caps any single and nested repeat count, and its weighted size is capped, which bounds its compiled size and the cost of a single match to the figures above, and every regex step's search, including the find-all rescans of `replace_regex` and `split_on`, is charged to the per-row transform work budget (the regex search bound above) - and non-escalating.
No heuristic screen stands beside the engine and that count: a heuristic analyzer can only estimate the class the linear-time engine eliminates outright, at the cost of an allowlist and a dependency of its own.
As net-new security behavior that adds a security-relevant dependency (re2js) and pins a wire-level dialect, this control is subject to the explicit security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy) before release.

## Name-constraint character class

One more partner-controlled regular expression reaches the local party outside the transform pipeline: a name field's `allowedCharacters` constraint (`NameConstraints`, `packages/core/src/config/linkageTermsSchema.ts`), a regex character class.
It differs from the transform patterns above in two ways that lower its stakes but not its ReDoS exposure: it is **not** key-building (the agreement receipt's terms hash covers the class only as text, like the rest of the terms), so it has no cross-party determinism requirement.
The value-level check that evaluates it is a **local advisory that warns and does not block** - the web cleaning editor flags a cleaned value whose characters fall outside the class, before any exchange round and with no effect on what is sent.
It is still partner-authored (it arrives in the invitation token), so a crafted class is the same ReDoS hazard and takes the same by-construction control.
The check compiles `^[allowedCharacters]$` under the linear-time engine (`compileLinearRegex`) and tests one code point at a time, each as a full (whole-input) match rather than an unanchored find, after escaping a leading `^` to a literal (so a leading caret is the allow-list the operator wrote, not a class negation that would invert the advisory).
A class that breaks out of the brackets therefore can neither backtrack catastrophically nor suppress the warning by matching a multi-character span or by an alternation branch that matches only a zero-width or leading span.
What this does **not** defeat is a class that genuinely admits the code point - a character-class shorthand (`\w`, `\p{L}`, `[:alpha:]`) or an alternation breakout whose branch matches a single code point (`a]|.|[b`, effectively allow-all).
The effective set diverges from a plain reading, but neutralizing it would take a full character-class parser and would false-flag a legitimately permissive class (`\p{L}` is the natural constraint for international names, indistinguishable at the engine level from a smuggle).
Because the check warns and does not block, this is an accepted, documented limit - a suppressed advisory badge, never a data-filtering, match-correctness, or ReDoS effect.

`NameConstraintsSchema` validates the class under that **same engine** at parse time - not `new RegExp` - on every path that decodes partner terms, so a class it accepts is guaranteed to compile at check time and the advisory cannot fail open on a native-versus-RE2 dialect gap; the degenerate empty class, which the engine cannot compile, is rejected there with the existing character-class message.
`MAX_NAME_LENGTH` (256) is a critical pre-compile length gate on that validation, the compile-cost bound the sibling `MAX_TRANSFORM_PATTERN_LENGTH` is for the transform patterns above.
Because Zod does not short-circuit chained checks, the refine that compiles `[allowedCharacters]` under re2js runs even on an over-length value, and re2js compile cost is super-linear in source length, so the refine tests the length first and defers an over-length class to the length ceiling's own rejection rather than ever compiling it.
Both count the same code units (`maxCodeUnits`), so no class the refine waves through on that length test is admitted by the ceiling.
The value-level check lives in core (`checkValueConstraints`, `packages/core/src/valueConstraints.ts`), shared by the web cleaning editor and the CLI's data-preparation warning, and must stay on this engine.
Because this path builds no keys and feeds no receipt, it needs no cross-build vector and is exempt from the dialect's byte-identical requirement - here the linear-time engine is purely the ReDoS control, not a determinism guarantee.

The display complement to that accepted limit: because the effective set can diverge from a plain reading, the operator-facing consent summary (`packages/core/src/consent/invitationSummary.ts`, which holds the class apart from the paraphrased constraints in `allowedCharactersClass`) does **not** paraphrase the class as a vetted "characters limited to X" allow-list.
It labels it as the partner-supplied, unverified regular expression it is (naming the trust boundary, not just the regex syntax family) and shows the raw (sanitized) class, so a crafted class - a leading-`^` negation, a `\p{L}`/`[:alpha:]` shorthand, or a bracket breakout - is not *presented* to the operator as a plain-language guarantee.
A non-regex-literate operator can still misread a crafted class, but the copy asserts no promise the value cannot back.
One bounded residual remains: the class body is itself partner-controlled display text rendered as a suffix, so a value that is a valid character class of printable letters and spaces (e.g.
`A-Za-z (checked by our compliance team`) renders as trailing prose after the label - the accurate "not verified by Alcove" note can be followed by a contradicting partner sentence.
It is confined to this advisory display surface (the note always precedes the value, and the value is sanitized and length-capped, so it can neither displace the note nor break the constraint list), an accepted residual rather than a hole; a rendering that binds the raw class as a visually distinct, bounded element would close it.
Both acceptance surfaces render the class from that one summary - the web consent screen in its own bounded element, the CLI accept prompt on its own line after the fixed label - so the residual is the same one on each, not a second shape.
The CLI's separate advisory still prints a fixed "disallowed characters" label with a count, not the pattern.

The consent summary and the web cleaning editor paraphrase a `filter_regex` step whose pattern is exactly `^.{2,}$` as keeping values of at least two characters, but no line break is matched by `.`, so such a step also drops a value that holds one, which the paraphrase does not say; every built-in placement follows `squash_spaces`, which leaves no line break, and the raw pattern is shown beside the paraphrase.
