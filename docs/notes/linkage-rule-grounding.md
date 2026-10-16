---
title: "Grounding the Linkage Rules: Comparison, Precision Order, and an Evidence Bar"
---

# Grounding the linkage rules: comparison, precision order, and an evidence bar

_Status: proposal, pending adoption. This note records the design rationale
behind the rules proposed in [linkage-rule-catalog.md](linkage-rule-catalog.md):
how they compare with published practice, why they run in precision order, what
transfers to two-party exact matching, the features they need, and the evidence
a rule set must show before it ships. Nothing here is adopted or shipped; the
shipped field and key sets are in
[default-linkage-rule-set.md](default-linkage-rule-set.md). See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation.

## How to read the citations

Sources are cited by author and year. The full reference for each, with its DOI
or URL, is in the catalog's [Sources](linkage-rule-catalog.md#sources) list, or
in this note's own [Sources](#sources) for those cited only here. Rules are
cited by their position in the catalog, 1 to 33. A statement marked
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
  inside an ordered cascade, every one is from health, death, voter or school
  records, and none is from HMIS.

## The deployment the rules assume

Three facts about the deployment shape the bands in the catalog.

**Exchanges run within one county.** The rules assume each exchange runs within one
county, with exchanges in many counties. Chance agreement grows with the size of the two
files: Zech et al. (2016) found 0.18% of individuals in an 11-million-record
sample of the Death Master File sharing their first name, last name and date of
birth with someone else, against 1.19% in the full 85.8-million-record file, and
Hillestad et al. (2008) found last name + DOB gave a 33% chance of a false match
in 79 million records. The geography of the counterparty matters as much: in
Mirel et al. (2022), links agreeing on name + sex + DOB with no SSN were 41.4%
false where the state disagreed and 0.3% where it agreed. A county exchange is
closer to the second row, which is why rule 12 is banded above 99.5% for one
county and for nothing wider.

**HUD's only ZIP is the project's.** HUD's FY2026 HMIS standards have no client
ZIP field. Their one ZIP is the project's: the ZIP of its principal site, or
where most of a scattered-site project's clients are housed (HUD 2025a; HUD
2025b), and in the CSV export it sits in the project file, not the client file
(HUD 2025c). Every client of a shelter shares it, so a party must never supply
it as the client's ZIP. A party with no client ZIP brings none, and rules 11,
23, 27 and 28 drop out of its exchanges. The owner ruled that a county may
supply HUD's older client ZIP instead, as the catalog records.

**The last four SSN digits are the HMIS norm.** Since the FY2024 standards HUD
has required an HMIS to collect only the last four digits, leaving each
Continuum to decide whether to collect all nine (HUD 2025d). A record holding
only those four digits is compliant collection, not a degraded one, which is why
rules 9, 13 to 16, 19 and 20 use the last four digits rather than a full SSN.
Two details of HUD's own handling bear on that:

- HUD's hashed CSV export writes the SSN as the unhashed last four digits
  followed by a hash of the full SSN, and each name as the hash of its Soundex
  code (HUD 2025c).
- A partial SSN is not necessarily the last four: HUD expects missing digits in
  any of the nine positions (HUD 2025b).

## How the rules compare with published practice

### HUD HMIS collects; it does not match

The standard Alcove's primary users export from defines what is collected and
how it is coded, and leaves matching to the vendor. Its one statement on it is
that HMIS software "should allow for the effective matching of partial SSNs"
(HUD 2025a). HUD's one published matching rule is its 2005 unduplication
guidance: agreement on any two of first name, last name, DOB and a partial SSN
makes a potential match, deleted when two fields conflict unless the full SSN
and two of the names and date agree (Sokol and Gutierrez 2005). Rule 20 and the
conflict veto below come from it.

### The token sets are unordered

The published exact-key systems emit sets, not cascades. linkja emits its hashes
side by side, the SSN-bearing ones only when an SSN is present, and leaves
matching to a separate component (MRAIA 2020). The N3C configuration emits
eighteen tokens per record (Regenstrief Institute 2021). The CODI guide
specifies fields and declines to specify keys at all (MITRE 2022). Each yields no
token for a key whose field is missing or invalid, as Alcove does, so a missing
field costs a match rather than adding a false one.

What the proposed rules take from them:

- **linkja's error variants.** linkja aims hashes at named entry errors: a
  swapped name order, a transposed day and month, a date off by one day or one
  year, a three-letter first name, and each part of a compound surname. Rules
  13 to 15, 22 and 24 are those devices; linkja's SSN is the last four digits,
  so its date variants are rules 13 to 15 exactly.
