---
title: "Linkage Rule Catalog: Proposed Rules and Their Precision Bands"
---

# Linkage rule catalog: proposed rules and their precision bands

_Status: proposed, not shipped.
Nothing here is built, and the operator-facing form follows when the rules ship.
The shipped key set, `hmis-keys`, is described in [default-linkage-rule-set.md](default-linkage-rule-set.md).
The design rationale behind this catalog -- how the rules compare with published practice, why they run in precision order, and what the evidence does not settle -- is in [linkage-rule-grounding.md](linkage-rule-grounding.md).
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
- `DOB` is the full date of birth.
  `YOB + MOB` is the year and month of birth without the day.
- `ZIP5` is the client's own five-digit ZIP code.
  `PHONE` is a ten-digit phone number.
  `EMAIL` is an email address, trimmed and lowercased.
- `SDX(LN)` is the Soundex code of the last name.
- `swap(LN, FN)` matches the two names in either order.
- `split(LN)` matches on the whole last name or on any one hyphen- or space-separated part of it.
- `DOB +/-1 year`, `DOB +/-1 day` and `DOB with day and month exchanged` match a date that differs in that way, and also the exact date.

### Bands

A rule's precision is the share of the pairs it accepts, at its position in the order, that are the same person.
Each rule has one of three bands: above 99.5%, 99% to 99.5%, or 95% to 99%.
The bands are the basis for precision tiers: rules will be grouped into tiers that a user selects together.
Each band is information a party consents to when it accepts a rule.

Each entry states the basis for its band in one of three ways:

- **A measured close relative.** A source measured a rule of a similar shape, and the entry says what differs.
- **Reasoning.** No measured relative exists, and the band is this note's inference from how much each element narrows a match.
- **The owner's judgment.** The band was set by the maintainer where neither measurement nor a close relative exists.

No rule here is measured directly in its exact shape.
The confidence stated with a band (high, medium or low) is about the band, not about the source.

Three differences apply to every measurement cited, and an entry restates them only where they matter most:

- No source is HMIS-to-Medicaid matching, or HMIS data at all.
  The measurements are from health, death, voter and school records.
- Most measured rules include sex or gender.
  Alcove's fields have none, so a rule without it accepts more false pairs than its measured relative (reasoning).
- The bands assume an exchange within one county.
  A county's files are far smaller than the state and national files most sources measured, and chance agreement grows with file size (Zech et al. 2016; Hillestad et al. 2008).

### Order

