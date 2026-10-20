---
title: "Grounding the Linkage Rules: Bands, Precision Order, and an Evidence Bar"
---

# Grounding the linkage rules: bands, precision order, and an evidence bar

_Status: proposal, pending adoption. This note records the design rationale
behind the rules in [linkage-rule-catalog.md](linkage-rule-catalog.md): why
there are two bands, why a rule loosens one element, where the coverage
condition comes from, how the rules compare with published practice, why they
run in precision order, what transfers to two-party exact matching, the
features they need, and the evidence a rule set must show before it ships.
Nothing here is adopted or shipped; the shipped field and key sets are in
[default-linkage-rule-set.md](default-linkage-rule-set.md). See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation.

## How to read the citations

Sources are cited by author and year. The full reference for each, with its DOI
or URL, is in the catalog's [Sources](linkage-rule-catalog.md#sources) list, or
in this note's own [Sources](#sources) for those cited only here. Rules are
cited by their number in the catalog, 1 to 39 with 36a. A statement marked
"(reasoning)" is this note's own inference, not a sourced fact.

Three limits on the sources apply throughout:

- **Token sets are read from shipped code and configuration.** linkja publishes
  no key specification, and Datavant no enumeration of its tokens; what is
  citable is what the software emits and what the N3C configuration selects.
- **The NCHS methodologies are probabilistic** linkages with a short
  deterministic pre-pass. They cannot directly decide a question about cascade
  order, so any ordering inference from them is by analogy.
- **The per-key measurements are not a benchmark.** They are of unordered
  tokens, of a key over an SSN-blocked sample, of a blocked candidate set from
  one institution, or of a stratum another matcher missed. None measures a key
  inside an ordered cascade, almost all are from health, death, voter and
  school records, and none is of two agencies' program records matched
  exactly.

## Why two bands

The catalog offers two bands, 99% and above and 95% to 99%, and nothing below
95%.

A third band above 99.5% was considered and dropped. Full-SSN rules do reach
it: Grannis et al. (2002) bound `SSN + DOB` at a false share under 0.14%
(computed). No rule without an SSN does, so the band would contain SSN rules
only, and the difference between it and 99% is one the evidence cannot show for most
of the catalog. A deployment that checks a band by reviewing a sample needs 300
reviewed pairs with no false pair to support 99%, and 600 to support 99.5% (the
rule of three, computed). An operator cannot be expected to weigh a distinction
that costs twice the review to show.

A band below 95%, such as 90%, would be added only for a rule with evidence
placing it there. None is offered today.

### The evidence standard

A rule gets a band when there is evidence for it: a measurement of the rule, a
measurement of a close relative, or an extrapolation from one that the catalog
spells out. The band must apply wherever the rule is offered. A rule with no
such evidence is not offered, and an operator reaches it only through the
expert key editor.

The split between measured and reasoned bands is not the axis that matters
(reasoning). Every measurement comes from a pool of records unlike the
operator's, so a measured band is itself an extrapolation to the operator's
files. What decides whether a rule is offered is whether its band applies
across the files it will be offered for.

The maintainer makes two exceptions, and the catalog states each: the three
email rules are placed at 95% while evidence for them is gathered, and rules 31
to 33, whose band holds only where the files cover few people, are offered at
95% for any pair of files and marked less certain.