- **N3C's contact and geography tokens.** Every N3C token with a ZIP also has a
  last name, and email and cell phone each appear once, beside a first name.
  Rules 11 and 28 are N3C tokens (28 without gender), and rules 25, 26, 29 and
  31 are stricter forms of its first name + phone and first name + email tokens.

Two divergences remain, both in the shipped rules:

- **No sex field.** Most measured name + DOB keys include sex or gender, and
  Alcove's fields have none. Each catalog entry with a sex-bearing relative
  treats the missing field as loosening the rule (reasoning).
- **Truncated last names.** Rules 2 to 4, 18 and 19 truncate the last name to
  three or four letters. The published sets truncate only the first name and
  keep the last name whole.

### Phonetic names

The evidence on a phonetic name code splits by what else a key requires. Beside an
SSN, phonetic names added true links and no false ones: in Grannis et al.
(2002), SSN + NYSIIS-coded names found 234 and 90 more correct links than SSN +
exact names at the same count of wrong ones, and in Mirel et al. (2022), links
where an SSN token and the Soundex-names token agreed without an exact-name
token were 531 true and none false. As the only name evidence it does badly: the
Soundex-names token alone was 81.4% false in Mirel. SSA's BENDEX accepts a
Soundex-equivalent surname with the SSN (SSA 2022), and Cook County left
phonetic codes out to preserve specificity (Trick et al. 2019).

So the catalog uses a Soundex surname only beside a ZIP, phone or email plus the
full first name and DOB (rules 23, 27, 30 and 32), and rejects Soundex names
with no SSN and no geography (reasoning). No source compares NYSIIS with
Soundex.

### The operating cascades

Four published deterministic cascades run rules in a stated order:

- **NCHS** runs a two-pass deterministic SSN stage before its probabilistic
  stage: full SSN first, then the last four digits, with a record linked in the
  first pass excluded from the second. It demands more corroboration of the
  weaker key, not less (NCHS 2022; NCHS 2023; NCHS 2024). Its probabilistic
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
The shipped `hmis-keys` order is not a precision order, as the comment on
`DEFAULT_LINKAGE_KEYS` in `packages/core/src/defaults/builtInLinkageTerms.ts`
records.

Published practice is split. NCHS orders strictest first. Cook County and Ong
put name + DOB first, but their later rules are not stricter forms of it: Cook
County's loosen the date, and Ong's drops the first name and the day and month.
Mirel et al. (2022) is the nearest measurement of a residual round: it charges a
weak token only for links no stronger token also supported, and that is where
the no-SSN name tokens failed.

### Placements the evidence forces

Within a band two tie-breaks apply (reasoning):

1. A rule that another rule contains runs first, so a match is credited to the
   stricter rule. Rule 5 runs before 6, 7 before 8, 10 and 11 before 12, 11
   before 23, 12 before 21, 22 and 24, 15 before 21, 23 before 27, 29 before
   30, and 31 before 32.
2. Otherwise full-SSN rules run before last-four rules, and those before rules
   with neither.

