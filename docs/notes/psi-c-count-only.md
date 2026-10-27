---
title: "Count-Only Linkage (PSI-C): Construction, Provenance, and Reporting"
---

# Count-only linkage: why psi-c counts every key under one permutation

*Status: directed by the maintainer's ruling of 2026-10-26; specified, not built. The construction is normatively specified in [PROTOCOL.md](../spec/PROTOCOL.md#psi-c) and its record rows in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#count-only-psi-c-records). The shipped build runs the earlier one-key construction, which the spec names at the head of its section, until this one lands. This note records why the construction has its shape, how the one-key construction came about, the alternatives weighed, and what is left for the maintainer to decide. See [docs/notes/README.md](README.md).*

This is design rationale. Nothing here binds an implementation; the normative rows live in the two spec documents linked above, and this note does not restate them.

## What psi-c is for

Two agencies deciding whether to build a linkage want one number before they negotiate: how many people do we both have? A count-only exchange answers that and nothing else. It is a **pre-agreement** instrument, and that is the fact from which most of the decisions below follow. The exchange that establishes the business case runs before the data-sharing agreement exists -- so it runs at the point where the honest-but-curious assumption the rest of the system leans on is least supported, and where a disclosure is least recoverable if it turns out to have been more than the parties intended.

That is also why the project's design text has always called the PPRL using PSI operational and PSI-C intended only for research, and why the spec says so again: the instrument informs a decision about data sharing, and it is not a production linkage with its output withheld.

The number is only useful if it is comparable to the linkage it is used to justify. A linkage runs every agreed key, and a later key matches records an earlier one misses, so a count over one key understates the overlap a real linkage would find, by an amount neither party can see.

## Provenance: the maintainer's design and the one-key narrowing

**The design.** The project's design text of April and May 2026 (`docs/DESCRIPTION.md`, then `docs/spec/PROTOCOL.md`) describes PSI-C as sequentially executed deterministic linkages, in which the sender permutes the receiver's doubly encrypted data before returning it, the results of several keys combine because the sender uses a consistent permutation in every round, and the association map in the permuted space has the same size as one in the original space. The same text calls PSI-C intended only for research.

**The narrowing.** In August 2026 an agent design review replaced that design with one round over exactly one key under the library's cardinality mode, and removed the multi-key text from the spec. PR #853 made the narrowing normative and asked for the maintainer's ratification of it in review. The PR merged with no review and no review comment, and nothing else records a ruling on it, so the narrowing was a design review's decision the maintainer did not ratify. Every later count-only pull request treated it as decided. PR #948 deleted the research-only qualifier on an agent recommendation, also with no ruling recorded.

**The ruling.** On 2026-10-26 the maintainer found that count-only had been built other than intended -- it was to run every key, use the same permutation, and produce a proper count -- and directed that it be rebuilt to the May design, with the disclosure that design adds accepted and stated. The rest of this note works out that design; where it chooses a mechanic the design text leaves open, it says so.

## What the narrowing saw, and what it decided wrongly

The design review's analysis was correct in its mechanism. A permutation held across rounds is a stable per-record pseudonym, and the receiver chooses its own inputs, so it can attribute slots to records. The cross-key count and that attribution are the same mechanism: there is no version of the construction that keeps the multi-key count and drops the vector, because the count is exactly what requires the pseudonym to be stable.

It understated the scale. It described the attack as one value at a time, one record bound per round. A receiver that gives each of its records its own pattern of real values and dummies across the keys attributes most matched slots in one run, by leaving fields blank in its own input, with no modified software. And even from genuine inputs the receiver's own key coverage narrows a slot: a slot matched on a set of keys belongs to a record with values for all of them. [PROTOCOL.md](../spec/PROTOCOL.md#threat-model-scope-of-the-count-only-claim) states both.

What it decided was a scoping question, not a feasibility one: whether the comparable count is worth that disclosure. The review traded the count's comparability away on an unmeasured judgment that the pre-agreement question rarely needs more than one key. The maintainer made the opposite trade, and the spec states the disclosure in full rather than avoiding the construction that causes it.

## Why the library's revealing mode, with Alcove applying the permutation

The vendored library (`@openmined/psi.js` 2.0.6-seclink.6) was driven on 2026-10-27, on the WebAssembly build and the native addon alike, with two keys, six receiver records and four sender records:

- **The cardinality mode cannot support the construction.** With the reveal flag cleared the server's response comes back sorted by ciphertext, the server takes no permutation, and the match returns a size with no association table. Each round's order is a function of that round's ciphertexts, so no order can be held across rounds.
- **The revealing mode can.** Its response comes back in request order, and its match returns each matched element's position in the response as received. With the sender rewriting the response's element list under one permutation for both rounds, the positions returned were slots: they mapped back to the receiver's records only through the permutation, and the union of the two rounds' slots was the distinct count.
- **A repeated value shows.** A request repeating one value had both of its slots matched to the same setup position, which is why the spec gives every holder of a repeated value a dummy (below).
- **The mode check refuses a mismatched flag** in both directions, but under this construction the flag does not tell `psi` from `psi-c`, since both set it.

