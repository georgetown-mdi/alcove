---
title: "Linkage Rule Catalog: Rules and Their Precision Bands"
---

# Linkage rule catalog: rules and their precision bands

_Status: built.
Every rule here that needs no missing feature is a key of the built-in key set `precision-ranked-rules` 2.1.0, in this order and with these bands and coverage conditions (`packages/core/src/defaults/builtInLinkageTerms.ts`; [default-linkage-rule-set.md](default-linkage-rule-set.md)).
A rule whose entry names a feature Alcove lacks has a band and no key, and no floor selects it.
The design rationale behind this catalog -- why two bands, why one loosened element per rule, why the rules run in precision order, how they compare with published practice, and what the evidence does not settle -- is in [linkage-rule-grounding.md](linkage-rule-grounding.md).
See [docs/notes/README.md](README.md)._

This is design rationale.
Nothing here binds an implementation.

## How to read an entry

### Notation

Each rule is a list of elements joined by `+`.
A rule matches two records only when every element agrees exactly.

- `SSN` is the full nine-digit Social Security number, and `SSN4` its last four digits.
- `LN` and `FN` are the last and first name, standardized.
  `LN3` and `LN4` are the first three or four letters of the last name.
  `FN1` and `FN3` are the first letter and the first three letters of the first name.
- `SFX` is the name suffix, standardized to a code (JR, SR, II, III, IV) or to the empty string when there is none, so two records without a suffix agree.
  It is read from a column of its own or taken from the name column, and suffixes stay stripped from `LN` and `FN`.
- `DOB` is the full date of birth.
  `YOB + MOB` is the year and month of birth without the day.
- `ZIP5` is the five-digit ZIP code of the person's own address, and `ZIP3` its first three digits.
  `street number` is the number of the person's street address.
  `STATE` and `COUNTY` are the state and county of the person's address.
- `PHONE` is a ten-digit phone number.
  `EMAIL` is an email address, trimmed and lowercased.
- `soundex(LN)` and `soundex(FN)` are the Soundex code of the last and the first name.
- `swap(LN, FN)` matches the two names in either order.
- `split(LN)` matches on the whole last name or on any one hyphen- or space-separated part of it.
- `DOB +/-1 year` matches a date with the same month and day and a year one higher or lower.
  `DOB +/-1 day` matches a date one day earlier or later.
  `DOB day/month exchanged` matches the date with those two parts swapped.
  Each also matches the exact date.

A party supplies the person's own ZIP, never the ZIP of the site that serves the person: everyone served at one site shares it.
A former address's ZIP, such as the person's last permanent address, may be supplied as the person's ZIP; where the other party records a current address it costs matches, not precision (reasoning).

### Bands

A rule's precision is the share of the pairs it accepts, at its position in the order, that are the same person.
Two bands are offered:

- **99%**: 99% and above.
- **95%**: 95% to 99%.