Rules 10 and 11 are refinements of rule 12: rule 12's elements plus one more. A
refinement adds a match only by splitting a value two of one party's records
share, which a one-to-one round drops as ambiguous
([PROTOCOL.md](../spec/PROTOCOL.md#value-level-round-participation)). Records
dropped as ambiguous stay eligible for later rounds, and a value ambiguous in
one round can become unique in a later one, so a refinement resolves those
values on either side of the looser rule. Tie-break 1 puts rules 10 and 11
first.

Two placements are the maintainer's:

- **Rule 12 runs above rules 13 to 16.** All five are banded above 99.5%;
  tie-break 2 alone would put rule 12 below rule 16.
- **Rules 22 and 24 run below the last-four-SSN date rules.** Their bands are
  lower, and the one measured reversed-name rule, Cook County's, required the
  last four digits (Trick et al. 2019); rule 22 does not.

Orders not forced by containment or a placement above are left open among rules
of one band.

## What transfers to two-party exact matching

Every error model above comes from linking a file against a reference file, or
deduplicating one file, in clear text. A two-party exact intersection fails
differently in three ways.

**A false match needs a value both files hold.** A match happens only when both
parties derive the same key value. An error confined to one party that produces
a value nobody holds destroys the key and costs a match. A false match needs a
real collision (two people whose true values agree on every element), an error
present in both files, or a one-sided error that lands on another real person's
correct value.

The last case is the dominant measured SSN error. In Grannis et al. (2002) the
most common SSN error "appeared to be" a spousal mix-up, a woman's record linked
to a man's sharing her last name, read as the guarantor's number on the
spouse's record. A wife recorded under her husband's SSN at one agency, against
a counterparty holding the husband under his own number, is a false match
wherever the rule's other elements agree, and the spousal mix-up shares the last
name. So for SSN rules the reference-file error rates are an estimate under
two-party intersection, not only an upper bound (reasoning).

**Standards manufacture shared errors.** The mechanisms that put one wrong value
in two files are the ones a shared operating context supplies: a client
repeating a code name, a document copied between agencies, and a shared
convention. HUD tells staff to record `01` for an unknown month and day, unless
the Continuum has its own filler (HUD 2025a), so two records independently agree
on a date neither knows. HUD's name data-quality codes admit placeholder and
made-up names entered to create a record (HUD 2025a). `baseline-pii` excludes
placeholder SSNs, but nothing bounds a filler date or a placeholder name, and
the data-quality codes that flag both are not matchable fields.

**A missing field yields no key.** A record missing any element of a rule
contributes nothing to that round and stays eligible for later ones. A rule's
reach is therefore the joint fill across both parties: Bernstam et al. (2022)
found the cell-phone token's record fill was 94.6% and its pair fill 68.01%. A
rule's reach must be quoted as pair fill or it is overstated.

## Rule features the evidence calls for

These are requirements, not designs. None exists in Alcove.

- **A date expansion of one day either side.** linkja and Cook County use one,
  and Cook County's largest spike in date differences was at one day (Trick et
  al. 2019). Rule 14 needs it.
- **A conflict veto.** A rule must be able to fire only where a named field is
  not present and different on both sides. HUD's 2005 guidance deletes a
  potential match with conflicting values in two of gender, name suffix, the
  parts of the date and the full SSN (Sokol and Gutierrez 2005). Without a veto,
  every rule with no SSN element accepts pairs whose valid SSNs disagree; in
  Mirel et al. (2022), links agreeing on no SSN token and no state were 41.4%
  false. Exact equality of hashed values cannot express this per pair, so it
  needs a protocol feature. Rule 20 needs it, on the date of birth.
- **A name-frequency condition.** Rule 33 may fire only for uncommon names,
  which needs a frequency score for the first and last name combination with a
  cut point, as The Link King computes (Campbell et al. 2006). No source gives
  a cut point tied to a measured precision.
- **Phone type.** The Sequoia Project (2018) had to tag numbers so work and
  mobile phones were not compared. `phone_number` is one untyped field. No
  proposed rule depends on it.

Two features were weighed and declined by the maintainer:

- **A per-party cap on shared contact values**, nulling a value held by more
  than some number of one party's records before keys are built. The reasons
  given: a one-to-one round already drops a value two of a party's records
  share, and every contact rule requires a full name. No source states a count
  cap for contact values: Cao et al. (2026) caught placeholder SSNs with a
  name-DOB consistency rule, not a count, and Culbertson et al. (2017) count
  999-9999 as a default rather than a value. The round does not drop a shelter
  phone held by clients with different names, whose rule values differ
  (reasoning). The full-name reason does not cover rules 25 and 26, which have
  no last name, or rules 30 and 32, which have its Soundex code.
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
- **Father-and-son pairs exist but are uncounted as false matches.** Matching
  voter records on first name, last name, DOB and address, Goel et al. (2020)
  found 7,504 in-state duplicates in Mississippi and 2,350 in Wisconsin, most
  differing on middle name or suffix, which the authors read as a parent and
  child given each other's birthdate. Hood and Bullock (2008) found "a small
  number" of fathers and sons with the same full name at one address. Kho et al.
  (2015) count suffixes only inside a mixed category of name disagreements.
- **The trade-off is stated, not measured.** Removing "Jr" risks a parent-child
  false match, and keeping it risks missing a son's own record that lacks it (Fu
  et al. 2022).

What follows (reasoning): requiring suffix agreement in a rule would cost
matches, since a suffix is often missing or misplaced on one side. As a veto --
a suffix present on both sides and different -- it targets the father-and-son
case, most of all in the rules with no date of birth to separate the
generations (rules 20, 29 to 32), and in rules 10 to 12 for the Goel case. It
would belong to the conflict veto, with suffixes still stripped from the name
fields. Its gain is bounded by how often both parties record a suffix, which no
source reports.

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
measured, on what, and reported alongside -- not a threshold. A pass-mark would
be Alcove's own choice, defensible only by an argument about the harm of a false
match in this setting, and this note does not propose one.

