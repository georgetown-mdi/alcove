---
title: "PSI Results From Run to Run: Where the Table Can Change on Unchanged Data"
---

# How a psi result can change from run to run on unchanged data

*Status: examined and measured; three rules built.
The sender's date-shape check (section 4) is built, and its stated limit is retired from [PROTOCOL.md](../spec/PROTOCOL.md).
A `swap` key sorts its pair on both parties (section 2), so its collision drop is the same in both roles.
The equal-count tie-break on file-sync and SFTP (section 5, narrow) is built on the two parties' `identity` names, on the maintainer's condition that nothing new is exchanged.
He declined the record-level uniqueness drop, the width bound in both roles, the value-keyed sweep order, and the fixed role, which stay stated limits.
See [docs/notes/README.md](README.md).*

This note lists each way a `psi` association table, or a `psi-c` count, can differ between two runs over the same records,
or between the two role assignments of one exchange.
For each it names the code path and the spec text,
reports a driven input and how often it reproduced,
and says whether a deterministic rule exists and what it would cost.
It points at the spec for the rules themselves rather than restating them.

## How the inputs were driven

Every driven figure below comes from real exchanges between two in-process parties:
`prepareForExchange` and `runExchange` (`packages/core/src/exchange.ts`) over `createMessagePipe` (`packages/core/src/connection/messageConnection.ts`),
the path the suites under `packages/core/test/` drive.
Where a section says a claim was read from code or is pinned by a suite, it was not driven here.
Both parties expect output and, except where section 5 adds a row, hold equal declared counts,
so the initiator becomes the receiver, the tie broken on no names ([Role resolution and work minimization](../spec/PROTOCOL.md#role-resolution-and-work-minimization)),
and swapping which party initiates swaps the roles with the data unchanged.
Where the records under test are uneven, a party is padded with a row that matches nothing (labelled `xF` or `yF`) to even the counts;
each section lists every row it drove, in row order, padding included.

Each configuration ran 20 times per initiator, under `cascade` and under `single-pass` where both apply, and under `psi-c` where it shows the count.
That is 21 configurations, two initiators each, 840 exchanges in all.
Every one of the 42 (configuration, initiator) cells gave a single outcome in 20 of 20 runs:
none of the sources below is random, and each is a function of the role or of the row order.
Measured 2026-11-04 on a 10-core `aarch64` development container under Node 26, WebAssembly backend.
The measurement scripts are not kept;
[`packages/core/test/roleSwapDeterminism.test.ts`](../../packages/core/test/roleSwapDeterminism.test.ts) pins the properties found to hold.

## 1. The canonical order's tie-break

**Mechanism.**
Where a round's candidate pairs admit more than one largest pairing, the sweep keeps the first in (sender rank, receiver rank) order,
so the role, and each party's row order, decide which largest pairing the table holds.
Code: `roundCandidatePairSweep` and `firstLargestPairing` in `packages/core/src/psi/roundResolution.ts`,
fed ranks from the two groupings under the cascade and rows by `replaySinglePassCascade` (`packages/core/src/psi/link.ts`) under single-pass.
Spec: the stated limit in [Record-level resolution: canonical order and tiebreak](../spec/PROTOCOL.md#record-level-resolution-canonical-order-and-tiebreak).

**Driven input.**
One `split_on` surname key splitting on the space the default name cleaning leaves where a hyphen was; three records a side, each holding two parts, forming one six-pair cycle
(party A, rows a0 to a2: `Papa-Uniform`, `Sierra-Tango`, `Quebec-Romeo`; party B, rows b0 to b2: `Romeo-Sierra`, `Papa-Quebec`, `Tango-Uniform`).
The reversed run gives A the rows `Quebec-Romeo`, `Sierra-Tango`, `Papa-Uniform`.

| Run | A's table | Reproduced |
| --- | --- | --- |
| A receiver | a0-b2, a1-b0, a2-b1 | 20/20, both strategies |
| A sender | a0-b1, a1-b2, a2-b0 | 20/20, both strategies |
| A receiver, A's rows reversed (rows numbered as before the reversal) | a0-b1, a1-b2, a2-b0 | 20/20, both strategies |
| `psi-c`, either role | count 3 | 20/20 |

All three pairs differ between the roles, and reversing A's three rows moves all three as well.
The count does not move, as the spec states.

**Incidence on synthetic data.**
Random hyphenated surnames with two to five parts a record, 40 to 300 records a side, nine settings of 20 seeds each under single-pass:
the two role assignments' tables were identical in all 180 seeds, about 7,900 pairs in all.
The role dependence needs a component of the candidate graph with two largest pairings whose canonical-first members differ, such as the cycle above,
and the random draws never formed one.
This bounds nothing about real data; it says the order is not reached by fan-out alone.

**Deterministic rule.**
Order the sweep by the matched value instead of row ranks: each candidate pair is named by the smallest value its two records share in the round.
Within a one-to-one round a value is held by one record a side, so this is a total order on the round's pairs,
and it depends on neither the role nor either party's row order.
- Disclosure: none beyond today, as far as this examination reads.
  Each resolver orders by its own plaintext of a matched value, which equals the partner's:
  the single-pass receiver holds its own matched values, and each cascade party holds its own matched positions ([The per-round grouping the two frames hold](../spec/PROTOCOL.md#the-per-round-grouping-the-two-frames-hold)).
  Nothing about the order is sent.
- Traffic: none; no frame or field changes.
- Other cost: the table is no longer reproducible from the frames alone, a property the spec states today,
  and an exchange's table changes once at the version that adopts it.

A cheaper rule fixes the role dependence only: sweep in an order keyed on a party attribute fixed for the exchange rather than on sender and receiver.
It costs nothing in disclosure or traffic, and leaves the row-order dependence in place.

## 2. The uniqueness rule under a one-sided expansion

**Mechanism.**
`transpositions`, `adjacent_years`, `adjacent_days` and `day_month_swaps` expand on the receiver alone,
and the within-round uniqueness rule then reads the expanded candidates,
so a variant can collide with another of a party's own records only when that party receives.
Code: `expandsOnReceiverOnly` and `expandFuzzyComparisons` (`packages/core/src/fuzzyComparisons.ts`);
the drop in `removeDuplicatesAndUndefineds` and `RoundValueParticipation` (`packages/core/src/psi/link.ts`).
Spec: the stated limit in [Which party expands](../spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions),
and its count-only reading in [Candidate sets under count-only](../spec/PSI_C.md#candidate-sets-under-count-only).

**Driven inputs.**

| Key | X's rows x0, x1 | Y's rows y0, yF | X receiver | X sender | Reproduced |
| --- | --- | --- | --- | --- | --- |
| `swap` on first and last name, measured on the 2026-11-04 build | (Carol, Smith), (Smith, Carol) | (Carol, Smith), (Henry, Brown) | no pair | x0-y0 | 20/20, both strategies |
| `adjacent_years` on date of birth | 01/15/1990, 01/15/1991 | 01/15/1990, 06/15/1950 | no pair | x0-y0 | 20/20, both strategies |
| either, under `psi-c` | as above | as above | count 0 | count 1 | 20/20 |

Unlike the tie-break, this moves the number of pairs and the count.
The realistic trigger is a party's own duplicate of one person entered with a one-year error in the date, or with two characters transposed.

**Deterministic rule for `swap`, built.**
Both parties place a `swap` key's pair in sorted order ([Where the expansion runs](../spec/PROTOCOL.md#where-the-expansion-runs-after-the-element-transform-into-the-cross-product)), so the key expands on neither.
X's two rows in the `swap` row above build one value, which the uniqueness rule drops in both roles:
no pair in both roles under both strategies, and count 0 in both roles under `psi-c`,
as [`roleSwapDeterminism.test.ts`](../../packages/core/test/roleSwapDeterminism.test.ts) pins.
The same file pins the `transpositions` case of the limit, which stays.

**Deterministic rule.**
Drop at the record level over the would-be expansion, in either role:
a party drops a record from the round when the variant set of its value shares a value with another of its own records' variant sets,
computing the expansion locally when it sends exact values.
Because each of these expansions is an involution, as the spec states, a pair then meets in one role exactly when it meets in the other.
That equivalence is argued here, not driven.
- Disclosure: none; the drop is computed from the party's own data before anything is sent.
- Traffic: none; the sender still sends exact values.
- Other cost: it drops more than today's receiver does.
  A record whose variants collide only on one variant loses all of them, so some pairs today's receiver keeps would be lost.

Expanding on both parties instead also makes the drop symmetric,
at the cost of the sender's candidate count multiplied by the key's width on the wire and in curve operations.

## 3. The width drop on a key that fans out and expands

**Mechanism.**
On an element that both splits (`split_on`) and expands (`generate_fuzzy_comparisons`), the width bound is measured on the row's assembled candidate set,
which includes the expansion on the receiver only.
A row that splits into more parts than the per-element fan-out factor, but fewer than the declared width, fits as the sender and is dropped as the receiver.
Code: `readRowUnderPlan` (`packages/core/src/standardization.ts`), the drop through `dropRowFromKeyRound`.
Spec: the stated limit "the width drop on a key that splits and expands can depend on the role" in [Which party expands](../spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions).

**Driven input.**
A surname element split on spaces, bounded to two characters and expanded by `transpositions`, so the declared width is 40.
X's rows are x0, one row of 21 distinct two-letter parts (`AB AC AD AE AF AG AH AI AJ AK AL AM AN AO AP AQ AR AS AT AU AV`), and xF, `ZZ`;
Y's rows are y0, `AB`, and yF, `YY`.
As the receiver, X's row realizes 42 candidates and is dropped: no pair.
As the sender, X sends its 21 parts and Y's expanded `AB` meets one: x0-y0.
20 of 20 runs each way, under both strategies.

**Deterministic rule.**
Measure the bound on the would-be expansion in both roles, so a sending party drops the same rows it would drop as the receiver.
- Disclosure: none; local.
- Traffic: none.
- Other cost: a row that matches today as the sender is dropped in both roles.

## 4. The date-shape refusal on the receiver

**Mechanism.**
The three date expansions refuse the exchange at the first value that is not eight digits, and in the build measured only the expanding party read the value, so only the receiver refused.
Code: `expandFuzzyComparisons` and the date candidate functions (`packages/core/src/fuzzyComparisons.ts`).
Spec: the rule "both roles refuse a date value that is not eight digits" in [Which party expands](../spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions), which retires the limit this section measured.

**Driven input.**
An `adjacent_years` element on date of birth behind a `replace_regex` that strips a leading `1990`.
X's rows are x0, 01/15/1990, and x1, 01/15/1985; Y's rows are y0, 01/15/1985, and yF, 06/15/1950.
X's 1990 birth date reaches the element as the four digits `0115`, and Y's values stay canonical.
X as the receiver: the exchange is refused, 20 of 20.
X as the sender: the exchange completes with the one pair x1-y0, 20 of 20.
This changes whether the run completes, not the table of a completed run.
These figures are from the 2026-11-04 build, which had no check on the sender.

**Deterministic rule, built.**
Check the shape in both roles: the sending party applies the receiver's check to each value it builds for a date element, and gives the receiver's refusal
([Which party expands](../spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions); `checksInputWithoutExpanding`, `packages/core/src/fuzzyComparisons.ts`).
The driven input above is refused in both roles, under both strategies,
as [`roleSwapDeterminism.test.ts`](../../packages/core/test/roleSwapDeterminism.test.ts) pins.
- Where: as each round's values are built, not in a pass over every row before the rounds.
  A cascade round after the first reads only the rows still unmatched, and the receiver checks only those;
  a sender checking every row up front would refuse a run the receiver role completes, which is the role dependence the rule removes.
- Read order: both roles read a key's elements in their declared order, a `swap` key included,
  so an empty value ends a row at the same element in both roles.
- Residual: the sender does not spend the receiver's one-sided expansion of an element ahead of the date, so a row that expansion alone takes past a per-row bound ends on the receiver and reaches the date on the sender.
  Matching it would measure the would-be expansion in both roles, the approach declined for the width bound (section 3).
- Disclosure: none; the check is local and the refusal is one the partner already meets from a receiver.
- Traffic: none.
- Other cost: an exchange that completed with that party as the sender is refused in both roles.
- Mixed builds: the check is local, so a build without it still sends such a value as the sender and the run completes.
  Until both parties run a build with the check, whether such a run completes depends on which build sends.

## 5. What moves the role between runs

Sources 1 to 4 are differences between the two role assignments.
They become run-to-run differences when the assignment moves between runs over the same records, which three things do:

- **A count change.**
  With both parties expecting output, the smaller declared count receives (`resolveRole` and `pickRole`, `packages/core/src/protocolSetup.ts`; [Role resolution](../spec/PROTOCOL.md#role-resolution-and-work-minimization)).
  Driven: adding a fourth row, `Xray`, which matches nothing, to party A in the cycle input above made A the sender in 20 of 20 runs whichever party initiated,
  and all three of the cycle's pairs moved.
  A recurring exchange whose counts cross therefore changes the pairs of records that did not change.
  The spec states that nothing holds the role steady across runs.
- **An equal-count tie.**
  In the build measured the tie went to the initiator.
  Driven: the equal-count rows of the cycle table above.
- **Who initiates, on file-sync and SFTP.**
  Over WebRTC the initiator is fixed by the invitation ([WEBRTC_TRANSPORT.md, Roles](../spec/WEBRTC_TRANSPORT.md#roles)).
  Over a synced folder or SFTP the handshake role follows the rendezvous: the party that arrives second, or whose hello file name sorts second on a collision, initiates (`setHandshakeRole` in `packages/core/src/connection/fileSyncRendezvous.ts`; [FILE_SYNC.md, Phase 1](../spec/FILE_SYNC.md#phase-1----rendezvous-lock-path)).
  So on those channels, in the build measured, an equal-count tie, and every source above under it, depended on arrival timing.
  This was read from the code, not driven over a real directory.
  The tie-break below removes that dependence for two parties with different names.

**Deterministic rule.**
Hold the role fixed for the exchange, from an attribute both parties hold for every run (for example which party issued the invitation), rather than from the counts.
That removes sources 1 to 4 from run to run, though not from a comparison between the two possible assignments.
- Disclosure: none; the counts are still exchanged for the bounds that read them.
- Traffic: the work minimization is given up.
  Where the fixed assignment is the heavier one, the cost is the spec's gap, up to about `35 * (D_large - D_small)` bytes per cascade round plus the matching curve operations
  ([The two strategies' cost terms](../spec/PROTOCOL.md#role-resolution-and-work-minimization)).
- Other cost: whether every channel keeps such an attribute for the life of an exchange is unverified here.

A narrower rule breaks only the equal-count tie on such an attribute instead of on the handshake role.
It costs nothing and removes the file-sync timing dependence; a count change still moves the role.

**The narrow rule, built on the names.**
At equal declared counts on file-sync and SFTP, the party whose `identity` sorts first becomes the receiver, whichever party arrives first;
where either name is absent or the two are equal, the tie goes to the initiator as before
([Role resolution and work minimization](../spec/PROTOCOL.md#role-resolution-and-work-minimization); `breaksRoleTieOnIdentity` and `resolveRole`, `packages/core/src/protocolSetup.ts`).
WebRTC keeps the initiator's tie, which the invitation already fixes.
[`roleTieIdentity.test.ts`](../../packages/core/test/roleTieIdentity.test.ts) drives the cycle input above in each arrival order and gets one receiver and one table.
- Why the names rather than a hash of each terms document: the two documents are identical where both parties run one configuration,
  and a hash over the whole document would let a responder's taken-on document vary with arrival order.
  The `identity` is the field that makes two parties' terms differ: it is per-party, never compared between them,
  and kept by a responder that takes on the initiator's terms.
- What is left on arrival order: one operator running both sides under one name, and two unnamed parties.
  No other attribute differs between the parties every run on these channels:
  the shared secret and the host key are the same on both sides,
  the inviter and acceptor roles are WebRTC configuration only,
  a party's peer id is a fresh random value each run unless configured,
  and a signing certificate is presented only on a run that signs.
  `alcove invite` and `alcove accept` require a name, so a configuration they write holds one;
  a quick exchange without `--identity`, or `alcove exchange` over a configuration naming no one, runs unnamed and reaches the fallback ([CLI.md](../CLI.md)).
- Disclosure and traffic: none; each name is already in the terms each party sends.
- Mixed builds: a build with the rule and one without it resolve the same role where the name order contradicts the arrival order,
  and the run refuses or waits, as the spec states.
  Below 1.0.0 partners upgrade together, so the rule takes no version step.

## 6. Row order under a deduplicating cardinality

**Mechanism.**
Under `many-to-one` the relaxed sweep keeps each many-side record's first pair in canonical order ([The per-side rules](../spec/PROTOCOL.md#the-per-side-rules)).
For one many-side record that first pair is the one with its lowest-row partner, whichever side sends,
so the table does not depend on the role, but does depend on the "one" party's row order.

**Driven input.**
The same `split_on` surname key as source 1.
X deduplicates; its rows are x0, `Papa-Quebec`, x1, `Quebec-Romeo`, and xF, `Zulu`.
Y's rows are y0, `Papa`, y1, `Quebec`, and y2, `Romeo`; the reversed run gives Y the rows `Romeo`, `Quebec`, `Papa`.

| Run | X's table | Reproduced |
| --- | --- | --- |
| either role | x0-y0, x1-y1 | 20/20, both strategies |
| either role, Y's rows reversed (rows numbered as before the reversal) | x0-y1, x1-y2 | 20/20, both strategies |

**Deterministic rule.**
The value-keyed order of source 1 covers this too, at the same cost.

## 7. What does not move the result

Each of these was driven or is pinned by a suite, and none changed a table or a count:

- **Repeated runs in one role.**
  Every run draws fresh PSI keys, and every configuration above gave one outcome in 20 of 20 runs.
  The PSI setup uses the library's exact `Raw` structure (`packages/core/src/psi/psiEngine.ts`), so there is no false-positive rate to vary.
- **Count-only randomness.**
  The dummies (`CountOnlyDummies`, `packages/core/src/psi/countOnlyRounds.ts`) and the permutation (`drawUniformPermutation`, `packages/core/src/psi/countOnlyPermutation.ts`) are drawn fresh each run, and every `psi-c` count above reproduced 20 of 20.
- **Linkage strategy.**
  Every configuration gave the same table under `cascade` and `single-pass`, as [`strategyDifferentialVectors.test.ts`](../../packages/core/test/psi/strategyDifferentialVectors.test.ts) pins.
- **Sharding.**
  A round split across one, two, three or five engines puts one engine's bytes on the wire and computes the same table ([`shardedPsiEngine.test.ts`](../../packages/core/test/psi/shardedPsiEngine.test.ts)).
- **Chunking and pacing.**
  A chunked round reproduces the single call byte for byte ([`psiEngineChunkIdentity.test.ts`](../../packages/core/test/psi/psiEngineChunkIdentity.test.ts)),
  and the paced sweep resolves a round as the unpaced one does ([`roundPacing.test.ts`](../../packages/core/test/psi/roundPacing.test.ts)).
- **Map iteration.**
  JavaScript `Map` and `Set` iterate in insertion order, which follows row order, so they add no dependence beyond source 1's and source 6's;
  the spec states the resolution reads no iteration order.

## Candidate build items

One line each, named by what they would do, with where each stands:

- Order each round's resolution sweep by the smallest matched value of each candidate pair rather than by row ranks, so neither the role nor either party's row order decides which largest pairing the table holds (sources 1 and 6). Declined.
- Hold the PSI role fixed for an exchange from an attribute both parties hold every run, rather than from the declared counts (source 5, and so sources 1 to 4 between runs). Declined.
- Break the equal-count role tie on an attribute fixed for the exchange instead of the handshake role, which follows arrival order on file-sync and SFTP (source 5, narrow). Built on the two parties' `identity` names, falling back to the initiator where they are equal or absent (section 5).
- Apply the one-sided expansions' uniqueness drop at the record level over the would-be expansion in both roles, so a pair meets in one role exactly when it meets in the other (source 2). Declined.
- Measure the width bound on the would-be expansion in both roles, so a row that splits and expands is dropped or kept the same whichever party receives (source 3). Declined.
- Check the date expansions' eight-digit shape on the sending party too, so whether the exchange completes does not depend on the role (source 4). Built.