No rule is offered below 95%.
A lower band, such as 90%, is added only when a rule has evidence placing it there.
An operator selects the rules by band; the screens an operator sees show the band, and this catalog keeps the evidence and the reasoning behind it.
Why two bands and not three: [linkage-rule-grounding.md](linkage-rule-grounding.md#why-two-bands).

### The evidence standard

A rule gets a band only when there is evidence for it, of one of four kinds.
Each entry names its kind:

- **Measured.** A source measured the rule, or the same rule with a difference the entry names.
- **Relative.** A source measured a rule of close shape, and the entry says what differs.
- **Refinement.** The rule has every element of a banded rule and more, so the candidate pairs it accepts are a subset of that rule's (see [Order](#order)).
- **Extrapolation.** Reasoning from a measurement, with each step stated in the entry.

The band must apply wherever the rule is offered.
Where it applies only to some files, the rule has a coverage condition (below), and it is offered only where the condition is met.
A rule with no such evidence is not offered: an operator reaches it only by authoring it in the expert key editor.
Those rules are listed, each with its reason, under [Not offered](#not-offered).

One exception is made by the maintainer's judgment: the three email rules (37 to 39) are offered at 95% while evidence for them is gathered.

### Coverage

Most rules are offered for any pair of files.
Rules 31 to 33, name and date with no SSN, contact field or geography, are offered only when both files draw their members from one state or one metropolitan area.
Chance agreement on a name and a date grows with the number of people the two files cover (Hillestad et al. 2008; Goel et al. 2020), and the measurements that place these rules at 95% are within one state or county.
Rule 30 puts the same condition into the rule itself, as a `STATE` or `COUNTY` element.
A `STATE` or `COUNTY` element stands in for the coverage answer, as a decision taken: within one state the element does what the answer does, and for files spanning states it still narrows the name and date of birth to one state or one county name. A county name repeats across states, so across states the `COUNTY` key narrows less than the `STATE` key, and its 95% there rests on that reasoning, not on a measurement.

A file drawn from one age group, such as one school class or one birth cohort, behaves like a far larger file, because its members share birth years.
In one graduating class of 428,410 students, about 500 combinations of name and date of birth appeared more than once, 0.12% (Fong et al. 2018), so at least about 0.23% of the students shared theirs (computed here).
Among California's 5,969,112 K-12 records, 14,781 combinations appeared more than once, 0.25% (Barrat and Berliner 2013), so at least 0.49% of the records shared theirs (computed here).
The bands assume files spanning all ages (reasoning).

### One loosened element

A rule loosens at most one element relative to an exact name and date: a Soundex surname, a date tolerance, a name swap or split, or a truncation.
Rules with a full SSN are the exception, and rules 10, 12 and 13 have two.
Rule 26, with two loosenings beside the last four SSN digits, is placed in the 95% band for that reason.
Why: [linkage-rule-grounding.md](linkage-rule-grounding.md#why-one-loosened-element).

### Weight of the sources

Each basis is weighed on four points, and an entry says where its source falls short:

- **Design.** Whether the truth is independent of the matcher measured, whether pairs were reviewed, and whether there are enough true pairs to bound the figure.
- **Reach.** How close the records are to program records shared between two agencies.
- **Age.** Whether an SSN-dependent result comes from an older file, collected when SSNs were more often present.
- **Vendor.** Whether a co-author works for the vendor whose method is measured.

The bands are the strongest evidence available, and it is mostly from health and voter files.
No source measures a rule on two agencies' program records matched exactly.
Most measured rules include sex or gender, which Alcove's fields do not; a rule without it accepts more false pairs than its measured relative (reasoning).

### Order

Rules run in precision order, the 99% band before the 95% band, and the catalog lists them in that order.
Within a band:

1. A refinement runs before the rule that contains it.
2. Otherwise rules with a full SSN run before rules with the last four digits, and those before rules with neither.

A refinement adds a match only where one party holds two records tied on the broader rule's value, which a one-to-one round drops as ambiguous ([PROTOCOL.md](../spec/PROTOCOL.md#value-level-round-participation)).
In Alcove a record dropped as ambiguous stays eligible for later rounds, so the order of a refinement and the rule containing it decides which rule is credited with a pair, not whether the pair matches.
Why precision order: [linkage-rule-grounding.md](linkage-rule-grounding.md#why-precision-order).

### Status

Every rule below is a key of the built-in key set, except a rule whose entry names a feature Alcove lacks or a rule not yet added to the set:

- Rule 21: the `street_number` type exists; the rule is not yet in the built-in key set.
- `name_suffix`, the standardized suffix behind `SFX`: rules 35, 36, 36a, 38 and 39.
- The shared-contact screen (rule 36a): the default cleaning drops a phone or email held by more than five distinct people in a party's file.

Eleven of the fourteen rules of the retired first built-in key set, 1.0.0, are in the 99% band; rules 26, 31 and 32 are in the 95% band.

## The 99% band

### Rules with a full SSN

Rules 1 to 13 rest on one measurement.
Grannis et al. (2002) linked the registries of two Indiana hospitals to the Indiana Death Master File by SSN, with partial review of the links, in one 1990s dataset.
Grannis et al. (2003) and Grannis et al. (2004) used the same two registries and the same pairs, so they do not replicate the result.
SSN availability in health systems' records fell from 83% in 2005 to 50% in 2014 (Culbertson et al. 2017), so the measured file had more SSNs than a file collected today.

The most common SSN error there "appeared to be" a spousal mix-up, a woman's record linked to a man's sharing her last name, read as the guarantor's number on the spouse's record (Grannis et al. 2002).

The refinements of rule 6 (rules 1 to 5) stay in the catalog although rule 6 contains them as candidate pairs.
They add a match only where one party holds two records tied on the `SSN + DOB` value, and an operator cannot be expected to know whether their file does.
Their cost is rounds, not precision.

#### 1. `SSN + LN + DOB`

99%. Any coverage. Refinement of rule 6.

The strictest rule: a full SSN with the last name and the full date of birth.

#### 2. `SSN + LN4 + DOB`

99%. Any coverage. Refinement of rule 6.

Catches a last name written differently after its fourth letter.

#### 3. `SSN + LN3 + DOB`

99%. Any coverage. Refinement of rule 6.

As rule 2, with a three-letter prefix.

#### 4. `SSN + DOB + FN`

99%. Any coverage. Refinement of rule 6.

Catches a changed last name when the full SSN agrees.
Bernstam et al. (2022) measured SSN + first name at 247 true pairs and 1 false, by manual review of candidate pairs blocked within one data warehouse; the authors include Datavant staff.

#### 5. `SSN + FN3 + DOB`

99%. Any coverage. Refinement of rule 6.

Catches a changed last name together with a first name spelled differently after its third letter.
The N3C linkage configuration (Regenstrief Institute 2021) ships a token with the same three-letter first name.

#### 6. `SSN + DOB`

99%. Any coverage. Measured.

Grannis et al. (2002) found SSN + full date of birth made 2 wrong links of 4,559 at one hospital and 2 of 5,218 at the other.
That bounds its false share under 0.14% (computed here), the one measurement in this catalog that would support a band above 99.5%.
In Mirel et al. (2022), links on which only the SSN + sex + DOB token agreed were 6 false against 2,151 true.
Its floor is the spousal mix-up above, where the spouses share a birth date.

#### 7. `SSN + FN + LN`

99%. Any coverage. Measured.

Catches any date-of-birth error when the SSN and both names agree.
In Grannis et al. (2002), SSN + last name + first name made 7 wrong links of 4,548 and 2 of 5,159.
A full first name separates spouses who share a surname and an SSN.

#### 8. `SSN + soundex(FN) + soundex(LN)`

99%. Any coverage. Measured with a different phonetic code.

Catches names spelled differently that keep their phonetic code; it runs after rule 7, a refinement of it.
In Grannis et al. (2002), SSN + NYSIIS-coded names found 234 and 90 more correct links than rule 7 (4,775 and 5,247), at the same count of wrong links (7 and 2).
Alcove's phonetic transform is Soundex, not NYSIIS.
Three sources compare the two codes (Sun and Golden 2019; Bailey et al. 2020; Christen 2006); only Sun and Golden compare them beside a full SSN, and they count the pairs each code agrees on, not false agreements; [linkage-rule-grounding.md](linkage-rule-grounding.md#phonetic-names) sets them out.

#### 9. `SSN + LN + FN1`

99%. Any coverage. Relative of rule 7.

Catches a first name recorded differently, when the full SSN and last name agree; it runs after rule 7, a refinement of it.
It differs from rule 7 by a first initial, which lets through spouses who share one (reasoning; no source gives that rate).

#### 10. `SSN + LN3 + FN1`

99%. Any coverage. Relative of rule 7.

As rule 9, with a three-letter last name.
A three-letter last name adds little, because the spousal errors already share the whole surname (reasoning).

#### 11. `SSN + FN + YOB + MOB`

99%. Any coverage. Relative.

Catches a changed last name and a wrong day of birth together.
In Grannis et al. (2002), SSN + first name + birth year + gender made no wrong links at either hospital (4,350 and 4,997 correct), and SSN + phonetic first name + birth month + gender made none either.
This rule has the year and month but no gender (reasoning).
In Mirel et al. (2022), links on which only the SSN + first name token agreed were 98.0% correct (2,705 true, 56 false); this rule also requires the birth year and month, so it is stricter than that token (reasoning).

#### 12. `SSN + FN3 + YOB + MOB`

99%. Any coverage. Relative of rule 11.

As rule 11, with a three-letter first name; it runs after rule 11, a refinement of it.

#### 13. `SSN + LN4 + YOB + MOB`

99%. Any coverage. Extrapolation from rule 6.

Catches a wrong day of birth when the full SSN agrees.
No measured relative drops the day.
The spousal mix-up behind rule 6's wrong links would also need the same birth year and month to match here (reasoning).

### Rules with the last four SSN digits

Some record systems collect only the last four SSN digits.
The four digits take 10,000 values, so adding them to a name + date key divides its chance agreements by about 10,000 where the digits are spread evenly (computed here).
In Hillestad et al.'s (2008) collision counts, removing them from a name + DOB + ZIP key created nearly 1,000 false positives in a 79-million-record file.

#### 14. `SSN4 + LN + DOB`

99%. Any coverage. Relative.

Catches records holding only the last four SSN digits.
Naessens et al. (2015) found last four SSN + DOB + sex at 99.9% positive predictive value, with 3 false positives.
This rule replaces sex with the last name, which narrows a match more (reasoning).
Naessens linked one health system's discharges to each other, in one region, and cut the four digits from complete SSNs held in both sources; its readmissions table fits 6,516 readmissions rather than the 52,212 its heading states.

#### 15. `SSN4 + split(LN) + FN + DOB`

99%. Any coverage. Refinement of rule 16.

Catches one part of a compound last name dropped or the parts reversed, beside the last four SSN digits.
Cook County added a two-last-names step after its validation that found 1,988 more matches, unvalidated (Trick et al. 2019).

#### 16. `SSN4 + FN + DOB`

99%. Any coverage. Relative of rule 14.

Catches a changed last name when only the last four SSN digits are held.
A last-name change was behind 44% of the 379 classified false-negative queries in UCLA's reviewed sample of links its EHR module missed, some queries having several errors (Ross et al. 2020).
It was a reason in 48 of the 200 sampled matches Cook County's rules missed, which Table 3 prints as 23% of the reasons listed, some matches having several (Trick et al. 2019).
Naessens et al. (2015) found last four SSN + DOB + sex at 99.9%; this rule replaces sex with the first name (reasoning).

#### 17. `SSN4 + LN + FN + DOB +/-1 year`

99%. Any coverage. Relative.

Catches a birth year off by one.
The year differed in 40.0% of confirmed duplicate pairs with a date-of-birth discrepancy, by an amount Just et al. (2016) do not give.
linkja emits a hash of the date plus one year, and its matching component compares it with every record's exact-date hash, which covers a one-year difference in either direction (MRAIA 2020).
Cook County's rule of the same shape found 313 matches its EHR process missed (Trick et al. 2019).
Cook County's six rules together had 189 of 201 sampled matches confirmed, 1 false and 11 not adjudicable, which is 189 of 190 adjudicable (computed here).
The sample holds only matches the EHR process missed, the matches both systems found being assumed true, so it is not the six rules' precision.
With the last four SSN digits dividing chance agreement by about 10,000 (computed here, from their 10,000 values), three candidate years add few chance agreements (reasoning).

#### 18. `SSN4 + LN + FN + DOB +/-1 day`

99%. Any coverage. Relative, as rule 17.

Catches a birth day off by one.
The day is the most frequent date-of-birth discrepancy, differing in 48.3% of pairs with one, by an amount Just et al. (2016) do not give, and Cook County's largest spike in date differences was at 1 day.
linkja emits a hash of the date plus one day, compared the same way in both directions (MRAIA 2020).
Cook County's rule of the same shape found 371 matches its EHR process missed (Trick et al. 2019).

#### 19. `SSN4 + LN + FN + DOB day/month exchanged`

99%. Any coverage. Relative, as rule 17.

Catches a day and month recorded in the wrong order, only 2.6% of date discrepancies (Just et al. 2016).
linkja emits this hash (MRAIA 2020); Cook County's rule of this shape, without the last four SSN digits, found 454 matches its EHR process missed (Trick et al. 2019).
A filler of `01` for an unknown month and day is unchanged by the exchange.
This rule covers the error the not-offered `LN + FN + DOB` with day and month exchanged would catch.

#### 20. `SSN4 + swap(LN, FN) + DOB`

99%. Any coverage. Relative, as rule 17.

Catches a first and last name recorded in the wrong fields, beside the last four SSN digits.
Name swaps were about 1.75% of true duplicate pairs (Just et al. 2016).
Trick et al. (2019) conflict on whether Cook County's reversed-name rule needed the last four SSN digits: the Methods and Figure 1 list transposed name + DOB without them, and footnote b of Table 2 says reversed-name matches required them.

### Rules with a ZIP or a phone and no SSN

#### 21. `LN + FN + DOB + street number + ZIP5`

99%. Any coverage. Refinement of rule 22. Needs `street_number`.

Its 99% rests on rule 22's extrapolation.
Ansolabehere and Hersh (2016) report 97.5% for a voter-file match, but that is a recall over a union of matching sweeps, and the paper measures neither `ZIP5` nor street number + `ZIP5` alone, so it is not a basis here.

#### 22. `LN + FN + DOB + ZIP5`

99%. Any coverage. Extrapolation.

Catches records with no SSN where the person's ZIP agrees.
The ZIP field's default cleaning keeps the first five digits, so a ZIP column supplies `ZIP5`.
It is exactly a token the N3C linkage configuration ships (Regenstrief Institute 2021).
The 99% is the maintainer's judgment on the following reasoning, not a measurement:

1. Cao et al. (2026) measured `LN + FN + DOB + sex + ZIP5` at 0.98 precision against shared-SSN labels, across thirty systems nationally.
   Labels of that kind count a true pair with a keying error in one SSN as false, which Just et al. (2016) put at about 1.7% of true pairs alone, so 0.98 is a ceiling for any key measured that way rather than an estimate of its precision.
   Cao et al. is vendor-authored and unreplicated, and Just et al. is a vendor's sample from cleanup projects, so both figures are approximate.
2. Hillestad et al. (2008) found one name + date + ZIP collision per 21,000 records in a 42,000-record regional file.
   There a ZIP divided name + date collisions about threefold; the about 700-fold division in the same report is the national file's.
3. Three relatives without names, or with a weaker name element, measured 97.7% to 99.2%: Naessens et al. (2015) on DOB + sex + `ZIP5`, Karmel and Gibson (2007) on DOB + sex + postcode + event date at 98.4%, and Beauchamp et al. (2011) on `FN3` + DOB + sex + postcode at 0.8% disagreement with a linkage on the Medicare number.
   Names only remove false pairs from them.
   Karmel and Gibson's figure gives a direction only.
4. The floor is a same-name parent and child with a copied birthdate at the same address, which a ZIP cannot separate.
   Goel et al.'s (2020) per-state figures (Figure A.3) put such pairs near zero in most states, about 1.25% of records in Mississippi and 0.9% in the District of Columbia.
   So the 99% can fail in a file like those, unless a suffix separates the pair.

Of these, Hillestad's collision counts and Goel's household floor are the independent support; the ceiling argument leans on Just, and the measurement it explains away is Cao's.
In Mirel et al. (2022), links agreeing on name + sex + DOB with no SSN were 41.4% false where the state token did not agree and 0.3% false where it agreed; a ZIP is a finer geography than a state (reasoning).
It is a refinement of rule 31: the pairs it accepts beyond rule 31 are those rule 31 drops as ambiguous within one party's file, mostly one person recorded twice (reasoning).

#### 23. `LN + FN + DOB + PHONE`

99%. Any coverage. Relative: a subset of `LN + FN + PHONE`.

Polubriaginof et al. (2018) measured first + last name + phone at 99.25% and 99.0% at two sites, and this rule adds the date of birth, so its false pairs are a subset (reasoning).
That measurement is one setting, its truth is mother-child relationships only, and its phone cleaning is not described.
A gold standard of mother-child relationships drawn from EHR records can be incomplete: Rogerson et al. (2026), testing a maternal-child linkage against relationships taken from maternity encounters and EHR relationship tables, reviewed 200 randomly selected false positives and found 55% were true relationships the gold standard lacked, so the measured figure may understate precision.
It is a refinement of rule 31: the pairs it accepts beyond rule 31 are those rule 31 drops as ambiguous within one party's file, mostly one person recorded twice (reasoning).

#### 24. `FN + DOB + PHONE`

99%. Any coverage. Extrapolation.

Catches a changed last name with no SSN.
The reasoning:

1. Polubriaginof et al. (2018) measured first name + phone at 98.9% and 98.8% at two sites, with no date.
2. What a first name and a phone leave is the same-name parent and child on a household phone, and the date of birth removes it (reasoning).
3. The measurement's mother-child truth may understate its precision (Rogerson et al. 2026), as for rule 23.

The N3C configuration ships first name + cell phone (Regenstrief Institute 2021).
The shared-contact screen (rule 36a) shrinks this rule's floor too.

## The 95% band

### Rules with an SSN or its last four digits

#### 25. `SSN + FN`

95%. Any coverage. Measured.

Catches any date-of-birth error and a changed last name when the full SSN agrees.
Bernstam et al. (2022) measured it at 247 true pairs and 1 false, on blocked candidate pairs from one data warehouse, with Datavant co-authors.
Its floor is a junior recorded under his father's SSN as guarantor, sharing his first name, which nothing else in the rule separates (reasoning).

#### 26. `SSN4 + LN4 + YOB + MOB`

95%. Any coverage. Extrapolation.

The thinnest shipped rule: two loosenings, a four-letter last name and no day of birth, beside the last four SSN digits.
In a national file it leaves about one chance partner per 190 records (reasoning).
No measured relative exists.

### Rules with geography or a name and date alone

#### 27. `LN + FN + DOB + ZIP3`

95%. Any coverage. Measured.

Built from the `zip3` element, the first three digits of the cleaned five-digit ZIP.

Cao et al. (2026) measured first + last name + DOB + three-digit ZIP at 0.97 precision against SSN-based labels, with 0.95 for first + last name + gender + DOB; it is the only measurement of a three-digit ZIP rule.
Against email-based and phone-based labels, on records with no valid SSN, the ZIP token scored 0.76 and 0.74; the authors attribute the drop to noisier labels.
A three-digit ZIP covers a hundred thousand to a million people, so it stays at 95% where rule 22 reaches 99%.
A ZIP costs matches where a person moves or gives another address: ZIP mismatches caused the largest share of one emergency medical service's failed record lookups (Park and Finnell 2012).

#### 28. `ZIP5 + soundex(LN) + FN + DOB`

95%. Any coverage. One loosening on rule 22.

Catches a misspelled last name that keeps its Soundex code, with no SSN.
Beside the ZIP, a Soundex surname admits about 2.9 times the false agreements of the exact surname (Randall et al. 2013), far inside the band.
One loosening on rule 22 stays at 95%, because rule 22's 99% is itself an extrapolation.
It is one of the three least supported rules in the catalog: [The Soundex-surname rules](#the-soundex-surname-rules).

#### 29. `ZIP5 + LN + FN + DOB +/-1 year`

95%. Any coverage. One loosening on rule 22.

Catches a birth year off by one with no SSN, as rule 17 does with it.
Three candidate years roughly triple rule 22's chance agreement (reasoning).
One loosening on rule 22 stays at 95%, for the reason given under rule 28.

#### 30. `LN + FN + DOB + STATE` or `LN + FN + DOB + COUNTY`

95%. Any coverage, both keys. Measured relatives within one state; reasoning across states (see [Coverage](#coverage)).

Rule 31 with its coverage condition written into the rule.
Its basis is rule 31's: Cole and Lee (2004) by state, Bian et al. (2019), Nechuta et al. (2020), and Mirel et al.'s (2022) row with the state token agreeing.
The two forms are two keys, the `STATE` key first, both a refinement of rule 31 and run before it.

A county name is ambiguous across states: the most common, Washington, names a county in about thirty states.
Within one state or one metropolitan area a county name almost always names one county, so the `COUNTY` form separates the pairs rule 31 ties there.
For a region crossing a state line, such as the District of Columbia, Maryland and Virginia, the `ZIP5`, `ZIP3` and `COUNTY` rules work and a `STATE` element would split the region.

#### 31. `LN + FN + DOB`

95%. Offered only when both files draw from one state or one metropolitan area. Measured relatives.

A rule with no SSN evidence, catching records whose SSN is missing or wrong.
The evidence spans a range, and both ends are stated.

Within one state or county:

- **Cole and Lee (2004)** matched WIC to food stamp records in Florida, Iowa and Kentucky and found name + date false positives of 0.2% to 6.5% by state, against a probabilistic reference, and 11.8% for infants in Iowa.
  It is cited at low weight; Nechuta and Bian are the main in-state evidence.
  Iowa is the one in-state outlier, at 6.5% (93.5% precision on the one reading of Table 27 that reconciles its rows, computed here), and plausibly an error in the reference.
  Iowa's WIC file had no SSN field, SSNs were taken from participant identifiers for women only, and the "false" pairs fall where the reference was weakest: women 0.0%, children 6.9%, infants 11.8%.
  The authors' own conclusion is that false positives were under one percent.
- **Nechuta et al. (2020)**, in Tennessee, had no confirmed false positive among the reviewed pairs, with 344 unresolved pairs covering 161 of 4,572 decedents, so 96.5% to 100% with the unresolved pairs counted.
- **Bian et al. (2019)**, in Florida, measured 99.3%.
- **Trick et al. (2019)**, in Cook County, ran complete name + DOB first, and its six rules together had one confirmed false match among 190 adjudicable sampled matches (see rule 17).
- **Mirel et al. (2022)** has a pattern-table row of 99.6% where name + sex + DOB and the state token agreed (79,757 true, 315 false; computed here, and the table prints a false rate of 0.3%).
  Each row counts the links on which exactly that set of tokens agreed, after each link was chosen for having the most SSN tokens, against an earlier NCHS linkage, so it is a stratum, not a rule's precision.
- **Ocampo et al. (2016)** matched case records across the whole of DC, Maryland and Virginia on names + DOB + sex or race, confirmed by each jurisdiction's own check rather than reviewed truth.
  It is a data point for the name + date rules, not a precedent for the metropolitan-area condition.
- **Bernstam et al. (2022)** measured last + first name + gender + DOB at 787 true and 1 false (99.9%), a one-sided 95% lower bound of 99.40% (computed here), on candidate pairs blocked within one data warehouse.

Wider than one state:

- **Goel et al. (2020)** matched voter files across states on first name, last name and DOB; roughly three-quarters of the cross-state pairings were confirmed duplicates, and the rest included keying errors.
- **Hillestad et al. (2008)**: the 42,000-record regional subset collided thirty times more often than scaling from the national file predicts, so a local file concentrates names and dates.

Florida, Tennessee and Cook County sit at or above 95%, most of them at or above 99%, so the rule is placed in the 95% band with Iowa named as the outlier.
An age-cohort file behaves like a far larger file ([Coverage](#coverage)).

#### 32. `swap(LN, FN) + DOB`

95%. Offered only when both files draw from one state or one metropolitan area. Follows rule 31.

Catches a first and last name recorded in the wrong fields.
Name swaps were about 1.75% of true duplicate pairs (Just et al. 2016).
How much it multiplies rule 31's chance agreement is unmeasured, and the multiplier is largest where the order of names varies by culture (reasoning).
The receiving party sends both orders ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termslinkage_keys)), so the rule accepts what rule 31 accepts plus reversed names.
linkja (MRAIA 2020) and Cook County use the same device.

#### 33. `split(LN) + FN + DOB`

95%. Offered only when both files draw from one state or one metropolitan area. Follows rule 31.

Catches one part of a compound last name dropped or the parts reversed.
Barrat and Berliner (2013), matching California's foster-care records to its K-12 records, found two steps splitting names added 9.1% of the final matches (memorandum Table 4); the 9.1% is an upper bound, since the steps also cut compound first names.
A review of 20 matches from each step found all 40 true, but the review was run while the steps were being refined, so the sample was not drawn blind.
With the factor `k` by which splitting multiplies rule 31's chance agreement taken as 0.3 (reasoning), the 95% band is met where rule 31's own false share is under about 1.6% at that 9.1% gain (computed here, from the formula in [linkage-rule-grounding.md](linkage-rule-grounding.md#why-one-loosened-element)).
A hyphenated last name was a reason in 50 of the 200 sampled matches Cook County's rules missed, which Table 3 prints as 24% of the reasons listed; Cook County changed its name processing after the project to catch them (Trick et al. 2019).
linkja's overview describes hashing each part of a compound surname, but the shipped code disables it (MRAIA 2020).

#### 34. `LN + FN + YOB + MOB + ZIP5`

95%. Any coverage. Relative.

Catches a wrong day of birth with no SSN.
It is a token the N3C configuration ships, without gender (Regenstrief Institute 2021).
Hillestad et al. (2008) put first + last name + birth year + ZIP at about one possible false match in 3,500 in a 42,000-record file, with error-free keys; this rule adds the month (reasoning).

### Rules with a phone or an email

#### 35. `LN + FN + SFX + PHONE`

95%. Any coverage. Measured without the suffix. Needs `name_suffix`.

Catches any date-of-birth error with no SSN.
Polubriaginof et al. (2018) measured first + last name + phone at 99.25% and 99.0%.
It stays at 95% for its floor, a same-name parent and child on a household phone, which no source measures.
The suffix removes that pair where both sides record a suffix, at the cost of the pair where only one side did, which loses this rule and keeps every rule without the element.
The band does not rise: Goel et al.'s (2020) Figure A.3 shows requiring the suffix cut same-name, same-date, same-address duplicates from about 1.25% to 0.65% of records in Mississippi and from 0.9% to 0.27% in DC, but no source measures the phone case.
Where one party's file has no suffix at all, the rule runs without the element rather than being dropped, since otherwise every junior recorded in the other file would fail it.
Bernstam et al. (2022) measured a cell phone alone at 95.6%.

#### 36. `PHONE + soundex(LN) + FN + SFX`

95%. Any coverage. One loosening on rule 35. Needs `name_suffix`.

As rule 35, with a last name that keeps its Soundex code; it runs after rule 35, a refinement of it.
The people most likely to share a phone are relatives, who share the surname exactly, so the Soundex code adds little (reasoning).

#### 36a. `FN + SFX + PHONE`

95%. Any coverage. Measured without the suffix. Needs `name_suffix` and the shared-contact screen.

Catches a changed last name and any date-of-birth error with no SSN.
Polubriaginof et al. (2018) measured first name + phone at 98.9% and 98.8% at two sites.
It is offered only because the default cleaning drops a phone or email held by more than five distinct people in a party's file.
Without that screen, a shelter's, clinic's or case manager's number on many clients gives each client one unique first-name-plus-phone value, which the one-to-one rule cannot catch, and no source measures numbers shared by an organization.
The same screen shrinks the sharing floor of every phone and email rule.

#### 37. `FN + DOB + EMAIL`

95%. Any coverage. The maintainer's judgment, pending evidence.

The email counterpart of rule 24.
See [The email rules](#the-email-rules).

#### 38. `LN + FN + SFX + EMAIL`

95%. Any coverage. The maintainer's judgment, pending evidence. Needs `name_suffix`.

Catches any date-of-birth error with no SSN, for records with an email address.
Kim et al. (2019) is its nearest measurement.
It is stricter than first name + email in the N3C configuration and the last name + email token Bell et al. (2026) list among Datavant's recommended tokens.

#### 39. `EMAIL + soundex(LN) + FN + SFX`

95%. Any coverage. One loosening on rule 38. Needs `name_suffix`.

As rule 38, with a last name that keeps its Soundex code; it runs after rule 38, a refinement of it, on the reasoning of rule 36.

### The Soundex-surname rules

Rules 28, 36 and 39 are the least supported in the catalog.
Every measurement of a Soundex surname as the only loosened name element, without geography or a contact field, falls below 95%:

- Rogot et al. (1983) found 2 of 34 reviewed pairs true where the last name agreed only by Soundex, the first name and birth year and month agreed exactly, and no SSN was available (Table 1).
- In Mirel et al. (2022), the Soundex-names token alone was 81.4% false.
- In Ocampo et al. (2016), the tier that pools Soundex-coded first and last names + DOB with an exact last name + DOB rule had 46.7% to 90.3% of its matches confirmed across six jurisdiction checks (Tables 3 to 5); the Maryland figures come from a 5% sample.
- NCHS planned to drop Soundex from National Death Index matching and use NYSIIS on last names, after evaluations found Soundex agreed on dissimilar names, adding false positives and very few true positives; no counts are given (Patterson and Bilgrad 1985).

The three rules are unmeasured rather than contradicted, since each has a ZIP or a contact field.
Beside a ZIP, a Soundex surname admits about three times the chance pairs (Randall et al. 2013), far inside the band; beside a phone or email the floor is household sharing, where the surname is the same anyway (reasoning).
They stay in the 95% band.
Whether Alcove adds a NYSIIS transform is open ([linkage-rule-grounding.md](linkage-rule-grounding.md#phonetic-names)).

### The email rules

The three email rules are in the 95% band by the maintainer's judgment, an exception to the evidence standard while evidence for them is gathered.
No source measures an email rule on program records.
One measurement exists outside program data: Kim et al. (2019) found pairs sharing a full email address were the same author in 26,870 of 26,942 (99.73%) against ORCID identifiers.
The email was attached only where it resembled the author's name, so it is nearest rule 38 on researchers' institutional addresses.
UCLA found 13 of 100 pairs agreeing on an email alone were the same person, in a stratum its EHR module had left unlinked (Ross et al. 2020).
The HL7 identity-matching guide grades first + last name + DOB + email "Superior" on uniqueness rather than measured precision (HL7 International 2025).
Two forms of one mailbox, with dots or a plus tag, produce different values, which costs matches but not precision (reasoning).

## Follow-on, unbanded until measured

`FN + LN + SSN4`, when one side has no valid date of birth, catches a date that is missing or a filler.
It needs a per-side missing-field condition, which Alcove lacks, and has no band until it is measured ([linkage-rule-grounding.md](linkage-rule-grounding.md#rule-features-the-evidence-calls-for)).

## Not offered

These rules have no evidence placing them at 95% or above.
An operator reaches them by authoring them in the expert key editor.

| Rule | Why it has no band |
| --- | --- |
| `LN + FN + DOB` with day and month exchanged | Its precision runs from 99% to under 50% as file size grows ([linkage-rule-grounding.md](linkage-rule-grounding.md#why-one-loosened-element)). Rule 19, with the last four SSN digits, covers the error |
| `LN + FN + DOB`, its swap and split forms, where the files cover more than one state or metropolitan area | Goel et al. (2020) confirmed only about three-quarters of cross-state name + date pairings as duplicates. Grannis (2005) measured a no-SSN name + date + gender rule at 89.1% and 89.5% specificity against the national Death Master File |
| `FN3 + LN + DOB` and `FN1 + LN + DOB` without an SSN; `soundex(FN) + soundex(LN) + DOB` without an SSN, geography or a contact field | In Mirel et al. (2022), links on which only these tokens agreed were 53.8% (first initial and three-letter first name), 95.7% (first initial) and 81.4% (Soundex names) false. Cook County's one confirmed false match came from its three-letter first-name rule (Trick et al. 2019) |
| `FN3 + LN + DOB` for uncommon names | Parked. A general tool cannot define a common name except relative to a particular population, so the name-frequency condition it needs is not built. Cook County's rule of this shape found 7,623 matches, the most of any rule (Trick et al. 2019) |
| Any contact field alone, or with only a date | A party learns from the result whether a value's holder is in the other file, and a contact value is shared across people ([default-linkage-rule-set.md](default-linkage-rule-set.md#criticisms-on-record)). Bernstam et al. (2022) measured a phone alone at 95.6%, and remark that infant twins share a birth date and phone |
| `FN + EMAIL` | No source measures a first name with an email. The email rules offered (37 to 39) add a date or a surname |

## Sources

Each entry begins with the short form the text cites it by.
The list includes the sources the design rationale cites for the bands; the rationale's other sources are listed in [linkage-rule-grounding.md](linkage-rule-grounding.md#sources).

- **Ansolabehere and Hersh 2016.** Ansolabehere S, Hersh ED. "ADGN: An Algorithm for Record Linkage Using Address, Date of Birth, Gender and Name." Author manuscript, 2016. https://www.eitanhersh.com/uploads/7/9/7/5/7975685/agdn_v1_4.pdf
- **Bailey et al. 2020.** Bailey, Cole, Henderson, Massey. "How Well Do Automated Linking Methods Perform? Lessons from U.S. Historical Data." Journal of Economic Literature 58(4):997-1044, 2020. doi:10.1257/jel.20191526. https://pmc.ncbi.nlm.nih.gov/articles/PMC8294155/
- **Barrat and Berliner 2013.** Barrat VX, Berliner B. "The Invisible Achievement Gap, Part 1: Education Outcomes of Students in Foster Care in California's Public Schools." WestEd, 2013; with its "Technical Memorandum for The Invisible Achievement Gap, Part 1: Linkage Between Data From the California Department of Education and From the California Department of Social Services," WestEd, 2013, Table 4. https://courts.ca.gov/sites/default/files/courts/default/2024-12/btb_xxii_iiia_13.pdf and https://web.archive.org/web/20140711145758id_/http://www.cftl.org/documents/2013/IAG/IAG_TM.pdf
- **Beauchamp et al. 2011.** Beauchamp A, Tonkin AM, Kelsall H, et al. "Validation of de-identified record linkage to ascertain hospital admissions in a cohort study." BMC Medical Research Methodology 11:42, 2011. doi:10.1186/1471-2288-11-42
- **Bell et al. 2026.** Bell DS, Saleh T, Sanz Vidorreta FJ, Pirani CN, Pevnick JM, Jenders RA, et al. "Accuracy of an XGBoost-based privacy preserving record linkage system compared with an electronic health record patient matching module in identifying patients shared between nearby academic health centers." Journal of the American Medical Informatics Association 33(4):901-908, 2026; Supplementary Table 1. doi:10.1093/jamia/ocag020
- **Bernstam et al. 2022.** Bernstam EV, Applegate RJ, Yu A, Chaudhari D, Liu T, Coda A, et al. "Real-World Matching Performance of Deidentified Record-Linking Tokens." Applied Clinical Informatics 13(4):865-873, 2022. doi:10.1055/a-1910-4154
- **Bian et al. 2019.** Bian J, Loiacono A, Sura A, Mendoza Viramontes T, Lipori G, Guo Y, et al. "Implementing a hash-based privacy-preserving record linkage tool in the OneFlorida clinical research network." JAMIA Open 2(4):562-569, 2019. doi:10.1093/jamiaopen/ooz050
- **Cao et al. 2026.** Cao C, Pillai J, Daraei S, Ghadermarzi S. "Linking patient records at scale with a hybrid approach combining contrastive learning and deterministic rules." Biology Methods and Protocols 11(1):bpag009, 2026. doi:10.1093/biomethods/bpag009
- **Christen 2006.** Christen P. "A comparison of personal name matching: techniques and practical issues." Joint Computer Science Technical Report Series TR-CS-06-02, Department of Computer Science, Australian National University, 2006; Table 4. A version appeared in the ICDM 2006 workshops, doi:10.1109/icdmw.2006.2.
- **Cole and Lee 2004.** Cole N, Lee E. "Feasibility and Accuracy of Record Linkage To Estimate Multiple Program Participation, Volume III: Results of Record Linkage." Abt Associates for the U.S. Department of Agriculture, Economic Research Service, E-FAN-03-008-3, 2004; Table 27. https://www.ers.usda.gov/webdocs/publications/43308/30264_efan03008-3_002.pdf
- **Culbertson et al. 2017.** Culbertson A, Goel S, Madden MB, Safaeinili N, Jackson KL, Carton T, et al. "The Building Blocks of Interoperability: A Multisite Analysis of Patient Demographic Attributes Available for Matching." Applied Clinical Informatics 8(2):322-336, 2017. doi:10.4338/ACI-2016-11-RA-0196
- **Fong et al. 2018.** Fong A, Barrat V, Finkelstein N. "Examination of data usability options for assessing eligibility for higher education in California." WestEd, 2018.
- **Goel et al. 2020.** Goel S, Meredith M, Morse M, Rothschild D, Shirani-Mehr H. "One Person, One Vote: Estimating the Prevalence of Double Voting in U.S. Presidential Elections." American Political Science Review 114(2):456-469, 2020; supplementary appendix, Figure A.3. doi:10.1017/S000305541900087X
- **Grannis 2005.** Grannis SJ. Slides presented to the National Committee on Vital and Health Statistics, 2005 (presentation, not peer-reviewed); the no-SSN rule's specificity against the Indiana subset and the full Death Master File.
- **Grannis et al. 2002.** Grannis SJ, Overhage JM, McDonald CJ. "Analysis of Identifier Performance Using a Deterministic Linkage Algorithm." Proceedings of the AMIA Annual Symposium 2002:305-309. https://pmc.ncbi.nlm.nih.gov/articles/PMC2244404/
- **Grannis et al. 2003.** Grannis SJ, Overhage JM, Hui S, et al. "Analysis of a probabilistic record linkage technique without human review." Proceedings of the AMIA Annual Symposium 2003:259-263.
- **Grannis et al. 2004.** Grannis SJ, Overhage JM, McDonald C. "Real world performance of approximate string comparators for use in patient matching." Studies in Health Technology and Informatics 107(Pt 1):43-47, 2004 (MEDINFO 2004). https://lhncbc.nlm.nih.gov/LHC-publications/PDF/pub9111.pdf
- **Hillestad et al. 2008.** Hillestad R, Bigelow JH, Chaudhry B, Dreyer P, Greenberg MD, Meili RC, et al. "Identity Crisis: An Examination of the Costs and Benefits of a Unique Patient Identifier for the U.S. Health Care System." RAND Corporation, MG-753-HLTH, 2008. https://www.rand.org/content/dam/rand/pubs/monographs/2008/RAND_MG753.pdf
- **HL7 International 2025.** HL7 International, Patient Administration Work Group. "Patient Matching," in Interoperable Digital Identity and Patient Matching, v2.0.0 (STU 2), HL7 FHIR US implementation guide, 2025. https://hl7.org/fhir/us/identity-matching/patient-matching.html
- **Just et al. 2016.** Just BH, Marc D, Munns M, Sandefer R. "Why Patient Matching Is a Challenge: Research on Master Patient Index (MPI) Data Discrepancies in Key Identifying Fields." Perspectives in Health Information Management 13(Spring):1e, 2016. https://pmc.ncbi.nlm.nih.gov/articles/PMC4832129/
- **Karmel and Gibson 2007.** Karmel R, Gibson D. "Event-based record linkage in health and aged care services data: a methodological innovation." BMC Health Services Research 7:154, 2007. doi:10.1186/1472-6963-7-154
- **Kim et al. 2019.** Kim J, Kim J, Owen-Smith J. "Generating automatically labeled data for author name disambiguation: an iterative clustering method." Scientometrics 118(1):253-280, 2019; Table 4. doi:10.1007/s11192-018-2968-3
- **Landsbach 2016.** Landsbach GD. "Study Analyzes Causes and Consequences of Patient Overlay Errors." Journal of AHIMA 87(9):40-43, 2016.
- **Mirel et al. 2022.** Mirel LB, Resnick DM, Aram J, Cox CS. "A methodological assessment of privacy preserving record linkage using survey and administrative data." Statistical Journal of the IAOS 38(2):413-421, 2022; Figure 1 and Table 1. doi:10.3233/sji-210891
- **MRAIA 2020.** Medical Research Analytics and Informatics Alliance. linkja-hashing and linkja-matching, source code as shipped, with "Privacy Preserving Record Linkage: Linkja Overview" (2019). GitHub, last revised 2020. https://github.com/MRAIA-ORG/linkja-hashing
- **Naessens et al. 2015.** Naessens JM, Visscher SL, Peterson SM, Swanson KM, Johnson MG, Rahman PA, et al. "Incorporating the Last Four Digits of Social Security Numbers Substantially Improves Linking Patient Data from De-identified Hospital Claims Databases." Health Services Research 50(Suppl 1):1339-1350, 2015. doi:10.1111/1475-6773.12323
- **Nechuta et al. 2020.** Nechuta S, Mukhopadhyay S, Krishnaswami S, Golladay M, McPheeters M. "Record Linkage Approaches Using Prescription Drug Monitoring Program and Mortality Data for Public Health Analyses and Epidemiologic Studies." Epidemiology 31(1):22-31, 2020. doi:10.1097/EDE.0000000000001110
- **Newman and Brown 1997.** Newman TB, Brown AN. "Use of Commercial Record Linkage Software and Vital Statistics to Identify Patient Deaths." Journal of the American Medical Informatics Association 4(3):233-237, 1997. doi:10.1136/jamia.1997.0040233
- **Ocampo et al. 2016.** Ocampo JMF, Smart JC, Allston A, Bhattacharjee R, Boggavarapu S, Carter S, et al. "Improving HIV Surveillance Data for Public Health Action in Washington, DC: A Novel Multiorganizational Data-Sharing Method." JMIR Public Health and Surveillance 2(1):e3, 2016. doi:10.2196/publichealth.5317
- **Ong et al. 2024.** Ong T, et al. "Linkability measures to assess the data characteristics for record linkage." Journal of the American Medical Informatics Association 31(11):2651-2659, 2024. doi:10.1093/jamia/ocae248
- **Park and Finnell 2012.** Park SC, Finnell JT. "Indianapolis Emergency Medical Service and the Indiana Network for Patient Care: Evaluating the Patient Match Algorithm." AMIA Annual Symposium Proceedings 2012:1221-1228. https://pmc.ncbi.nlm.nih.gov/articles/PMC3540486/
- **Patterson and Bilgrad 1985.** Patterson JE, Bilgrad R. "The National Death Index Experience: 1981-1985." In Record Linkage Techniques - 1985, Internal Revenue Service, Statistics of Income, 1985, pp. 245-254. https://www.irs.gov/pub/irs-soi/1985preprintar17.pdf
- **Polubriaginof et al. 2018.** Polubriaginof FCG, Vanguri R, Quinnies K, et al. "Disease Heritability Inferred from Familial Relationships Reported in Medical Records." Cell 173(7):1692-1704, 2018; Table S4. doi:10.1016/j.cell.2018.04.032
- **Randall et al. 2013.** Randall SM, Ferrante AM, Boyd JH, Semmens JB. "The effect of data cleaning on record linkage quality." BMC Medical Informatics and Decision Making 13:64, 2013. doi:10.1186/1472-6947-13-64
- **Regenstrief Institute 2021.** Regenstrief Institute. "N3C Linkage Honest Broker - Site Technical Engagement Packet," version 6, 2021; Appendix H. https://www.regenstrief.org/wp-content/uploads/2022/04/siteengagementpacket-pre-nda-v06.pdf
- **Rogerson et al. 2026.** Rogerson CM, Bartlett CW, Price J, Li L, Mendonca EA, Grannis S. "Derivation and validation of an algorithm for maternal-child linkage in electronic health records." Journal of the American Medical Informatics Association 33(2):451-456, 2026. doi:10.1093/jamia/ocaf177
- **Rogot et al. 1983.** Rogot E, Schwartz SH, O'Conor KV, Olsen CL. "The Use of Probabilistic Methods in Matching Census Samples to the National Death Index." In Record Linkage Techniques preprints, Internal Revenue Service, Statistics of Income, 1983; Table 1. https://www.irs.gov/pub/irs-soi/1983preprintar30.pdf
- **Ross et al. 2020.** Ross MK, Sanz J, Tep B, Follett R, Soohoo SL, Bell DS. "Accuracy of an Electronic Health Record Patient Linkage Module Evaluated between Neighboring Academic Health Care Centers." Applied Clinical Informatics 11(5):725-732, 2020. doi:10.1055/s-0040-1718374
- **Sun and Golden 2019.** Sun Y, Golden C. "Comparing Multiple SAS Functions for Text Field Matching in Data Linkage: SOUNDEX, NYSIIS, COMPGED." SAS Global Forum 2019, paper 3755-2019. https://support.sas.com/resources/papers/proceedings19/3755-2019.pdf
- **Trick et al. 2019.** Trick WE, Doshi K, Ray MJ, Angulo F. "Development and Evaluation of Record Linkage Rules in a Safety-Net Health System Serving Disadvantaged Communities." ACI Open 3:e63-e70, 2019. doi:10.1055/s-0039-1693129