**The state of practice is worse than the guidance.** Of forty-five published
studies linking Medicaid claims to birth certificates, four mentioned a
validation study and "none of the studies provided results of the validation
exercises" (Heins et al. 2022). The published Medicaid-to-homeless-services match
closest to Alcove's pairing states no matching method, and its quality
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
2017). For an HMIS-class file a benefit-program subset covers the low-income
stratum well and almost nobody else. Either way, the error rate reaches the rest
of the file only by extrapolation.

### Per-key ablation, and its one precedent

The bar should require each rule's marginal contribution: the set measured with
that rule removed, reporting the recall it added and the precision it cost. No
guidance requires this, and one evaluation performs it. Mirel et al. (2022)
tabulated the token combinations among returned links, so a weak token was
charged only for links no stronger token also supported, and dropped any
combination over 50% false by a rule fixed before the results. The four
combinations dropped all rested on name, sex and date with no SSN token.
Dropping them moved the result from 93.8% precision and 98.7% recall to 98.9%
and 97.8%, removing 11,515 false links at the cost of 1,738 true ones.

A rule's marginal contribution is what it adds after the earlier rules have
claimed their records, so the ablation has to run with the cascade in place. A
rule measured alone can look valuable and add nothing in position.

### What a two-party exact-key evaluation must add

Four requirements follow from the intersection geometry rather than the
guidance:

- **Report pair fill, not record fill.**
- **Enumerate the shared-error modes and test them**: a filler date, a repeated
  code name, a placeholder both agencies inherited.
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
- **No precision for ZIP alone, or for any email rule**, in any sector. The
  nearest figures are UCLA's selected strata: among pairs its EHR module had not
  linked, 13 of 100 agreeing only on email, 26 of 100 only on phone, and 94 of
  100 on first name + DOB + ZIP were the same person (Ross et al. 2020).
- **No sharing rate for a phone or email across people**, and nothing on a
  shelter or case manager's number appearing on many client records.
- **No ZIP-stability figure for a highly mobile population.** Phone turnover is
  measured: 54.5% of homeless adults with a cell phone reported two or more
  numbers in three months (Rhoades et al. 2017).
- **No obtainable evaluation corpus** for a two-party exact-key product: every
  holder of labelled truth gates it behind review and a data use agreement.
- **No baseline for this user class.** No published HMIS-class linkage reports a
  precision or recall figure a rule set could be measured against.

Two analyses of re-identification attacks on hashed match-keys assume an
adversary holding exchanged tokens together with clear-text quasi-identifiers
(Vidanage et al. 2020; Eliazar et al. 2025). Whether that threat model reaches a
two-party PSI exchange is a question about Alcove's protocol this note does not
decide.

## Sources