**The alternative weighed: a fork mode.** The fork could gain a third request mode in which the server takes a permutation and the client's match returns slot indices, keeping a mode marker on the wire. It was not adopted. It adds a change to cryptographic code and a re-vendor with provenance for a marker that protects little: the protection that matters is the sender's own permutation, and no mode, in the library or out of it, lets the receiver tell whether the sender applied one. Algorithm agreement is already compared symmetrically at the run boundary before any round.

**What the revealing route gives up.** The one-key build rested on three properties the library held in its cardinality mode. Exactness stays, from the `Raw` setup. The mode marker on the wire is gone, and algorithm agreement moves to the agreed terms. The unavailability of the identifier-revealing operations moves from the library into Alcove's own engine, which keeps every round's matches and returns only the count. That last move is a property of Alcove's software rather than of the library, which is a real loss against a receiver running modified software -- but such a receiver learns what the spec already states the receiver's software can learn, and no library mode would stop it either.

## Which count

Two counts fit "a consistent permutation":

- **The union of slots**: the receiver's records matched on at least one key. It needs the permutation alone. It over-counts against a linkage when two of the receiver's records match one sender record on different keys, and it depends on which party is the receiver. In the probe above, one receiver record matched different sender records on the two keys; the union counted three records where a one-to-one linkage pairs two.
- **The one-to-one cascade replayed over pseudonyms**: the sender also gives its records stable pseudonyms, through a per-round index table over a padded setup, and the receiver's engine replays the cascade in key order over slots and pseudonyms. Its size is that of a true one-to-one linkage, as the May text says, and it does not depend on which party is the receiver.

The replay was taken: it is the count comparable to the linkage it is used to justify, which is the instrument's purpose. The index table is the single-pass index table's idea, keyed by pseudonym instead of by row, so that sender row order -- which can be meaningful, a file sorted by name or date -- does not reach the receiver.

**Uniqueness over the whole dataset.** The `psi` cascade applies its uniqueness rule to the records still unmatched at each key, so a value repeated within one dataset can take part once an earlier key matches all but one of its holders. Neither party knows on the wire which of its records matched, so matching that rule would mean sending every holder and resolving the repetition in the replay, where the receiver would see its own repeated values as one setup element matched by several slots, tying those slots to records it knows share a value. The whole-dataset rule avoids that. Its cost is a count that can differ from a `psi` run's where values repeat within a dataset, in either direction, which the spec states.

## The mechanics, and the one this note adds

The ruling names two mechanics as following from the design rather than being choices: per-record dummies and padding, so every round's request has one element per record in the receiver's own order and slots line up; and the whole-dataset uniqueness rule. Padding also hides each key's coverage from the partner, which the one-key build's frames disclosed.

Two more are this note's own reading, proposed with the spec rather than taken from the design text:

- **Round values are prefixed with the round's position.** One exchange uses one PSI key a party for all its rounds (`packages/core/src/psi/psiEngine.ts`). Without separation a value appearing under two keys -- a record whose two keys realize to the same string, or one record's key 1 equal to another's key 2 -- encrypts to the same element in both rounds, and the receiver, which knows where its own values coincide, could link those slots to records. A fresh key per round would also close it; the prefix is simpler and keeps one engine per exchange.
- **Each run draws its own permutations.** A recurring exchange reusing one would let the receiver line up slots across runs, which turns the differencing attack into a per-slot one.

## The alternative weighed: one round of key blocks

A lower-leak design runs one round in which each receiver record is a block of one value for each key, and the sender permutes the blocks and shuffles the values within each block. The receiver learns how many of a record's keys matched but not which, so per-key counts, key overlap and the crafted pattern attack are much weaker. It yields only the union count, with no cascade replay, so its figure is not that of a linkage, and it is outside the design the maintainer ruled for. Not adopted; recorded here as the starting point if the disclosure above is ever judged too much.

## Open questions for the maintainer

The spec keeps each of these refused, fail-closed, on a reason of its own, until the maintainer rules:

- **Candidate sets** (fan-out, fuzzy comparisons, swap) in the first build. The one-key build's reason -- a count of matched values rather than records -- does not apply under per-record slots and a record-level replay. Group sizes would identify records, though, so every record's candidates would be padded to its key's declared width, which makes the width bound the padding size. The built-in default keys include a swap key, so a default draft stays refused under count-only until candidate sets are admitted. Recommended: a stage of its own right after the core rebuild, padded to the declared width.
- **`single-pass` and `missing_field` key conditions.** The one-key reason ("one key in one round") is gone for both. Every count-only round is full-size, so single-pass would differ from the cascade only in batching, and a missing-field condition's two rounds would pad like any other. Recommended: admit both once the replay is shared.