The catalog keeps each band's evidence and reasoning; the screens an operator
sees name each floor by a label with no percentage
([Bands](linkage-rule-catalog.md#bands)).

## Coverage and file size

Chance agreement grows with the number of people two files cover. Zech et al.
(2016) found 0.18% of individuals in an 11-million-record random sample (13.1%
of the national records) of the Death Master File sharing their first name,
last name and date of birth with someone else, against 1.19% in the full
85.8-million-record file. Zech's two figures differ by the number of people
covered, not by geography. Hillestad et al. (2008) found last name + DOB gave a
33% chance of a false match in 79 million records.

Geography matters beyond size. A local file concentrates names and dates:
Hillestad's 42,000-record regional subset collided thirty times more often than
scaling from the national file predicts. And the counterparty's geography
matters: in Mirel et al. (2022), links agreeing on name + sex + DOB with no SSN
were 41.4% false where the state token did not agree and 0.3% where it agreed.
A token is not created when any of its fields is missing, so the first row
includes pairs with a state missing on one side.

The catalog's entry for rule 31 sets out the measured range: Florida, Tennessee
and Cook County at or above 95%, most at or above 99%; Iowa the one in-state
outlier, plausibly an error in the reference; and cross-state pairings where
only about three-quarters were confirmed duplicates (Goel et al. 2020). So name
+ date rules with no SSN, contact field or geography are marked less certain
wherever keys are listed: their band holds where the files cover few people
and falls as the number covered grows. The mark speaks of how many people the
files cover rather than of a place, since size is what drives chance agreement
and a state or metropolitan area is only one unit that could stand for it.

Ocampo et al. (2016) matched case records across the whole of DC, Maryland and
Virginia, confirmed by each jurisdiction's own check. It is a data point for
the name + date rules, not evidence of how many people they hold their band
over.

A file drawn from one age group behaves like a far larger file, since its
members share birth years. In one graduating class, 0.12% of name and date
combinations appeared more than once (Fong et al. 2018), so at least about
0.23% of the students shared theirs; across California's K-12 records the
figure was 0.25% of combinations (Barrat and Berliner 2013), at least 0.49% of
the records (both computed). The bands assume files spanning all ages
(reasoning).

### The person's own ZIP

A ZIP rule needs the ZIP of the person's own address. Some data standards
record only the ZIP of the site that serves a person: HUD's FY2026 HMIS
standards have no client ZIP, and their one ZIP is the project's principal site
(HUD 2025a; HUD 2025b), held in the project file of the export, not the client
file (HUD 2025c). Everyone served at one site shares it, so a party must never
supply it as the person's ZIP. A party with no person's ZIP brings none, and
the ZIP rules drop out of its exchanges.

A former address's ZIP may be supplied instead, such as the ZIP of the last
permanent address that HUD's earlier standards recorded (HUD 2010). Where the
other party records a current address, it costs matches rather than precision
(reasoning): ZIP change caused 95.7% of the true readmissions Naessens et al.'s
(2015) DOB + sex + ZIP rules missed.

### The last four SSN digits

Some systems collect only the last four SSN digits: HUD's standards since FY2024
require only those four, leaving each Continuum to decide whether to collect
all nine (HUD 2025d). A record holding only the four digits is a normal record
in such a system, which is why rules 14 to 20 and 26 use them.

## Why one loosened element

A rule that tolerates an error in a base rule runs after it, so it adds only
the true pairs that have that error and the chance pairs its tolerance opens.
Its precision is about

    g / (g + k * f)

where `g` is the share of true pairs with the error, `k` the factor by which the
tolerance multiplies the base rule's chance agreement, and `f` the base rule's
own false share, which grows with file size (reasoning).

- **A rare error with a wide tolerance fails.** `LN + FN + DOB` with day and
  month exchanged catches an error behind only 2.6% of date discrepancies (Just
  et al. 2016), and the exchange opens a second candidate date for most
  records. Across the range of `f` from a small file to a large one its
  precision runs from 99% to under 50% (computed), so it is not offered;
  rule 19, with the last four SSN digits, covers the error.
- **A common error with a narrow tolerance passes.** Splitting compound names
  added up to 9.1% of a statewide match's pairs (Barrat and Berliner 2013).
  With `k` taken as 0.3 (reasoning), that meets the 95% band wherever `f` is
  under about 1.6% (rule 33, computed). Name swaps are about 1.75% of true
  pairs (Just et al. 2016), but the shipped swap is not a narrow tolerance: the
  receiving party sends both name orders for every record (rule 32). Placing
  the swap under this heading assumed a narrower swap than ships, one loosening
  only records whose two names are each plausible in the other slot; how much
  the shipped swap multiplies rule 31's chance agreement is unmeasured.

Two loosenings in one rule multiply their factors, while the true pairs they
add are only those with both errors, the intersection of two small shares. So
precision falls fast with each loosening added (reasoning). The argument
applies only when each single loosening runs as its own rule: the pairs with
one error are then claimed by the single-loosening rule, and the double rule
adds only pairs with both.

Beside a full SSN, `f` is small enough that a product of factors stays small,
which is why the full-SSN rules may loosen two elements. Rule 26 loosens two
beside the last four digits and is placed at 95% for it.

### Bits per field do not add

A budget that sums the bits each field contributes is a screen for rules not
worth measuring, not a band (reasoning). Hillestad et al. (2008) measured the
increments: a ZIP divided name + date collisions about 700-fold in the national
file and about threefold in the 42,000-record regional file. A field's
contribution depends on the file and on the fields beside it.

## How the rules compare with published practice

### Published unduplication guidance

HUD's HMIS standards define what is collected and how it is coded, and leave
matching to the software vendor; their one statement on it is that the software
"should allow for the effective matching of partial SSNs" (HUD 2025a). HUD's one
published matching rule is its 2005 unduplication guidance: agreement on any two
of first name, last name, DOB and a partial SSN makes a potential match, as does
a full-SSN match alone. A match is deleted when two fields conflict unless the
full SSN and two of the names and date agree, a null never counting as a
conflict. A separate rule, its twin check, deletes a match on last name + DOB
where the SSNs do not match, a missing SSN counting as not matching, both
clients were under 18 at program entry, and both first names are present and
differ (Sokol and Gutierrez 2005, Part 7, p. 9).

### The token sets are unordered

The published exact-key systems emit sets, not cascades. linkja emits its hashes
side by side, the SSN-bearing ones only when an SSN is present, and leaves
matching to a separate component (MRAIA 2020). The N3C configuration emits
eighteen tokens per record (Regenstrief Institute 2021). The CODI guide
specifies fields and declines to specify keys at all (MITRE 2022). Each yields no
token for a key whose field is missing or invalid, as Alcove does, so a missing
field costs a match rather than adding a false one.

What the catalog takes from them:

- **linkja's error variants.** linkja aims hashes at named entry errors: a
  swapped name order, a transposed day and month, a date off by one day or one
  year, and a three-letter first name. Its SSN is the last four digits, so its
  date and name variants are rules 17 to 20. Three details of the shipped code
  (MRAIA 2020):
  - It computes only a date plus one day and a date plus one year, and only in
    the hashes that include an SSN. Its matching component compares each record's
    exact-date hash with every record's offset hash, which covers a one-step
    difference in either direction within a pair.
  - Its overview describes hashing each part of a compound surname, which rules
    15 and 33 follow, but the shipped code disables it and collapses a
    hyphenated surname into one word.
  - The overview's data dictionary lists the three-letter first-name hash
    with an SSN and without the date of birth, but the code includes the date.
- **N3C's contact and geography tokens.** Every N3C token with a ZIP also has a
  last name, and email and cell phone each appear once, beside a first name.
  Rules 22 and 34 are N3C tokens (34 without gender), and the phone and email
  rules are stricter forms of its first name + phone and first name + email
  tokens.

Two divergences remain, both in the shipped rules:

- **No sex field.** Most measured name + DOB keys include sex or gender, and
  Alcove's fields have none. Each catalog entry with a sex-bearing relative
  treats the missing field as loosening the rule (reasoning).
- **Truncated last names.** Rules 2, 3, 10, 13 and 26 truncate the last name to
  three or four letters. The published sets truncate only the first name and
  keep the last name whole.

### Phonetic names

The evidence on a phonetic name code splits by what else a key requires.

**Beside an SSN, phonetic names added true links and no false ones.** In
Grannis et al. (2002), SSN + NYSIIS-coded names found 234 and 90 more correct
links (4,775 and 5,247) than SSN + exact names (4,541 and 5,157) at the same
count of wrong ones (7 and 2). In Mirel et al. (2022), links where an SSN token
and the Soundex-names token agreed without an exact-name token were 531 true
and none false (rows 9 and 10 of Table 1, 10 and 521; the 521 also agreed on
the SSN + exact first-name token, so counting that as an exact-name token
leaves 10 true and none false). SSA's BENDEX accepts a Soundex-equivalent
surname with the SSN (SSA 2022).

**As the only loosened name element, without geography or a contact field, a
Soundex surname does badly.** Rogot et al. (1983, Table 1) found 2 of 34
reviewed pairs true where the last name agreed only by Soundex, the first name
and birth year and month agreed exactly, and no SSN was available; the
Soundex-names token alone was 81.4% false in Mirel; in Ocampo et al. (2016),
the tier pooling Soundex-coded first and last names + DOB with an exact last
name + DOB rule had 46.7% to 90.3% of its matches confirmed across six
jurisdiction checks (Tables 3 to 5); and NCHS planned to drop Soundex from
National Death Index matching for NYSIIS on last names, after evaluations
found Soundex added false positives and very few true positives, with no
counts given (Patterson and Bilgrad 1985).
Cook County left phonetic codes out to preserve specificity (Trick et al.
2019).

So the catalog uses a Soundex surname only beside a ZIP, phone or email plus
the full first name (rules 28, 36 and 39), where it is unmeasured rather than
contradicted: beside a ZIP it admits about 2.9 times the false agreements of
the exact surname (Randall et al. 2013), and beside a contact field the floor
is household sharing, where the surname is the same anyway (reasoning).

**Soundex and NYSIIS.** Grannis measured NYSIIS, and Alcove's phonetic
transform is Soundex. Three sources compare the two codes (Sun and Golden 2019;
Bailey et al. 2020; Christen 2006). Christen found Soundex had the higher
f-measure on known name variants, with no SSN involved. Sun and Golden compared
them beside a full SSN, on 2,037 pairs agreeing on the SSN, birth month and
year and sex but not exactly on name, and Soundex agreed on more of them; they
state no false-agreement rate. So no source measures either code's false
agreements beside an SSN, and rule 8's measurement reaches Soundex by
extrapolation. Whether Alcove adds a NYSIIS transform is an open question.

### The operating cascades

Four published deterministic cascades run rules in a stated order:

- **NCHS**, in its recent methodologies, runs a two-pass deterministic SSN
  stage before its probabilistic stage: full SSN first, then the last four
  digits, with a record linked in the first pass excluded from the second. It
  demands more corroboration of the weaker key, not less (NCHS 2022; NCHS 2023;
  NCHS 2024). Its probabilistic
  passes are overlapping blocking passes combined afterwards, not a cascade.
- **Cook County** runs complete name + DOB first and its two last-four-SSN rules
  fifth and sixth. It counts matches per rule but validates the six together,
  and found homelessness associated with disagreement between its rules and its
  EHR process (adjusted odds ratio 2.4) (Trick et al. 2019).
- **Ong et al. (2020)** ran first name + last name + DOB, then last name + last
  four SSN + birth year, and the second step produced no new links.
- **Massachusetts's school-meals match** ran exact name + DOB, then the same
  with day and month switched, then first initial + last name + DOB + city
  (Cole and Logan 2006).

The Sequoia Project (2018) placed its name + DOB + sex + phone rule at highest
precedence, above its last-four-SSN rule, on uniqueness rather than precision.

No source publishes an ordered cascade with a measured false-match rate per
position.

## Why precision order

Under the default `cascade` strategy each round excludes the records an earlier
rule matched
([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termslinkage_strategy)).
Order therefore decides which rule claims a record more than one would match,
and it can change the match set: a record claimed early is unavailable to a
later rule that would have paired it with a different partner record.

Running rules in precision order means the rule that claims a record is the most
precise one that could, and a less precise rule sees only what every more
precise rule left (reasoning). Each band is information a party consents to, so
the order is what makes a rule's band describe the pairs it actually claims.
The shipped built-in key set runs in precision order, the 99% band before the 95%
band, as the comment on `DEFAULT_LINKAGE_KEYS` in
`packages/core/src/defaults/builtInLinkageTerms.ts` records.

Published practice is split. NCHS orders strictest first. Cook County and Ong
put name + DOB first, but their later rules are not stricter forms of it: Cook
County's loosen the date, and Ong's drops the first name and the day and month.
Mirel et al. (2022) is the nearest measurement of a residual round: it charges a
weak token only for links no stronger token also supported, and that is where
the no-SSN name tokens failed. It is still a pattern stratum, not a precision:
each row counts the links on which exactly that set of tokens agreed, after
each link was chosen for having the most high-precision (SSN) tokens, other
tokens breaking ties, against an earlier NCHS linkage as the truth.

### Placements the evidence forces

Within a band two tie-breaks apply (reasoning):

1. A refinement runs before the rule that contains it, so a match is credited
   to the stricter rule. Rules 1 to 5 run before 6; 7 before 8, 9 and 10; 11
   before 12; 15 before 16; 21 before 22; 35 before 36; and 38 before 39.
   Rules 22 and 23 are refinements of rule 31 and run in the band above it.
2. Otherwise full-SSN rules run before last-four rules, and those before rules
   with neither.

A refinement adds a match only by splitting a value two of one party's records
share, which a one-to-one round drops as ambiguous
([PROTOCOL.md](../spec/PROTOCOL.md#value-level-round-participation)). Records
dropped as ambiguous stay eligible for later rounds, so the order of a
refinement and the rule containing it decides which rule is credited with a
pair, not whether the pair matches.

The claim for rules 22 and 23 is about candidate pairs. Their candidate pairs
are a subset of rule 31's, and the pairs they accept beyond it are those rule
31 drops as ambiguous within one party's file, mostly one person recorded twice
(reasoning).

The refinements of rule 6 (rules 1 to 5) stay in the catalog although rule 6
contains them: they add a match only where one party holds two records tied on
the broader value, and an operator cannot be expected to know whether their
file does. Their cost is rounds, not precision.

Orders not forced by containment or a tie-break are left open among rules of
one band.

## What transfers to two-party exact matching

Every error model above comes from linking a file against a reference file, or
deduplicating one file, in clear text. A two-party exact intersection fails
differently in three ways.

**A false match needs a value both files hold.** A match happens only when both
parties derive the same key value. An error confined to one party that produces
a value nobody holds destroys the key and costs a match. A false match needs a
real collision (two people whose true values agree on every element), an error
present in both files, or a one-sided error that lands on another real person's
correct value, as an overlay does, one person's information recorded on
another's record (Landsbach 2016).

The last case is the dominant measured SSN error. In Grannis et al. (2002) the
most common SSN error "appeared to be" a spousal mix-up, a woman's record linked
to a man's sharing her last name, read as the guarantor's number on the
spouse's record. A wife recorded under her husband's SSN at one agency, against
a counterparty holding the husband under his own number, is a false match
wherever the rule's other elements agree, and the spousal mix-up shares the last
name. So for SSN rules the reference-file error rates are an estimate under
two-party intersection, not only an upper bound (reasoning).

**Standards manufacture shared errors.** The mechanisms that put one wrong value
in two files are the ones a shared operating context supplies: a person
repeating a made-up name, a document copied between agencies, and a shared
convention. A filler entered for an unknown value looks like a real one, a
disguised missing value (Ong et al. 2024). HUD tells staff
to record `01` for an unknown month and day, unless the Continuum has its own
filler (HUD 2025a), so two records independently agree on a date neither knows,
and its name data-quality codes admit placeholder and made-up names entered to
create a record (HUD 2025a). `baseline-pii` excludes placeholder SSNs, and the
default cleaning drops a listed placeholder name or date
([DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#per-party-placeholder-lists))
and the SSN, ZIP and phone fillers below
([Fillers the default cleaning drops](#fillers-the-default-cleaning-drops)),
but nothing bounds a filler month and day.

**A missing field yields no key.** A record missing any element of a rule
contributes nothing to that round and stays eligible for later ones. A rule's
reach is therefore the joint fill across both parties: Bernstam et al. (2022)
found 94.6% of records filled the phone number field, while the cell-phone
token's pair fill was 68.01%. A rule's reach must be quoted as pair fill or it
is overstated.

## Fillers the default cleaning drops

A filler both files hold is a false match on every key it enters, so the
default cleaning drops the fillers below. The pipelines are specified in
[DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#per-type-pipelines).

### SSN placeholders

- **`078-05-1120`.** It first appeared on a sample card in wallets sold
  nationwide in 1938, and was "subsequently reported thousands of times by
  different individuals", 6,000 or more wage earners in 1943 (Scheuren 1985).
  linkja and the California Policy Lab's hashing code each reject it, with
  `123-45-6789` (MRAIA 2020; California Policy Lab 2023).
- **`219-09-9999` and runs of consecutive digits.** The Open Path HMIS
  warehouse rejects as published numbers `219-09-9999`, `078-05-1120`, the
  first nine digits of each rotation of `0123456789`, and each of those
  reversed (Green River Data Group 2026).
- **`111-22-3333`.** North Carolina names it "the most common 'SSN' in North
  Carolina", entered by people who do not want to share their real SSNs
  (Government Data Analytics Center 2023).
- **Seven or more 9s or 0s in a row.** Grannis et al. (2023) hold that SSNs
  "should contain no more than six nines or six zeros in a row". The default
  drops a nine-digit value holding seven or more 9s, or seven or more 0s, in a
  row.

The `ssn4` derived from an `ssn` column drops a value whose full digits are on
the same list, from the same constant in code, so the two cannot list different
values. Without it, everyone who wrote a placeholder would share its last four
on every `SSN4` rule (reasoning). It drops a value with a filler run too, except
a run of zeros when the area number is `000`, which is the padding of a masked
SSN whose last four it keeps (reasoning). A column of last fours is not
screened: a bare last four cannot be told from a placeholder's.

### ZIP fillers

- **Codes for an unknown or foreign address.** The Florida Cancer Data System
  asks for `99999` when a US resident's ZIP is unknown and `88888` for a
  resident of a country other than the United States or Canada (Florida Cancer
  Data System 2021).
- **Codes for no address.** A Medi-Cal guide lists ZIP `00000`, `99999` or
  `ZZZZZ` among the entries used in place of the address of a person
  experiencing homelessness (Center for Health Care Strategies 2025). The
  CenSoc geography codebook warns that "non-identifiable codes such as 'XX768'
  and '00000'" may remain in its ZIP field (CenSoc 2025).
- **Codes not issued.** The Datavant specification N3C sites follow treats "zip
  codes not issued by the US government" as invalid (Regenstrief Institute
  2021), and OpenLinkToken rejects any code starting `000` (Open Link Token
  2026). Its list also names repeated-digit and sequential codes, which the
  default does not adopt.

The default drops `00000`, `99999`, `88888` and any value starting `000` after
padding. `ZZZZZ` has no digits and is dropped as empty. A value with letters
among its digits, such as `XX768`, keeps its digits and is padded, here to
`00768` (reasoning).

### Phone fillers

CDC's immunization-registry guide says to "eliminate 'filler' data that can
match incorrectly (e.g. 999-999-9999 for phone number)" (CDC 2025), and Grannis
et al. (2023) hold that telephone numbers "should contain no more than six
nines or six zeros in a row". The default drops a ten-digit value holding seven
or more 9s, or seven or more 0s, in a row.

## No SSN conflict veto by default

A rule with no SSN element accepts pairs whose valid SSNs disagree. A veto
would stop it there, and the catalog adopts none by default.

- **Its cost is the true pairs whose SSNs differ by a keying error.** Just et
  al. (2016) put pairs with a one- or two-digit SSN difference at about 1.7% of
  true pairs, an approximate figure from a vendor's cleanup-project sample, and
  larger differences add more: Newman and Brown (1997) found SSNs differed in
  7.6% of a matcher's links.
- **A hashed exact match cannot tolerate the difference.** NCHS accepts
  agreement on at least 8 of 9 SSN digits in its Class 1 matches and 7 of 9 in
  Class 2 (NCHS 2005), the independent support for tolerating a keying error.
  An exact match on a hashed SSN cannot take that route.
- **Its net effect on the 95% rules is unmeasured.** Their false share may reach
  the veto's cost, so it could help or harm them, and no source measures which.

## Rule features the evidence calls for

These are requirements, not designs, sorted by whether Alcove builds them.

### Built

- **A date expansion of one day either side: the `adjacent_days` comparison
  (#2275).** linkja, through its matching component, and Cook County use one,
  and Cook County's largest spike in date differences was at one day (Trick et
  al. 2019). Rule 18 needs it.
- **Address and area elements: the `street_number` type (#2299), and the
  `zip3` key-element transform over a ZIP and the `state` and `county` types
  (#2297).** They serve a street number (rule 21), a three-digit ZIP (rule 27),
  and state and county (rule 30).
- **A shared-contact screen: the shared-value screen (#2280), defaulting to
  five people per phone or email value** (spec:
  [DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#shared-value-screens)).
  Without it, a shelter's, clinic's or case manager's number on many clients
  gives each client one unique first-name-plus-phone value, which the
  one-to-one rule cannot catch. Rule 36a is offered only with it, and it
  shrinks the sharing floor of every phone and email rule. No source states a
  count cap for contact values: Cao et al. (2026) caught placeholder SSNs with
  a name-DOB consistency rule, not a count, and Culbertson et al. (2017) count
  999-9999 as a default rather than a value.
- **A per-side missing-field condition: a key's `condition`, admitting the
  date of birth** (spec:
  [PROTOCOL.md](../spec/PROTOCOL.md#keys-with-a-missing-field-condition)). A
  key stating it runs only where the named field is absent on one side, as two
  rounds, one per side lacking the field. It is not called a conflict veto: a
  veto implies comparing the two sides' values per pair, which exact equality
  of hashed values cannot do, while a condition stated per side, which both
  parties resolve the same way, needs only the terms. HUD's 2005 guidance
  deletes a potential match with conflicting values in two of gender, name
  suffix, the parts of the date and the full SSN (Sokol and Gutierrez 2005).
  The follow-on rule `FN + LN + SSN4`, for a side with no valid date of birth,
  uses it, and a filler date counts as absent
  ([DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#filler-dates)).
  Rules 35, 36, 36a, 38 and 39, the contact rules with no date of birth, need
  it as a missing-date condition too; see [Name suffixes](#name-suffixes).

### Not built
- **A phone type.** The Sequoia Project (2018) had to tag numbers so work and
  mobile phones were not compared. `phone_number` is one untyped field. No
  rule depends on it.
- **A name suffix field, by decision.** No suffix rule ships; the contact
  rules with no date of birth are to run through the missing-date condition
  instead, and are not yet built-in keys. See [Name suffixes](#name-suffixes).
- **A name-frequency condition**, which `FN3 + LN + DOB` for uncommon names
  would need: a frequency score for the first and last name combination with a
  cut point, as The Link King computes (Campbell et al. 2006). A general tool
  cannot define a common name except relative to a particular population, so
  the rule is parked.
- **Email local-part canonicalization**, folding dots and plus tags. Email is
  standardized by trimming and lowercasing only, so one mailbox written two ways
  gives two values and a missed match, not a false one (reasoning).

## Name suffixes

No source measures how often suffixes disagree between two files, or how often
a father and son make a false match.

- **Suffixes are recorded inconsistently.** HUD has asked for a separate suffix
  field since 2004, and the FY2026 export has one (HUD 2004; HUD 2025c).
  Elsewhere suffixes land in the wrong place or on one side only: employers
  enter them in E-Verify against the instructions (Westat 2012), Hawaii's
  school-meals guide gives a suffix on one file and not the other as a worked
  example of a near match (Hawaii Department of Education 2016), and Michigan's
  student data often had them appended to last names (Dynarski et al. 2013).
- **The one prevalence figure is small.** Students with a suffix were 0.3% of a
  Michigan sample, and moving suffixes to their own field made little difference
  to the match rate (Dynarski et al. 2013).
- **Matchers strip them.** Cook County removes suffixes from names (Trick et al.
  2019), and a Texas voter match removed them as "often not standard"
  (Ansolabehere and Hersh 2016). HUD's 2005 guidance instead counts a suffix
  conflict toward deleting a potential match (Sokol and Gutierrez 2005).
- **Parent-and-child pairs are counted in voter files.** Matching voter records
  on first name, last name, DOB and address, Goel et al. (2020) found 7,504
  in-state duplicates in Mississippi and 2,350 in Wisconsin, most differing on
  middle name or suffix, which the authors read as a parent and child given each
  other's birthdate. Their Figure A.3 puts same-name, same-date, same-address
  duplicates near zero in most states, about 1.25% of records in Mississippi and
  0.9% in DC, and requiring the suffix cut them to 0.65% and 0.27%. Hood and
  Bullock (2008) found "a small number" of fathers and sons with the same full
  name at one address. Kho et al. (2015) count suffixes only inside a mixed
  category of name disagreements.
- **The trade-off is stated, not measured.** Removing "Jr" risks a parent-child
  false match, and keeping it risks missing a son's own record that lacks it (Fu
  et al. 2022).

So the catalog writes the suffix as an element only in the contact rules with
no date of birth, where the same-name parent and child on a household phone or
email is the floor (rules 35, 36, 36a, 38 and 39). No suffix field is built.
The element would remove the parent-and-child pair only where both sides record
the suffix, at the cost of the pair where only one side did. The five rules
are to run instead through the per-side missing-date condition, and are not
yet built-in keys: each would run without the suffix, only where one party's
record has no date of birth, so a parent and child whose records both hold a
date are left to the rules that compare it. Suffixes stay stripped from the
name fields. The bands do not rise, because the phone and email floor is
unmeasured.

## The acceptance-evidence bar

### What the bar is, and what it is not

**Neither methodological authority sets a numeric pass-mark.** The reporting
guidance "does not set minimum standards or criteria for information that should
be provided nor is it a checklist or protocol" (Gilbert et al. 2018). The
evaluation guide says thresholds "are generally selected in the context of a
specific linkage or analysis", and that whether measured differences matter
"depends on the relationship between these variables and the parameters of
interest" (Harron et al. 2017).

So the bar below is a measurement and disclosure obligation -- what must be
measured, on what, and reported alongside -- not a threshold. The catalog's
bands are Alcove's own choice, and the bar is what a rule set must show for a
band to be checked rather than extrapolated.

**The state of practice is worse than the guidance.** Of forty-five published
studies linking Medicaid claims to birth certificates, four mentioned a
validation study and "none of the studies provided results of the validation
exercises" (Heins et al. 2022). A published match of Medicaid claims to a
housing-services information system states no matching method, and its quality
assessment is that "manual inspection of the matches indicates that those that
matched appeared accurate" (Nescott et al. 2023).

### The triad

The two guidance documents agree on three measurements:

1. **A gold-standard comparison** on a subset where the truth is knowable,
   reporting precision and recall rather than specificity or F-measure, which
   mislead where non-matches far outnumber matches.
2. **A linked-versus-unlinked comparison** broken out by demographic group,
   using standardized differences rather than p-values.
3. **A sensitivity analysis** re-running the headline result under stricter and
   looser matching -- for a cascade, with the weaker rules removed.

Harron et al.'s worked example of the third shows the trade: tightening one
linkage moved false matches from 0.9% to 0.3% and 0.1% while missed matches
rose from 0.4% to 10.7% and 51.5%, and the strictest arm lost an association
that was real in the gold standard.

### Substitute truth, and why it flatters

Where some pairs have a strong identifier, a substitute truth is free: run the
weaker rules against the pairs the strong identifier decided, and count how
often they would have been wrong. Its bias goes with every number it produces:
the subset is better kept than the file, and "records with high quality data
may differ systematically from those of poorer quality data" (Harron et al.
2017). Labels from a shared SSN also count a true pair with a keying error in
one SSN as false, so they put a ceiling on the precision they can show (rule
22). Either way, the error rate reaches the rest of the file only by
extrapolation.

### Sample review

A deployment can check a band without a gold standard by reviewing a random
sample of a rule's accepted pairs: 300 reviewed pairs with no false pair support
99%, and 600 support 99.5% (the rule of three, computed). A reviewed false pair
needs a larger sample to support the same band.

### Per-key ablation, and its one precedent

The bar should require each rule's marginal contribution: the set measured with
that rule removed, reporting the recall it added and the precision it cost. No
guidance requires this, and one evaluation performs it. Mirel et al. (2022)
tabulated the token combinations among returned links, so a weak token was
charged only for links no stronger token also supported, and dropped any
combination over 50% false. The false rate was computed against the same gold
standard on the same data, and nothing says the threshold was set in advance.
The four combinations dropped all rested on name, sex and date with no SSN
token. Dropping them moved the result from 93.8% precision and 98.7% recall to
98.9% and 97.8%, removing 11,515 false links at the cost of 1,738 true ones
(computed from rows 8, 11, 12 and 19 of Table 1).

A rule's marginal contribution is what it adds after the earlier rules have
claimed their records, so the ablation has to run with the cascade in place. A
rule measured alone can look valuable and add nothing in position.

### What a two-party exact-key evaluation must add

Four requirements follow from the intersection geometry rather than the
guidance:

- **Report pair fill, not record fill.**
- **Enumerate the shared-error modes and test them**: a filler date, a repeated
  made-up name, a placeholder both agencies inherited.
- **Measure precision on the population that will be intersected**, not a
  deduplication of one file, whose candidate set comes from blocking rules with
  no counterpart in a two-party exchange.
- **Emit per-rule attribution.** The reporting guidance asks for "the step in the
  algorithm at which the records were linked" with each pair (Gilbert et al.
  2018). Alcove records per-key stages, so this is a disclosure question.

### The bar, in one list

A rule set should not ship without:

1. Precision and recall on a gold-standard or substitute-truth subset, per rule
   and for the set, with the subset's construction and selection bias stated.
2. The pair fill of each rule, on data representative of both parties.
3. A per-rule ablation inside the cascade, in the set's declared order.
4. A linked-versus-unlinked comparison by demographic group.
5. A sensitivity analysis over stricter and looser variants of the set.
6. The shared-error modes tested, and what each contributed.
7. A stated order with the reason each rule sits where it does.

Numbers 2, 3, 6 and 7 are the two-party and cascade additions; 1, 4 and 5 are
the field's triad. None has a pass-mark.

## What the evidence does not settle

These gaps were searched for and not found:

- **No per-position precision** for any published cascade.
- **No precision for a five-digit ZIP rule without sex that is not capped by
  SSN labels, and none for an email rule on program records.** The ZIP5 band is
  an extrapolation (rule 22), and the one
  email measurement is of researchers' institutional addresses (Kim et al.
  2019).
  UCLA's selected strata are the nearest figures from program-like records:
  among pairs its EHR module had not linked, 13 of 100 agreeing only on email,
  26 of 100 only on phone, and 94 of 100 on first name + DOB + ZIP were the
  same person (Ross et al. 2020).
- **No measure of a phone or email shared by an organization** across the
  people it serves, and none of the same-name parent and child on a household
  phone or email.
- **No net effect of an SSN veto** on the 95% rules.
- **No comparison of Soundex and NYSIIS false agreements beside an SSN.**
- **No ZIP-stability figure for a highly mobile population.** Phone turnover is
  measured: 54.5% of homeless adults with a cell phone reported two or more
  numbers in three months (Rhoades et al. 2017).
- **No obtainable evaluation corpus** for a two-party exact-key product: every
  holder of labelled truth gates it behind review and a data use agreement.
- **No published baseline** for an exact-key linkage between two agencies'
  program records that a rule set could be measured against.

Two analyses of re-identification attacks on hashed match-keys assume an
adversary holding exchanged tokens together with clear-text quasi-identifiers
(Vidanage et al. 2020; Eliazar et al. 2025). Whether that threat model reaches a
two-party PSI exchange is a question about Alcove's protocol this note does not
decide.

## Sources

Sources cited by both notes are in the catalog's
[Sources](linkage-rule-catalog.md#sources) list. Those cited only here:

- **California Policy Lab 2023.** California Policy Lab. "hashed-linkage," source code and README (the SSN screen in Hash/Python/hashing_base_linkagetoolkit.py). GitHub, last revised 2023. https://github.com/californiapolicylab/hashed-linkage
- **Campbell et al. 2006.** Campbell K, Deck D, Cox A, Broderick C. "The Link King: User Manual, Version v5.2." Washington State Department of Social and Health Services, 2006. https://web.archive.org/web/20070106073145id_/http://www.the-link-king.com:80/user_manual.zip
- **CDC 2025.** Centers for Disease Control and Prevention, National Center for Immunization and Respiratory Diseases. "Immunization Information Systems Patient-Level De-duplication Best Practices." February 2025. https://www.cdc.gov/iis/media/pdfs/2025/02/De-Duplication_Best_Practices_Report.pdf
- **CenSoc 2025.** CenSoc project. "censocdev," the code and codebooks that build the CenSoc files (the Geography File codebook's `death_zip` entry). GitHub, 2025. https://github.com/caseybreen/censocdev
- **Center for Health Care Strategies 2025.** Center for Health Care Strategies. "Data Sources for Determining Members' Housing and Homelessness Status." Tool, February 2025. https://www.chcs.org/media/Data-Sources-for-Determining-Members-Housing-and-Homelessness-Status.pdf
- **Cole and Logan 2006.** Cole N, Logan C. "Data Matching in the National School Lunch Program: 2005. Volume 2: State Case Studies." Abt Associates for the U.S. Department of Agriculture, Food and Nutrition Service, Report CN-06-DM2, 2006. https://www.fns.usda.gov/sites/default/files/DataMatching-V2.pdf
- **Dynarski et al. 2013.** Dynarski SM, Hemelt SW, Hyman JM. "The Missing Manual: Using National Student Clearinghouse Data to Track Postsecondary Outcomes." NBER Working Paper 19552, 2013. doi:10.3386/w19552
- **Eliazar et al. 2025.** Eliazar A, Brown JT, Cinamon S, Kantarcioglu M, Malin B. "Re-identification risk for common privacy preserving patient matching strategies when shared with de-identified demographics." Journal of the American Medical Informatics Association 33(2):336-346, 2026 (online 2025). doi:10.1093/jamia/ocaf183
- **Florida Cancer Data System 2021.** Florida Cancer Data System, University of Miami. "Data Linkage Record Layout." 2021. https://fcds.med.miami.edu/downloads/datarequest/Data%20Linkage%20Record%20Layout.pdf
- **Fu et al. 2022.** Fu S, Davis C, Rothstein J, Ramesh A, White E. "Hashed Linkages for Administrative Datasets: A Technical How-to Guide." California Policy Lab, 2022. https://capolicylab.org/wp-content/uploads/2022/03/Hashed-Linkages-for-Administrative-Datasets.-A-Technical-How-to-Guide.pdf
- **Gilbert et al. 2018.** Gilbert R, Lafferty R, Hagger-Johnson G, Harron K, Zhang LC, Smith P, et al. "GUILD: GUidance for Information about Linking Data sets." Journal of Public Health 40(1):191-198, 2018. doi:10.1093/pubmed/fdx037
- **Government Data Analytics Center 2023.** North Carolina Government Data Analytics Center. "Linking Records Across Data Systems, Part 3: Linking Workforce Data." NCLDS, version 1.1, December 2023. https://nclds.nc.gov/documents/linking-data-workforce-data/download
- **Grannis et al. 2023.** Grannis SJ, Xu H, Li X, Kasthurirathne S, Vest J, Harle C, et al. "Enhancing Patient Matching in Support of Operational Health Information Exchange: Final Report." Agency for Healthcare Research and Quality, grant 5R01HS023808, 2023. https://digital.ahrq.gov/file/39156/download?token=7edlb45a
- **Green River Data Group 2026.** Green River Data Group. "hmis-warehouse" (Open Path HMIS Warehouse), lib/util/concerns/hud_validation_util.rb. GitHub, 2026. https://github.com/greenriver/hmis-warehouse/blob/c19a88c2beebf21dbc741e10d5bd6d82e4d131fb/lib/util/concerns/hud_validation_util.rb
- **Harron et al. 2017.** Harron KL, Doidge JC, Knight HE, Gilbert RE, Goldstein H, Cromwell DA, et al. "A guide to evaluating linkage quality for the analysis of linked data." International Journal of Epidemiology 46(5):1699-1710, 2017. doi:10.1093/ije/dyx177
- **Hawaii Department of Education 2016.** Hawaii Department of Education, Hawaii Child Nutrition Programs. "Direct Certification Module User Guide for All Schools." 2016. https://hcnp.hawaii.gov/wp-content/uploads/2016/07/Direct-Certification-User-Guide-for-All-Schools.pdf
- **Heins et al. 2022.** Heins S, Predmore Z, Hoch E, Baxi S. "Linking Medicaid Claims, Birth Certificates, and Other Sources to Advance Maternal and Infant Health: Final Report." RAND, PR-A1961-1, for the HHS Office of the Assistant Secretary for Planning and Evaluation, 2022. https://aspe.hhs.gov/sites/default/files/documents/db89f9777de0142dc5b6562692f67032/linking-medicaid-claims-other-data.pdf
- **Hood and Bullock 2008.** Hood MV III, Bullock CS III. "Worth a Thousand Words? An Analysis of Georgia's Voter Identification Statute." American Politics Research 36(4):555-579, 2008. doi:10.1177/1532673X08316608
- **HUD 2004.** U.S. Department of Housing and Urban Development. "Homeless Management Information Systems (HMIS); Data and Technical Standards Final Notice." Federal Register 69(146):45888-45934, 2004. https://www.govinfo.gov/content/pkg/FR-2004-07-30/html/04-17097.htm
- **HUD 2010.** U.S. Department of Housing and Urban Development. "Homeless Management Information System (HMIS) Data Standards Revised Notice." March 2010. https://web.archive.org/web/20170829223119id_/https://www.hudexchange.info/resources/documents/FinalHMISDataStandards_March2010.pdf
- **HUD 2025a.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Data Standards Manual." 2025. https://files.hudexchange.info/resources/documents/HMIS-Data-Standards.pdf
- **HUD 2025b.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Data Dictionary." HUD Exchange, 2025.
- **HUD 2025c.** U.S. Department of Housing and Urban Development. "HMIS CSV Format Specifications, Version 1.0 (FY 2026)." HUD Exchange, 2025.
- **HUD 2025d.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Standard Reporting Terminology Glossary." 2025. https://files.hudexchange.info/resources/documents/HMIS-Standard-Reporting-Terminology-Glossary.pdf
- **Kho et al. 2015.** Kho AN, Cashy JP, Jackson KL, Pah AR, Goel S, Boehnke J, et al. "Design and implementation of a privacy preserving electronic health record linkage tool in Chicago." Journal of the American Medical Informatics Association 22(5):1072-1080, 2015. doi:10.1093/jamia/ocv038
- **MITRE 2022.** The MITRE Corporation. "HL7 FHIR Implementation Guide: PPRL Release 1 - US Realm, STU1" (CODI). GitHub, 2022. https://github.com/mitre/codi-fhir-pprl-ig
- **NCHS 2005.** National Center for Health Statistics. "The Third National Health and Nutrition Examination Survey (NHANES III) Linked Mortality File: Matching Methodology." December 2005.
- **NCHS 2022.** National Center for Health Statistics. "The Linkage of the 2016 National Hospital Care Survey to 2015-2017 Centers for Medicare & Medicaid Services Transformed Medicaid Statistical Information System Claims Data: Matching Methodology and Analytic Considerations." 2022. https://www.cdc.gov/nchs/data/datalinkage/2016-nhcs-cms-medicaid-linkage-methodology.pdf
- **NCHS 2023.** National Center for Health Statistics. "The Linkage of the National Center for Health Statistics (NCHS) Survey Data to U.S. Department of Housing and Urban Development (HUD) Administrative Data: Linkage Methodology and Analytic Considerations." 2023. https://www.cdc.gov/nchs/data/datalinkage/NCHS-HUD-Linked-Data-Methodology-and-Analytic-Considerations.pdf
- **NCHS 2024.** National Center for Health Statistics. "The Linkage of National Center for Health Statistics Survey Data to Centers for Medicare & Medicaid Services Transformed Medicaid Statistical Information System Claims Data (2014-2019): Matching Methodology and Analytic Considerations." 2024. https://www.cdc.gov/nchs/data/datalinkage/NCHS-CMS-TMSIS-Linkage-Methodology_1.pdf
- **Nescott et al. 2023.** Nescott E, Metraux S, McDuffie MJ, Brown E. "Health & Housing in Delaware: Matching Medicaid Claims and Encounters and the Community Management Information System Databases." Delaware Journal of Public Health 9(2):18-22, 2023. doi:10.32481/djph.2023.06.005
- **Ong et al. 2020.** Ong TC, Duca LM, Kahn MG, Crume TL. "A hybrid approach to record linkage using a combination of deterministic and probabilistic methodology." Journal of the American Medical Informatics Association 27(4):505-513, 2020. doi:10.1093/jamia/ocz232
- **Open Link Token 2026.** Open Link Token Contributors. "OpenLinkToken," v2.2.0, the US postal code attribute (lib/python/openlinktoken/src/main/openlinktoken/attributes/person/us_postal_code_attribute.py). GitHub, 2026. https://github.com/TruvetaPublic/OpenLinkToken
- **Rhoades et al. 2017.** Rhoades H, Wenzel S, Rice E, Winetrobe H, Henwood B. "No Digital Divide? Technology Use among Homeless Adults." Journal of Social Distress and the Homeless 26(1):73-77, 2017. doi:10.1080/10530789.2017.1305140
- **Scheuren 1985.** Scheuren F. "Methodologic Issues in Linkage of Multiple Data Bases." In Kilss B, Alvey W (eds.), "Record Linkage Techniques - 1985: Proceedings of the Workshop on Exact Matching Methodologies." Internal Revenue Service, Statistics of Income Division, 1985, p. 158. https://nces.ed.gov/FCSM/pdf/RLT85.pdf
- **Sokol and Gutierrez 2005.** Sokol B, Gutierrez O. "Technical Guidelines for Unduplicating and De-identifying HMIS Client Records." U.S. Department of Housing and Urban Development, 2005. https://web.archive.org/web/2017id_/https://www.hudexchange.info/resources/documents/TechnicalGuidelinesForUnduplicatingAndDeIdentifyingClientRecords.pdf
- **SSA 2022.** Social Security Administration. "Beneficiary Earnings and Data Exchange (BENDEX) Handbook for Daily Process." 2022. https://web.archive.org/web/20230605183520id_/https://www.ssa.gov/dataexchange/documents/BENDEXMANUAL2022.pdf
- **The Sequoia Project 2018.** The Sequoia Project. "A Framework for Cross-Organizational Patient Identity Management." 2018. https://sequoiaproject.org/wp-content/uploads/2018/06/The-Sequoia-Project-Framework-for-Patient-Identity-Management-v31.pdf
- **Vidanage et al. 2020.** Vidanage A, Ranbaduge T, Christen P, Randall S. "A Privacy Attack on Multiple Dynamic Match-key based Privacy-Preserving Record Linkage." International Journal of Population Data Science 5(1):1345, 2020. doi:10.23889/ijpds.v5i1.1345
- **Westat 2012.** Westat. "Evaluation of the Accuracy of E-Verify Findings." Report to the U.S. Department of Homeland Security, 2012. https://www.e-verify.gov/sites/default/files/everify/data/FindingsEVerifyAccuracyEval2012.pdf
- **Zech et al. 2016.** Zech J, Husk G, Moore T, Shapiro JS. "Measuring the Degree of Unmatched Patient Records in a Health Information Exchange Using Exact Matching." Applied Clinical Informatics 7(2):330-340, 2016. doi:10.4338/ACI-2015-11-RA-0158
