---
title: "Default Standardization and Type Inference"
---

# Default standardization and type inference

An exchange that authors no `standardization` block does not skip cleaning: the
cleaning is reconstructed from the input metadata and the linkage terms, one
fixed pipeline per semantic type. This document specifies those pipelines -- the
exact ordered steps, their parameters, and the value each produces -- and the
column-name table that assigns a semantic type, a role, and a payload default
when no `metadata` block is authored either.

It is the spec-tier complement to
[Data standardizing transformations](../EXCHANGE_REFERENCE.md#data-standardizing-transformations)
and [Input metadata](../EXCHANGE_REFERENCE.md#input-metadata) in
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md), which say what a
transformation is, how an operator authors one, and what each configuration
field means; this document says what the defaults do, step by step, so a
reviewer or an independent implementor can reproduce them without reading the
source. It does not cover the step functions themselves (see
[Available functions](../EXCHANGE_REFERENCE.md#available-functions)), the
regular-expression dialect they execute under or the normative `parse_date`
semantics (see
[PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect)), or the rule
that binds a linkage field to an input column (see
[PROTOCOL.md](PROTOCOL.md#linkage-participation-the-role-axis)). Intended
readers are implementors, security auditors, and maintainers changing a
pipeline.

The step sequences, the worked examples, the alias table, the affix, state,
street suffix, directional and unit designator tables, and the date-format
inference parameters below are checked against the shipped registries by
`packages/core/test/config/defaultStandardizationDoc.test.ts`: an edit to either side
that is not mirrored in the other fails the unit suite.

## Cross-party invariant

A standardized value is the byte string hashed into the PSI set element (see
[Key input data](PROTOCOL.md#key-input-data)). Two parties therefore match a
record only when their pipelines agree byte for byte: a single differing step
yields different keys, and the pair matches nothing on that key. Nothing
reports this. A missed match is indistinguishable from an absent record, so a
divergence shows as a quietly smaller intersection rather than an error.

Three consequences follow, and they are what make these pipelines a protocol
surface rather than a local formatting choice.

- **A change to any step sequence in this document is wire-affecting.** Both
  parties must run releases with the same sequence. Changing one is a
  breaking protocol change even though no wire format moves.
- **Nothing in the handshake detects a divergence.** The two parties exchange
  and hash their linkage terms (the agreed-terms hash covers those, and the
  terms state a field's `type` and `constraints`, not its cleaning); each
  party's standardization -- authored or reconstructed -- stays local and is
  neither sent nor committed to. Agreement on the pipelines comes from both
  sides running the same specification, not from a check at run time.
- **A per-party parameter is legitimate only when the output is canonical.**
  One instance is the `date_of_birth` input format, which each party infers
  from its own file's layout (see
  [Date-format inference](#date-format-inference)). It is safe because every
  input layout is reformatted to the same `YYYYMMDD` output. A step whose
  parameter changed the *output* form could not be inferred per party this way.
  A placeholder list is another per-party parameter; it decides only which
  values are dropped, never the form of a value kept (see
  [Per-party placeholder lists](#per-party-placeholder-lists)). The
  shared-value limit is the third, and it also decides only which values are
  dropped (see [Shared-value screens](#shared-value-screens)). The
  `first_name` rule for a listed last name is the fourth, and it too decides
  only which values are dropped (see
  [First name beside a listed last name](#first-name-beside-a-listed-last-name)).

### Per-party placeholder lists

The `first_name`, `last_name`, `date_of_birth`, `street_name`, `unit` and
`city` pipelines each end in a placeholder list: a `null_if` whose `values` are
dropped. In the defaults the `first_name` list is the `last_name` list with
twelve values added (see [`first_name`](#first_name)), the `unit` list is the
`street_name` list with one value added (see [`unit`](#unit)), the `city` list
is the `street_name` list (see [`city`](#city)), and each field's list is that
field's own step parameter. An operator may edit any of these
lists in their own standardization, to add a filler their system writes or to
keep a value the list drops. The `first_name` transformation also drops `JOHN` or `JANE` beside
the last name `DOE`, by a rule outside its list that an operator may edit or
remove in the same way (see
[First name beside a listed last name](#first-name-beside-a-listed-last-name)).

Both parties still derive the same pipelines from the defaults. An edit is one
party's own, and it is never sent. It changes no value the pipeline keeps, so it
cannot make two different values equal: a value one party's list drops and the
other's keeps is absent from the first party's keys and matches nothing there.

The other screens are fixed parts of their default pipelines, not per-party
parameters: the single-letter `last_name` screen, the date-of-birth screen for
a year before 1900, the `ssn` and `ssn4` structural, placeholder and
filler-run screens, and the `phone_number` and `zip_code` filler screens. An operator who authors their own pipeline can change any step in it,
these screens included, as for any field.

## When the defaults apply

The defaults are reconstructed when an exchange specification has no
`standardization` block. An authored block is authoritative and replaces them
entirely: there is no per-field merge, no default step is appended to an
authored pipeline, and a linkage field the block leaves uncovered falls back to
the identity transformation over its bound column -- the raw value, unchanged --
not to the pipeline below.

Reconstruction produces one transformation per linkage field, in the order the
terms declare the fields:

- The field's **input column** is resolved by the binding rule shared with the
  dataset builder and the satisfiability pre-flight: absent an authored
  transformation, the first `role: linkage` column whose semantic `type` equals
  the field's type (see
  [Linkage participation](PROTOCOL.md#linkage-participation-the-role-axis)).
  One field is derived when the input has no `role: linkage` column of its
  type: an `ssn4`
  field with no `role: linkage` column of type `ssn4` binds to the first
  `role: linkage` column of type `ssn` (see
  [Last four derived from a full SSN](#last-four-derived-from-a-full-ssn)). A
  field that binds to no column yields no transformation and is reported as
  unsatisfiable before the exchange runs.
- The field's **steps** are the pipeline this document lists for the field's
  semantic type. Every type a linkage field may declare has one, so the
  reconstruction never leaves a matching field uncleaned. The two
  metadata-only types (`identifier` and `other`) have no pipeline and are not
  linkage-field types; a column of either is never hashed into a key.
- An `ssn`, `phone_number` or `email_address` field's transformation also
  states its **`max_people_per_value`**, the limit of the
  [shared-value screen](#shared-value-screens) its pipeline block lists.
- A `first_name` field's transformation also states its
  **`null_if_last_name`**, the
  [rule for a listed last name](#first-name-beside-a-listed-last-name) its
  pipeline block lists.

Two behaviors of the pipelines as a whole are specified elsewhere and apply to
every sequence below: the input value is normalized to Unicode NFC before the
first step (see
[Unicode normalization](../EXCHANGE_REFERENCE.md#unicode-normalization)), and a
step that produces `null` ends the pipeline, excluding the record from every
linkage key that references the field (see
[Null propagation](../EXCHANGE_REFERENCE.md#null-propagation)).

## Per-type pipelines

Each pipeline below is written as the `steps` array of a data standardizing
transformation, in the on-disk snake_case form, beside the
`max_people_per_value` of the three types that state one and the
`null_if_last_name` of `first_name`: pasting one under an
authored transformation for a column of that type reproduces the default
cleaning exactly.

The worked examples give the standardized result for a raw cell value. Both
columns are JSON scalars, so whitespace is visible and `null` is the no-value
result -- the record has no value for this field and is dropped from every
linkage key referencing it.

### `ssn`

```yaml
max_people_per_value: 1
steps:
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "^[0-9 \\-\\x{2010}-\\x{2014}\\x{2212}]*$"
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 9
  - function: filter_regex
    params:
      pattern: "^\\d{9}$"
  - function: filter_regex
    params:
      pattern: "^0{0,2}[1-9]"
  - function: filter_regex
    params:
      pattern: "^(?:[0-578]|6[0-57-9]|66[0-57-9])"
  - function: filter_regex
    params:
      pattern: "^\\d{3}(?:[1-9]\\d|\\d[1-9])"
  - function: filter_regex
    params:
      pattern: "[1-9]\\d{0,3}$"
  - function: null_if
    params:
      values: ["000000000", "111111111", "222222222", "333333333", "444444444", "555555555", "666666666", "777777777", "888888888", "999999999",
        "012345678", "123456789", "234567890", "345678901", "456789012", "567890123", "678901234", "789012345", "890123456", "901234567",
        "876543210", "987654321", "098765432", "109876543", "210987654", "321098765", "432109876", "543210987", "654321098", "765432109",
        "078051120", "219099999", "111223333"]
  - function: replace_regex
    params:
      pattern: "^(?:\\d*9{7}|0{0,2}[1-9]\\d*0{7})\\d*$"
      replacement: ""
  - function: null_if
    params:
      value: ""
```

Result: exactly nine digits.

- **Character screen.** After surrounding whitespace is trimmed, a value
  holding any character other than an ASCII digit, a space or a dash is
  dropped, before any character is removed from it. A dash is the ASCII hyphen
  or one of the Unicode dashes U+2010 to U+2014 and U+2212 (hyphen,
  non-breaking hyphen, figure dash, en dash, em dash, minus sign) that a
  spreadsheet or word processor substitutes for it. This drops a masked value
  (`***-**-8924`, `123-??-8924`), a value holding a non-ASCII digit, and a
  number written with a decimal point (`78051120.0`). Stripped to its remaining
  digits and padded, each would become an `ssn` key on digits other than the
  SSN's.
- **Digits only.** Spaces and dashes are removed, and a cell that cleans to
  empty is dropped.
- **Padding.** A short value is zero-padded to nine, for an SSN stored as a
  number that lost its leading zeros. Anything that is not nine digits after
  padding -- ten digits, say -- is dropped.
- **Area number `000`.** A value whose first three digits are `000` after
  padding is dropped.
- **Numbers never issued.** A value is dropped when its area number (the
  first three digits) is `666` or `900` to `999`, its group number (the next
  two) is `00`, or its serial number (the last four) is `0000`.
- **Placeholders.** A value of one digit repeated nine times is dropped, and
  so is each listed run of consecutive digits and each listed value known to
  be shared by many people.
- **Filler runs.** A value holding seven or more 9s in a row, or seven or more
  0s in a row (unless the area number is `000`), is dropped. The `replace_regex` empties
  such a value and the `null_if` drops the empty result; six in a row are kept.
- **Shared within the file.** A value more than one person in the party's own
  file holds is dropped from every record holding it (see
  [Shared-value screens](#shared-value-screens)).

The area-number rule rests on one Social Security Administration rule: no SSN
is issued with the area number `000`. A value with that area is therefore not
a full SSN but one of two things, and keeping either would make an `ssn` key
matching on fewer digits than the field states:

- A fragment of six digits or fewer, such as a last four, which padding would
  turn into area `000`. A nine-digit SSN stored as a number loses at most two leading zeros, so
  it keeps at least seven digits and is not dropped.
- A value masked with zeros, such as `000-00-8924`. Its last four still reach
  `ssn4` (see [Last four derived from a full SSN](#last-four-derived-from-a-full-ssn)).

The empty-value drop precedes `pad_left` by design: a blank cell padded to
`"000000000"` would be dropped only as a side effect of a later step, the
area-number rule or the placeholder list, so a pipeline an operator authors
without either step would silently reintroduce the blank-cell match.

The other area, group and serial rules are the rest of the SSA structural
rules: the SSA issues no number in area `666` or `900` to `999`, with group
`00`, or with serial `0000`. A value breaking one is not an issued SSN but a
test, made-up or mistyped value, which two parties can hold for two different
people. The `valid_only` constraint the default `ssn` field declares states the
same rules as a data-quality signal reported against the cleaned dataset (see
[Constraints](../EXCHANGE_REFERENCE.md#constraints)).

The placeholder list names every repeated-digit value, including the three
(`000000000`, `666666666`, `999999999`) a structural rule already drops, so a
pipeline an operator authors with the list but without a structural rule still
drops a value of one repeated digit. The other values on the list:

- **Runs of consecutive digits**: the first nine digits of each rotation of
  `0123456789`, from `012345678` to `901234567`, and each of those reversed,
  from `876543210` to `765432109`. Several break a structural rule too and are
  listed for the same reason.
- **`078051120`**, the number printed on the sample card sold in wallets from
  1938 and reported as their own by thousands of people.
- **`219099999`**, another published number.
- **`111223333`**, a number entered by people who do not want to give their
  own.

The `ssn4` derived from an `ssn` column drops a value whose digits are on this
list too (see
[Last four derived from a full SSN](#last-four-derived-from-a-full-ssn)).
These screens are fixed parts of the
default pipeline, not per-party parameters (see
[Per-party placeholder lists](#per-party-placeholder-lists)); an operator who
authors their own pipeline can change any step in it, as for any field.

| Input | Result |
| ----- | ------ |
| `"078-05-1121"` | `"078051121"` |
| `"  078 05 1121  "` | `"078051121"` |
| `"078\u201305\u20131121"` | `"078051121"` |
| `"23456789"` | `"023456789"` |
| `"1234567"` | `"001234567"` |
| `"123456"` | `null` |
| `"***-**-8924"` | `null` |
| `"XXX-XX-8924"` | `null` |
| `"123-??-8924"` | `null` |
| `"1234567\uff18\uff19"` | `null` |
| `"78051120.0"` | `null` |
| `"000-00-8924"` | `null` |
| `"666-12-3456"` | `null` |
| `"900-12-3456"` | `null` |
| `"123-00-4567"` | `null` |
| `"123-45-0000"` | `null` |
| `"222-22-2222"` | `null` |
| `"1234567890"` | `null` |
| `"123-45-6789"` | `null` |
| `"12345678"` | `null` |
| `"876-54-3210"` | `null` |
| `"078-05-1120"` | `null` |
| `"219-09-9999"` | `null` |
| `"111-22-3333"` | `null` |
| `"129-99-9999"` | `null` |
| `"123-99-9999"` | `"123999999"` |
| `"abc"` | `null` |

### `ssn4`

```yaml
steps:
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "^[0-9 \\-\\x{2010}-\\x{2014}\\x{2212}]*$|(?:[0-9][ \\-\\x{2010}-\\x{2014}\\x{2212}]*){4}$"
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 4
  - function: extract_regex
    params:
      pattern: "(\\d{4})$"
  - function: filter_regex
    params:
      pattern: "^\\d{4}$"
  - function: null_if
    params:
      values: ["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999"]
```

Result: exactly four digits. The pipeline accepts either a bare last-four value
or a full nine-digit SSN and takes the trailing four digits in both cases, so a
column holding whole SSNs and one holding only the last four standardize to the
same value once both are declared `ssn4`. A cleaned-empty cell is dropped before
padding, a short value is zero-padded to four, and a value of one digit
repeated four times is dropped: the all-zero serial, which the SSA never
issues, and the nine placeholders beside it. A real SSN whose serial is one
repeated digit, such as `123-45-7777`, therefore loses its `ssn4` value while
its `ssn` value is kept.

After surrounding whitespace is trimmed, and before any character is removed, a
value is kept only in one of two forms:

- It holds nothing but ASCII digits, spaces and dashes (the dashes of the
  [`ssn` character screen](#ssn)). A value of one to three digits is kept as a
  last four that lost its leading zeros.
- It ends in four ASCII digits, spaces and dashes aside. Its mask lies before
  its last four, as in `***-**-8924` or `123-??-8924`, and its last four are
  kept.

Any other value is dropped. It is masked in its last four, by ASCII or
non-ASCII characters as in `078-05-XXXX`, or ends in a non-ASCII digit or a
decimal point, and removing those characters would key it on other digits of
the SSN.

| Input | Result |
| ----- | ------ |
| `"6789"` | `"6789"` |
| `"123-45-6789"` | `"6789"` |
| `"123\u201345\u20136789"` | `"6789"` |
| `"***-**-8924"` | `"8924"` |
| `"XXX-XX-8924"` | `"8924"` |
| `"123-??-8924"` | `"8924"` |
| `"89"` | `"0089"` |
| `"078-05-XXXX"` | `null` |
| `"078-05-\u2022\u2022\u2022\u2022"` | `null` |
| `"XXXX"` | `null` |
| `"1120.0"` | `null` |
| `"0000"` | `null` |
| `"7777"` | `null` |
| `"123-45-7777"` | `null` |
| `"abcd"` | `null` |

#### Last four derived from a full SSN

When the input has no `role: linkage` column of type `ssn4`, the defaults bind
the `ssn4` field to the first `role: linkage` column of type `ssn` and run the
pipeline below over it, beside the `ssn` pipeline over the same column. It is
the `ssn4` pipeline with four steps added after the empty-value drop: the
digits are padded to nine, a value the `ssn` placeholder list names is dropped,
and a value with a filler run is emptied and then dropped.

```yaml
steps:
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "^[0-9 \\-\\x{2010}-\\x{2014}\\x{2212}]*$|(?:[0-9][ \\-\\x{2010}-\\x{2014}\\x{2212}]*){4}$"
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 9
  - function: null_if
    params:
      values: ["000000000", "111111111", "222222222", "333333333", "444444444", "555555555", "666666666", "777777777", "888888888", "999999999",
        "012345678", "123456789", "234567890", "345678901", "456789012", "567890123", "678901234", "789012345", "890123456", "901234567",
        "876543210", "987654321", "098765432", "109876543", "210987654", "321098765", "432109876", "543210987", "654321098", "765432109",
        "078051120", "219099999", "111223333"]
  - function: replace_regex
    params:
      pattern: "^(?:\\d*9{7}|0{0,2}[1-9]\\d*0{7})\\d*$"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 4
  - function: extract_regex
    params:
      pattern: "(\\d{4})$"
  - function: filter_regex
    params:
      pattern: "^\\d{4}$"
  - function: null_if
    params:
      values: ["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999"]
```

A file holding full SSNs and no last-four column therefore supplies `ssn4`.
Each value it keeps equals the one a partner holding only the last four
derives, since the added steps drop values and change none they keep.

The `ssn` placeholder list reaches the derived value: `123-45-6789` and
`078-05-1120` are `null` as `ssn` and as `ssn4`. The list is compared after
padding, as in the `ssn` pipeline, so `12345678` is dropped as `012345678` is.
A masked value keeps its last four: the digits of `***-**-8924` pad to
`000008924`, which the list does not name.

The `ssn` filler runs reach it too: `129-99-9999` and `100-00-0001` are `null`
as `ssn` and as `ssn4`. A run of zeros in an area number of `000` is not a
filler here, since it is the padding of a masked value: `***-**-0001` pads to
`000000001` and keeps `"0001"`.

The other `ssn` screens do not reach it, since the pipeline reads the cell as
written, not the `ssn` result. The `ssn` character screen does not: `***-**-8924`
is `null` as `ssn` and `"8924"` as `ssn4`. Nor does the `ssn` area-number rule:
`000-00-8924` is likewise `null` as `ssn` and `"8924"` as `ssn4`. The `ssn`
rules for numbers never issued do not reach it either: `900-12-3456` is `null`
as `ssn` and `"3456"` as `ssn4`. The shared-value screen on the `ssn` column
reaches it only where the party's own terms set `deduplicate`, whether or not
they declare an `ssn` field (see
[Shared-value screens](#shared-value-screens)).

| Input | Result |
| ----- | ------ |
| `"287-65-4321"` | `"4321"` |
| `"***-**-8924"` | `"8924"` |
| `"000-00-8924"` | `"8924"` |
| `"900-12-3456"` | `"3456"` |
| `"1234567"` | `"4567"` |
| `"123-45-6789"` | `null` |
| `"12345678"` | `null` |
| `"078-05-1120"` | `null` |
| `"111-22-3333"` | `null` |
| `"219-09-9999"` | `null` |
| `"129-99-9999"` | `null` |
| `"100-00-0001"` | `null` |
| `"***-**-0001"` | `"0001"` |

A file with its own `role: linkage` column of type `ssn4` keeps using it, and
nothing is derived. That column runs the `ssn4` pipeline, without the `ssn`
placeholder list, so a full SSN written there keeps its last four, as
`123-45-6789` does in the [`ssn4` table](#ssn4). An `ssn4` column with any other role does not stop the
derivation, so a file that keeps its `ssn4` column out of matching still
supplies `ssn4` keys derived from a matched `ssn` column.

An authored standardization gets no derived binding either: a linkage field it
leaves uncovered falls back to the identity transformation, which over a full
SSN column would hash the whole SSN as its last four. An authored
transformation that binds `ssn4` to an `ssn` column runs the steps the operator
wrote: steps that do not reduce the value to its last four hash more of the
SSN. Rebinding the web inviter's `ssn4` cleaning card to an `ssn` column
replaces the card's steps with this pipeline's, and so does a web acceptor's
rebinding of its `ssn4` field to an `ssn` column. A configuration loaded into the
web inviter or the console keeps its own steps, as the command line runs them.
A second card for an `ssn4`-typed field, named other than `ssn4`, that is
rebound to an `ssn` column is declared with type `ssn` and keeps the steps it
had.

### `first_name`

```yaml
null_if_last_name:
  values: ["JOHN", "JANE"]
  last_names: ["DOE"]
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: replace_separators_with_spaces
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_affixes
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z]"
  - function: null_if
    params:
      values: ["DR", "MISS", "MR", "MRS", "MS", "MX", "PROF", "PROFESSOR", "SIR", "FRAU", "HR", "MONSIEUR", "IND", "MISC"]
  - function: null_if
    params:
      values: ["UNKNOWN", "UNK", "GIRL", "TWIN", "FEMALE", "TRAUMA", "REFUSED", "ANONYMOUS", "NONE", "TEST", "BABY", "BOY", "MALE", "BABY BOY", "BABY GIRL", "BB", "BG", "FNU", "UNKNOWN MALE", "UNKNOWN FEMALE", "TWIN A", "TWIN B"]
```

Result: an uppercase ASCII value whose word separators are single spaces, with
leading honorifics and trailing generational and degree suffixes removed as
[affix removal](#affix-removal) states, matching the
`allowed_characters: "A-Z "` and `affixes_allowed: false` constraints the
default name fields declare.

Order determines the meaning here:

- The three steps between the leading `trim_whitespace` and `remove_non_ascii`
  turn a non-ASCII character into the ASCII one it stands for, so the
  following `remove_non_ascii` does not delete it: `squash_spaces` applies the
  [whitespace fold](#whitespace-fold), `remove_accents` folds an accented
  letter to its base letter -- e-acute becomes `E`, not nothing -- and applies
  the [letter table](#letter-table), and `replace_separators_with_spaces`
  applies the [punctuation map](#punctuation-map). A letter with neither an
  accent to strip nor a table entry (a Greek or Cyrillic character) is deleted
  by `remove_non_ascii`.
- `replace_separators_with_spaces` runs **before** `remove_punctuation` so a
  hyphen, apostrophe, ampersand, slash, or underscore becomes a token boundary
  instead of vanishing: `"O'Brien"` becomes `"O BRIEN"`, not `"OBRIEN"`. Both
  parties must therefore tokenize identically for a hyphenated name to match.
- The second `squash_spaces` collapses the runs of spaces that the separator,
  affix, and punctuation steps leave behind.
- The `filter_regex` on `[A-Z]` drops a value containing no letter at all,
  which is what removes a cell that cleaned to empty or to punctuation alone.
- The `null_if` after it drops a value that is only a title (`"Mr."`,
  `"DR"`, `"Miss"`): `remove_affixes` never empties a field, so a cell holding
  a title alone reaches this step intact. Its values are every word in the
  Titles list under [affix removal](#affix-removal), upper-cased, and none of
  them is a name on its own.
- The closing `null_if` is the placeholder list: it drops a value that is
  exactly one of its `values`, words that stand in for a name nobody recorded.
  It runs on the cleaned value, so `"Unknown"`, `"unknown"` and `"UNK"` are
  each dropped, and so are `"Baby Boy"` and `"B.B."`.
  A name containing one of the values beside another word (`"Baby Jane"`) or
  inside a longer one (`"Boyd"`, `"Babyak"`) is kept.

The `first_name` list is the `last_name` list with twelve values added, each a
whole value a record system writes in place of a first name it does not have:
`BABY`, `BOY` and `MALE`, `BABY BOY` and `BABY GIRL` and their initials `BB` and
`BG`, `UNKNOWN MALE` and `UNKNOWN FEMALE`, `TWIN A` and `TWIN B`, and `FNU`, for
first name unknown.

Each name field has its own placeholder list, and an operator may
edit either one for their own data (see
[Per-party placeholder lists](#per-party-placeholder-lists)). A value is
written in the cleaned form, upper-case ASCII letters and spaces, since that is
the form the list is compared with.

A one-letter first name is kept, unlike a one-letter last name (see
[`last_name`](#last_name)). The built-in keys `SSN + LN + FN1` and
`SSN + LN3 + FN1` match on the first initial beside a full SSN, so a record
holding only an initial matches through them. Every built-in key on the whole
first name, such as `LN + FN + DOB`, drops a one-letter first name with a
`filter_regex` step on its own first-name element, so a record holding only an
initial matches through keys on part of the first name, such as
`SSN + LN + FN1`, and not through these.

Digits are not punctuation and are not removed: a value containing one keeps
it.

| Input | Result |
| ----- | ------ |
| `"  Jose  "` | `"JOSE"` |
| `"Dr. Mary-Jane"` | `"MARY JANE"` |
| `"O'Brien"` | `"O BRIEN"` |
| `"O\u2019Brien"` | `"O BRIEN"` |
| `"Smith\u2010Jones"` | `"SMITH JONES"` |
| `"Mary\u00a0Jane"` | `"MARY JANE"` |
| `"Mary \u2003\u00a0 Jane"` | `"MARY JANE"` |
| `"Mary\r\nJane"` | `"MARY JANE"` |
| `"Mary\tJane"` | `"MARY JANE"` |
| `"Ann_Marie"` | `"ANN MARIE"` |
| `"\u0141ucja"` | `"LUCJA"` |
| `"Jo"` | `"JO"` |
| `"Jane Doe"` | `"JANE DOE"` |
| `"Doering"` | `"DOERING"` |
| `"Doe"` | `"DOE"` |
| `"Baby Jane"` | `"BABY JANE"` |
| `"Boyd"` | `"BOYD"` |
| `"Babyak"` | `"BABYAK"` |
| `"J."` | `"J"` |
| `"Unknown"` | `null` |
| `"baby"` | `null` |
| `"Baby Boy"` | `null` |
| `"B.B."` | `null` |
| `"Unknown Female"` | `null` |
| `"Twin A"` | `null` |
| `"FNU"` | `null` |
| `"5"` | `null` |
| `"   "` | `null` |

#### First name beside a listed last name

`null_if_last_name` drops the cleaned first name of a record whose cleaned last
name is listed: by default the first name `JOHN` or `JANE` beside the last name
`DOE`. The record keeps its other fields, so it matches only on the keys
without a first name. The Census Bureau's Person Identification Validation
System keeps John and Jane Doe as names but sets stricter matching
requirements for them; this rule makes the matching stricter by dropping the
first name.

The rule is not a step, because it reads a second field and a step reads one
value. It compares whole cleaned values, as a `null_if` list does: `JOHN`
beside `DOE` is dropped, while `JOHNNY` or `JOHN Q` beside `DOE`, and `JOHN`
beside `DOER` or `DOE SMITH`, are kept.

The last name is read from the party's first `role: linkage` column of type
`last_name`, whether or not the terms declare a field of that type. It is
cleaned by the party's own transformation for a `last_name` field reading that
column where its standardization has one, and otherwise by the default
[`last_name`](#last_name) pipeline. A file with no such column drops nothing by
this rule.

Like a placeholder list, the rule is the party's own: an operator may edit
either list or remove the rule in their own standardization, and it is never
sent. It drops a value and changes none it keeps, so it cannot make two
different values equal. The shared-value screens count people by the first
name before this rule, and a coverage count taken record by record before the
run does not apply it.

#### Whitespace fold

`squash_spaces` replaces every run of characters with the Unicode
`White_Space` property by one ASCII space (U+0020). The property includes the
ASCII tab, line feed, vertical tab, form feed, and carriage return, the next
line control U+0085, the no-break space U+00A0, and the Unicode space
separators (U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000). A
lone character folds as well as a run, so `"Mary"`, a no-break space, and
`"Jane"` standardize to `"MARY JANE"`, the value a partner who typed an
ordinary space produces. The zero-width no-break space U+FEFF is not
`White_Space` and is not folded; `remove_non_ascii` deletes it.

#### Punctuation map

`replace_separators_with_spaces` treats each typographic apostrophe and dash
below exactly as it treats the ASCII character it stands for: it becomes a
space, splitting the word there. O'Brien typed with U+2019 and Smith-Jones
typed with U+2010 standardize to the same values as `"O'Brien"` and
`"Smith-Jones"`.

| Characters | ASCII equivalent |
| ---------- | ---------------- |
| U+2018, U+2019, U+201B, U+02BC, U+FF07 | apostrophe `'` |
| U+2010-U+2015, U+2212, U+FE58, U+FE63, U+FF0D | hyphen `-` |

Other typographic punctuation (curly double quotes, for instance) has no
entry; `remove_non_ascii` deletes it without splitting the word.

#### Letter table

`remove_accents` spells out the Latin letters below, which have no canonical
decomposition and so no accent for the diacritic strip to remove. Each maps to
the ASCII spelling a writer without the letter conventionally uses; the
lowercase letter maps to the same spelling in lowercase. After `to_upper_case`
a name pipeline holds the uppercase spelling either way.

| Uppercase | Lowercase | Maps to |
| --------- | --------- | ------- |
| U+1E9E (capital sharp s) | U+00DF (sharp s) | `SS` / `ss` |
| U+00C6 (ash) | U+00E6 | `AE` / `ae` |
| U+0152 (ethel) | U+0153 | `OE` / `oe` |
| U+00DE (thorn) | U+00FE | `TH` / `th` |
| U+0141 (L with stroke) | U+0142 | `L` / `l` |
| U+00D8 (O with stroke) | U+00F8 | `O` / `o` |
| U+0110 (D with stroke) | U+0111 | `D` / `d` |
| U+00D0 (eth) | U+00F0 | `D` / `d` |

### `last_name`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: replace_separators_with_spaces
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_affixes
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z]"
  - function: null_if
    params:
      values: ["DR", "MISS", "MR", "MRS", "MS", "MX", "PROF", "PROFESSOR", "SIR", "FRAU", "HR", "MONSIEUR", "IND", "MISC"]
  - function: filter_regex
    params:
      pattern: "^.{2,}$"
  - function: null_if
    params:
      values: ["UNKNOWN", "UNK", "GIRL", "TWIN", "FEMALE", "TRAUMA", "REFUSED", "ANONYMOUS", "NONE", "TEST"]
```

The `last_name` sequence is the `first_name` sequence with one step added, the
`filter_regex` on `^.{2,}$` before the placeholder list, and a shorter
placeholder list (below); the notes under [`first_name`](#first_name) on the
other steps apply unchanged. The added step drops a value of one
character. Every such value left at this point is a letter, so it drops an
initial written in place of a surname (`"Q"`, `"Q."`). The two are listed
separately because they are two independent defaults: a change to one is not
automatically a change to the other.

The placeholder list is the `first_name` list without the twelve values that
list adds. Neither list drops `DOE`, and the `last_name` list keeps `BABY`,
`BOY` and `MALE`: each is a surname as well as a placeholder.

| Input | Result |
| ----- | ------ |
| `"van der Berg"` | `"VAN DER BERG"` |
| `"Smith Jr."` | `"SMITH"` |
| `"Alesund"` | `"ALESUND"` |
| `"\u00d8stergaard"` | `"OSTERGAARD"` |
| `"Gro\u00df"` | `"GROSS"` |
| `"Doe"` | `"DOE"` |
| `"Baby Boy"` | `"BABY BOY"` |
| `"Baby"` | `"BABY"` |
| `"Boy"` | `"BOY"` |
| `"Male"` | `"MALE"` |
| `"Refused"` | `null` |
| `"Q"` | `null` |
| `"!!!"` | `null` |

#### Affix removal

`remove_affixes` strips a title or suffix only at an edge of the value, so a
surname that is also an affix word is kept: `"Judge"` stays `"JUDGE"`,
`"Van Der Herr"` stays `"VAN DER HERR"`, and `"Md Rahman"` stays
`"MD RAHMAN"`. The rule, identical for both name fields:

- The value is split into words at runs of whitespace, and the kept words are
  rejoined with one space.
- Titles are stripped only as one or more leading words, each followed by
  another word. A title word may end in a period (`"Dr."`); a title joined to
  the next word by a period (`"Dr.Smith"`) is stripped from that word.
- Suffixes are stripped only as one or more trailing words, each preceded by
  another word. A suffix word may end in a period, a comma, or both
  (`"Jr.,"`); a comma ending the preceding word (`"Smith, Jr."`) is left to
  `remove_punctuation`.
- Titles are stripped before suffixes, and neither pass strips the last
  remaining word, so affix removal never empties a field: `"Mr Iv"` becomes
  `"IV"`. A value that is only one of the titles below, any of them, is
  dropped by the pipeline's trailing `null_if` instead; a value that is only a
  suffix is kept.
- Matching is case-insensitive.

| List | Words |
| ---- | ----- |
| Titles | dr, miss, mr, mrs, ms, mx, prof, professor, sir, frau, hr, monsieur, ind, misc |
| Suffixes | esq, esquire, jr, jnr, junior, sr, snr, senior, 2, 2nd, 3rd, 4th, ii, iii, iv, md, phd, j.d, ll.m, m.d, d.o, d.c, p.c, ph.d |

Neither list holds a word common as a surname or given name on its own -- the
occupational titles judge, doctor, officer, and captain, the title herr, the single-letter
numerals i, v, and x, or the kinship and religious titles sister, brother, and
father. A title or suffix word in the middle of the value is always kept.

| Input | Result |
| ----- | ------ |
| `"Judge"` | `"JUDGE"` |
| `"O'Judge"` | `"O JUDGE"` |
| `"Judge-Smith"` | `"JUDGE SMITH"` |
| `"Smith, Jr."` | `"SMITH"` |
| `"Smith Jr III"` | `"SMITH"` |
| `"Mr Smith Jr"` | `"SMITH"` |
| `"Smith Ph.D."` | `"SMITH"` |
| `"Sir John"` | `"JOHN"` |
| `"Mr"` | `null` |
| `"Sir."` | `null` |
| `"Monsieur"` | `null` |
| `"Jr"` | `"JR"` |

### `date_of_birth`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: parse_date
    params:
      input_format: "MM/DD/YYYY"
      output_format: "YYYYMMDD"
  - function: filter_regex
    params:
      pattern: "^(?:19|[2-9])"
  - function: null_if
    params:
      values: ["19000101", "19010101"]
```

Result: eight digits, `YYYYMMDD`, for a date in 1900 or later. A value the
input format cannot parse is dropped, as is one that parses to a date the
calendar does not have; the normative parsing, two-digit-year, and
calendar-check rules are in
[PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect).

Two screens follow the parse, on the `YYYYMMDD` value:

- **Before 1900.** The `filter_regex` drops a date whose year is before 1900,
  taken as a typing error or a filler rather than a birth date.
- **Placeholders.** The closing `null_if` is the placeholder list. Its default
  values, `19000101` and `19010101` (1900-01-01 and 1901-01-01), are dates a
  system writes when a birth date is unknown. A value is written in the
  `YYYYMMDD` output form, since that is the form the list is compared with.
  An operator may edit the list for their own data (see
  [Per-party placeholder lists](#per-party-placeholder-lists)).

A date after the day of the run is kept. Deciding which dates lie in the future
would need the date of the run, and cleaning reads no clock: the two-digit-year
pivot under `parse_date` is a constant for the same reason, so that both
parties derive the same value from the same cell whenever each runs.

`output_format` is fixed at `YYYYMMDD` -- it is the cross-party canonical form,
and changing it changes every date key. `input_format` is the one default
parameter that varies per party without an operator's edit.

#### Filler dates

A cleaned date whose month and day are both `01` (`YYYY0101`) is a filler: a
system writes 1 January for an unknown month and day, and some assign 1 January
of a birth decade. It is kept rather than dropped, since it is also a real
birth date for some people, and marked:

- No key element reads it, so no key built on the date of birth matches it,
  the one-year, one-day and day/month expansions included: a partner's
  `19800102` expanded by one day does not meet this party's `19800101`.
- A [missing-field condition](PROTOCOL.md#keys-with-a-missing-field-condition)
  counts it as missing, so the record takes part in a key that accepts a
  missing date of birth.
- The cleaned value stays in the field, so the
  [shared-value screens](#shared-value-screens) still read it as part of a
  person.

The mark is applied when the keys are built, to every `date_of_birth` field
whatever pipeline cleaned it, and it is not a step an operator can remove.
It reads the cleaned value in the `YYYYMMDD` form, so a party whose own
cleaning writes another form marks nothing.

#### Date-format inference

`MM/DD/YYYY` is the value used when no format is supplied. An exchange that
authors no `standardization` supplies one instead: it infers the layout from
the values of the first `role: linkage` `date_of_birth` column, the column the
field binds to, so a file written `YYYY-MM-DD` is parsed as written rather than
dropped wholesale. A front end that writes the default standardization out for
its operator -- the CLI's `init` and invite paths, the web editors, the
console -- infers from that same column, so a column the operator retypes as
the date of birth is parsed with its own layout.

Inference scans the column's non-empty values, up to the scan cap, and tests
each against every candidate in the table below. A candidate parses a value
when the parsing steps of the `date_of_birth` pipeline above, with that
candidate as their `input_format`, produce a date from the value. The screens
that follow those steps do not take part, so a date before 1900 or on the
default placeholder list still counts for the candidate that reads it, and the
format inferred for a column is the same with or without the screens. The run
then drops such a date.

- The result is the candidate that parses the most scanned values. On a tie
  the earlier candidate in the table's order wins: a column whose days are all
  12 or under is parsed equally by `MM/DD/YYYY` and `DD/MM/YYYY`, and
  `MM/DD/YYYY` wins.
- A value no candidate parses is noise and counts for none.
- The result must parse more than half of the scanned values some candidate
  parses. A few mistyped values -- a three-digit year, a two-digit year, a
  day-first date -- therefore cannot choose the format, and a column split
  evenly between two layouts yields none.

Inference yields nothing for an empty column, one whose every value is noise,
or one no candidate parses a majority of, and the pipeline then keeps the
`MM/DD/YYYY` above. The same fallback applies when the input declares no
`role: linkage` `date_of_birth` column.

| Parameter | Value |
| --------- | ----- |
| Candidate input formats, in tie-break order | `MM/DD/YYYY`, `YYYY-MM-DD`, `YYYYMMDD`, `MM-DD-YYYY`, `MM/DD/YY`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY` |
| Maximum non-empty values scanned | `1000` |

Because the inferred format only tells the parser how to read this party's own
file, and every candidate produces the same `YYYYMMDD` output, two parties
holding differently formatted dates still derive identical keys, provided each
party's format is inferred correctly. A `DD/MM/YYYY` column whose days are all
12 or under ties and infers `MM/DD/YYYY`, so every date in it is read with day
and month swapped and does not match the partner's value for the same date. The
examples below use the `MM/DD/YYYY` default.

| Input | Result |
| ----- | ------ |
| `"01/02/1990"` | `"19900102"` |
| `"1/2/1990"` | `"19900102"` |
| `"1990-01-02"` | `null` |
| `"02/30/1990"` | `null` |
| `"01/02/1900"` | `"19000102"` |
| `"12/31/1899"` | `null` |
| `"01/01/1900"` | `null` |
| `"1/1/1901"` | `null` |
| `"01/01/1985"` | `"19850101"` |

### `phone_number`

```yaml
max_people_per_value: 5
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: replace_regex
    params:
      pattern: "^1(\\d{10})$"
      replacement: "$1"
  - function: filter_regex
    params:
      pattern: "^\\d{10}$"
  - function: replace_regex
    params:
      pattern: "^\\d*(?:9{7}|0{7})\\d*$"
      replacement: ""
  - function: null_if
    params:
      value: ""
```

Result: exactly ten digits. Formatting characters are removed, a leading US
country code on an eleven-digit number is stripped, and anything that is not
ten digits afterwards is dropped. The pipeline assumes the North American
ten-digit form: an international number of another length is dropped rather
than normalized, and no country other than `1` is recognized.

A ten-digit value holding seven or more 9s in a row, or seven or more 0s in a
row, is dropped as a filler such as `999-999-9999`. The `replace_regex` empties
such a value and the `null_if` drops the empty result; six in a row are kept.

A number more than five people in the party's own file hold is dropped from
every record holding it (see [Shared-value screens](#shared-value-screens)).

| Input | Result |
| ----- | ------ |
| `"(202) 555-0123"` | `"2025550123"` |
| `"+1 202 555 0123"` | `"2025550123"` |
| `"12025550123"` | `"2025550123"` |
| `"555-0123"` | `null` |
| `"999-999-9999"` | `null` |
| `"000-000-0000"` | `null` |
| `"202-999-9999"` | `null` |
| `"202-000-0000"` | `null` |
| `"202-099-9999"` | `"2020999999"` |

### `email_address`

```yaml
max_people_per_value: 5
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: to_lower_case
  - function: filter_regex
    params:
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
```

Result: a lowercased address of the shape `local@domain.tld`. The filter is a
shape test, not a validator: it requires one `@` with a dotted right-hand side
and no whitespace, and admits addresses no mail system would accept. The
engine's `\s` does not match a vertical tab (U+000B), so an address holding one
passes the filter. An address more than five people in the party's own file
hold is dropped from every record holding it (see
[Shared-value screens](#shared-value-screens)).

`remove_non_ascii` precedes the filter, so a non-ASCII character in an address
is deleted rather than causing the value to be dropped -- an internationalized
address is truncated to its ASCII characters. Both parties do the same, so such
an address still matches itself; it does not match a partner's copy that was
already stored in an ASCII form.

| Input | Result |
| ----- | ------ |
| `"  Jane.Doe@Example.COM  "` | `"jane.doe@example.com"` |
| `"a@b.c"` | `"a@b.c"` |
| `"not-an-email"` | `null` |

### `street_number`

```yaml
steps:
  - function: trim_whitespace
  - function: extract_regex
    params:
      pattern: "^0*([1-9][0-9]*)"
```

Result: the house number the value starts with, as ASCII digits with no
leading zero. The column can hold the number alone or a whole address line.
Either way the number is the run of digits at the start of the trimmed value,
and it ends at the first character that is not a digit. A value that does not
start with a digit is dropped, which drops a PO box, a rural route, and a
number written after a sign, such as `#12`. A digit outside ASCII `0`-`9`,
such as a fullwidth digit, is not read as one.

The rules for the number:

- Leading zeros are removed, so `0042 Elm` and `42 Elm` agree. A house number
  is a count, not a fixed-width code like a ZIP, and a file that pads it to a
  fixed width would otherwise match no party that does not.
- A number made only of zeros is dropped, as a placeholder rather than a house
  number.
- A unit or letter after the number is not part of it: `123-B Main St`,
  `123B Main St` and `123 Main St Apt 4` all clean to `123`.
- A range keeps its first number: `123-125 Main` cleans to `123`, so a party
  recording the range agrees with one recording the building's first number.
- A fraction is dropped: `123 1/2 Main` cleans to `123`, so it agrees with a
  party that leaves the fraction out, and `123` and `123 1/2` are not told
  apart.
- A hyphenated house number, such as `37-12 75th St` in Queens, follows the
  range rule and cleans to `37`. It agrees with a party writing `37-12` but not
  with one writing `3712`.
- A grid address that starts with a letter, such as `N6W23001`, is dropped.

The type is inferred only from a number-named column
([Type inference from column names](#type-inference-from-column-names)). An
address-line column such as `address`, `street_address` or `address1` infers
nothing; typing it `street_number` in its metadata matches on the number it
starts with.

| Input | Result |
| ----- | ------ |
| `"123"` | `"123"` |
| `"123 Main St Apt 4"` | `"123"` |
| `"123-B Main St"` | `"123"` |
| `"  0042 Elm"` | `"42"` |
| `"100 Elm"` | `"100"` |
| `"123-125 Main"` | `"123"` |
| `"123 1/2 Main"` | `"123"` |
| `"0"` | `null` |
| `"PO Box 12"` | `null` |
| `"Main St"` | `null` |
| `""` | `null` |

### `street_name`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: replace_regex
    params:
      pattern: "[\\-\\x{2010}-\\x{2015}\\x{2212}]"
      replacement: " "
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z0-9]"
  - function: usps_street_name
  - function: null_if
    params:
      values: ["UNKNOWN", "UNK", "NONE"]
```

Result: the street name in uppercase, its words separated by single spaces,
with punctuation removed and its suffix and directionals written in their USPS
Publication 28 forms. The steps before `usps_street_name` are those of
[`city`](#city) before its placeholder list:

- An accented letter becomes its base letter, so a name written with an
  n-tilde agrees with one written with a plain n.
- A hyphen or typographic dash becomes a space, so `Wilkes-Barre Blvd` and
  `Wilkes Barre Blvd` agree.
- Other punctuation is deleted, so `Mary's Rd` and `Marys Rd` agree.
- A value left with no letter or digit, a blank or all-punctuation value, is
  dropped.

`usps_street_name` then writes the suffix and the directionals as the
[street name abbreviations](#street-name-abbreviations) below state, so
`Main Street` and `Main St` agree, as do `North Main St` and `N Main St`. A
numbered name is kept as written, as the standard keeps it: `Fifth Ave` and
`5th Ave` stay different.

The closing `null_if` is the placeholder list (see
[Per-party placeholder lists](#per-party-placeholder-lists)). `UNKNOWN` is the
value the ONC Project US@ Technical Specification writes for an address part
nobody recorded, and says not to match on. `UNK` and `NONE` are the words the
name lists drop for a value nobody recorded.

The pipeline expects the street name alone. A whole address line typed
`street_name` keeps its house number and unit, so its last word is not read as
a suffix, and it agrees only with a party whose column contains the same parts.

The type is inferred from `street_name` and `streetname`
([Type inference from column names](#type-inference-from-column-names)). A
column named `street`, which often contains a whole address line, infers
nothing.

| Input | Result |
| ----- | ------ |
| `"Main St"` | `"MAIN ST"` |
| `"  main   st. "` | `"MAIN ST"` |
| `"N. Main St."` | `"N MAIN ST"` |
| `"Martin Luther King Jr. Blvd"` | `"MARTIN LUTHER KING JR BLVD"` |
| `"Wilkes-Barre Blvd"` | `"WILKES BARRE BLVD"` |
| `"Calle Pe\u00f1a"` | `"CALLE PENA"` |
| `"Fifth Ave"` | `"FIFTH AVE"` |
| `"Unknown"` | `null` |
| `"..."` | `null` |
| `""` | `null` |

#### Street name abbreviations

`usps_street_name` writes a street name's suffix and directionals in the forms
of USPS Publication 28, as the ONC Project US@ Technical Specification v1.0
applies it to a street address line. It splits the value into words at runs of
whitespace, compares each word in any ASCII letter case, and rejoins the words
with one space. A word it does not rewrite is kept as written.

It reads each word by its position, in this order:

1. Two directional words that start or end the value and combine are read as
   one directional: `NORTH` or `SOUTH` followed by `EAST` or `WEST`, each
   spelled out or abbreviated, is the two-letter directional, so `NORTH E` is
   `NE`. `NORTH SOUTH` and `EAST WEST` do not combine.
2. A directional that ends the value, after at least one other word, is the
   postdirectional, and is abbreviated.
3. A suffix form that ends what remains, after at least one other word, is the
   suffix, and is written as its row's abbreviation.
4. A directional that starts what remains, before at least one other word, is
   the predirectional, and is abbreviated.
5. The words left are the street name. A name of one word that is a
   directional or a suffix form is spelled out. In a longer name, a directional
   right after the predirectional is spelled out, and so is the word right
   before the suffix where it is a directional or a suffix form. Every other
   word is kept.

A directional is spelled out as its word and abbreviated as its abbreviation in
the [directional table](#directionals). A suffix form is spelled out as its
row's suffix name and abbreviated as its row's abbreviation in the
[suffix table](#street-suffixes). A form two rows list is read by the first
row listing it: `MDW`, a form of `MEADOWS` and the abbreviation of `MEADOW`,
stays `MDW`, and `PKWY` is spelled out as `PARKWAY`.

| Input | Result | Rule |
| ----- | ------ | ---- |
| `"Main Street"` | `"MAIN ST"` | A suffix form ending the name is abbreviated. |
| `"St. Mary's Rd"` | `"ST MARYS RD"` | A suffix form elsewhere is kept. |
| `"North Bay Street"` | `"N BAY ST"` | A leading directional is abbreviated. |
| `"Bay Drive West"` | `"BAY DR W"` | A trailing directional is abbreviated. |
| `"North E. Main Street"` | `"NE MAIN ST"` | Two leading directionals that combine are one. |
| `"Main St North East"` | `"MAIN ST NE"` | Two trailing directionals that combine are one. |
| `"East-West Hwy"` | `"E WEST HWY"` | Of `EAST WEST` or `NORTH SOUTH`, the second is part of the name, spelled out. |
| `"Bay W. Drive"` | `"BAY WEST DR"` | A directional between the name and the suffix is part of the name, spelled out. |
| `"North Avenue"` | `"NORTH AVE"` | A directional that is the whole name is spelled out. |
| `"N. Ave"` | `"NORTH AVE"` | A directional that is the whole name is spelled out. |
| `"Southeast Freeway North"` | `"SOUTHEAST FWY N"` | A directional that is the whole name is spelled out. |
| `"Main Avenue Drive"` | `"MAIN AVENUE DR"` | Of two suffix forms, the first is part of the name, spelled out. |
| `"Main Ave. Dr."` | `"MAIN AVENUE DR"` | Of two suffix forms, the first is part of the name, spelled out. |
| `"Ave. E"` | `"AVENUE E"` | A suffix form that is the whole name is spelled out. |
| `"E 1700 S"` | `"E 1700 S"` | A numbered name keeps the directionals on either side. |
| `"Avenue of the Americas"` | `"AVENUE OF THE AMERICAS"` | A value ending in no suffix form keeps its other words. |

Where the standard decides from the street itself, this reading decides by
position alone, the same way for both parties:

- A one-letter street name that is also a directional is read as the
  directional: `N St NW` cleans to `NORTH ST NW`, which still matches itself.
- Highway names, which the Project US@ specification writes from a separate
  table (its Appendix C), are not rewritten: `Hwy 64` and `Highway 64` stay
  different, and the `ROAD` of `County Road N East` is abbreviated as a suffix,
  to `COUNTY RD NE`.
- A suffix form in another position is never rewritten, so `Mt Vernon Ave` and
  `Mount Vernon Ave`, and `St Charles Ave` and `Saint Charles Ave`, stay
  different.
- A Spanish directional is not translated, so `Calle 3 NO` is kept as it is.

#### Directionals

| Directional | Abbreviation |
| ----------- | ------------ |
| `NORTH` | `N` |
| `SOUTH` | `S` |
| `EAST` | `E` |
| `WEST` | `W` |
| `NORTHEAST` | `NE` |
| `NORTHWEST` | `NW` |
| `SOUTHEAST` | `SE` |
| `SOUTHWEST` | `SW` |

#### Street suffixes

The street suffix table of USPS Publication 28, as Appendix B of the Project
US@ Technical Specification v1.0 reproduces it, row for row and in its order:
the primary street suffix name, the forms commonly written for it, and its
standard abbreviation. A row's suffix name and abbreviation are forms of it as
well.

| Suffix name | Forms | Abbreviation |
| ----------- | ----- | ------------ |
| `ALLEY` | `ALLEE`, `ALLEY`, `ALLY`, `ALY` | `ALY` |
| `ANEX` | `ANEX`, `ANNEX`, `ANNX`, `ANX` | `ANX` |
| `ARCADE` | `ARC`, `ARCADE` | `ARC` |
| `AVENUE` | `AV`, `AVE`, `AVEN`, `AVENU`, `AVENUE`, `AVN`, `AVNUE` | `AVE` |
| `BAYOU` | `BAYOO`, `BAYOU` | `BYU` |
| `BEACH` | `BCH`, `BEACH` | `BCH` |
| `BEND` | `BEND`, `BND` | `BND` |
| `BLUFF` | `BLF`, `BLUF`, `BLUFF` | `BLF` |
| `BLUFFS` | `BLUFFS` | `BLFS` |
| `BOTTOM` | `BOT`, `BTM`, `BOTTM`, `BOTTOM` | `BTM` |
| `BOULEVARD` | `BLVD`, `BOUL`, `BOULEVARD`, `BOULV` | `BLVD` |
| `BRANCH` | `BR`, `BRNCH`, `BRANCH` | `BR` |
| `BRIDGE` | `BRDGE`, `BRG`, `BRIDGE` | `BRG` |
| `BROOK` | `BRK`, `BROOK` | `BRK` |
| `BROOKS` | `BROOKS` | `BRKS` |
| `BURG` | `BURG` | `BG` |
| `BURGS` | `BURGS` | `BGS` |
| `BYPASS` | `BYP`, `BYPA`, `BYPAS`, `BYPASS`, `BYPS` | `BYP` |
| `CAMP` | `CAMP`, `CP`, `CMP` | `CP` |
| `CANYON` | `CANYN`, `CANYON`, `CNYN` | `CYN` |
| `CAPE` | `CAPE`, `CPE` | `CPE` |
| `CAUSEWAY` | `CAUSEWAY`, `CAUSWA`, `CSWY` | `CSWY` |
| `CENTER` | `CEN`, `CENT`, `CENTER`, `CENTR`, `CENTRE`, `CNTER`, `CNTR`, `CTR` | `CTR` |
| `CENTERS` | `CENTERS` | `CTRS` |
| `CIRCLE` | `CIR`, `CIRC`, `CIRCL`, `CIRCLE`, `CRCL`, `CRCLE` | `CIR` |
| `CIRCLES` | `CIRCLES` | `CIRS` |
| `CLIFF` | `CLF`, `CLIFF` | `CLF` |
| `CLIFFS` | `CLFS`, `CLIFFS` | `CLFS` |
| `CLUB` | `CLB`, `CLUB` | `CLB` |
| `COMMON` | `COMMON` | `CMN` |
| `COMMONS` | `COMMONS` | `CMNS` |
| `CORNER` | `COR`, `CORNER` | `COR` |
| `CORNERS` | `CORNERS`, `CORS` | `CORS` |
| `COURSE` | `COURSE`, `CRSE` | `CRSE` |
| `COURT` | `COURT`, `CT` | `CT` |
| `COURTS` | `COURTS`, `CTS` | `CTS` |
| `COVE` | `COVE`, `CV` | `CV` |
| `COVES` | `COVES` | `CVS` |
| `CREEK` | `CREEK`, `CRK` | `CRK` |
| `CRESCENT` | `CRESCENT`, `CRES`, `CRSENT`, `CRSNT` | `CRES` |
| `CREST` | `CREST` | `CRST` |
| `CROSSING` | `CROSSING`, `CRSSNG`, `XING` | `XING` |
| `CROSSROAD` | `CROSSROAD` | `XRD` |
| `CROSSROADS` | `CROSSROADS` | `XRDS` |
| `CURVE` | `CURVE` | `CURV` |
| `DALE` | `DALE`, `DL` | `DL` |
| `DAM` | `DAM`, `DM` | `DM` |
| `DIVIDE` | `DIV`, `DIVIDE`, `DV`, `DVD` | `DV` |
| `DRIVE` | `DR`, `DRIV`, `DRIVE`, `DRV` | `DR` |
| `DRIVES` | `DRIVES` | `DRS` |
| `ESTATE` | `EST`, `ESTATE` | `EST` |
| `ESTATES` | `ESTATES`, `ESTS` | `ESTS` |
| `EXPRESSWAY` | `EXP`, `EXPR`, `EXPRESS`, `EXPRESSWAY`, `EXPW`, `EXPY` | `EXPY` |
| `EXTENSION` | `EXT`, `EXTENSION`, `EXTN`, `EXTNSN` | `EXT` |
| `EXTENSIONS` | `EXTS` | `EXTS` |
| `FALL` | `FALL` | `FALL` |
| `FALLS` | `FALLS`, `FLS` | `FLS` |
| `FERRY` | `FERRY`, `FRRY`, `FRY` | `FRY` |
| `FIELD` | `FIELD`, `FLD` | `FLD` |
| `FIELDS` | `FIELDS`, `FLDS` | `FLDS` |
| `FLAT` | `FLAT`, `FLT` | `FLT` |
| `FLATS` | `FLATS`, `FLTS` | `FLTS` |
| `FORD` | `FORD`, `FRD` | `FRD` |
| `FORDS` | `FORDS` | `FRDS` |
| `FOREST` | `FOREST`, `FORESTS`, `FRST` | `FRST` |
| `FORGE` | `FORG`, `FORGE`, `FRG` | `FRG` |
| `FORGES` | `FORGES` | `FRGS` |
| `FORK` | `FORK`, `FRK` | `FRK` |
| `FORKS` | `FORKS`, `FRKS` | `FRKS` |
| `FORT` | `FORT`, `FRT`, `FT` | `FT` |
| `FREEWAY` | `FREEWAY`, `FREEWY`, `FRWAY`, `FRWY`, `FWY` | `FWY` |
| `GARDEN` | `GARDEN`, `GARDN`, `GRDEN`, `GRDN` | `GDN` |
| `GARDENS` | `GARDENS`, `GDNS`, `GRDNS` | `GDNS` |
| `GATEWAY` | `GATEWAY`, `GATEWY`, `GATWAY`, `GTWAY`, `GTWY` | `GTWY` |
| `GLEN` | `GLEN`, `GLN` | `GLN` |
| `GLENS` | `GLENS` | `GLNS` |
| `GREEN` | `GREEN`, `GRN` | `GRN` |
| `GREENS` | `GREENS` | `GRNS` |
| `GROVE` | `GROV`, `GROVE`, `GRV` | `GRV` |
| `GROVES` | `GROVES` | `GRVS` |
| `HARBOR` | `HARB`, `HARBOR`, `HARBR`, `HBR`, `HRBOR` | `HBR` |
| `HARBORS` | `HARBORS` | `HBRS` |
| `HAVEN` | `HAVEN`, `HVN` | `HVN` |
| `HEIGHTS` | `HT`, `HTS` | `HTS` |
| `HIGHWAY` | `HIGHWAY`, `HIGHWY`, `HIWAY`, `HIWY`, `HWAY`, `HWY` | `HWY` |
| `HILL` | `HILL`, `HL` | `HL` |
| `HILLS` | `HILLS`, `HLS` | `HLS` |
| `HOLLOW` | `HLLW`, `HOLLOW`, `HOLLOWS`, `HOLW`, `HOLWS` | `HOLW` |
| `INLET` | `INLT` | `INLT` |
| `ISLAND` | `IS`, `ISLAND`, `ISLND` | `IS` |
| `ISLANDS` | `ISLANDS`, `ISLNDS`, `ISS` | `ISS` |
| `ISLE` | `ISLE`, `ISLES` | `ISLE` |
| `JUNCTION` | `JCT`, `JCTION`, `JCTN`, `JUNCTION`, `JUNCTN`, `JUNCTON` | `JCT` |
| `JUNCTIONS` | `JCTNS`, `JCTS`, `JUNCTIONS` | `JCTS` |
| `KEY` | `KEY`, `KY` | `KY` |
| `KEYS` | `KEYS`, `KYS` | `KYS` |
| `KNOLL` | `KNL`, `KNOL`, `KNOLL` | `KNL` |
| `KNOLLS` | `KNLS`, `KNOLLS` | `KNLS` |
| `LAKE` | `LK`, `LAKE` | `LK` |
| `LAKES` | `LKS`, `LAKES` | `LKS` |
| `LAND` | `LAND` | `LAND` |
| `LANDING` | `LANDING`, `LNDG`, `LNDNG` | `LNDG` |
| `LANE` | `LANE`, `LN` | `LN` |
| `LIGHT` | `LGT`, `LIGHT` | `LGT` |
| `LIGHTS` | `LIGHTS` | `LGTS` |
| `LOAF` | `LF`, `LOAF` | `LF` |
| `LOCK` | `LCK`, `LOCK` | `LCK` |
| `LOCKS` | `LCKS`, `LOCKS` | `LCKS` |
| `LODGE` | `LDG`, `LDGE`, `LODG`, `LODGE` | `LDG` |
| `LOOP` | `LOOP`, `LOOPS` | `LOOP` |
| `MALL` | `MALL` | `MALL` |
| `MANOR` | `MNR`, `MANOR` | `MNR` |
| `MANORS` | `MANORS`, `MNRS` | `MNRS` |
| `MEADOW` | `MEADOW` | `MDW` |
| `MEADOWS` | `MDW`, `MDWS`, `MEADOWS`, `MEDOWS` | `MDWS` |
| `MEWS` | `MEWS` | `MEWS` |
| `MILL` | `MILL` | `ML` |
| `MILLS` | `MILLS` | `MLS` |
| `MISSION` | `MISSN`, `MSSN` | `MSN` |
| `MOTORWAY` | `MOTORWAY` | `MTWY` |
| `MOUNT` | `MNT`, `MT`, `MOUNT` | `MT` |
| `MOUNTAIN` | `MNTAIN`, `MNTN`, `MOUNTAIN`, `MOUNTIN`, `MTIN`, `MTN` | `MTN` |
| `MOUNTAINS` | `MNTNS`, `MOUNTAINS` | `MTNS` |
| `NECK` | `NCK`, `NECK` | `NCK` |
| `ORCHARD` | `ORCH`, `ORCHARD`, `ORCHRD` | `ORCH` |
| `OVAL` | `OVAL`, `OVL` | `OVAL` |
| `OVERPASS` | `OVERPASS` | `OPAS` |
| `PARK` | `PARK`, `PRK` | `PARK` |
| `PARKS` | `PARKS` | `PARK` |
| `PARKWAY` | `PARKWAY`, `PARKWY`, `PKWAY`, `PKWY`, `PKY` | `PKWY` |
| `PARKWAYS` | `PARKWAYS`, `PKWYS` | `PKWY` |
| `PASS` | `PASS` | `PASS` |
| `PASSAGE` | `PASSAGE` | `PSGE` |
| `PATH` | `PATH`, `PATHS` | `PATH` |
| `PIKE` | `PIKE`, `PIKES` | `PIKE` |
| `PINE` | `PINE` | `PNE` |
| `PINES` | `PINES`, `PNES` | `PNES` |
| `PLACE` | `PL` | `PL` |
| `PLAIN` | `PLAIN`, `PLN` | `PLN` |
| `PLAINS` | `PLAINS`, `PLNS` | `PLNS` |
| `PLAZA` | `PLAZA`, `PLZ`, `PLZA` | `PLZ` |
| `POINT` | `POINT`, `PT` | `PT` |
| `POINTS` | `POINTS`, `PTS` | `PTS` |
| `PORT` | `PORT`, `PRT` | `PRT` |
| `PORTS` | `PORTS`, `PRTS` | `PRTS` |
| `PRAIRIE` | `PR`, `PRAIRIE`, `PRR` | `PR` |
| `RADIAL` | `RAD`, `RADIAL`, `RADIEL`, `RADL` | `RADL` |
| `RAMP` | `RAMP` | `RAMP` |
| `RANCH` | `RANCH`, `RANCHES`, `RNCH`, `RNCHS` | `RNCH` |
| `RAPID` | `RAPID`, `RPD` | `RPD` |
| `RAPIDS` | `RAPIDS`, `RPDS` | `RPDS` |
| `REST` | `REST`, `RST` | `RST` |
| `RIDGE` | `RDG`, `RDGE`, `RIDGE` | `RDG` |
| `RIDGES` | `RDGS`, `RIDGES` | `RDGS` |
| `RIVER` | `RIV`, `RIVER`, `RVR`, `RIVR` | `RIV` |
| `ROAD` | `RD`, `ROAD` | `RD` |
| `ROADS` | `ROADS`, `RDS` | `RDS` |
| `ROUTE` | `ROUTE` | `RTE` |
| `ROW` | `ROW` | `ROW` |
| `RUE` | `RUE` | `RUE` |
| `RUN` | `RUN` | `RUN` |
| `SHOAL` | `SHL`, `SHOAL` | `SHL` |
| `SHOALS` | `SHLS`, `SHOALS` | `SHLS` |
| `SHORE` | `SHOAR`, `SHORE`, `SHR` | `SHR` |
| `SHORES` | `SHOARS`, `SHORES`, `SHRS` | `SHRS` |
| `SKYWAY` | `SKYWAY` | `SKWY` |
| `SPRING` | `SPG`, `SPNG`, `SPRING`, `SPRNG` | `SPG` |
| `SPRINGS` | `SPGS`, `SPNGS`, `SPRINGS`, `SPRNGS` | `SPGS` |
| `SPUR` | `SPUR` | `SPUR` |
| `SPURS` | `SPURS` | `SPUR` |
| `SQUARE` | `SQ`, `SQR`, `SQRE`, `SQU`, `SQUARE` | `SQ` |
| `SQUARES` | `SQRS`, `SQUARES` | `SQS` |
| `STATION` | `STA`, `STATION`, `STATN`, `STN` | `STA` |
| `STRAVENUE` | `STRA`, `STRAV`, `STRAVEN`, `STRAVENUE`, `STRAVN`, `STRVN`, `STRVNUE` | `STRA` |
| `STREAM` | `STREAM`, `STREME`, `STRM` | `STRM` |
| `STREET` | `STREET`, `STRT`, `ST`, `STR` | `ST` |
| `STREETS` | `STREETS` | `STS` |
| `SUMMIT` | `SMT`, `SUMIT`, `SUMITT`, `SUMMIT` | `SMT` |
| `TERRACE` | `TER`, `TERR`, `TERRACE` | `TER` |
| `THROUGHWAY` | `THROUGHWAY` | `TRWY` |
| `TRACE` | `TRACE`, `TRACES`, `TRCE` | `TRCE` |
| `TRACK` | `TRACK`, `TRACKS`, `TRAK`, `TRK`, `TRKS` | `TRAK` |
| `TRAFFICWAY` | `TRAFFICWAY` | `TRFY` |
| `TRAIL` | `TRAIL`, `TRAILS`, `TRL`, `TRLS` | `TRL` |
| `TRAILER` | `TRAILER`, `TRLR`, `TRLRS` | `TRLR` |
| `TUNNEL` | `TUNEL`, `TUNL`, `TUNLS`, `TUNNEL`, `TUNNELS`, `TUNNL` | `TUNL` |
| `TURNPIKE` | `TRNPK`, `TURNPIKE`, `TURNPK` | `TPKE` |
| `UNDERPASS` | `UNDERPASS` | `UPAS` |
| `UNION` | `UN`, `UNION` | `UN` |
| `UNIONS` | `UNIONS` | `UNS` |
| `VALLEY` | `VALLEY`, `VALLY`, `VLLY`, `VLY` | `VLY` |
| `VALLEYS` | `VALLEYS`, `VLYS` | `VLYS` |
| `VIADUCT` | `VDCT`, `VIA`, `VIADCT`, `VIADUCT` | `VIA` |
| `VIEW` | `VIEW`, `VW` | `VW` |
| `VIEWS` | `VIEWS`, `VWS` | `VWS` |
| `VILLAGE` | `VILL`, `VILLAG`, `VILLAGE`, `VILLG`, `VILLIAGE`, `VLG` | `VLG` |
| `VILLAGES` | `VILLAGES`, `VLGS` | `VLGS` |
| `VILLE` | `VILLE`, `VL` | `VL` |
| `VISTA` | `VIS`, `VIST`, `VISTA`, `VST`, `VSTA` | `VIS` |
| `WALK` | `WALK` | `WALK` |
| `WALKS` | `WALKS` | `WALK` |
| `WALL` | `WALL` | `WALL` |
| `WAY` | `WY`, `WAY` | `WAY` |
| `WAYS` | `WAYS` | `WAYS` |
| `WELL` | `WELL` | `WL` |
| `WELLS` | `WELLS`, `WLS` | `WLS` |

### `unit`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: remove_non_ascii
  - function: to_upper_case
  - function: replace_regex
    params:
      pattern: "\\b(?:APARTMENT|APT|BUILDING|BLDG|DEPARTMENT|DEPT|FLOOR|FL|HANGAR|HANGER|HNGR|KEY|LOT|PIER|ROOM|RM|SLIP|SPACE|SPC|STOP|SUITE|STE|TRAILER|TRLR|UNIT)(?:\\b|([0-9]))"
      replacement: "$1"
  - function: replace_regex
    params:
      pattern: "\\b(?:BASEMENT|BSMT)(?:\\b|([0-9]))"
      replacement: "BSMT $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:FRONT|FRNT)(?:\\b|([0-9]))"
      replacement: "FRNT $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:LOBBY|LBBY)(?:\\b|([0-9]))"
      replacement: "LBBY $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:LOWER|LOWR)(?:\\b|([0-9]))"
      replacement: "LOWR $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:OFFICE|OFC)(?:\\b|([0-9]))"
      replacement: "OFC $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:PENTHOUSE|PH)(?:\\b|([0-9]))"
      replacement: "PH $1"
  - function: replace_regex
    params:
      pattern: "\\bREAR(?:\\b|([0-9]))"
      replacement: "REAR $1"
  - function: replace_regex
    params:
      pattern: "\\bSIDE(?:\\b|([0-9]))"
      replacement: "SIDE $1"
  - function: replace_regex
    params:
      pattern: "\\b(?:UPPER|UPPR)(?:\\b|([0-9]))"
      replacement: "UPPR $1"
  - function: remove_punctuation
  - function: replace_regex
    params:
      pattern: "\\b(?:NUMBER|NUM|NO)(?: +([A-Z]*[0-9])|([0-9]))"
      replacement: "$1$2"
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z0-9]"
  - function: null_if
    params:
      values: ["UNKNOWN", "UNK", "NONE", "NA"]
```

Result: the identifier of the apartment, suite or other unit of an address,
in uppercase, its words separated by single spaces, with punctuation removed.
A designator that stands alone is kept in its abbreviation instead.

- The first `replace_regex` deletes each designator in the
  [designator table](#secondary-unit-designators) that needs an identifier,
  spelled out or abbreviated, as a whole word or where it is written against
  the digit that starts the identifier. `Apt 4B`, `Apartment 4B`, `Unit 4B`,
  `Apt-4B` and `Apt4B` all keep `4B`.
- The nine `replace_regex` steps after it each write one designator that
  stands alone, spelled out or abbreviated, as its abbreviation followed by a
  space. Each matches the designator as a whole word or where it is written
  against a digit, so `Basement` becomes `BSMT`, and `Penthouse 2`,
  `Penthouse2` and `PH2` all become `PH 2`. The later `squash_spaces` and
  `trim_whitespace` steps fold the added space away.
- Every punctuation mark is then deleted, a hyphen included, so `4-B` and
  `4B`, and `#4B` and `4B`, agree.
- The `replace_regex` after it deletes a number marker, `NO`, `NUM` or
  `NUMBER`, written before a word that contains a digit, after a space or
  against the digit. `Apt No 4`, `Apt Number 4`, `Apt 4` and `#4` all keep
  `4`. A marker with no such word after it is kept, since a `NO` with no
  number after it may be the identifier itself: `Apt No` keeps `NO`. The
  Project US@ specification names `NUM`, `NO`, `NUMBER` and `#` among the
  words an address leaves out before a number.
- A value left with no letter or digit is dropped: a blank or all-punctuation
  value, and a designator written with no identifier, such as `Apt`.
- The closing `null_if` is the placeholder list (see
  [Per-party placeholder lists](#per-party-placeholder-lists)): the
  [`street_name`](#street_name) list and `NA`, the cleaned form of `N/A`,
  written where an address has no unit.

The designator is left out because it depends on who wrote the value. The
Project US@ specification lets a writer who does not know the right designator
write `#` in its place, so `#4B` and `Apt 4B` can name the same unit, and
keeping the designator would leave that pair unmatched. Two units at one
address that differ only by designator, such as `Bldg 2` and `Apt 2`, clean to
the same value. A value naming several parts keeps the identifier of each:
`Bldg 3 Apt 12` cleans to `3 12`, which does not agree with `Apt 12`.

A designator that stands alone, such as `REAR` or `BSMT`, needs no identifier:
it is the whole of what tells that unit from the others at the address, so it
is kept.

The type is inferred from `unit`, `unit_number`, `apartment`, `apt` and their
short spellings
([Type inference from column names](#type-inference-from-column-names)). A
second address-line column such as `address2` infers nothing, since it can
contain a care-of name or a PO box instead of a unit; typing it `unit` in its
metadata matches on it.

| Input | Result |
| ----- | ------ |
| `"Apt 4B"` | `"4B"` |
| `"Apartment 4B"` | `"4B"` |
| `"Unit 4B"` | `"4B"` |
| `"#4B"` | `"4B"` |
| `"Apt-4B"` | `"4B"` |
| `"4B"` | `"4B"` |
| `"apt. 4-b"` | `"4B"` |
| `"Suite200"` | `"200"` |
| `"  Unit  12 "` | `"12"` |
| `"Hangar 3"` | `"3"` |
| `"Hanger 3"` | `"3"` |
| `"Apt No. 4"` | `"4"` |
| `"Unit Number 12"` | `"12"` |
| `"No.4B"` | `"4B"` |
| `"Apt No"` | `"NO"` |
| `"Bldg 3 Apt 12"` | `"3 12"` |
| `"Basement"` | `"BSMT"` |
| `"Rear"` | `"REAR"` |
| `"Rear Apt"` | `"REAR"` |
| `"Penthouse B"` | `"PH B"` |
| `"Penthouse 2"` | `"PH 2"` |
| `"Penthouse2"` | `"PH 2"` |
| `"PH2"` | `"PH 2"` |
| `"Apt"` | `null` |
| `"N/A"` | `null` |
| `"Unknown"` | `null` |
| `"#"` | `null` |
| `""` | `null` |

#### Secondary unit designators

The secondary unit designators of USPS Publication 28, as Table 1 of the
Project US@ Technical Specification v1.0 lists them, in its order. A
designator that stands alone needs no number or letter after it.

Publication 28 spells one designator `HANGAR` and Table 1 prints it `HANGER`.
Both spellings are accepted, with the one abbreviation `HNGR`, because the two
sources spell it differently.

| Designator | Abbreviation | Stands alone |
| ---------- | ------------ | ------------ |
| `APARTMENT` | `APT` | no |
| `BASEMENT` | `BSMT` | yes |
| `BUILDING` | `BLDG` | no |
| `DEPARTMENT` | `DEPT` | no |
| `FLOOR` | `FL` | no |
| `FRONT` | `FRNT` | yes |
| `HANGAR`, `HANGER` | `HNGR` | no |
| `KEY` | `KEY` | no |
| `LOBBY` | `LBBY` | yes |
| `LOT` | `LOT` | no |
| `LOWER` | `LOWR` | yes |
| `OFFICE` | `OFC` | yes |
| `PENTHOUSE` | `PH` | yes |
| `PIER` | `PIER` | no |
| `REAR` | `REAR` | yes |
| `ROOM` | `RM` | no |
| `SIDE` | `SIDE` | yes |
| `SLIP` | `SLIP` | no |
| `SPACE` | `SPC` | no |
| `STOP` | `STOP` | no |
| `SUITE` | `STE` | no |
| `TRAILER` | `TRLR` | no |
| `UNIT` | `UNIT` | no |
| `UPPER` | `UPPR` | yes |

### `city`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: replace_regex
    params:
      pattern: "[\\-\\x{2010}-\\x{2015}\\x{2212}]"
      replacement: " "
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z0-9]"
  - function: null_if
    params:
      values: ["UNKNOWN", "UNK", "NONE"]
```

Result: the city name in uppercase, its words separated by single spaces, with
punctuation removed. The steps before the placeholder list are those of
[`county`](#county) without its removal of the word `COUNTY`:

- An accented letter becomes its base letter.
- A hyphen or typographic dash becomes a space, so `Winston-Salem` and
  `Winston Salem` agree.
- Other punctuation is deleted, so `Coeur d'Alene` and `Coeur dAlene` agree.
- A value left with no letter or digit, a blank or all-punctuation value, is
  dropped.

The closing `null_if` is the placeholder list (see
[Per-party placeholder lists](#per-party-placeholder-lists)), the
[`street_name`](#street_name) list: the Project US@ specification says not to
match on `UNKNOWN` for any part of an address.

No word is abbreviated or spelled out: `St Louis` and `Saint Louis` stay
different. The Project US@ specification spells a city name out in its
entirety but lists no city abbreviations, so no table rewrites one. A city
name is ambiguous across states, as a county name is, and the cleaned value
contains no state.

The type is inferred from `city`, `city_name` and `cityname`
([Type inference from column names](#type-inference-from-column-names)).

| Input | Result |
| ----- | ------ |
| `"Baltimore"` | `"BALTIMORE"` |
| `"  baltimore "` | `"BALTIMORE"` |
| `"St. Louis"` | `"ST LOUIS"` |
| `"Winston-Salem"` | `"WINSTON SALEM"` |
| `"Coeur d'Alene"` | `"COEUR DALENE"` |
| `"Espa\u00f1ola"` | `"ESPANOLA"` |
| `"Unknown"` | `null` |
| `"..."` | `null` |
| `""` | `null` |

### `zip_code`

```yaml
steps:
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: substring
    params:
      start: 1
      length: 5
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 5
  - function: filter_regex
    params:
      pattern: "^0{0,2}[1-9]"
  - function: null_if
    params:
      values: ["00000", "99999", "88888"]
```

Result: exactly five digits. Stripping every non-digit subsumes a leading trim
and a non-ASCII removal, so neither appears as its own step; keeping the first
five digits collapses a ZIP+4 to its five-digit prefix; and the pad restores
the leading zero on a New England ZIP stored as a number. The empty-value drop
before `pad_left` mirrors the `ssn` pipeline -- `substring` already yields
`null` for an empty slice, so it adds no coverage on its own and is retained as
the explicit statement of the rule.

Two filler screens follow the pad:

- **Starting `000`.** A value whose first three digits are `000` after padding
  is dropped: `00000`, and a fragment of two digits or fewer padded to five.
- **Unknown and foreign codes.** `99999`, written for an unknown ZIP, and
  `88888`, written for a resident of another country, are dropped.

The list names `00000` as well, so a pipeline an operator authors with the list
but without the `000` screen still drops it.

Note the width: a value of more than five digits keeps its first five rather
than being dropped, which is the one default pipeline that truncates instead of
refusing. A nine-digit ZIP+4 written without its separator therefore
standardizes to the same value as the five-digit form.

| Input | Result |
| ----- | ------ |
| `"20057"` | `"20057"` |
| `"20057-1234"` | `"20057"` |
| `"  2057  "` | `"02057"` |
| `"501"` | `"00501"` |
| `"00000"` | `null` |
| `"12"` | `null` |
| `"99999"` | `null` |
| `"88888"` | `null` |
| `"abc"` | `null` |

A linkage key element over a `zip_code` field can match on the three-digit ZIP
area instead of the full ZIP with the `zip3` transform. It keeps the first
three digits of the cleaned five-digit value, leading zeros included, so
`02139` becomes `021`; any value that is not exactly five digits is dropped.
It is a key-element transform, not part of this pipeline, and the consent
display states it on each key that uses it. Over a date, the consent display
measures a `zip3` as it measures a `substring` keeping the first three
characters, with one limit those share: a `coalesce` between the `parse_date`
and the `zip3` is read as fixed by the date's layout, so an element whose
`coalesce` default is what reaches the `zip3` is reported as a key that can
never match, and the exchange is refused, rather than marked as matching any
date.

### `state`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: state_code
```

Result: a two-letter USPS code. The value is uppercased with its punctuation
removed, and `state_code` then replaces a full name with its code, keeps a code
as it is, and drops anything else. A misspelled name, an abbreviation other
than the USPS code (`Calif`), and a foreign province are all dropped.

The recognized places are the 50 states, the District of Columbia, and the five
inhabited territories with a USPS code: American Samoa, Guam, the Northern
Mariana Islands, Puerto Rico and the US Virgin Islands. Two groups of USPS
codes are not recognized: the freely associated states (`FM`, `MH`, `PW`),
which are sovereign countries, and the military codes (`AA`, `AE`, `AP`), which
route mail rather than name a place of residence.

#### State and territory codes

| Code | Names |
| ---- | ----- |
| `AL` | `ALABAMA` |
| `AK` | `ALASKA` |
| `AZ` | `ARIZONA` |
| `AR` | `ARKANSAS` |
| `CA` | `CALIFORNIA` |
| `CO` | `COLORADO` |
| `CT` | `CONNECTICUT` |
| `DE` | `DELAWARE` |
| `FL` | `FLORIDA` |
| `GA` | `GEORGIA` |
| `HI` | `HAWAII` |
| `ID` | `IDAHO` |
| `IL` | `ILLINOIS` |
| `IN` | `INDIANA` |
| `IA` | `IOWA` |
| `KS` | `KANSAS` |
| `KY` | `KENTUCKY` |
| `LA` | `LOUISIANA` |
| `ME` | `MAINE` |
| `MD` | `MARYLAND` |
| `MA` | `MASSACHUSETTS` |
| `MI` | `MICHIGAN` |
| `MN` | `MINNESOTA` |
| `MS` | `MISSISSIPPI` |
| `MO` | `MISSOURI` |
| `MT` | `MONTANA` |
| `NE` | `NEBRASKA` |
| `NV` | `NEVADA` |
| `NH` | `NEW HAMPSHIRE` |
| `NJ` | `NEW JERSEY` |
| `NM` | `NEW MEXICO` |
| `NY` | `NEW YORK` |
| `NC` | `NORTH CAROLINA` |
| `ND` | `NORTH DAKOTA` |
| `OH` | `OHIO` |
| `OK` | `OKLAHOMA` |
| `OR` | `OREGON` |
| `PA` | `PENNSYLVANIA` |
| `RI` | `RHODE ISLAND` |
| `SC` | `SOUTH CAROLINA` |
| `SD` | `SOUTH DAKOTA` |
| `TN` | `TENNESSEE` |
| `TX` | `TEXAS` |
| `UT` | `UTAH` |
| `VT` | `VERMONT` |
| `VA` | `VIRGINIA` |
| `WA` | `WASHINGTON` |
| `WV` | `WEST VIRGINIA` |
| `WI` | `WISCONSIN` |
| `WY` | `WYOMING` |
| `DC` | `DISTRICT OF COLUMBIA` |
| `AS` | `AMERICAN SAMOA` |
| `GU` | `GUAM` |
| `MP` | `NORTHERN MARIANA ISLANDS` |
| `PR` | `PUERTO RICO` |
| `VI` | `VIRGIN ISLANDS`, `US VIRGIN ISLANDS` |

| Input | Result |
| ----- | ------ |
| `"Maryland"` | `"MD"` |
| `"md"` | `"MD"` |
| `" new  york "` | `"NY"` |
| `"D.C."` | `"DC"` |
| `"U.S. Virgin Islands"` | `"VI"` |
| `"Calif"` | `null` |
| `""` | `null` |

### `county`

```yaml
steps:
  - function: trim_whitespace
  - function: squash_spaces
  - function: remove_accents
  - function: replace_regex
    params:
      pattern: "[\\-\\x{2010}-\\x{2015}\\x{2212}]"
      replacement: " "
  - function: remove_non_ascii
  - function: to_upper_case
  - function: remove_punctuation
  - function: replace_regex
    params:
      pattern: "^COUNTY OF |\\bCOUNTY\\b"
      replacement: ""
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z0-9]"
```

Result: an uppercase county name with the word `COUNTY` and punctuation
removed. A hyphen or typographic dash (an en dash, for one) becomes a space before non-ASCII characters and punctuation are removed, so
`Miami-Dade`, `Miami–Dade` and `Miami Dade` agree, while an apostrophe is deleted, so
`Prince George's` and `Prince Georges` agree. A leading `COUNTY OF` is removed
as well as the word `COUNTY` anywhere in the value. A value left with no letter
or digit is dropped. No other spelling is reconciled: `St Marys` and `Saint
Marys` stay different, as do `DeKalb` and `De Kalb`; an abbreviated `Co` and
the words `Parish` and `Borough` are kept.

A county name is ambiguous across states: Washington, Jefferson and Franklin,
among others, each name a county in many states, and the cleaned value holds
no state. A `county` field therefore identifies a place only when both
parties' files come from one state or one region whose county names do not
repeat; across states it matches people in different counties of the same
name.

| Input | Result |
| ----- | ------ |
| `"Montgomery County"` | `"MONTGOMERY"` |
| `"MONTGOMERY COUNTY"` | `"MONTGOMERY"` |
| `"montgomery"` | `"MONTGOMERY"` |
| `"Prince George's County"` | `"PRINCE GEORGES"` |
| `"Miami-Dade"` | `"MIAMI DADE"` |
| `"Miami–Dade"` | `"MIAMI DADE"` |
| `"County of Los Angeles"` | `"LOS ANGELES"` |
| `"County"` | `null` |
| `""` | `null` |

## Shared-value screens

A shared-value screen drops a cleaned value held by more people in the party's
own file than the field allows. It is stated as a transformation's
`max_people_per_value`, a whole number of at least 1, rather than as a step,
because it reads the whole file and a step reads one value.

### What the screen does

The screen runs after the field's pipeline has cleaned every record, and
before any key is built. It counts the distinct people in the file who hold
each cleaned value of the field. A value held by more than
`max_people_per_value` people is dropped from every record holding it, as a
step producing `null` drops it: the records keep their other fields, and every
key that references the field leaves them out.

The defaults state these limits:

| Field type | `max_people_per_value` |
| ---------- | ---------------------- |
| `ssn` | `1` |
| `phone_number` | `5` |
| `email_address` | `5` |

No other default transformation states one.

Where the party's own terms set `deduplicate`, the `ssn` screen also reaches
an `ssn4` field read from a column of type `ssn` or from the column an `ssn`
field reads (see
[Last four derived from a full SSN](#last-four-derived-from-a-full-ssn)),
whether or not the terms declare an `ssn` field: a record whose SSN the screen
drops has no `ssn4` value either. Where a party's own cleaning splits a
record's SSN cell into several values, the record has no `ssn4` value when the
screen drops any one of them. A party whose terms do not set `deduplicate`
keeps the record's `ssn4` value. The screen is the one an `ssn` field reading
that column has:

- Where an `ssn` field of the terms reads the column, it is that field's own
  screen, so under the party's own standardization it is the
  `max_people_per_value` its `ssn` transformation states, and none where that
  transformation states none.
- Otherwise the column is cleaned by the default `ssn` pipeline and screened at
  the default `ssn` limit, under the default cleaning and the party's own
  standardization alike.

An `ssn4` field read from a column of its own is not screened.

### Counting distinct people

A person is a record's cleaned `first_name` and `date_of_birth` values. The
last name takes no part in the count, so a person whose last name differs
between records, after a marriage or a keying error, is still one person. Each
is read from the party's own column of that type, the first
`role: linkage` column of the type in its metadata, declared or inferred,
whether or not the terms declare a field of the type. A type with no such
column takes no part in the count.

The column is cleaned by the party's own transformation for a linkage field of
that type where its standardization has one reading that column, and otherwise
by the default pipeline for the type, a date's format inferred from the column
(see [Date-format inference](#date-format-inference)). The terms cannot remove
a column from the count.

- Records holding the same two values are one person, so a person's own
  duplicate records count once, whatever last name each holds.
- A record missing one or both of the values, because its cell was empty or
  its pipeline dropped the value, is the same person as a record that holds
  the same value of the field, agrees with it on every value it has, and has a
  value it lacks. A record no other record completes this way is a person of
  its own.
- When the file has neither column, every record holding a value is one
  person, and the screen drops nothing.

The count has three limits:

- A record with neither a first name nor a date of birth agrees with every
  holder of its value, so it never counts as another person.
- A person's own duplicate record whose cleaned first name differs, such as a
  typo or a nickname, counts as another person, so a value can be dropped from
  one person's records. The count compares cleaned values exactly, so it
  recognizes neither.
- A file with no first-name column counts people by date of birth alone, so
  two people born on one date who share a value count as one, and the value is
  kept.

For example, two records sharing an SSN, one holding `MARIA`, `LOPEZ`,
`19800101` and the other no name and `19900505`, are two people, so the SSN is
dropped from both. Had the second record held `19800101`, the two would be one
person and the SSN would be kept. A record holding `MARIA`, `GARCIA`,
`19800101` beside the first is the same person, and the SSN is kept: the last
name is not compared. A record holding `MAIRA`, `LOPEZ`, `19800101` beside the
first is another person: the count corrects no spelling.

Under one-to-one matching the cascade accepts a pair only on a key value one
record on each side holds (see [PSI](PROTOCOL.md#psi)), so a key value two of
a party's records share already matches neither of them. When one of two
records sharing an SSN lacks the name or date a key needs, only the other
builds that key and its value is unique, so the SSN screen is what drops it.

### Why five people for a phone or email

A household shares a phone number or an email address, and an organization --
a shelter, a clinic, a case manager -- records its own number on many of its
clients. A shared number causes a false match only when two different people
on it share a first name, which a key on first name and phone number cannot
separate.

- In the American Community Survey 2024 1-year estimates for the US (tables
  B11016, households by size, and B25008, population in occupied housing
  units), about 90% of people live in households of five or fewer, and at
  least 9.5% in households of six or more, counting a household of seven or
  more as seven. A limit of five keeps the values of most households.
- The expected number of same-first-name pairs among h people is about
  h(h-1)/2 times the first-name collision rate, about 1% in general and 3%
  among concentrated names: 0.1 to 0.3 pairs among five people, and 12 to 37
  among fifty.

The cost that remains is a household of six or more, which loses its phone and
email values, and a household where two members share a first name, which only
a date of birth separates. Five is a working value, not set from a measurement
of where, between a household and an organization's clients, false matches
start.

### Per-party limits

Each party may change a limit or remove it in its own standardization. The
cost of the count grows with the square of the limit, so a very large limit
slows the first read of that field. A limit decides only which values are
dropped, never the form of a value kept, so it cannot make two different
values equal. Each party applies the screens to its own file only: the
partner's records take no part in the count, and nothing about the screens is
sent beyond the values that remain.

An authored standardization replaces the defaults entirely, so a transformation
it writes without `max_people_per_value` has no screen. A coverage count taken
record by record before the run does not apply the screen.

No screen drops a date of birth for being frequent in the file. The
date-of-birth screens are the per-value ones its pipeline lists.

## Type inference from column names

When an exchange specification has no `metadata` block, each input column's
semantic type, role, and payload default are inferred from its name. The
lookup is on the column name's lookup key, which folds the whole name in four
steps:

1. Lowercase it.
2. Replace each `#` with the word `number`, set off by a `_` on each side.
3. Collapse each run of whitespace, `.`, `_` and `-` to one `_`.
4. Drop every character that is not a letter or digit from either end.

The key is an exact match against the table below, never a substring or prefix
test, so `First Name`, ` ssn` and `Date-of-Birth` infer but `zip_area` and
`ssn_last4` do not.
A character that is not a letter or digit at either end is dropped, so `ssn.`, `(ssn)` and `ssn:` have the key
`ssn`, and `Tel.` and `SSN No.` have `tel` and `ssn_no`.
A `#` is read as `number`, so `SSN #` and `SS#` have the keys `ssn_number` and
`ss_number`, and `Case #` is the record number `case_number`.
Punctuation inside a name, other than `#` and the separators above, stays in
the key.
The key is used only for the lookup: the column keeps its raw
header as its name in its metadata, its transform `input`, the run's display
and the result. Every name in the table is its own lookup key, and no two names
in it share one.

The fold has two limits. The console's quick-exchange confirm screen gives
examples of the columns never sent and lists the columns sent; only the command line's pre-run display
lists the names a quick exchange holds back.
A header recognized after folding is shown as written, so on the display a
whitespace-padded name such as ` ssn` differs from the bare `ssn` only by that
whitespace.

| Semantic type | Column names that infer it | `role` | `is_payload` |
| ------------- | -------------------------- | ------ | ------------ |
| `ssn` | `ssn`, `social`, `social_security`, `socialsecurity`, `soc_sec`, `socsec`, `social_sec`, `socialsec`, `soc_security`, `socsecurity`, `ssn_number`, `ssnnumber`, `ssn_no`, `ssnno`, `ssn_num`, `ssnnum`, `ssn_nbr`, `ssnnbr`, `ss_number`, `ssnumber`, `ss_no`, `ssno`, `ss_num`, `ssnum`, `ss_nbr`, `ssnbr`, `social_number`, `socialnumber`, `social_no`, `socialno`, `social_num`, `socialnum`, `social_nbr`, `socialnbr`, `social_security_number`, `social_securitynumber`, `socialsecurity_number`, `socialsecuritynumber`, `social_security_no`, `social_securityno`, `socialsecurity_no`, `socialsecurityno`, `social_security_num`, `social_securitynum`, `socialsecurity_num`, `socialsecuritynum`, `social_security_nbr`, `social_securitynbr`, `socialsecurity_nbr`, `socialsecuritynbr`, `soc_sec_number`, `soc_secnumber`, `socsec_number`, `socsecnumber`, `soc_sec_no`, `soc_secno`, `socsec_no`, `socsecno`, `soc_sec_num`, `soc_secnum`, `socsec_num`, `socsecnum`, `soc_sec_nbr`, `soc_secnbr`, `socsec_nbr`, `socsecnbr`, `social_sec_number`, `social_secnumber`, `socialsec_number`, `socialsecnumber`, `social_sec_no`, `social_secno`, `socialsec_no`, `socialsecno`, `social_sec_num`, `social_secnum`, `socialsec_num`, `socialsecnum`, `social_sec_nbr`, `social_secnbr`, `socialsec_nbr`, `socialsecnbr`, `soc_security_number`, `soc_securitynumber`, `socsecurity_number`, `socsecuritynumber`, `soc_security_no`, `soc_securityno`, `socsecurity_no`, `socsecurityno`, `soc_security_num`, `soc_securitynum`, `socsecurity_num`, `socsecuritynum`, `soc_security_nbr`, `soc_securitynbr`, `socsecurity_nbr`, `socsecuritynbr` | `linkage` | `false` |
| `ssn4` | `ssn4` | `linkage` | `false` |
| `first_name` | `first_name`, `firstname`, `fname` | `linkage` | `false` |
| `last_name` | `last_name`, `lastname`, `lname` | `linkage` | `false` |
| `date_of_birth` | `date_of_birth`, `dateofbirth`, `dob` | `linkage` | `false` |
| `identifier` | `identifier`, `id` | `identifier` | `false` |
| `phone_number` | `phone_number`, `phone`, `telephone`, `tel`, `cell`, `cell_phone`, `cellphone`, `mobile`, `mobile_phone`, `mobilephone`, `home_phone`, `homephone`, `work_phone`, `workphone`, `business_phone`, `businessphone`, `office_phone`, `officephone`, `day_phone`, `dayphone`, `evening_phone`, `eveningphone`, `primary_phone`, `primaryphone`, `alt_phone`, `altphone`, `alternate_phone`, `alternatephone`, `contact_phone`, `contactphone`, `main_phone`, `mainphone`, `daytime_phone`, `daytimephone`, `personal_phone`, `personalphone`, `secondary_phone`, `secondaryphone`, `cellular`, `cellular_phone`, `cellularphone`, `land_line`, `landline`, `home_telephone`, `hometelephone`, `work_telephone`, `worktelephone`, `home_tel`, `hometel`, `work_tel`, `worktel`, `cell_tel`, `celltel`, `mobile_tel`, `mobiletel`, `phone_home`, `phonehome`, `phone_work`, `phonework`, `phone_cell`, `phonecell`, `phone_mobile`, `phonemobile`, `phonenumber`, `phone_no`, `phoneno`, `phone_num`, `phonenum`, `phone_nbr`, `phonenbr`, `telephone_number`, `telephonenumber`, `telephone_no`, `telephoneno`, `telephone_num`, `telephonenum`, `telephone_nbr`, `telephonenbr`, `tel_number`, `telnumber`, `tel_no`, `telno`, `tel_num`, `telnum`, `tel_nbr`, `telnbr`, `cell_number`, `cellnumber`, `cell_no`, `cellno`, `cell_num`, `cellnum`, `cell_nbr`, `cellnbr`, `cell_phone_number`, `cell_phonenumber`, `cellphone_number`, `cellphonenumber`, `cell_phone_no`, `cell_phoneno`, `cellphone_no`, `cellphoneno`, `cell_phone_num`, `cell_phonenum`, `cellphone_num`, `cellphonenum`, `cell_phone_nbr`, `cell_phonenbr`, `cellphone_nbr`, `cellphonenbr`, `mobile_number`, `mobilenumber`, `mobile_no`, `mobileno`, `mobile_num`, `mobilenum`, `mobile_nbr`, `mobilenbr`, `mobile_phone_number`, `mobile_phonenumber`, `mobilephone_number`, `mobilephonenumber`, `mobile_phone_no`, `mobile_phoneno`, `mobilephone_no`, `mobilephoneno`, `mobile_phone_num`, `mobile_phonenum`, `mobilephone_num`, `mobilephonenum`, `mobile_phone_nbr`, `mobile_phonenbr`, `mobilephone_nbr`, `mobilephonenbr`, `home_phone_number`, `home_phonenumber`, `homephone_number`, `homephonenumber`, `home_phone_no`, `home_phoneno`, `homephone_no`, `homephoneno`, `home_phone_num`, `home_phonenum`, `homephone_num`, `homephonenum`, `home_phone_nbr`, `home_phonenbr`, `homephone_nbr`, `homephonenbr`, `work_phone_number`, `work_phonenumber`, `workphone_number`, `workphonenumber`, `work_phone_no`, `work_phoneno`, `workphone_no`, `workphoneno`, `work_phone_num`, `work_phonenum`, `workphone_num`, `workphonenum`, `work_phone_nbr`, `work_phonenbr`, `workphone_nbr`, `workphonenbr`, `business_phone_number`, `business_phonenumber`, `businessphone_number`, `businessphonenumber`, `business_phone_no`, `business_phoneno`, `businessphone_no`, `businessphoneno`, `business_phone_num`, `business_phonenum`, `businessphone_num`, `businessphonenum`, `business_phone_nbr`, `business_phonenbr`, `businessphone_nbr`, `businessphonenbr`, `office_phone_number`, `office_phonenumber`, `officephone_number`, `officephonenumber`, `office_phone_no`, `office_phoneno`, `officephone_no`, `officephoneno`, `office_phone_num`, `office_phonenum`, `officephone_num`, `officephonenum`, `office_phone_nbr`, `office_phonenbr`, `officephone_nbr`, `officephonenbr`, `day_phone_number`, `day_phonenumber`, `dayphone_number`, `dayphonenumber`, `day_phone_no`, `day_phoneno`, `dayphone_no`, `dayphoneno`, `day_phone_num`, `day_phonenum`, `dayphone_num`, `dayphonenum`, `day_phone_nbr`, `day_phonenbr`, `dayphone_nbr`, `dayphonenbr`, `evening_phone_number`, `evening_phonenumber`, `eveningphone_number`, `eveningphonenumber`, `evening_phone_no`, `evening_phoneno`, `eveningphone_no`, `eveningphoneno`, `evening_phone_num`, `evening_phonenum`, `eveningphone_num`, `eveningphonenum`, `evening_phone_nbr`, `evening_phonenbr`, `eveningphone_nbr`, `eveningphonenbr`, `primary_phone_number`, `primary_phonenumber`, `primaryphone_number`, `primaryphonenumber`, `primary_phone_no`, `primary_phoneno`, `primaryphone_no`, `primaryphoneno`, `primary_phone_num`, `primary_phonenum`, `primaryphone_num`, `primaryphonenum`, `primary_phone_nbr`, `primary_phonenbr`, `primaryphone_nbr`, `primaryphonenbr`, `alt_phone_number`, `alt_phonenumber`, `altphone_number`, `altphonenumber`, `alt_phone_no`, `alt_phoneno`, `altphone_no`, `altphoneno`, `alt_phone_num`, `alt_phonenum`, `altphone_num`, `altphonenum`, `alt_phone_nbr`, `alt_phonenbr`, `altphone_nbr`, `altphonenbr`, `alternate_phone_number`, `alternate_phonenumber`, `alternatephone_number`, `alternatephonenumber`, `alternate_phone_no`, `alternate_phoneno`, `alternatephone_no`, `alternatephoneno`, `alternate_phone_num`, `alternate_phonenum`, `alternatephone_num`, `alternatephonenum`, `alternate_phone_nbr`, `alternate_phonenbr`, `alternatephone_nbr`, `alternatephonenbr`, `contact_phone_number`, `contact_phonenumber`, `contactphone_number`, `contactphonenumber`, `contact_phone_no`, `contact_phoneno`, `contactphone_no`, `contactphoneno`, `contact_phone_num`, `contact_phonenum`, `contactphone_num`, `contactphonenum`, `contact_phone_nbr`, `contact_phonenbr`, `contactphone_nbr`, `contactphonenbr`, `main_phone_number`, `main_phonenumber`, `mainphone_number`, `mainphonenumber`, `main_phone_no`, `main_phoneno`, `mainphone_no`, `mainphoneno`, `main_phone_num`, `main_phonenum`, `mainphone_num`, `mainphonenum`, `main_phone_nbr`, `main_phonenbr`, `mainphone_nbr`, `mainphonenbr`, `daytime_phone_number`, `daytime_phonenumber`, `daytimephone_number`, `daytimephonenumber`, `daytime_phone_no`, `daytime_phoneno`, `daytimephone_no`, `daytimephoneno`, `daytime_phone_num`, `daytime_phonenum`, `daytimephone_num`, `daytimephonenum`, `daytime_phone_nbr`, `daytime_phonenbr`, `daytimephone_nbr`, `daytimephonenbr`, `personal_phone_number`, `personal_phonenumber`, `personalphone_number`, `personalphonenumber`, `personal_phone_no`, `personal_phoneno`, `personalphone_no`, `personalphoneno`, `personal_phone_num`, `personal_phonenum`, `personalphone_num`, `personalphonenum`, `personal_phone_nbr`, `personal_phonenbr`, `personalphone_nbr`, `personalphonenbr`, `secondary_phone_number`, `secondary_phonenumber`, `secondaryphone_number`, `secondaryphonenumber`, `secondary_phone_no`, `secondary_phoneno`, `secondaryphone_no`, `secondaryphoneno`, `secondary_phone_num`, `secondary_phonenum`, `secondaryphone_num`, `secondaryphonenum`, `secondary_phone_nbr`, `secondary_phonenbr`, `secondaryphone_nbr`, `secondaryphonenbr`, `cellular_number`, `cellularnumber`, `cellular_no`, `cellularno`, `cellular_num`, `cellularnum`, `cellular_nbr`, `cellularnbr`, `cellular_phone_number`, `cellular_phonenumber`, `cellularphone_number`, `cellularphonenumber`, `cellular_phone_no`, `cellular_phoneno`, `cellularphone_no`, `cellularphoneno`, `cellular_phone_num`, `cellular_phonenum`, `cellularphone_num`, `cellularphonenum`, `cellular_phone_nbr`, `cellular_phonenbr`, `cellularphone_nbr`, `cellularphonenbr`, `land_line_number`, `land_linenumber`, `landline_number`, `landlinenumber`, `land_line_no`, `land_lineno`, `landline_no`, `landlineno`, `land_line_num`, `land_linenum`, `landline_num`, `landlinenum`, `land_line_nbr`, `land_linenbr`, `landline_nbr`, `landlinenbr`, `home_telephone_number`, `home_telephonenumber`, `hometelephone_number`, `hometelephonenumber`, `home_telephone_no`, `home_telephoneno`, `hometelephone_no`, `hometelephoneno`, `home_telephone_num`, `home_telephonenum`, `hometelephone_num`, `hometelephonenum`, `home_telephone_nbr`, `home_telephonenbr`, `hometelephone_nbr`, `hometelephonenbr`, `work_telephone_number`, `work_telephonenumber`, `worktelephone_number`, `worktelephonenumber`, `work_telephone_no`, `work_telephoneno`, `worktelephone_no`, `worktelephoneno`, `work_telephone_num`, `work_telephonenum`, `worktelephone_num`, `worktelephonenum`, `work_telephone_nbr`, `work_telephonenbr`, `worktelephone_nbr`, `worktelephonenbr`, `home_tel_number`, `home_telnumber`, `hometel_number`, `hometelnumber`, `home_tel_no`, `home_telno`, `hometel_no`, `hometelno`, `home_tel_num`, `home_telnum`, `hometel_num`, `hometelnum`, `home_tel_nbr`, `home_telnbr`, `hometel_nbr`, `hometelnbr`, `work_tel_number`, `work_telnumber`, `worktel_number`, `worktelnumber`, `work_tel_no`, `work_telno`, `worktel_no`, `worktelno`, `work_tel_num`, `work_telnum`, `worktel_num`, `worktelnum`, `work_tel_nbr`, `work_telnbr`, `worktel_nbr`, `worktelnbr`, `cell_tel_number`, `cell_telnumber`, `celltel_number`, `celltelnumber`, `cell_tel_no`, `cell_telno`, `celltel_no`, `celltelno`, `cell_tel_num`, `cell_telnum`, `celltel_num`, `celltelnum`, `cell_tel_nbr`, `cell_telnbr`, `celltel_nbr`, `celltelnbr`, `mobile_tel_number`, `mobile_telnumber`, `mobiletel_number`, `mobiletelnumber`, `mobile_tel_no`, `mobile_telno`, `mobiletel_no`, `mobiletelno`, `mobile_tel_num`, `mobile_telnum`, `mobiletel_num`, `mobiletelnum`, `mobile_tel_nbr`, `mobile_telnbr`, `mobiletel_nbr`, `mobiletelnbr`, `phone_home_number`, `phone_homenumber`, `phonehome_number`, `phonehomenumber`, `phone_home_no`, `phone_homeno`, `phonehome_no`, `phonehomeno`, `phone_home_num`, `phone_homenum`, `phonehome_num`, `phonehomenum`, `phone_home_nbr`, `phone_homenbr`, `phonehome_nbr`, `phonehomenbr`, `phone_work_number`, `phone_worknumber`, `phonework_number`, `phoneworknumber`, `phone_work_no`, `phone_workno`, `phonework_no`, `phoneworkno`, `phone_work_num`, `phone_worknum`, `phonework_num`, `phoneworknum`, `phone_work_nbr`, `phone_worknbr`, `phonework_nbr`, `phoneworknbr`, `phone_cell_number`, `phone_cellnumber`, `phonecell_number`, `phonecellnumber`, `phone_cell_no`, `phone_cellno`, `phonecell_no`, `phonecellno`, `phone_cell_num`, `phone_cellnum`, `phonecell_num`, `phonecellnum`, `phone_cell_nbr`, `phone_cellnbr`, `phonecell_nbr`, `phonecellnbr`, `phone_mobile_number`, `phone_mobilenumber`, `phonemobile_number`, `phonemobilenumber`, `phone_mobile_no`, `phone_mobileno`, `phonemobile_no`, `phonemobileno`, `phone_mobile_num`, `phone_mobilenum`, `phonemobile_num`, `phonemobilenum`, `phone_mobile_nbr`, `phone_mobilenbr`, `phonemobile_nbr`, `phonemobilenbr` | `linkage` | `false` |
| `email_address` | `email_address`, `emailaddress`, `email` | `linkage` | `false` |
| `street_number` | `street_number`, `streetnumber`, `street_no`, `streetno`, `street_num`, `streetnum`, `street_nbr`, `streetnbr`, `house_number`, `housenumber`, `house_no`, `houseno`, `house_num`, `housenum`, `house_nbr`, `housenbr`, `address_number`, `addressnumber`, `address_no`, `addressno`, `address_num`, `addressnum`, `address_nbr`, `addressnbr` | `linkage` | `false` |
| `street_name` | `street_name`, `streetname` | `linkage` | `false` |
| `unit` | `unit`, `apartment`, `apt`, `unit_number`, `unitnumber`, `unit_no`, `unitno`, `unit_num`, `unitnum`, `unit_nbr`, `unitnbr`, `apartment_number`, `apartmentnumber`, `apartment_no`, `apartmentno`, `apartment_num`, `apartmentnum`, `apartment_nbr`, `apartmentnbr`, `apt_number`, `aptnumber`, `apt_no`, `aptno`, `apt_num`, `aptnum`, `apt_nbr`, `aptnbr` | `linkage` | `false` |
| `city` | `city`, `city_name`, `cityname` | `linkage` | `false` |
| `zip_code` | `zip_code`, `zipcode`, `zip`, `zip5`, `zip_5` | `linkage` | `false` |
| `state` | `state`, `state_code`, `statecode`, `state_name`, `statename` | `linkage` | `false` |
| `county` | `county`, `county_name`, `countyname` | `linkage` | `false` |

Each multi-word type also lists its no-separator spelling, since the lookup key
keeps words apart, so a single-token column export (`firstname`, `dateofbirth`)
infers as well as a separated one.
The `ssn`, `phone_number`, `street_number`, and `unit` rows also list each of
their words with the endings `number`, `no`, `num`, and `nbr`, such as
`ssn_no`, `homephonenumber`, and `streetno`.
The `ssn` and `phone_number` rows list each spelling with every `_` between
its words either kept or dropped, so `SocialSecurity Number` and
`HomePhone No` infer as well.

Two rules sit outside the table, and only the second depends on the inference mode.
Direct mode is a run on an input file with no invitation and no
configuration: the CLI's zero-setup run and the console's quick exchange.
Every other inference is declared-only: a configuration with no `metadata`
block, and an invitation composed from an input file.

- A name whose lookup key is absent from the table but ends in `_id`, such as
  `case_id` or `Member ID`, infers `type: identifier`.
  So does a name whose lookup key is `clientid`, `personid`, `personalid`,
  `patientid`, `recordid`, `memberid`, or `mrn`, such as `ClientID`, the HMIS
  CSV export's `PersonalID`, or `MRN`.
  So does a record number: a name whose lookup key ends in `_number`, `_no`, or
  `number` after at least one other character, such as `case_number`,
  `Record No`, or `CaseNumber`, or whose header, less any characters that are not letters or digits at its
  end, ends in a lowercase letter followed by `No`, such as `RecordNo`.
  So is a name whose lookup key is on the run-together record-number list
  below, such as `RECORDNO` or `caseno`.
  In both modes it infers what the table's `identifier` row infers.
  A header ending in a lowercase `no`, such as `Casino`, is not a record number.
  Nor is a name whose lookup key ends in `yes_no` or `yesno`, such as
  `Consent Yes No`.
  The table is looked up first, so a name it lists, such as `ssn_number` or
  `StreetNo`, keeps its table type and is not a record number.
- Any other name absent from the table infers nothing when declared-only, and
  `type: other`, `role: payload`, `is_payload: true` in direct mode.

The run-together record-number list holds the lookup keys `recordno`,
`caseno`, `clientno`, `patientno`, `memberno`, `membershipno`, `accountno`,
`acctno`, `personno`, `participantno`, `subjectno`, `customerno`,
`studentno`, `employeeno`, `householdno`, `claimno`, `policyno`, `fileno`,
`refno`, `referenceno`, `chartno`, `mrno`, `idno`, `encounterno`,
`admissionno`, `enrollmentno`, `registrationno`, `orderno`, `invoiceno`,
`ticketno`, and `serialno`.

The record-number rule has two limits:

- An all-capitals or all-lowercase header with an unseparated `no` whose
  lookup key is not on the list, such as `VISITNO`, is not a record number and
  is sent in direct mode; a `metadata` block that declares it holds it back.
- A name ending in a record-number suffix that the table does not list is a
  record number whatever its column holds, such as `fax_number`: it is not
  sent, and it can index the records as any record number can.

A second pass then decides which column indexes this party's own records: the
first `identifier`-typed column in header order that is not a record number is
promoted to `role: identifier`, and with none, the first record number is.
A record number is often not unique to one record, so it never outranks an
`identifier`-typed column of another kind. Every other `identifier`-typed column,
whichever row typed it, infers nothing when declared-only, and `role: ignored`,
`is_payload: false` in direct mode, so no `identifier`-typed column is sent in either mode.

A column that ends the second pass with no role is undeclared, which only
declared-only inference leaves: the inferred
metadata has no entry for it, so the run does not index by it or send it, and
matches on it only when a standardization transform names it as its `input`. What a party sends is exactly what its metadata declares.
Declared-only, every inferred entry has `is_payload: false`, so the run sends no column until a `metadata` block declares one sent.
In direct mode a column is sent when neither the table nor the `identifier` rule above types it, and every other column infers `is_payload: false`.
A column is a linkage key only when its lookup key is a name in the table,
so in direct mode a linkage column under any other name, such as `Given Name`
or `Birthdate`, infers `role: payload` and is sent. The
run names its undeclared columns before it connects; the operator-facing
detail is in [Input metadata](../EXCHANGE_REFERENCE.md#input-metadata).

Two properties of these assignments are critical for matching. Every
inferred linkage type has `is_payload: false`, so a column inferred into
matching is not also disclosed to the partner unless the operator says so; and
for a declared column, matching participation still requires `role: linkage`,
so a column inferred `identifier` never reaches a key however its type reads,
and not even an explicit transform naming it can bind it, since a declared
role wins over the transform (see
[Linkage participation](PROTOCOL.md#linkage-participation-the-role-axis)).

## See also

- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) - the configuration
  reference these defaults substitute for: the transformation and step schemas,
  the step-function catalog, and the metadata block
- [PROTOCOL.md](PROTOCOL.md) - the regex dialect and `parse_date` semantics the
  steps run under, the field-to-column binding rule, and how a standardized
  value becomes a linkage key
- [TRANSFORM_REGEX_DIALECT.md](TRANSFORM_REGEX_DIALECT.md) - the bounds on
  partner-authored transform patterns
- [TRANSFORM_PARAMETER_BOUNDS.md](TRANSFORM_PARAMETER_BOUNDS.md) - the bounds on
  partner-authored transform parameters
- [linkage-rule-grounding.md](../notes/linkage-rule-grounding.md#fillers-the-default-cleaning-drops) -
  the sources for the SSN placeholders and the ZIP and phone fillers the
  pipelines drop