Two things are not open. `deduplicate` stays refused: what a count means under a many-to-X cardinality is not defined. And how often coverage singles out a record on genuine data is unmeasured; measuring it on a realistic dataset before consent copy states a limit is proposed, as is a receiver-side warning when a coverage class is small, neither of them built.

## Count reporting: who learns the number

The receiver computes the count; the sender learns nothing about it from the rounds. Whether the number travels back is decided by the agreed output entitlement, and the specified rule is a single count-report frame from receiver to sender in the both-entitled case and no frame at all otherwise ([PROTOCOL.md](../spec/PROTOCOL.md#count-reporting-and-entitlement) has the normative rule).

The consequence to state plainly is that the sender's copy of the count is the receiver's word. Alcove does not stop a receiver that reports a different number. That is the same posture as the association-table return leg under `psi`, where the sender's half of the pairing likewise arrives as the receiver's report, so this is not a new class of trust -- but it is stated rather than left for a reader to assume a mutually-computed figure.

**Where that is stated, and to whom.** The consent tier states it to both seats at accept time, because acceptance cannot tell either party which seat it will take -- the role follows from record counts neither side has exchanged yet. The completion surfaces can: by then the seat is resolved, so the sender's number shows the caveat again where it is read, and the receiver's does not. Repeating it for a receiver would be worse than redundant -- it would be false, since a receiver's count comes from its own engine, not from a partner. That asymmetry is the reason the caveat lives at the seat rather than beside every count: a warning that fires on the enforced case teaches an operator to discount it on the trust-contingent one.

"Where it is read" is more than one place. A completed exchange states the count twice: once in the result surface, which shows the full caveat, and once in the disclosure ledger's receive row, which is the condensed record of what the exchange did and the part an operator is most likely to skim or screenshot. A ledger that repeated the figure without saying who produced it would put the number in front of the reader stripped of the fact that qualifies it, and the shorter copy would be the more durable one. So the receive row closes with its own row-sized provenance clause on a partner-reported count -- what produced the number -- while the result surface keeps the sentence explaining what that means. The two are one vocabulary at two lengths rather than two wordings of the caveat, and the receiver's row, like the receiver's result surface, shows neither.

**The alternative weighed, and not adopted.** When both parties are entitled to output, the exchange could run **role-swapped double rounds**: each party takes the receiver role once, each computes its own count from its own rounds, and the two values are exchanged only to be compared, with a divergence aborting the exchange. Neither party would then hold a number it took on the other's word, and a receiver that lied would be caught by the comparison rather than believed.

It was not adopted, for two reasons. It doubles the elliptic-curve work of the exchange -- the expensive part -- to remove a trust dependency the system already accepts in the same shape elsewhere; and the abort-on-divergence it buys is not the guarantee it first appears to be, since a party willing to misreport a count is equally able to contribute a different input set to its own rounds, which the comparison cannot detect. The dissent is recorded here rather than discarded: it is a coherent design, and if psi-c ever needs a checkable count -- for a setting where the number itself has contractual weight -- this is where to start, not from scratch. Under the replay the two directions' counts are equal for conforming parties, since the count does not depend on which party is the receiver, so the comparison would be exact.

## Why the threat-model scope is stated plainly

The count-only property protects the sender against a receiver that contributes a genuine dataset, up to what that receiver's own key coverage narrows. It does not protect the sender against a receiver that chooses its input set: a pattern of real values and dummies across the keys attributes most matched records in one run, one live candidate padded with values the sender cannot hold turns a count of 0 or 1 into a membership answer, and two runs differing in one record do the same by subtraction. All three sit a step beyond honest-but-curious, all three are accepted rather than prevented, and [PROTOCOL.md](../spec/PROTOCOL.md#threat-model-scope-of-the-count-only-claim) says so in the specification rather than in a footnote.

Stating it there is by design. A count-only exchange reads, to a non-specialist, like the safe option -- and it is offered specifically to program officers weighing whether to share data at all, who are the readers least equipped to supply the missing caveat themselves. An algorithm whose selling point is "you learn only a number" has to state, in the same place, what a partner can do with the freedom to decide which numbers to ask for. The accurate framing is that psi-c bounds what the protocol shows the operator, not what a determined partner's software can arrange to learn.

## See also

- [PROTOCOL.md](../spec/PROTOCOL.md#psi-c) - the normative construction, refusals, wire shape, and threat-model scope
- [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#count-only-psi-c-records) - the count-only record rows and what the signed receipt attests
- [one-sided-disclosure.md](one-sided-disclosure.md) - why a shuffle does not hide a party's own data from that party, and the one-sided disclosure tradeoffs psi shares
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model) - the honest-but-curious model the scope above is stated against