Sources cited by both notes are in the catalog's
[Sources](linkage-rule-catalog.md#sources) list. Those cited only here:

- **Culbertson et al. 2017.** Culbertson A, Goel S, Madden MB, Safaeinili N, Jackson KL, Carton T, et al. "The Building Blocks of Interoperability: A Multisite Analysis of Patient Demographic Attributes Available for Matching." Applied Clinical Informatics 8(2):322-336, 2017. doi:10.4338/ACI-2016-11-RA-0196
- **Dynarski et al. 2013.** Dynarski SM, Hemelt SW, Hyman JM. "The Missing Manual: Using National Student Clearinghouse Data to Track Postsecondary Outcomes." NBER Working Paper 19552, 2013. http://www.nber.org/papers/w19552
- **Eliazar et al. 2025.** Eliazar A, Brown JT, Cinamon S, Kantarcioglu M, Malin B. "Re-identification risk for common privacy preserving patient matching strategies when shared with de-identified demographics." Journal of the American Medical Informatics Association 33(2):336-346, 2026 (online 2025). doi:10.1093/jamia/ocaf183
- **Fu et al. 2022.** Fu S, Davis C, Rothstein J, Ramesh A, White E. "Hashed Linkages for Administrative Datasets: A Technical How-to Guide." California Policy Lab, 2022. https://capolicylab.org/wp-content/uploads/2022/03/Hashed-Linkages-for-Administrative-Datasets.-A-Technical-How-to-Guide.pdf
- **Gilbert et al. 2018.** Gilbert R, Lafferty R, Hagger-Johnson G, Harron K, Zhang LC, Smith P, et al. "GUILD: GUidance for Information about Linking Data sets." Journal of Public Health 40(1):191-198, 2018. doi:10.1093/pubmed/fdx037
- **Goel et al. 2020.** Goel S, Meredith M, Morse M, Rothschild D, Shirani-Mehr H. "One Person, One Vote: Estimating the Prevalence of Double Voting in U.S. Presidential Elections." American Political Science Review 114(2):456-469, 2020; supplementary appendix. doi:10.1017/S000305541900087X
- **Harron et al. 2017.** Harron KL, Doidge JC, Knight HE, Gilbert RE, Goldstein H, Cromwell DA, et al. "A guide to evaluating linkage quality for the analysis of linked data." International Journal of Epidemiology 46(5):1699-1710, 2017. doi:10.1093/ije/dyx177
- **Hawaii Department of Education 2016.** Hawaii Department of Education, Hawaii Child Nutrition Programs. "Direct Certification Module User Guide for All Schools." 2016. https://hcnp.hawaii.gov/wp-content/uploads/2016/07/Direct-Certification-User-Guide-for-All-Schools.pdf
- **Heins et al. 2022.** Heins S, Predmore Z, Hoch E, Baxi S. "Linking Medicaid Claims, Birth Certificates, and Other Sources to Advance Maternal and Infant Health: Final Report." RAND, PR-A1961-1, for the HHS Office of the Assistant Secretary for Planning and Evaluation, 2022. https://aspe.hhs.gov/sites/default/files/documents/db89f9777de0142dc5b6562692f67032/linking-medicaid-claims-other-data.pdf
- **Hood and Bullock 2008.** Hood MV III, Bullock CS III. "Worth a Thousand Words? An Analysis of Georgia's Voter Identification Statute." American Politics Research 36(4):555-579, 2008. doi:10.1177/1532673X08316608
- **HUD 2004.** U.S. Department of Housing and Urban Development. "Homeless Management Information Systems (HMIS); Data and Technical Standards Final Notice." Federal Register 69(146):45888, 2004. https://www.govinfo.gov/content/pkg/FR-2004-07-30/html/04-17097.htm
- **Kho et al. 2015.** Kho AN, Cashy JP, Jackson KL, Pah AR, Goel S, Boehnke J, et al. "Design and implementation of a privacy preserving electronic health record linkage tool in Chicago." Journal of the American Medical Informatics Association 22(5):1072-1080, 2015. doi:10.1093/jamia/ocv038
- **MITRE 2022.** The MITRE Corporation. "HL7 FHIR Implementation Guide: PPRL Release 1 - US Realm, STU1" (CODI). GitHub, 2022. https://github.com/mitre/codi-fhir-pprl-ig
- **NCHS 2022.** National Center for Health Statistics. "The Linkage of the 2016 National Hospital Care Survey to 2015-2017 Centers for Medicare & Medicaid Services Transformed Medicaid Statistical Information System Claims Data: Matching Methodology and Analytic Considerations." 2022. https://www.cdc.gov/nchs/data/datalinkage/2016-nhcs-cms-medicaid-linkage-methodology.pdf
- **NCHS 2023.** National Center for Health Statistics. "The Linkage of the National Center for Health Statistics (NCHS) Survey Data to U.S. Department of Housing and Urban Development (HUD) Administrative Data: Linkage Methodology and Analytic Considerations." 2023. https://www.cdc.gov/nchs/data/datalinkage/NCHS-HUD-Linked-Data-Methodology-and-Analytic-Considerations.pdf
- **NCHS 2024.** National Center for Health Statistics. "The Linkage of National Center for Health Statistics Survey Data to Centers for Medicare & Medicaid Services Transformed Medicaid Statistical Information System Claims Data (2014-2019): Matching Methodology and Analytic Considerations." 2024. https://www.cdc.gov/nchs/data/datalinkage/NCHS-CMS-TMSIS-Linkage-Methodology_1.pdf
- **Nescott et al. 2023.** Nescott E, Metraux S, McDuffie MJ, Brown E. "Health & Housing in Delaware: Matching Medicaid Claims and Encounters and the Community Management Information System Databases." Delaware Journal of Public Health 9(2):18-22, 2023. doi:10.32481/djph.2023.06.005
- **SSA 2022.** Social Security Administration. "Beneficiary Earnings and Data Exchange (BENDEX) Handbook for Daily Process." 2022. https://web.archive.org/web/20230605183520id_/https://www.ssa.gov/dataexchange/documents/BENDEXMANUAL2022.pdf
- **Vidanage et al. 2020.** Vidanage A, Ranbaduge T, Christen P, Randall S. "A Privacy Attack on Multiple Dynamic Match-key based Privacy-Preserving Record Linkage." International Journal of Population Data Science 5(1):1345, 2020. doi:10.23889/ijpds.v5i1.1345
- **Westat 2012.** Westat. "Evaluation of the Accuracy of E-Verify Findings." Report to the U.S. Department of Homeland Security, 2012. https://www.e-verify.gov/sites/default/files/everify/data/FindingsEVerifyAccuracyEval2012.pdf