Rules run in precision order, highest band first, and the catalog lists them in that order.
Within a band, a rule that another rule contains runs first; otherwise rules with a full SSN run before rules with the last four digits, and those before rules with neither (reasoning).
Rule 12 is placed by the maintainer ahead of rules 13 to 16.
Why precision order, and which placements the evidence forces: [linkage-rule-grounding.md](linkage-rule-grounding.md#why-precision-order).

Each entry says whether the rule is in `hmis-keys` today.
Three rules need a feature Alcove lacks, and their entries name it: rules 14, 20 and 33.

## Rules above 99.5%

### 1. `SSN + LN + DOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

The strictest rule: a full SSN with the last name and the full date of birth.
Grannis et al. (2002) linked two hospitals' records to the Indiana Death Master File by SSN.
SSN plus full date of birth made 2 wrong links against 4,557 and 5,216 correct ones.
This rule adds the last name, so its false pairs are a subset of those (reasoning).
In Mirel et al. (2022), links on which only the SSN + sex + DOB token agreed were 6 false against 2,151 true.

### 2. `SSN + LN4 + DOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

Catches a last name written differently after its fourth letter.
Its false pairs are a subset of SSN + full date of birth, measured as for rule 1 (Grannis et al. 2002).

### 3. `SSN + LN4 + YOB + MOB`

Above 99.5%. Reasoning; low confidence. In `hmis-keys` today.

Catches a wrong day of birth when the full SSN agrees.
No measured relative drops the day.
The most common SSN error in Grannis et al. (2002), a spouse's record under the guarantor's number, would also need the same birth year and month (reasoning).

### 4. `SSN + LN3 + DOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

As rule 2, with a three-letter prefix.
Its false pairs are a subset of SSN + full date of birth (Grannis et al. 2002).

### 5. `SSN + DOB + FN`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

Catches a changed last name when the full SSN agrees.
Its false pairs are a subset of SSN + full date of birth (Grannis et al. 2002).
Bernstam et al. (2022) measured SSN + first name at 99.6% precision on blocked candidate pairs from one data warehouse.
It runs before rule 6, which contains it.

### 6. `SSN + FN3 + DOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

Catches a changed last name together with a first name spelled differently after its third letter.
Its false pairs are a subset of SSN + full date of birth (Grannis et al. 2002).
The N3C linkage configuration (Regenstrief Institute 2021) ships a token with the same three-letter first name.

### 7. `SSN + FN + YOB + MOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

Catches a changed last name and a wrong day of birth together.
In Grannis et al. (2002), SSN + phonetic first name + birth month + gender made no wrong links at either hospital.
In Mirel et al. (2022), links on which only the SSN + first name token agreed were 98.0% correct (2,705 true, 56 false).
This rule also requires the birth year and month, so it is stricter than that token (reasoning).

### 8. `SSN + FN3 + YOB + MOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

As rule 7, with a three-letter first name; it runs after rule 7, which it contains.
In Grannis et al. (2002), SSN + first name + birth year + gender made no wrong links at either hospital (4,350 and 4,997 correct), and neither did the same rule with a phonetic first name.
This rule has the month but no gender, and truncates the first name rather than coding it phonetically (reasoning).

### 9. `SSN4 + LN + DOB`

Above 99.5%. A measured close relative; medium confidence. In `hmis-keys` today.

Catches records that hold only the last four SSN digits, the only digits HUD has required an HMIS to collect since FY2024 (HUD 2025d).
Naessens et al. (2015) found last four SSN + DOB + sex at 99.9% positive predictive value, with 3 false positives among 52,212 true 30-day readmissions.
This rule replaces sex with the last name, which narrows a match more (reasoning).
Hillestad et al. (2008) found that removing the last four SSN digits from a name + DOB + ZIP key creates nearly 1,000 false positives in a 79-million-record file.
Naessens linked one health system's discharges to each other, and cut the four digits from complete SSNs held in both sources.

### 10. `LN + FN + DOB + PHONE`

Above 99.5%. A measured close relative; medium confidence. New.

Accepts the pairs rule 12 accepts that also agree on a phone.
It adds a match only where rule 12's value is held by two records in one party's file, which a one-to-one round drops as ambiguous ([PROTOCOL.md](../spec/PROTOCOL.md#value-level-round-participation)).
The Sequoia Project (2018) found first + last name + DOB + sex + phone identified a single person in 99.5% of matches, in one health system's own records; that is uniqueness, not precision.
A shared household or shelter phone needs the same full name and date of birth as well to make a false match (reasoning).

### 11. `LN + FN + DOB + ZIP5`

Above 99.5%, where the ZIP is the client's own. A measured close relative and reasoning; low confidence. New.

Accepts the pairs rule 12 accepts that also agree on the client's ZIP, and adds matches as rule 10 does.
It is exactly a token the N3C linkage configuration ships (Regenstrief Institute 2021).
In Mirel et al. (2022), links agreeing on name + sex + DOB with no SSN were 41.4% false where the state disagreed and 0.3% false where it agreed; a ZIP is a finer geography than a state (reasoning).
Cao et al. (2026) measured first + last name + DOB + three-digit ZIP at 0.97 precision against 0.95 for first + last name + gender + DOB.
Its false pairs are a subset of rule 12's, so its band cannot be lower (reasoning).
A party must never supply HUD's project ZIP as the client's: every client of a shelter shares it.

### 12. `LN + FN + DOB`

Above 99.5% within one county. A measured close relative and reasoning; low confidence. In `hmis-keys` today.

A rule with no SSN evidence, catching records whose SSN is missing or wrong.
Mirel et al. (2022) found links agreeing on name + sex + DOB and on state were 99.6% correct (79,757 true, 315 false; computed here).
That row includes sex and covers a state; without sex more false pairs agree, and a county's files are far smaller than a state's (reasoning).
Across states the same links were 41.4% false, so the band applies only to an exchange within one county.
Bernstam et al. (2022) measured last + first name + gender + DOB at 99.9% precision in one data warehouse.

### 13. `SSN4 + LN + FN + DOB +/-1 year`

Above 99.5%. Reasoning; medium confidence. New.

Catches a birth year off by one, which differed in 40.0% of confirmed duplicate pairs with a date-of-birth discrepancy (Just et al. 2016).
HUD lets staff estimate an unknown birth year from the client's age (HUD 2025a).
linkja emits this hash (MRAIA 2020), and Cook County's rule of the same shape found 313 matches its EHR process missed (Trick et al. 2019).
No source publishes its precision; Cook County's six rules together had 189 of 201 sampled matches confirmed, 1 false and 11 not adjudicable.
With the last four SSN digits and both full names, three candidate years add few chance agreements (reasoning).

### 14. `SSN4 + LN + FN + DOB +/-1 day`

Above 99.5%. Reasoning; medium confidence. New.
Needs a date expansion of one day either side, which Alcove lacks.

Catches a birth day off by one.
The day is the most frequent date-of-birth discrepancy, 48.3% of pairs with one (Just et al. 2016), and Cook County's largest spike in date differences was at 1 day.
linkja emits this hash (MRAIA 2020), and Cook County's rule of the same shape found 371 matches its EHR process missed (Trick et al. 2019).
The band rests on the same reasoning as rule 13.

### 15. `SSN4 + LN + FN + DOB with day and month exchanged`

Above 99.5%. Reasoning; medium confidence. New.

Catches a day and month recorded in the wrong order, only 2.6% of date discrepancies (Just et al. 2016), so it adds little.
linkja emits this hash (MRAIA 2020); Cook County's rule of this shape, without the last four SSN digits, found 454 matches its EHR process missed (Trick et al. 2019).
HUD's filler of `01` for an unknown month and day is unchanged by the exchange (HUD 2025a).

### 16. `SSN4 + FN + DOB`

Above 99.5%. A measured close relative; medium confidence. New.

Catches a changed last name when only the last four SSN digits are held.
Last-name changes were 44% of the classified errors in UCLA's reviewed sample of links its EHR module missed (Ross et al. 2020), and 23% of a sample of matches Cook County's rules missed (Trick et al. 2019).
Naessens et al. (2015) found last four SSN + DOB + sex at 99.9% positive predictive value; this rule replaces sex with the first name (reasoning).
Naessens's death figures are for Minnesota residents only, and its readmissions link one health system's discharges to each other.

## Rules from 99% to 99.5%

### 17. `SSN + LN + FN1`

99% to 99.5%. A measured close relative and reasoning; low confidence. In `hmis-keys` today.

Catches a first name recorded differently, when the full SSN and last name agree.
In Grannis et al. (2002), SSN + last name + first name made 7 wrong links against 4,541 correct, and 2 against 5,157.
The most common SSN error there "appeared to be" a spouse sharing the last name, and a first initial lets through spouses who share an initial (reasoning; no source gives that rate).

### 18. `SSN + LN3 + FN1`

99% to 99.5%. A measured close relative and reasoning; low confidence. In `hmis-keys` today.

As rule 17.
A three-letter last name adds little looseness, because the spousal errors already share the whole surname (reasoning).

### 19. `SSN4 + LN4 + YOB + MOB`

99% to 99.5%. Reasoning; low confidence. In `hmis-keys` today.

The thinnest rule in `hmis-keys`: about 13 bits from the four SSN digits, a four-letter prefix, and about 10 bits from the year and month (reasoning).
No measured relative exists.

### 20. `FN + LN + SSN4`, unless the dates of birth disagree

99% to 99.5%. Reasoning; low confidence. New.
Needs a conflict veto -- fire only when a field is not present and different on both sides -- which Alcove lacks.

Catches a date of birth that is missing, a filler, or off by more than rules 13 to 15 allow.
HUD's 2005 unduplication guidance treats agreement on any two of first name, last name, DOB and a partial SSN as a potential match.
It deletes the match when two of gender, name suffix, the parts of the date and the full SSN conflict, unless the full SSN and two of the names and date agree (Sokol and Gutierrez 2005).
The veto stops the rule when both sides hold a valid date beyond rules 13 to 15's tolerances; without it, two same-name people sharing four digits would match (reasoning).
Ong et al. (2020) ran last name + last four SSN + birth year after first + last name + DOB, and it added no links, in a heart-disease registry.

### 21. `LN + FN + DOB with day and month exchanged`

99% to 99.5%. Reasoning; low confidence. New.

Catches a day and month exchanged when no SSN evidence agrees.
Cook County's third rule has this shape (Trick et al. 2019), and Massachusetts's school-meals match ran it as its second round after exact name + DOB (Cole and Logan 2006).
It doubles the candidate dates of rule 12, so it roughly doubles chance agreement (reasoning).
It runs after rules 12 and 15, which it contains.

### 22. `swap(LN, FN) + DOB`

99% to 99.5%. Reasoning; low confidence. In `hmis-keys` today.

Catches a first and last name recorded in the wrong fields.
The receiving party sends both orders ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termslinkage_keys)), so the rule accepts what rule 12 accepts plus reversed names (reasoning).
linkja (MRAIA 2020) and Cook County use the same device, but Cook County's reversed-name matches also required the last four SSN digits (Trick et al. 2019), and this rule does not.

### 23. `ZIP5 + SDX(LN) + FN + DOB`

99% to 99.5%. A measured close relative and reasoning; low confidence. New, added provisionally by the maintainer.

Catches a misspelled last name that keeps its Soundex code, with no SSN.
UCLA found 94 of 100 reviewed pairs agreeing on first name + DOB + ZIP were the same person, in a stratum selected by match score (Ross et al. 2020); this rule adds a Soundex surname, so its false pairs are a subset (reasoning).
Beside an SSN, phonetic names added true links and no false ones (Grannis et al. 2002, with a different phonetic code; Mirel et al. 2022).
As the only name evidence they do badly: the Soundex-names token alone was 81.4% false in Mirel.
Twins sharing a birth date and address made Naessens's two false positives on DOB + sex + ZIP, and a full first name excludes twins with different names.

## Rules from 95% to 99%

### 24. `split(LN) + FN + DOB`

95% to 99%. Reasoning; low confidence. New.

Catches one part of a compound last name dropped or the parts reversed.
A hyphenated last name was 24% of a sample of matches Cook County's rules missed; Cook County added a two-last-names step afterward that found 1,988 more matches, outside its validation sample (Trick et al. 2019).
linkja hashes each part of a compound surname (MRAIA 2020), and a Texas voter-file match split hyphenated names the same way (Ansolabehere and Hersh 2016).
Agreement on one common part, such as Garcia against Smith-Garcia with the same first name and date, is open to chance agreement (reasoning).

### 25. `FN + DOB + PHONE`

95% to 99%. A measured close relative and reasoning; low confidence. New, added provisionally by the maintainer.

Catches a changed last name with no SSN.
The N3C configuration ships first name + cell phone (Regenstrief Institute 2021), and this rule adds the date of birth (reasoning: a subset of its false pairs).
A phone narrows a match far more than a ZIP: in one health system's records its distinctiveness was 51.6% against 0.6% for postal code (The Sequoia Project 2018).
UCLA found only 26 of 100 pairs agreeing on a phone alone were the same person (Ross et al. 2020), so a false match needs a shared phone, first name and date, such as same-name twins (reasoning).

### 26. `FN + DOB + EMAIL`

95% to 99%. Reasoning; low confidence. New.

The email counterpart of rule 25.
No source measures any rule with an email address.
The N3C configuration ships first name + email (Regenstrief Institute 2021).
The HL7 identity-matching guide grades first + last name + DOB + email "Superior", above first + last name + DOB + sex + last four SSN, on uniqueness rather than measured precision (HL7 International 2025).
UCLA found 13 of 100 pairs agreeing on an email alone were the same person (Ross et al. 2020).
It will rarely fire for an HMIS party: HUD's export format has no client email field (HUD 2025c).

### 27. `ZIP5 + SDX(LN) + FN + DOB +/-1 year`

95% to 99%. Reasoning; low confidence. New, added provisionally by the maintainer.

Catches a birth year off by one with no SSN, as rule 13 does with it.
It contains rule 23, and three candidate years roughly triple its chance agreement (reasoning).
The one-year device comes from linkja and Cook County, both of which pair it with the last four SSN digits.

### 28. `LN + FN + YOB + MOB + ZIP5`

95% to 99%. Reasoning; low confidence. New.

Catches a wrong day of birth with no SSN.
It is a token the N3C configuration ships, without gender (Regenstrief Institute 2021).
Hillestad et al. (2008) put first + last name + birth year + ZIP at about one possible false match in 3,500 in a 42,000-record file, with error-free keys; this rule adds the month (reasoning).
A shelter ZIP pools many clients into one value (Park and Finnell 2012).

### 29. `LN + FN + PHONE`

95% to 99%. A measured close relative and reasoning; low confidence. New.

Catches any date-of-birth error with no SSN.
It is stricter than Bernstam et al.'s (2022) cell-phone-alone token, measured at 95.6% precision (reasoning: a subset of its false pairs).
A household phone shared by a father and son with the same name, or a shelter's or case manager's number on two same-name clients, could make a false match.
Phones change often in this population: 54.5% of homeless adults with a cell phone reported two or more numbers in three months (Rhoades et al. 2017), which costs matches but not precision (reasoning).

### 30. `PHONE + SDX(LN) + FN`

95% to 99%. Reasoning; low confidence. New.

As rule 29, with a last name that keeps its Soundex code; it runs after rule 29, which it contains.
The people most likely to share a phone are relatives, who share the surname exactly, so the Soundex code adds little risk (reasoning).
No source measures it.

### 31. `LN + FN + EMAIL`

95% to 99%. The owner's judgment; low confidence. New.

Catches any date-of-birth error with no SSN, for records holding an email address.
No source measures any rule with an email address.
It is stricter than both first name + email in the N3C configuration and the last name + email token Datavant recommends (Bell et al. 2026).
UCLA found 13 of 100 pairs agreeing on an email alone were the same person (Ross et al. 2020).
Two forms of one mailbox, with dots or a plus tag, produce different values, which costs matches but not precision (reasoning).

### 32. `EMAIL + SDX(LN) + FN`

95% to 99%. Reasoning; low confidence. New.

As rule 31, with a last name that keeps its Soundex code; it runs after rule 31, which it contains, on the reasoning of rule 30.

## Precision not established

### 33. `FN3 + LN + DOB`, uncommon names only

Not established; its nearest measured relative is below 95%. New.
Needs a name-frequency condition, a score saying how common a first and last name combination is, which Alcove lacks.

Catches a first name spelled differently after its third letter, such as Priscilla and Priscila.
Cook County's rule of this shape found 7,623 matches, the most of any rule, and also made its one confirmed false match: two first names sharing three letters, the last name Smith, and one date (Trick et al. 2019).
The Link King accepts a looser match only for a rare name, scoring name combinations from .1 to 1 and treating 0.3 or lower as rare (Campbell et al. 2006).
Against it: in Mirel et al. (2022), links on which only the first-initial and three-letter-first-name tokens agreed, with no SSN or state, were 53.8% false.
With an SSN token also agreeing, the same links were 720 true and none false.
A county's smaller files and the condition might bring it into 95% to 99% (reasoning, low confidence); no source measures the restricted rule.

## Open questions for the owner

- **Rule 33.**
  Its nearest measured relative is below 95% precision, and so below every other rule's band.
  Whether it runs before it is measured is open.
- **HUD's older client ZIP.**
  HUD's FY2026 standards have no client ZIP; their only ZIP is the project's (HUD 2025a; HUD 2025b).
  HUD's earlier standards had a client ZIP, the ZIP of the last permanent address, where the client last lived for 90 days or more (HUD 2010).
  For a client already homeless it is a former address, while a Medicaid plan records a current one.
  ZIP change caused 95.7% of the true readmissions Naessens et al.'s (2015) DOB + sex + ZIP rules missed.
  Whether a county may supply that ZIP as the client ZIP for rules 11, 23, 27 and 28 is open.

## Shapes considered and not proposed

| Shape | Evidence | Why not |
| --- | --- | --- |
| `FN + DOB + ZIP5` | UCLA: 94 of 100 reviewed pairs were the same person, in a stratum selected by match score (Ross et al. 2020) | Measured below the band of every SSN rule. Rule 23 adds a Soundex surname to it |
| `FN + EMAIL` | N3C configuration token (Regenstrief Institute 2021), unmeasured | UCLA's email-only pairs were the same person in 13 of 100. Rule 31 is the stricter form |
| `LN + EMAIL` | Datavant recommended token (Bell et al. 2026), unmeasured | The same sharing concern. Rule 31 adds the first name |
| `FN + PHONE` | N3C configuration token (Regenstrief Institute 2021), unmeasured | Household sharing (Ross et al. 2020; The Pew Charitable Trusts 2018). Rule 29 is the stricter form |
| `FN3 + LN + DOB` for every name; `SDX(FN) + SDX(LN) + DOB` | Bernstam et al. 2022, the same shapes with gender measured at 98.5% and 98.6% on blocked pairs | In Mirel et al. (2022), the Soundex token alone was 81.4% false and the first-initial token alone 95.7%. Cook County's one confirmed false match came from its three-letter rule. Rule 33 keeps the three-letter form for uncommon names |
| `PHONE + DOB`, `EMAIL + DOB` | None | No name element. Infant twins share a birth date and phone (Bernstam et al. 2022) |
| `LN + FN + ZIP5` | N3C configuration token (Regenstrief Institute 2021), with gender, unmeasured | Unmeasured, and rule 28 keeps a year and month |
| Any contact field alone | Bernstam et al. 2022, phone alone 95.6% | A party learns from the result whether a value's holder is in the other file, and a contact value is shared across people ([default-linkage-rule-set.md](default-linkage-rule-set.md#criticisms-on-record)) |

## Sources

Each entry begins with the short form the text cites it by.
Sources cited only by the design rationale are listed in [linkage-rule-grounding.md](linkage-rule-grounding.md#sources).

- **Ansolabehere and Hersh 2016.** Ansolabehere S, Hersh ED. "ADGN: An Algorithm for Record Linkage Using Address, Date of Birth, Gender and Name." Author manuscript, 2016. https://www.eitanhersh.com/uploads/7/9/7/5/7975685/agdn_v1_4.pdf
- **Bell et al. 2026.** Bell DS, Saleh T, Sanz Vidorreta FJ, Pirani CN, Pevnick JM, Jenders RA, et al. "Accuracy of an XGBoost-based privacy preserving record linkage system compared with an electronic health record patient matching module in identifying patients shared between nearby academic health centers." Journal of the American Medical Informatics Association 33(4):901-908, 2026; Supplementary Table 1. doi:10.1093/jamia/ocag020
- **Bernstam et al. 2022.** Bernstam EV, Applegate RJ, Yu A, Chaudhari D, Liu T, Coda A, et al. "Real-World Matching Performance of Deidentified Record-Linking Tokens." Applied Clinical Informatics 13(4):865-873, 2022. doi:10.1055/a-1910-4154
- **Campbell et al. 2006.** Campbell K, Deck D, Cox A, Broderick C. "The Link King: User Manual, Version v5.2." Washington State Department of Social and Health Services, 2006. https://web.archive.org/web/20070106073145id_/http://www.the-link-king.com:80/user_manual.zip
- **Cao et al. 2026.** Cao C, Pillai J, Daraei S, Ghadermarzi S. "Linking patient records at scale with a hybrid approach combining contrastive learning and deterministic rules." Biology Methods and Protocols 11(1):bpag009, 2026. doi:10.1093/biomethods/bpag009
- **Cole and Logan 2006.** Cole N, Logan C. "Data Matching in the National School Lunch Program: 2005. Volume 2: State Case Studies." Abt Associates for the U.S. Department of Agriculture, Food and Nutrition Service, Report CN-06-DM2, 2006. https://www.fns.usda.gov/sites/default/files/DataMatching-V2.pdf
- **Grannis et al. 2002.** Grannis SJ, Overhage JM, McDonald CJ. "Analysis of Identifier Performance Using a Deterministic Linkage Algorithm." Proceedings of the AMIA Annual Symposium 2002:305-309. https://pmc.ncbi.nlm.nih.gov/articles/PMC2244404/
- **Hillestad et al. 2008.** Hillestad R, Bigelow JH, Chaudhry B, Dreyer P, Greenberg MD, Meili RC, et al. "Identity Crisis: An Examination of the Costs and Benefits of a Unique Patient Identifier for the U.S. Health Care System." RAND Corporation, MG-753-HLTH, 2008. https://www.rand.org/content/dam/rand/pubs/monographs/2008/RAND_MG753.pdf
- **HL7 International 2025.** HL7 International, Patient Administration Work Group. "Patient Matching," in Interoperable Digital Identity and Patient Matching, v2.0.0 (STU 2), HL7 FHIR US implementation guide, 2025. https://hl7.org/fhir/us/identity-matching/patient-matching.html
- **HUD 2010.** U.S. Department of Housing and Urban Development. "Homeless Management Information System (HMIS) Data Standards Revised Notice." March 2010. https://web.archive.org/web/20170829223119id_/https://www.hudexchange.info/resources/documents/FinalHMISDataStandards_March2010.pdf
- **HUD 2025a.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Data Standards Manual." 2025. https://files.hudexchange.info/resources/documents/HMIS-Data-Standards.pdf
- **HUD 2025b.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Data Dictionary." HUD Exchange, 2025.
- **HUD 2025c.** U.S. Department of Housing and Urban Development. "HMIS CSV Format Specifications, Version 1.0 (FY 2026)." HUD Exchange, 2025.
- **HUD 2025d.** U.S. Department of Housing and Urban Development. "FY 2026 HMIS Standard Reporting Terminology Glossary." 2025. https://files.hudexchange.info/resources/documents/HMIS-Standard-Reporting-Terminology-Glossary.pdf
- **Just et al. 2016.** Just BH, Marc D, Munns M, Sandefer R. "Why Patient Matching Is a Challenge: Research on Master Patient Index (MPI) Data Discrepancies in Key Identifying Fields." Perspectives in Health Information Management 13(Spring):1e, 2016. https://pmc.ncbi.nlm.nih.gov/articles/PMC4832129/
- **Mirel et al. 2022.** Mirel LB, Resnick DM, Aram J, Cox CS. "A methodological assessment of privacy preserving record linkage using survey and administrative data." Statistical Journal of the IAOS 38(2):413-421, 2022; Figure 1 and Table 1. doi:10.3233/sji-210891
- **MRAIA 2020.** Medical Research Analytics and Informatics Alliance. linkja-hashing, source code as shipped, with "Privacy Preserving Record Linkage: Linkja Overview" (2019). GitHub, last revised 2020. https://github.com/MRAIA-ORG/linkja-hashing
- **Naessens et al. 2015.** Naessens JM, Visscher SL, Peterson SM, Swanson KM, Johnson MG, Rahman PA, et al. "Incorporating the Last Four Digits of Social Security Numbers Substantially Improves Linking Patient Data from De-identified Hospital Claims Databases." Health Services Research 50(Suppl 1):1339-1350, 2015. doi:10.1111/1475-6773.12323
- **Ong et al. 2020.** Ong TC, Duca LM, Kahn MG, Crume TL. "A hybrid approach to record linkage using a combination of deterministic and probabilistic methodology." Journal of the American Medical Informatics Association 27(4):505-513, 2020. doi:10.1093/jamia/ocz232
- **Park and Finnell 2012.** Park SC, Finnell JT. "Indianapolis Emergency Medical Service and the Indiana Network for Patient Care: Evaluating the Patient Match Algorithm." AMIA Annual Symposium Proceedings 2012:1221-1228. https://pmc.ncbi.nlm.nih.gov/articles/PMC3540486/
- **Regenstrief Institute 2021.** Regenstrief Institute. "N3C Linkage Honest Broker - Site Technical Engagement Packet," version 6, 2021; Appendix H. https://www.regenstrief.org/wp-content/uploads/2022/04/siteengagementpacket-pre-nda-v06.pdf
- **Rhoades et al. 2017.** Rhoades H, Wenzel S, Rice E, Winetrobe H, Henwood B. "No Digital Divide? Technology Use among Homeless Adults." Journal of Social Distress and the Homeless 26(1):73-77, 2017. doi:10.1080/10530789.2017.1305140
- **Ross et al. 2020.** Ross MK, Sanz J, Tep B, Follett R, Soohoo SL, Bell DS. "Accuracy of an Electronic Health Record Patient Linkage Module Evaluated between Neighboring Academic Health Care Centers." Applied Clinical Informatics 11(5):725-732, 2020. doi:10.1055/s-0040-1718374
- **Sokol and Gutierrez 2005.** Sokol B, Gutierrez O. "Technical Guidelines for Unduplicating and De-identifying HMIS Client Records." U.S. Department of Housing and Urban Development, 2005. https://web.archive.org/web/2017id_/https://www.hudexchange.info/resources/documents/TechnicalGuidelinesForUnduplicatingAndDeIdentifyingClientRecords.pdf
- **The Pew Charitable Trusts 2018.** The Pew Charitable Trusts. "Enhanced Patient Matching Is Critical to Achieving Full Promise of Digital Health Records." 2018. https://www.pewtrusts.org/-/media/assets/2018/09/healthit_enhancedpatientmatching_report_final.pdf
- **The Sequoia Project 2018.** The Sequoia Project. "A Framework for Cross-Organizational Patient Identity Management." 2018. https://sequoiaproject.org/wp-content/uploads/2018/06/The-Sequoia-Project-Framework-for-Patient-Identity-Management-v31.pdf
- **Trick et al. 2019.** Trick WE, Doshi K, Ray MJ, Angulo F. "Development and Evaluation of Record Linkage Rules in a Safety-Net Health System Serving Disadvantaged Communities." ACI Open 3:e63-e70, 2019. doi:10.1055/s-0039-1693129
- **Zech et al. 2016.** Zech J, Husk G, Moore T, Shapiro JS. "Measuring the Degree of Unmatched Patient Records in a Health Information Exchange Using Exact Matching." Applied Clinical Informatics 7(2):330-340, 2016. doi:10.4338/ACI-2015-11-RA-0158
