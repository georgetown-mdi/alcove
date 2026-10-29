---
title: "Exchange reference"
---

# Exchange reference

This document is the field-level reference for Alcove exchange specifications. It covers every field of the four components - linkage terms, connection, metadata, and data standardization - with types, valid values, consistency rules, and examples. How the PSI protocol uses these parameters is in [PROTOCOL.md](spec/PROTOCOL.md), the threat model in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), and the commands that read this file in [CLI.md](CLI.md).

<!-- Adding to this doc? Keep it conceptual and operational. Constant values, byte/wire
layouts, algorithm steps, and the rationale behind them belong in the spec tier: see
docs/spec/README.md, "Where does my content go?". -->

An exchange specification is a JSON or YAML document that describes one Alcove exchange between two parties. All three applications read the same one: the web application provides an editor for it, the console authors and runs one on the machine it is mounted on, and the CLI reads it as its configuration file. A file the web app writes for download is an ordinary `alcove.yaml` validated against the same schema, with no secret in it. What an application does with a setting it cannot run - hold it unchanged and say so, or refuse the file naming the setting, never drop it - is in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md), "What a consumer does with a setting it cannot honor".

An exchange specification has four top-level components:

| Component | Required | Description |
|-----------|----------|-------------|
| `linkage_terms` | yes | What will be exchanged and how; verified by both parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `standardization` | no | Data cleaning and standardizing transformations applied before linkage |

Beside them sit the optional top-level blocks [`authentication`](#authentication), [`signing`](#signing), [`retention_disposition`](#retention_disposition), [`include_own_columns`](#include_own_columns), [`include_matching_key`](#include_matching_key) and [`csv_delimiter`](#csv_delimiter), and the terms enforcement record [`expected_partner_deduplicate`](#expected_partner_deduplicate). A key the configuration schema does not read is rejected when the configuration is read, at any level: at the top level, and inside any block, such as `linkage_terms`, a `linkage_fields` entry, `connection` and its `server` and `options`, `metadata`, `standardization`, `authentication`, and `signing`, except the keys of `connection.provider_options`. The error names the key and the block holding it, and no exchange runs until it is corrected. `alcove invite`, `alcove update`, and `alcove verify-receipt --partner-terms` read only the blocks they use, so a key outside those is refused by the file's next whole-file read (`alcove exchange`, `alcove apply`). What this means when a file written by a newer web application is loaded by an older CLI: [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md#what-an-older-cli-does-with-a-newer-file).

## File references

Credential and opaque string fields in `alcove.yaml` support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally. A relative path is resolved against the directory `alcove` runs in, not the directory holding the configuration. For example:

```yaml
connection:
  server:
    password: "@sftp.key"
```

Only the fields marked "`@`-file recommended" in their descriptions, together with the opaque `connection.provider_options` map, support this convention. Any other field is not treated as an `@`-file reference: a free-text field such as `linkage_terms.identity` or `retention_disposition`, or a local-path field such as `signing.identity_file`, keeps a leading `@` as a literal character rather than reading it as a file path.

---

## Linkage terms

Linkage terms are verified by both parties at the start of every exchange. After authentication, both parties swap their terms; if any fields are inconsistent, the exchange is cancelled. Fields marked as "soft" (only `date`) produce a warning rather than an error, and the exchange continues: neither party's `date` is rewritten and no updated terms are written. The agreed-terms file written beside each exchange record holds both parties' terms as each sent them, so it records both dates.

The document's four free-text fields - [`identity`](#linkage_termsidentity), the legal agreement's [`purpose`](#linkage_termslegal_agreement), a payload column's [`description`](#linkage_termspayload), and each [constraint `exclude`](#constraints) value - are single-line values capped at 1024 characters, and none may contain a control character: a NUL, an ESC, a tab, or a line break is refused when the terms are read, whichever side authored them. Letters outside ASCII are untouched.

The identities, the purpose, and the payload column descriptions are also written verbatim into both parties' [exchange records](spec/EXCHANGE_RECORD.md), so they also refuse the nine Unicode text-direction formatting characters - the embeddings, overrides, and isolates of Unicode UAX #9. The implicit direction marks `U+200E`, `U+200F`, and `U+061C` stay admitted. An `exclude` value reaches no record and keeps the nine.

The document's names take a rule of their own, inside their 256-character cap: a linkage field, key, or element `name`, an element's `field` or `swap` reference, a [transform step's](#transform-steps) `function` name and each of its `params` keys, a [payload column's](#linkage_termspayload) `name`, and the legal agreement's [`reference`](#linkage_termslegal_agreement) may hold neither a control character nor one of the nine text-direction formatting characters. Letters in any script are untouched. Alcove removes those same characters from your own CSV column headers when it reads the file (see [CSV header sanitation](spec/PARSED_INPUT_BOUNDS.md#csv-header-sanitation-at-ingestion)), so a header and a terms name agree. The [`metadata`](#input-metadata) block's column `name` takes the same rule.

Two kinds of value are held to their length caps alone: the string values of a transform step's `params` - a regex pattern, a replacement, a delimiter, a default - at 1000 characters each, and a name constraint's [`allowed_characters`](#constraints) class, at 256. A `params` key takes the name rule. Alcove escapes control characters in these values wherever it displays them.

### The built-in rules

A quick exchange, an invitation the web app creates from its defaults, and the template `alcove init` writes all fill in their linkage fields and keys from the product's built-in rules. The web app's Advanced invite path also starts from them.

The built-in rules have two parts:

- The linkage **fields**: eleven PII elements, `ssn`, `ssn4`, `first_name`, `last_name`, `date_of_birth`, `phone_number`, `email_address`, `zip_code`, `state`, `county`, and `street_number`, each in its standardized form and with the constraints it holds.
- The linkage **keys**: the rules of the [linkage rule catalog](notes/linkage-rule-catalog.md), each in one of two bands, applied in the catalog's order: the highest-precision rules, then the rules broader matching adds.

What the built-in rules do and do not cover:

- They cover the linkage **fields** (with their constraints) and the linkage **keys** (with their bands, and their order, which is the order they are applied in), and nothing else. `identity`, `date`, `algorithm`, `linkage_strategy`, `output`, and `deduplicate` are each party's own choice.
- A run matches on a **subset** of the built-in keys, never on an addition to them: the keys of the built-in rules chosen, less any key that matches on a field no column of your input file can supply. The terms document that travels with the exchange records exactly which keys ran, and is the authoritative account of any one exchange.
- Both parties' keys must match key for key. A quick exchange between two files where only one supplies a column a selected key needs, such as a ZIP code, stops before any data moves, naming the keys only one side declares. Remove the column from the file that has it, or agree on terms through an invitation.

The terms do not name the built-in rules; they hold the fields and keys themselves. Where the agreed keys are exactly the "highest precision" or "broader matching" keys, in their order, and the fields those keys read are the built-in fields, the accepting party's terms review says so, worked out from the keys and fields themselves.

Five of the rules broader matching adds match a name with a phone number or an email address and no date of birth: `LN + FN + PHONE`, `PHONE + soundex(LN) + FN`, `FN + PHONE`, `LN + FN + EMAIL`, and `EMAIL + soundex(LN) + FN`. Each matches only where one of the two records has no valid date of birth ([Keys that run only where a field is missing](#keys-that-run-only-where-a-field-is-missing)), so a file with no date-of-birth column still matches through them.

Every built-in rule on the whole first name, such as `LN + FN + DOB`, matches only a first name of at least two letters: each drops a one-letter first name with a [`filter_regex`](#string-transformation) step on its first-name element (see [`first_name`](spec/DEFAULT_STANDARDIZATION.md#first_name)). A record holding only an initial matches through the rules on part of the first name, such as `SSN + LN + FN1`.

#### Choosing the built-in rules

Each rule is in one of two bands: the highest-precision rules, and the others. The evidence placing each rule is in the [linkage rule catalog](notes/linkage-rule-catalog.md#bands). There are two choices, each selecting rules in the catalog's order:

- **Highest precision**: selects the highest-precision rules.
- **Broader matching**: selects them all, the highest-precision rules first.

No configuration key sets the choice; it decides which keys are written into the terms. It does not travel: the terms hold the keys selected. Where each path takes it from:

- A quick exchange and `alcove init` write the keys for broader matching. In a configuration `alcove init` wrote, its comments beside `linkage_keys` list the keys to delete to run only the highest-precision rules or to leave out the rules marked less certain.
- The invitation editor of the web app and the console starts at the same choice and offers both on Customize > Matching keys; Review & create names the choice the keys were drawn with ([Choosing the matching keys](WEB_APP.md#choosing-the-matching-keys)).
- The display a run shows before it connects lists the keys selected, and on a quick exchange names the selection ([What the run shows before it starts](CLI.md#what-the-run-shows-before-it-starts)).

#### Rules marked less certain

Three of the rules broader matching adds match on a name and a date of birth with nothing else: as written, with the names swapped, or on one part of a compound last name. These are less reliable the more people the two files cover; a file of one age group, such as one school class, counts as covering many people. Broader matching selects them with the rest.

- Every list of keys marks them `(less certain)`: Matching keys and the acceptance screen in the web app and the console, the quick exchange confirm step, the CLI's acceptance and `alcove apply` displays, and the display a run shows before it starts. The CLI prints the explanation once under the key list, labeled `why keys are marked less certain:`.
- Any key built only from first name, last name, and date of birth fields is marked, including one written by hand. A key with any other field is not marked, and the mark rates no other key.
- To leave them out:
  - On Matching keys, turn off a key's checkbox. On the console, for a configuration you opened, delete them from `linkage_keys` in `alcove.yaml`, run `alcove update`, and have your partner run `alcove apply` on what it prints.
  - A quick exchange always uses them. Set the exchange up with an invitation instead: in the console, turn them off on Customize > Matching keys; on the command line, write a configuration with `alcove init URL INPUT_FILE`, delete them from `linkage_keys`, and run `alcove invite` and `alcove accept`.
  - In a configuration `alcove init` wrote, delete them from `linkage_keys` before an invitation is made from it. Once the configuration serves a partnership, delete them, run `alcove update`, and have your partner run `alcove apply` on what it prints ([Changing the terms of an established partnership](CLI.md#changing-the-terms-of-an-established-partnership)).
  - An accepting party takes the invitation's keys whole, so it asks its partner for an invitation without them, and does not apply a terms update that contains them.

A `zip` column must hold the ZIP code of the person's own address. A site's or agency's ZIP code, and likewise a staff or agency phone number, matches unrelated people served at that site. Give such a column `role: ignored` in `metadata`; in a quick exchange, which has no `metadata` block, remove it from the file: a renamed header is sent to your partner.

The built-in keys' validation, the criticisms recorded against them, and what a quick exchange rests on are in [default-linkage-rule-set.md](notes/default-linkage-rule-set.md).

### `linkage_terms.version`

*Type:* string  
*Required:* yes  
*Consistency:* mandatory

A semver string identifying the schema of the linkage aggreement. Two versions are incompatible if no migration path exists from the lower version to the higher.

### `linkage_terms.identity`

*Type:* string  
*Required:* no, except under [`signing.mode: certificate`](#signingmode)  
*Consistency:* none

A free-text string identifying the party holding these terms. It is self-asserted: the protocol does nothing to vouch for it. It is recorded, with the partner's, in the unsigned self-attested exchange record every exchange that disclosed produces (see [Exchange record format](spec/EXCHANGE_RECORD.md)), as an unverified label. Common contents are name, organization, and contact information.

The placeholder [`alcove init`](CLI.md#initialization) writes into a fresh template is not a label: a command that reads a label refuses that exact value, in the field or on `--identity`, as it refuses none at all (see [Configuration](CLI.md#configuration)).

Omit the field to run unnamed. Alcove supplies no label of its own, the record omits its field, and every surface that shows a party name shows an absence marker. Present, the value must be non-empty and within the length cap; an empty string is refused. [`alcove invite`](CLI.md#offline-invitation) and [`alcove accept`](CLI.md#offline-acceptance) require a name, so a configuration written by an acceptance always holds one.

Under [`signing.mode: certificate`](#signingmode) both parties must be named, and the identity must match the one bound into the party's signing certificate, or the partner rejects the receipt. A run with signing configured is refused before it starts (exit 64) when this party is unnamed, and at terms agreement, before any linkage key or data crosses, when the partner is. [`alcove fingerprint`](CLI.md#signing-identity-fingerprint) warns on a mismatch, and [`alcove exchange`](CLI.md#signing-identity-and-the-agreed-terms) refuses the run before any credential, terms, or data are sent. See [Signing](#signing).

```yaml
linkage_terms:
  identity: "Jane Smith, Agency A, jsmith@agency-a.gov"
```

### `linkage_terms.date`

*Type:* ISO 8601 date string  
*Required:* yes  
*Consistency:* soft

Date these linkage terms were last modified. A mismatch produces a warning indicating that one party may have a stale copy.

### `linkage_terms.algorithm`

*Type:* enum: `psi` | `psi-c`  
*Required:* yes  
*Consistency:* mandatory

- `psi` -- reveals the intersection (matched records and their identifiers). Intended for operational data exchange.
- `psi-c` -- reveals only the cardinality of the intersection (how many records match).

A count-only exchange is one round over one key, so `psi-c` narrows what the rest of the document may say. Terms setting it are refused, naming what to change, when they declare any of:

- more than one entry in `linkage_keys`;
- `linkage_strategy: single-pass`;
- `deduplicate: true`;
- payload in either direction -- a non-empty `payload.send` or `payload.receive`, or [input metadata](#input-metadata) that would transmit a column (`is_payload: true` on a column whose `role` is not `ignored`).

The refusal happens where the terms are authored, where an invitation over them is created, and where a received invitation is parsed or accepted. It is never resolved by narrowing the document to the count-only shape or by running it as `psi`; the reasoning is in [PROTOCOL.md](spec/PROTOCOL.md#psi-c). None of this constrains `psi` terms.

### `linkage_terms.linkage_strategy`

*Type:* enum: `cascade` | `single-pass`  
*Required:* yes (defaults to `cascade` when omitted)  
*Consistency:* mandatory

How the agreed linkage keys are matched. Both strategies produce the same association table; they differ in how the per-key matching is sequenced on the wire, and in what one party discloses to the other.

- `cascade` -- the default. Matches the keys one at a time, in order; each round excludes the records an earlier key matched. Round trips grow with the number of keys.
- `single-pass` -- batches every key into one exchange and has the receiver reconstruct the cascade locally, so the round-trip count does not grow with the keys; suited to a high-latency channel (`filedrop` or `sftp`). It has a tighter scale ceiling than `cascade`; an exchange above it aborts on both parties with guidance (reduce the record count or split the dataset; fewer keys takes new terms).

Under `single-pass` the receiver learns the sender's full per-key duplicate structure, so it sees matches on less precise keys the cascade would have discarded; the emitted result is identical. Both parties must agree on the value or the exchange aborts. The wire shape and disclosure: [PROTOCOL.md](spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass); the ceiling: [PROTOCOL.md](spec/PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).

Both strategies match on the several values a `split_on` produces, and on the several a `generate_fuzzy_comparisons` or a key declaring `swap` produces, reaching the same table on the same rows (see [Fan-out (multi-value fields)](#fan-out-multi-value-fields)). What refuses those terms is the count-only algorithm, whatever the strategy. A both-sided `deduplicate` matches them under either strategy, grouping the records a key's several values reach (see [Deduplicating matches](#linkage_termsdeduplicate)).

### `linkage_terms.output`

*Type:* object  
*Required:* yes  
*Consistency:* mandatory

```yaml
linkage_terms:
  output:
    expects_output: true       # this party expects to receive the result
    share_with_partner: false  # the other party expects to receive the result
```

If `share_with_partner` is `true`, the other party's terms must also have `expects_output: true`; a mismatch aborts the exchange.

`expects_output` must be `true` if this party's `deduplicate` is `true`.

PSI roles (sender / receiver) are derived from `output` after the terms exchange. Both parties send their record counts in the terms exchange -- including when only one party has `expects_output: true` -- so each party's row count is put on the wire in every case, with no separate count round-trip. If exactly one party has `expects_output: true`, that party becomes the PSI receiver regardless of the counts. If both parties have `expects_output: true`, the party with the smaller dataset becomes the receiver and ties are broken in favour of the initiator -- a work-minimizing assignment derived in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#role-resolution-and-work-minimization).

### `linkage_terms.deduplicate`

*Type:* boolean
*Required:* yes  
*Consistency:* none

Whether to deduplicate the inputs of the party holding these terms. `true` says that several of THIS party's records may be matched to the same partner record: the declaring party is the "many" side, and it groups its own inputs by the partner's data. Each party decides its own value; the two need not agree, and the pair decides the exchange's cardinality (`false`/`false` matches one-to-one, `true`/`false` many-to-one, `true`/`true` many-to-many). The procedure each cardinality runs, and the additional disclosure a deduplicating match makes, are in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching).

> **Strategies:** many-to-one and many-to-many run under either [linkage strategy](#linkage_termslinkage_strategy), settled at the terms exchange after each party's record count is disclosed and before any linkage-key or payload data moves. Under `single-pass` the receiver resolves the pairing and reports the cluster diagnostic below; its partner receives the pairs alone.
>
> **Candidate sets:** a [`split_on`](#fan-out-multi-value-fields), a [`generate_fuzzy_comparisons`](#element-fields) expansion, or a [`swap`](#swapped-keys) key runs under a both-sided match with either strategy, and its clusters may join records that matched on different values of one key ([the entity closure](spec/PROTOCOL.md#the-many-to-many-entity-closure)). [The built-in rules](#the-built-in-rules) declare a swapped key.
>
> **The result:** the result file holds one row per matched pair under every cardinality. Where both parties group, the pairs resolve into [entity clusters](spec/PROTOCOL.md#the-many-to-many-entity-closure): a cluster formed on one matched value writes `m * n` rows for `m` of your records and `n` of your partner's, and one joined through a record that matched on several values writes one row per pair that matched. No column marks a cluster's boundary; a reader computes clusters from the pairs, and both parties compute the same ones.
>
> **What the run reports:** once the terms are agreed on, the run states your own `deduplicate`, the value your partner presented, and the resolved cardinality: in the CLI log at `info`, its default level, and on the web app's running screen until the run completes. The console shows your own value where you agree to the exchange. Your [exchange record](spec/EXCHANGE_RECORD.md#the-resolved-matching) holds the same three on every run. A run that resolves to a deduplicating cardinality also raises a notice of what that means for the result, following the agreed [`output`](#linkage_termsoutput): on the CLI's machine-interface warning stream, among the web app's run notices (in the diagnostic log for an unattended scheduled run), and among the console's run warnings. A both-sided run whose two declared record counts project a pair table past the advisory bound adds an advisory naming the projection and each side's contribution; the bound is in [PROTOCOL.md](spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps). Neither notice stops the run.
>
> **Where each party's value comes from:** an invitation holds the inviting party's `deduplicate` and nothing more.
>
> - **Accepting an invitation:** for any invitation shape but count-only, the web accept screen offers the accepting party a control for its own value, defaulting to `false`, and the consent display states both values and what the pair discloses. `alcove accept` offers no such control and always derives `false`, so an accepted deduplicating invitation runs many-to-one with the inviting party as the "many" side.
> - **A quick exchange:** each side declares its own value with [`--deduplicate`](CLI.md#quick-exchange), off by default, and the pair is settled at the terms exchange. The console's quick exchange offers the same value on its confirm step and passes it to the recurring-run hand-off as `--deduplicate`.
> - **The inviting party's side** is held to what its invitation declared: an acceptance records that value in [`expected_partner_deduplicate`](#expected_partner_deduplicate), and a partner presenting a different one at the run is refused before any key or payload moves.
> - **Two parties that each authored their own configuration file** have no such declaration between them, and that pair runs as written.
> - **An accepting party on a route with no control** groups its own records by declaring `deduplicate: true` in its own configuration file; where both files declare it, the exchange is many-to-many. Nothing records an inviting party's expectation of its partner's value, so this is not refused.

```yaml
linkage_terms:
  deduplicate: false
```

A party declaring `true` must have `expects_output: true`; the cross-party `output` consistency check enforces this, so no separate check applies to this field.

The partner may still have `expects_output: false`. Then the deduplicating party alone resolves the match and applies the uniqueness rule the partner would otherwise have applied, so each of its own records is still matched to at most one partner record (see [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching)). Two parties both declaring `true` both receive the result.

#### Choosing linkage keys for a both-sided match

A cluster is the set of records joined by the values they shared under one linkage key, so a key that is not near-unique where it is present groups records that are not one individual. The rules for authoring [`linkage_keys`](#linkage_termslinkage_keys) under a both-sided match are in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#the-many-to-many-entity-closure).

A both-sided run reports how many clusters it formed, over how many records of each party, and for each cluster size the number of distinct matched values that formed it: `alcove exchange` on its report after the run, the browser on the completion panel. Clusters almost all one-to-one mean the match was close to one-to-one; a cluster far larger than the rest formed on a single value is a key that named a group rather than a person; one formed on several values was chained by a record that matched on more than one value of a key. Nothing is asked of your partner for this report, and nothing refuses on it. Under [`single-pass`](#linkage_termslinkage_strategy) only the receiver gets the report; its partner can group the result file's pairs but not count the values, which the result file does not hold.

### `expected_partner_deduplicate`

*Type:* boolean
*Required:* no
*Consistency:* none (a local record, never exchanged)

A top-level key of `alcove.yaml`, a sibling of `linkage_terms`: the [`deduplicate`](#linkage_termsdeduplicate) an accepted invitation declared for the *inviting* party's own side. An exchange run from this file refuses a partner presenting any other value at the terms exchange, before any key or payload moves. Every accept path records it: `alcove accept`, online and offline, and the browser's managed and console flows.

`linkage_terms.deduplicate` beside it is *your own* side, taken from your own app's control where it offers one and `false` otherwise, so the two may differ. The run reads the binding only from this key.

Omit it for an exchange you and your partner each authored from your own configuration files: an absent key holds the partner to nothing. Do not add one by hand: it records what an invitation stated, and a value you chose would abort a correct exchange.

```yaml
linkage_terms:
  deduplicate: false

expected_partner_deduplicate: true
```

### `linkage_terms.linkage_fields`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

The linkage fields define the standardized form of each PII element that participates in linkage. Each field has a name, a semantic type, and optional constraints. The name is a unique identifier used by linkage key elements and data standardizing transformations.

Constraints are not enforced by the application: they are standards both parties commit to meeting when preparing their data. The application warns when a value violates a constraint it can test at the value level (`exclude`, `allowed_characters`, and `valid_only`), but never transforms the data to satisfy it. `affixes_allowed` has no value-level test, so it is never checked and never warns.

Social Security Numbers must be formatted as `XXXXXXXXX` (nine-character numeric string, no dashes). Dates of birth must be formatted as `YYYYMMDD`. Converting raw input to these formats is the responsibility of each party's data standardization.

```yaml
linkage_terms:
  linkage_fields:
    - name: ssn
      type: ssn
      constraints:
        valid_only: true
        exclude:
          - "123456789"
          - "111111111"
    - name: ssn4
      type: ssn4
    - name: first_name
      type: first_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: first_name_raw
      type: first_name
    - name: last_name
      type: last_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: date_of_birth
      type: date_of_birth
```

#### Fields fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Identifier referenced by linkage key elements and standardization outputs |
| `type` | string | yes | The type of PII this field represents (see [Semantic types](#semantic-types)) |
| `constraints` | object | no | Data standards both parties commit to meeting when preparing this field |

#### Semantic types

| Value | Description |
|-------|-------------|
| `ssn` | Social Security Number (9-character string) |
| `ssn4` | Last four digits of SSN; distinct from `ssn` because some parties only possess the last four digits |
| `first_name` | Given name |
| `last_name` | Family name |
| `date_of_birth` | Date of birth |
| `phone_number` | Phone number |
| `email_address` | Email address |
| `street_number` | House number of a street address; canonical form is the leading digits with no leading zero |
| `street_name` | Name of the street in a street address, without the house number or unit; canonical form is uppercase with punctuation removed and the suffix and directionals in their USPS forms |
| `unit` | Apartment, suite, or other unit of a street address; canonical form is the unit's identifier, uppercase with punctuation removed, or a designator that needs none, such as `REAR` |
| `city` | City name; canonical form is uppercase with punctuation removed |
| `zip_code` | US ZIP code; canonical form is 5 digits, zero-padded |
| `state` | US state, District of Columbia, or inhabited territory; canonical form is the two-letter USPS code |
| `county` | County name; canonical form is uppercase with the word `COUNTY` and punctuation removed |
| `identifier` | Column that indexes a party's own records; never matchable |
| `other` | A column whose PII type is none of the above |

The first fourteen values are the complete type set for a `linkage_fields[].type`. `identifier` and `other` are valid only for a `metadata[].type`: inference assigns `identifier` to an `id`, `identifier`, `MRN`, `ClientID`, `PersonID`, `PersonalID`, `PatientID`, `RecordID`, `MemberID`, `_id`-suffixed, or record-number column (see the table under [Input metadata](#input-metadata)), and `other` is the type of a declared column with no linkage type. A `linkage_fields[].type` set to either is rejected.

The column names each type is inferred from are in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names), and the cleaning steps for each type in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#per-type-pipelines). An inferred column of any type below is not sent as payload unless you mark it so.
- **`street_number`** is inferred only from a number-named column (`street_number`, `house_number`, `address_number` and their short spellings), not from an address-line column such as `address`, `street_address`, or `address1`; to match on the number such a column starts with, type it `street_number` in your `metadata`. The value is cleaned to the number it starts with, so `123 Main St Apt 4` and `123` both match as `123`, and a value that does not start with a digit is dropped. Its built-in key is `LN + FN + DOB + street number + ZIP5`. The column must hold each person's own address, never that of a site that serves them ([rules for leading zeros, ranges, and fractions](spec/DEFAULT_STANDARDIZATION.md#street_number)).
- **`street_name`**, **`unit`**, and **`city`** are inferred from `street_name`; `unit`, `unit_number`, `apartment`, or `apt`; and `city` or `city_name`. A `street` or `address2` column is not inferred; type it in your `metadata` to match on it. None of the three has a built-in key. Each value is cleaned to uppercase with single spaces and no punctuation, so `St. Mary's Rd` and `ST MARYS RD` match; a street name's suffix and directionals take their USPS Publication 28 forms, so `North Main Street` and `N Main St` match; a unit keeps only its identifier, so `Apt 4B`, `Unit 4B`, `#4B`, and `4B` match, while `Rear` or `Basement` keeps its designator. A blank or all-punctuation value, `Unknown`, `Unk`, or `None`, and a unit of `N/A`, are dropped. A city name is not abbreviated or expanded: `St Louis` and `Saint Louis` do not match ([cleaning steps](spec/DEFAULT_STANDARDIZATION.md#street_name)).
- **`zip_code`** is inferred from `zip` and its spellings. Its built-in keys each put it beside a name and a date of birth. A key element can match on the three-digit ZIP area with the [`zip3`](#string-transformation) transform: `02139` matches as `021`, as the built-in rule `LN + FN + DOB + ZIP3` does.
- **`state`** is inferred from `state`, `state_code`, or `state_name`, and **`county`** from `county` or `county_name` (the no-separator spellings too). Their built-in keys are `LN + FN + DOB + STATE` and `LN + FN + DOB + COUNTY`; the county key is selected for any pair of files ([Choosing the built-in rules](#choosing-the-built-in-rules)), and the state key runs first where a file has both. A state is cleaned to its two-letter code from the full name or the code, and any other value is dropped. A county name is cleaned to uppercase with the word `COUNTY` and punctuation removed.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `date_of_birth` | Must be a valid date |
| `exclude` | array of strings | any | Values that must not appear in the data; useful for filtering placeholder values such as `123456789` and `111111111` for SSNs |
| `allowed_characters` | string | name fields | Regex character class; characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr., etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

The table above is the complete set of constraints. A constraint not listed for a given semantic type, such as `allowed_characters` on an `ssn` field, is refused as an unrecognized key in your own configuration, like any other key the schema does not read. In a partner's terms it is dropped.

---

### `linkage_terms.linkage_keys`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

An ordered list of linkage keys applied in sequence, in the order listed. Each round of the PSI protocol matches only records not yet resolved in a prior round. Each element references a linkage field by name and may optionally specify transformations applied to that field's canonical value before it is concatenated into the key.

The name of each linkage key must be unique. The elements within any linkage must either reference a unique linkage field or have an alias that is unique. Each element's `field` must name a declared linkage field (a `name` from `linkage_terms.linkage_fields`); a key that references an undeclared field is rejected when the terms are decoded, rather than silently collapsing to an empty key at exchange time.

```yaml
linkage_terms:
  linkage_keys:
    - name: "SSN4 + Last Name + DOB"
      elements:
        - field: ssn4
        - field: last_name
        - field: date_of_birth
    - name: "SSN + Last Name (4) + First Initial"
      elements:
        - field: ssn
        - field: last_name
          transform:
            - function: substring
              params:
                start: 1
                length: 4
        - field: first_name
          transform:
            - function: substring
              params:
                start: 1
                length: 1
    - name: "SSN, all two-digit transpositions"
      elements:
        - field: ssn
          transform:
            - function: substring
              params:
                start: 1
                length: 9
          generate_fuzzy_comparisons: transpositions
```

#### Key fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name for this key |
| `elements` | array | yes | Data elements combined to form the key |
| `swap` | array | no | An array of two field names (or element `name` values) for which the receiver swaps their data elements for this key (see below) |
| `condition` | object | no | `missing_field`: the name of a `date_of_birth` linkage field. The key then matches only pairs where one side's record has no valid value for that field ([Keys that run only where a field is missing](#keys-that-run-only-where-a-field-is-missing)) |

#### Element fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | yes | Name of a linkage field from `linkage_terms.linkage_fields` |
| `name` | string | no | Optional alias for this element; used when the same field appears more than once in a key, or as the target of a `swap` |
| `transform` | array | no | Sequence of transformation steps applied to the canonical field value before concatenation into the key |
| `generate_fuzzy_comparisons` | string | no | Method for generating additional values for fuzzy matching, applied after any transformation: `transpositions` generates every two-position transposition of the value (all pairs of positions, not adjacent ones alone); `edit_distances` generates all single-character deletions, matching values within one edit distance; `adjacent_years` generates dates +/- 1 year from the input; `adjacent_days` generates the day before and the day after, across month and year ends and February 29; `day_month_swaps` generates the date with its day and month exchanged, where that is a real calendar date |

**Cost toward the `single-pass` ceiling.** An element declaring an expansion costs the candidate values it can reach toward the [`single-pass`](#linkage_termslinkage_strategy) dataset ceiling, in place of 1. The count follows the width the element's own `transform` bounds its value to: a `substring` to 10 characters costs 11 for `edit_distances` and 46 for `transpositions`; an element whose transforms bound no width costs the full 128-character expansion limit (129 for `edit_distances`) and exceeds the per-key ceiling on its own. `adjacent_years` and `adjacent_days` cost 3 and `day_month_swaps` 2, whatever the width. Bound the element with a transform that fixes its width - a `substring` to a length, a `phonetic` code, a `parse_date` layout. The arithmetic is in [PROTOCOL.md](spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).

**Bounding a `transpositions` element.** Its count grows with the square of the width. An element declaring `transpositions` must bound its value with a width-fixing transform; terms whose element bounds none are refused before the exchange runs. The widest width allowed, alone or with two stacked elements, is in [PROTOCOL.md](spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions).

**The date kinds need a `parse_date` ahead of them.** An element declaring `adjacent_years`, `adjacent_days`, or `day_month_swaps` needs a `parse_date` transform emitting the default `YYYYMMDD` layout before it. On the receiving party, the first row whose value is not eight digits refuses the exchange; the sending party does not expand and sends such a row's exact value, so whether a file holding such a row refuses depends on which party resolves as the receiver. An eight-digit value that is no real calendar date, such as `19990229`, emits no candidate.

**Which party expands.** `transpositions`, `adjacent_years`, `adjacent_days`, and `day_month_swaps` are generated by the receiving party alone, and the result is the same whichever party that is. `edit_distances` is generated by both parties. This follows from the method named and is not authored ([one-sided-fuzzy-expansion.md](notes/one-sided-fuzzy-expansion.md)).

#### Transform steps

Each step in a `transform` array applies one function from the cleaning and standardizing function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions in the [Data standardization](#data-standardizing-transformations) section) |
| `params` | object | no | Function-specific parameters |

#### Swapped keys

When a `swap` array is present, the receiver transmits the linkage key in both orders - as authored, and with the two named elements exchanged - and the sender transmits the authored order alone, so records whose two values agree and records whose two values are reversed both match. For example, a key might match first name swapped with last name to catch names reversed at one agency. The result is the same whichever party resolves to the receiver ([one-sided-fuzzy-expansion.md](notes/one-sided-fuzzy-expansion.md)).

A `swap` target names an element by its `name` if it declares one, otherwise by its `field`. The terms are rejected when they are decoded if:

- a target matches no element of its key;
- the two elements declare different [`generate_fuzzy_comparisons`](#element-fields) (both must declare the same value, or neither one);
- the two elements declare different [`transform`](#element-fields) pipelines. An omitted `transform` and an empty list are the same pipeline, and `params` keys are compared without regard to order. Cleaning that belongs to one column rather than to the key goes in that column's [data standardizing transformation](#data-standardizing-transformations).

A swapped key costs two candidate values per record toward the [`single-pass`](#linkage_termslinkage_strategy) dataset ceiling, in place of one, multiplied by whatever its elements declare. It is a candidate set, so a count-only exchange refuses it ([Fan-out (multi-value fields)](#fan-out-multi-value-fields)).

#### Keys that run only where a field is missing

A key with a `condition` matches only pairs where one side's record has no valid date of birth. It keeps a key without the date, such as first name, last name, and the last four SSN digits, from matching two people who share those values and have different dates:

```yaml
linkage_terms:
  linkage_keys:
    - name: "FN + LN + SSN4, one side without a date of birth"
      elements:
        - field: first_name
        - field: last_name
        - field: ssn4
      condition:
        missing_field: date_of_birth
```

- **What counts as missing.** A date your cleaning drops: an empty cell, a value that does not parse, a date before 1900, or one on the placeholder list, and a date whose month and day are both 01 ([filler dates](spec/DEFAULT_STANDARDIZATION.md#filler-dates)). A missing date is never read as a disagreement.
- **Which pairs it matches.** A pair where both records have a valid date is not matched by this key, whether the dates agree or not. Put the keys that match on the date before it.
- **How it runs.** As two rounds, in each of which one side sends only its records without a date and the other sends all of its records. It is one key in the terms, the consent display, and the review, and it costs two candidate values per record toward the [`single-pass`](#linkage_termslinkage_strategy) dataset ceiling.
- **What it tells the partner.** A party receiving the result learns, for each pair matched through the key, which record had no valid date of birth. Whatever its role, your partner also learns how many of your records not yet matched at the key have no valid date of birth. Both parties' displays state both, and where no other key matches on the date of birth they list it as `date of birth (only whether it is present)`.
- **An input with no column for the field.** The key runs with every record counted as having no valid date of birth. A date-of-birth column whose name Alcove does not recognize ([the column names it infers from](spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names)), such as `birth_dt`, counts as no column; declare it in the [input metadata](#input-metadata) with `type: date_of_birth` and `role: linkage`. A column your `standardization` or `metadata` names that the file does not have is refused.
- **What is refused.** The terms are rejected when they are decoded if `missing_field` names a field not in `linkage_fields`, a field that is not a `date_of_birth`, or a field one of the key's own elements matches on, and when `algorithm` is `psi-c`.

The specification is in [PROTOCOL.md](spec/PROTOCOL.md#keys-with-a-missing-field-condition).

### `linkage_terms.legal_agreement`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Reference to the legal data sharing agreement authorizing this exchange, the purpose of the disclosure under it, and the agreement's expiration date. A single agreement can authorize several purposes; `purpose` is a brief readable statement of the one this exchange is for, recorded in cleartext into the exchange record so the record stands alone as a HIPAA 164.528 accounting / FERPA 99.32 disclosure-log entry. All three fields are required when the block is present, and `reference`, `purpose`, and `expiration_date` are each cross-checked against the partner's; a mismatch cancels the exchange. The check is byte-exact, so both parties must configure identical text -- including the same Unicode normalization form; the same wording in a different normalization counts as a mismatch. If `expiration_date` has passed, the exchange fails before any data is transmitted.

```yaml
linkage_terms:
  legal_agreement:
    reference: "MOU-2025-0042"
    purpose: "Audit and evaluation of the State tutoring program"
    expiration_date: "2027-12-31"
```

### `linkage_terms.payload`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Additional data columns transmitted after the intersection is identified, over the established encrypted channel. Each party independently specifies what they will send and what they expect to receive. Column descriptions sent to the partner constitute a data dictionary.

```yaml
linkage_terms:
  payload:
    send:
      - name: "enrollment_date"
        description: "Date of program enrollment (YYYY-MM-DD)"
      - name: "benefit_amount"
        description: "Monthly benefit amount in USD"
    receive:
      - name: "case_id"
        description: "Partner agency case identifier"
```

A party that declares it receives no output (`output.expects_output: false`) may not list `payload.receive` columns: it cannot receive payload for matched records it never gets, so the combination is refused. A non-receiving party is sent no payload and refuses any it is sent regardless, so a non-receiving helper never receives the partner's disclosed columns. It may still `send` payload (to a partner that does receive output).

`payload.send` and `payload.receive` are the exchanged data dictionary, cross-checked as a mirror (one party's `send` against the other's `receive`) at every run's terms exchange, before any key or data moves. In practice you rarely author either: accepting an invitation sets `payload.receive` from the invitation's `send`, a recurring exchange fills an unset one on its first run, and inviting or [`alcove update`](CLI.md#changing-the-terms-of-an-established-partnership) writes `payload.send` from your metadata.

- **`payload.send`** -- the columns this party discloses. At the terms exchange a run states the columns its [input metadata](#input-metadata) actually transmits (`is_payload: true` and `role` not `ignored`), so the dictionary shown for consent and written into the [exchange record](spec/EXCHANGE_RECORD.md) matches what flows. A `send` naming exactly that set is stated as written, descriptions included; one that differs is replaced by the transmitted set, and your partner meets the difference as a [change to your terms](#when-your-partners-terms-change). Where the configuration lists a `payload.send` and the metadata sends a column it does not list, the run warns before it connects, naming the column. An `alcove invite`, an `alcove update`, and every web app invitation state the transmitted set wherever the metadata is known, and one made from the configuration rewrites `payload.send` to it and warns. A web re-invitation from a saved exchange states it from the saved metadata, or repeats the saved `send` where no metadata was saved.
  - Accepting an invitation that declares `receive: []` gives you `send: []`. If your metadata then transmits a column (one declared `is_payload: true`; inference sends none), your partner meets it as a terms change and refuses it unless it takes it on. Mark such columns `is_payload: false` (or `role: ignored`) to send none.
  - A partner entitled to no result is sent no payload, so there `send` is stated as written.
- **`payload.receive`** -- what this party expects to be disclosed. Declaring it, including an explicit `receive: []`, is strict: a partner whose stated `send` differs is a [terms change](#when-your-partners-terms-change) this party takes on or refuses before any linkage round, association table, or payload moves, under either [linkage strategy](#linkage_termslinkage_strategy). Omitting it lets an invitation be made without knowing the partner's columns: a recurring exchange fills it on its first run ([Leaving `payload.receive` unset](#leaving-payloadreceive-unset)), and a one-off run takes whatever the partner sends. Omitting it never changes what is disclosed: each sender's own metadata governs what it sends. A received payload is not checked against it again after it arrives.
  - Where you declared `expects_output: false`, your partner sends no payload, so the empty `receive` required of you there contradicts nothing.
  - To go ahead with columns a strict `receive` refuses, list them in your `receive`, or remove `receive` so a recurring exchange sets it on its next run; to go ahead with none, have your partner mark them `is_payload: false` (or `role: ignored`).

Each list names a column once. A column named twice, in your own file or in a partner's invitation, is read once: the first entry stands, with its description, and the exchange does not fail.

How the terms exchange holds both lists, and how an unset `payload.receive` is filled on the first run, are specified in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md#payload-disclosure-consent).

#### Leaving `payload.receive` unset

Leave `payload.receive` out, and the first run of a recurring exchange fills it in:

- Once the terms exchange has passed its checks, before any key or data moves, the run records the columns your partner's terms declare it sends as your `payload.receive`. `alcove exchange`, the online `alcove invite` and `alcove accept`, and a quick exchange run with `--save` write them into the `alcove.yaml` they run from; the web app writes them into the saved recurring exchange on its first run from Recurring exchanges. On the [console](CONSOLE.md), they go into the `alcove.yaml` the console composes for that one run, not into the one in your working folder or the [recurring-run configuration](CONSOLE.md#graduating-to-a-scheduled-run) it hands back, so add them there yourself under `linkage_terms.payload.receive`; a console quick exchange records them nowhere.
- A command-line run at a terminal first shows the columns your partner declares and asks whether to take them. Yes records them and the run continues; no ends the run (exit 64) before any of your linkage keys or data are sent. A partner declaring no column is not asked about. See [CLI.md](CLI.md#your-partners-first-payload-columns).
- A run with no terminal on stdin, an `INPUT_FILE` of `-`, an `alcove accept --consent-to-terms`, or a run the console drives takes the columns without asking. A command-line run writes one line naming the columns and the configuration it wrote them to, at every log level, and on its event stream; the web app and the console's run view show them.
- Every later run holds your partner to that list.
- If the list cannot be written, for example because the file is read-only, the run stops before any data moves, naming the file.

`alcove init` and the configuration `alcove invite` writes leave the key out, with a comment where it would go. Nothing is filled for an explicit `receive: []`, a count-only (`psi-c`) configuration, one with `expects_output: false`, or a run refused at the terms exchange. A one-off exchange - a quick exchange without `--save`, or a web exchange run from the invitation - records nothing and takes whatever the partner sends. Filling the list is not a terms change; a later difference from it is.

#### When your partner's terms change

Your terms state the columns your input metadata sends, whatever `payload.send` lists. When you add or drop a payload column in your input, just run: your partner meets the new set as a change to its terms at the terms exchange, before any key or data moves.

The party whose terms differ from its partner's decides on what it receives: the columns its partner now sends or no longer sends, compared against its `payload.receive`, a narrowing decided as an addition is. Columns it sends that its partner's terms do not receive are shown too, but are the partner's to decide. Any other agreed term that differs - a legal agreement, the linkage keys - is part of the same change, and the party that receives the first terms message (the responder) is the one asked about it. To have your partner take on a change you made by hand, send it with [`alcove update`](CLI.md#changing-the-terms-of-an-established-partnership).

What a run shows and does when it meets a change - the prompt at a terminal, the refusal (exit 64) and `alcove.proposed-terms` file when unattended, and the changes no run can continue under, including a partner `deduplicate` other than the one [`expected_partner_deduplicate`](#expected_partner_deduplicate) holds - is in [CLI.md](CLI.md#when-your-partners-terms-change). The web app's handling is in [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#when-your-partners-terms-change) and the console's in [CONSOLE.md](CONSOLE.md#when-your-partners-terms-change).

---

## Connection

Specifies the communication channel and server addresses. The partner shared secret is configured separately, in the top-level [`authentication`](#authentication) block; for WebRTC, the inviter/acceptor peer-addressing role is [`connection.role`](#connectionrole).

### Connection blocks by channel

The smallest block each channel takes, to paste into `alcove.yaml` in place of the placeholder `alcove init`, `alcove invite`, and `alcove accept` write. Every field is described in the sections below; the tuning under [`connection.options`](#connectionoptions) is optional everywhere.

**SFTP** -- both parties connect to one SFTP server and exchange files in a directory there:

```yaml
connection:
  channel: sftp
  server:
    host: sftp.example.org
    port: 22
    path: /exchanges/agency-a-agency-b/
    username: alcove
    private_key: "@/run/secrets/id_ed25519"
```

Supply exactly one credential beside `username`, `password` or `private_key`, best written as an [`@`-file reference](#file-references). The server's host key is pinned in [`host_key_fingerprint`](#sftp-server-authentication), which an interactive first run records for you.

**Shared-folder** -- both parties read and write one directory each has mounted (a network share, or a folder a sync tool keeps in step with the partner's):

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

There is no server and no credential: access to the directory is the access control. For separate drop and pickup folders, use the [`inbound_path`/`outbound_path`](#connectioninbound_path--connectionoutbound_path) pair.

**WebRTC** -- both parties connect through a coordination server and exchange data over a direct peer-to-peer channel:

```yaml
connection:
  channel: webrtc
  server:
    host: api.peerjs.com
    port: 443
  role: inviter
```

The peer addresses are derived from the shared secret; [`connection.role`](#connectionrole) is `inviter` on the party that issued the invitation and `acceptor` on the party that accepted it. `alcove accept` writes this block whole from the invitation, including the invitation's relay as [`invitation_relay`](#connectioninvitation_relay).

A webrtc connection takes only the keys listed below; any other, such as `allowed_relay` for [`allowed_relays`](#connectionallowed_relays) or a `server` key written beside `server`, is a usage error (exit 64) naming the key.

**Which to pick.** [COMMUNICATION.md](COMMUNICATION.md#channels) describes each channel and [DEPLOYMENT.md](DEPLOYMENT.md) how to operate it. The two parties need not name the same file-based channel: one party's `filedrop` mount can be a directory the other reaches over `sftp`. Both parties must be on WebRTC to use it.

### `connection.channel`

*Type:* enum: `webrtc` | `sftp` | `filedrop`  
*Required:* yes

The communication channel for the exchange. See [COMMUNICATION.md](COMMUNICATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for infrastructure requirements for each channel.

| Value | Description |
|-------|-------------|
| `sftp` | Parties connect to a shared SFTP server and exchange files there |
| `webrtc` | Both parties connect via a PeerJS coordination server and exchange data over a WebRTC data channel |
| `filedrop` | Parties exchange files through a locally-mounted directory (e.g. a network folder backed by an SFTP server, to which their partner connects directly) |

### `connection.path`

*Type:* string  
*Required:* filedrop only, unless the split [`inbound_path`/`outbound_path`](#connectioninbound_path--connectionoutbound_path) pair is used instead  
*Applies to:* `filedrop`

Absolute path to the shared folder on the local filesystem, used in shared mode (one directory both parties read and write). Both parties must be able to read and write files in this directory. Use `file://` URLs with the CLI for quick exchanges. Mutually exclusive with the `inbound_path`/`outbound_path` pair; supply exactly one of the two forms.

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

### `connection.inbound_path` / `connection.outbound_path`

*Type:* string  
*Required:* no (the split alternative to a single shared folder)  
*Applies to:* `filedrop` (top-level) and `sftp` (under `server`, see below)

A *split* configuration for deployments where the inbound and outbound folders are separate - a managed share, or an SFTP server with distinct drop and pickup directories. This party reads the peer's files from `inbound_path` and writes its own to `outbound_path`; the deployment bridges the two parties' folders (one party's outbound is the other's inbound). Each party chooses its own directories.

Rules:

- Set both halves together, or neither; the pair is mutually exclusive with the single `path` (filedrop) / `server.path` (sftp).
- The two directories must differ. This is checked at config validation and again when the connection opens, after normalizing redundant separators, `.` segments, a trailing slash, and, for filedrop, backslashes. Not caught, and the operator's to keep distinct: `..` segments (which may cross a symlink), case (Windows filesystems are case-insensitive), and, for SFTP, a relative path versus the absolute path it expands to under the login home.
- A split configuration requires retain mode (`options.retain_files: true`), which in turn requires `lockless_rendezvous: true` and `timestamp_in_filename: true`; see [docs/spec/FILE_SYNC.md](spec/FILE_SYNC.md#split-inboundoutbound-directories).
- filedrop paths must be absolute. SFTP paths may be absolute or relative. Retain mode requires a fresh directory, enforced for *both* directories; an SFTP login home is usually not empty and will often be rejected.

```yaml
# Shared-folder with separate inbound and outbound folders
connection:
  channel: filedrop
  inbound_path: /mnt/share/from-partner
  outbound_path: /mnt/share/to-partner
  options:
    retain_files: true
    lockless_rendezvous: true
    timestamp_in_filename: true
```

**From the CLI.** Pass `--outbound-path DIR` on the quick exchange, `alcove invite`, `alcove accept`, or `alcove exchange`. The directory the command already names becomes the inbound directory - the server URL or positional path for the quick exchange, invite, and accept, or the loaded config's directory for `alcove exchange` - and `--outbound-path` becomes the outbound. It applies to `sftp` and `filedrop`, is validated under the same rules, and requires retain mode: pass `--retain-files` (which implies `--lockless-rendezvous` and `--timestamp-in-filename`), or, for `alcove exchange`, have `retain_files: true` in the config. Each party sets its own.

```sh
# Quick exchange over split shared folders: read your partner's files from
# from-partner, write your own to to-partner, retaining a transcript of both.
alcove --retain-files --outbound-path /mnt/share/to-partner \
  file:///mnt/share/from-partner records.csv ./results/
```

**Mirror relationship across an invitation.** When an invitation holds a split-directory endpoint, the acceptor's seeded connection block is the inviter's mirror image: the acceptor's `inbound_path` is the inviter's `outbound_path`, and its `outbound_path` the inviter's `inbound_path`. `alcove invite` writes the inviter's own pair onto the endpoint and the swap is applied only on the accepting side. The seeded block also holds the retain-mode options, so it is runnable once the credential placeholders are filled in. Two fixed container mounts, such as `/data/in` and `/data/out`, can therefore stay the same on both sides. Where the two parties' paths or channels differ (one party syncing a local `file:///` directory to a server the other reaches over `sftp://`), the operator edits the paths, host, and channel in the normal accept flow. An SFTP login-home (unset) path conveys the roles with no suggested path.

### `connection.server`

*Type:* object  
*Required:* yes (webrtc and sftp only)  
*Applies to:* `webrtc`, `sftp`

The primary server for the exchange. For WebRTC this is the PeerJS coordination server; for SFTP this is the SFTP host. A URL may be supplied as a convenience and will be decomposed into its component fields; the component fields are the authoritative form. The component fields are percent-decoded from the URL form, so author a reserved or non-ASCII character percent-encoded in the URL (for example a space as `%20`); it is stored decoded.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes, except beside a create-mode `provision` | Hostname or IP address; a create-mode `server` may leave it out for `alcove invite` to fill (see [On-demand server provisioning](#on-demand-server-provisioning)) |
| `port` | integer | no | Port number. Unset, it is 22 for SFTP, the SSH library's default, to which Alcove passes no port; and 443 for WebRTC signaling, or 80 when `secure` is `false` |
| `path` | string | no | URL path for WebRTC signaling; remote working directory (shared mode) for SFTP |
| `inbound_path` | string | SFTP only | Inbound (peer-written) remote directory for a split-directory exchange; see [`connection.inbound_path` / `connection.outbound_path`](#connectioninbound_path--connectionoutbound_path). Set with `outbound_path`; mutually exclusive with `path`; requires retain mode |
| `outbound_path` | string | SFTP only | Outbound (self-written) remote directory for a split-directory exchange; the companion to `inbound_path` |
| `username` | string | SFTP-consumed; accepted but unread on webrtc | Username for server authentication |
| `key` | string | WebRTC only | PeerJS API key for private PeerJS servers; omit when using a public server. Defaults to `peerjs`, the key a PeerJS deployment serves under unless it is configured otherwise |
| `secure` | boolean | WebRTC only | Whether the signaling socket is opened over TLS (`wss:`) rather than plain `ws:`. Defaults to `true`. Set `false` only for a server reached with no network in between, such as a loopback or test server: signaling carries the derived rendezvous ids and both parties' candidate addresses. A browser peer has no equivalent field: it takes the scheme from the page it was served over. The `port` default follows it - 443 when secure, 80 otherwise - and `path` defaults to `/` |

#### SFTP server authentication

SFTP requires at most one primary authentication method alongside `username`. `private_key_passphrase` is a companion to `private_key` and is invalid without it.

| Field | Type | Description |
|-------|------|-------------|
| `password` | string | Password authentication; `@`-file recommended |
| `private_key` | string | Path to SSH private key; `@`-file recommended |
| `private_key_passphrase` | string | Passphrase for an encrypted private key; only valid with `private_key`; `@`-file recommended |
| `keyboard_interactive` | boolean | Answer the server's `keyboard-interactive` authentication prompts with `password`, in addition to offering the direct `password` method; only valid with `password`. Enable this for a server that disables the SSH `password` method but accepts the same password over `keyboard-interactive`. Every prompt is answered with the same configured password, so it cannot satisfy a multi-prompt or one-time-code challenge. Default `false`. Applies to the CLI `sftp` channel only. |
| `host_key_fingerprint` | string or list | OpenSSH SHA256 host-key fingerprint (`SHA256:<43 standard base64 chars>`, the `+`/`/` alphabet OpenSSH emits, not base64url), or a non-empty list of them. When set, the server's host key is verified before authentication and the connection is rejected unless it matches one listed fingerprint. A list allows host-key rotation with no failed exchange: pin the incoming key beside the current one for the rekey window, then drop the old entry. When absent, a non-interactive run is refused and an interactive run prompts with the presented fingerprint and records it on confirmation; see [CLI.md](CLI.md#sftp-host-key-trust). `alcove invite` also writes it from a [create-mode provisioning answer](#how-alcove-invite-calls-a-create-mode-endpoint) that states one. `@`-file supported (per entry). Applies to the CLI `sftp` channel only. |

A whole `sftp` block with a credential in it, and the block each other channel takes, is under [Connection blocks by channel](#connection-blocks-by-channel).

```yaml
# SFTP host-key rotation: pin the incoming key alongside the current one for the
# rekey window so either is accepted, then drop the old entry after the cutover.
connection:
  channel: sftp
  server:
    host: sftp.example.org
    host_key_fingerprint:
      - "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s" # current
      - "SHA256:0PNQ1x9Pe3aaFqkPq0n8Uihhi8nN2nx2nKQ0gWqXm8s" # incoming
```

#### On-demand server provisioning

When the primary server is brought up on demand rather than always running, a `provision` sub-object can be added to `server`. It names an HTTPS endpoint that Alcove calls to bring the server up. Its `mode` says which of two things the endpoint does:

- **`start`** (the default): the server has a fixed, known address and is started on demand so it uses no resources between exchanges. The static `host` and other `server` fields are in both parties' configs beside `provision`, and `alcove exchange` calls the endpoint before every run. An online `alcove invite` or `alcove accept` and a quick exchange call it too, taking the block from `--server-provision`. Both parties may call it independently.
- **`create`**: the endpoint makes a new server and answers with its address. The inviting party calls it once, with an offline `alcove invite` from its configuration; the invitation names the returned address, and the invite writes it into this configuration's `server`. Every later `alcove exchange` of this configuration connects to that written address without calling the endpoint, until the next invitation creates another server. The accepting party's configuration is seeded from the invitation and holds only static `server` fields.

Alcove never stops or deletes the server in either mode: stopping an idle server, or deleting a created one after its exchanges, is the endpoint's or its operator's job.

The fields, a misspelled one refused:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string (`start` \| `create`) | no | `start` when unset; any other value is refused, naming it |
| `host` | string | yes | Hostname of the provisioning API |
| `port` | integer | no | Port, 1-65535; defaults to 443 |
| `path` | string | no | API path; defaults to `/` |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

```yaml
# Start mode: wake a serverless PeerJS instance before connecting
connection:
  channel: webrtc
  server:
    host: peerjs.example.org
    port: 443
    provision:
      host: api.example.org
      path: /peerjs/start
      auth:
        bearer: "@provision.key"
```

```yaml
# Create mode: alcove invite makes a new SFTP server and writes its address
connection:
  channel: sftp
  server:
    username: alice
    private_key: "@~/.ssh/id_ed25519"
    provision:
      mode: create
      host: api.example.org
      path: /sftp/create
      auth:
        bearer: "@/run/secrets/provision.key"
```

A create-mode `server` may leave `host` out, as above: the first `alcove invite` from the configuration writes the address the endpoint returns. Until then the configuration has no server to connect to, so `alcove exchange` and `alcove accept` refuse it, naming `connection.server.host` and `alcove invite` as the step that fills it. A start-mode `server`, and one with no `provision`, requires `host`.

##### How `alcove exchange` calls a start-mode endpoint

The call runs once per run, before the run's first connection to the server, [SFTP host-key trust](CLI.md#sftp-host-key-trust) included. Every check the run can make without contacting anything comes first, so a run refused by one of them sends nothing: the configuration and key file, the input file and linkage terms, the signing identity, the shared secret's format and expiry, and, on an SFTP server with no pinned host key, whether the run is interactive. Host-key confirmation and verification, the key exchange, and terms agreement come after it. A `2xx` answer means the server now accepts connections, and the run connects to the static `server` fields. Each party calls independently, in either order or at once, so the endpoint must tolerate one call from each. Any other answer stops the run; the request and how an answer maps to an exit code are in [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#server-provisioning-endpoint-call).

An online `alcove invite` or `alcove accept`, and a quick exchange, take a start-mode block from `--server-provision` and its credential flags instead ([Starting the server on demand](CLI.md#starting-the-server-on-demand)), and send the call at the same point with the same exit codes: after the checks they can make from their own inputs and before the host-key probe and the first connection. An online invite sends it after printing the invitation. The configuration an online invite or accept, or a quick exchange with `--save`, writes keeps the block with its `@path` references, so every later `alcove exchange` sends the same call. An invitation never carries the block: each party states its own endpoint and credential.

##### How `alcove invite` calls a create-mode endpoint

An offline `alcove invite` from a configuration whose `server` states a create-mode `provision` sends the call after every check it can make from its own inputs (the configuration, the key-file path, the input file against the linkage terms) and before it creates the invitation. The endpoint answers `2xx` with a JSON object holding `host` and, optionally, `port`, `path`, and, for an SFTP server, `host_key_fingerprint`, and nothing else:

```json
{"host": "sftp-17.example.org", "port": 22, "path": "/exchange", "host_key_fingerprint": "SHA256:EXAMPLEfingerprintEXAMPLEfingerprintEXAMPLE"}
```

The invitation names that address, and the invite writes `host` into the configuration's `connection.server`, and `port` and `path` when the answer states them, keeping every other field and the `provision` block. An answer the endpoint's status refuses, or one that is too large, not JSON, or holds a field out of range or any other field, stops the invite before it prints an invitation or writes the key file; the answer's limits and the exit codes are in [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#server-provisioning-endpoint-call).

The created server's host key:

- **The answer states `host_key_fingerprint`.** It must be the server's key fingerprint in OpenSSH SHA256 form (`SHA256:` followed by 43 base64 characters); any other value stops the invite as above. The invite writes it into `connection.server.host_key_fingerprint`, replacing any pin already there, so every later run connects only to a server presenting that key. A webrtc configuration has no host key to pin, so an answer stating one for it stops the invite.
- **The answer leaves it out.** The invite leaves `connection.server.host_key_fingerprint` as it is. With no pin, the first run confirms the server's key on first use ([SFTP host-key trust](CLI.md#sftp-host-key-trust)). A pin already in the configuration stays, so a created server presenting a different key fails it at the next run; remove it to confirm the new key on first use.

An invitation over SFTP names no host-key fingerprint, so the accepting party confirms the new server's key on first use either way.

An invite that stops after the call may leave a server the endpoint created and no configuration names; Alcove does not delete it:

- When the endpoint's answer is a usable address that this configuration's `server` block cannot hold -- a returned `path` beside `inbound_path`, for example -- the refusal names the created server's host (never the returned path, which may hold a token).
- When the answer itself is refused -- by its status, or as too large, not JSON, or holding a field out of range or any other field -- or does not arrive in time, Alcove has no address it can show. The endpoint's own logs are the lead for finding the server and removing it.

### `connection.role`

*Type:* string (`inviter` | `acceptor`)  
*Required:* no  
*Applies to:* `webrtc`

Records this party as the inviter or acceptor for WebRTC peer addressing. It is independent of the PSI protocol roles, which [`linkage_terms.output`](#linkage_termsoutput) determines. For `sftp` and `filedrop` the field is not part of the schema and is refused as an unrecognized key.

**Required on a `webrtc` connection the CLI runs, and the two parties must differ.** Each party's PeerJS peer ID is derived from the shared secret and its own label, and it dials the ID the other's label derives. A CLI configuration missing it is a usage error before anything is dialed, and two parties with the same value fail at the coordination server with an ID collision. It also fixes the key-exchange role (`acceptor` -> initiator, `inviter` -> responder), so do not edit it to fix a connection.

`alcove invite` and `alcove accept` set it on every WebRTC connection block they write. A web app's `http://`/`https://` address or a `ws://`/`wss://` URL given to `alcove invite` builds the webrtc connection block and an invitation naming the same host, port, and path; `alcove accept` seeds its block from that endpoint. See [Inviting over WebRTC](CLI.md#inviting-over-webrtc). The web application supplies the label from its own flow.

```yaml
connection:
  channel: webrtc
  server:
    host: api.peerjs.com
  role: inviter
```

### `connection.stun`

*Type:* array  
*Required:* no  
*Applies to:* `webrtc`

STUN servers for ICE candidate gathering. Each entry is a `stun:` or `stuns:` URI that names a host. Refused, with an error naming the entry and the refused part but never the url: a scheme with no host (`stun:`), a user before the host (`stun:user@host`), a query string (`stun:host:3478?x=1`), a path (`stun:host:3478/x`), or a fragment (`stun:host:3478#x`). Mutually exclusive with `ice_provision`.

> **Honored by the CLI only.** A `stun` list replaces the CLI's built-in default; a run that lists no STUN url, including one that lists only `turn`, uses the default. The CLI queries only the first STUN url it lists ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)). The browser takes its servers from its own relay setting ([WEB_APP.md](WEB_APP.md#relay-settings)), so these fields change nothing a browser gathers. The default, what it discloses, and the idiom for gathering host candidates only are in [CLI.md](CLI.md#stun-and-what-it-discloses).

```yaml
connection:
  stun:
    - "stun:stun.example.org:3478"
    - "stuns:stun2.example.org:5349"
```

### `connection.turn`

*Type:* array  
*Required:* no  
*Applies to:* `webrtc`

TURN servers for the case where a direct peer-to-peer connection cannot be established. Mutually exclusive with `ice_provision`.

The CLI passes these entries to its peer connection; the browser uses its own relay setting instead ([WEB_APP.md](WEB_APP.md#relay-settings)). Which of the relays it lists, these and the [invitation's](#connectioninvitation_relay), a CLI run allocates on is [the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator); [`allowed_relays`](#connectionallowed_relays) narrows them. What a relayed run has been verified to do, the certificate the CLI requires of a relay, and the refusals at run time are in [CLI.md](CLI.md#turn).

A `url` may set no query parameter other than `transport`, and no path or fragment (`turns:host:443/x`, `turn:host#x`); a `url` holding an `@` is refused as naming a user before its host. A refusal names the entry and the refused part and never repeats the url or a value, so a credential pasted into the url is not echoed. Credential type `hmac-sha1` describes how a deployment issues a time-limited credential; the issued value is still sent as the password, so both types take the same shape here.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | TURN server URI: `turn:` or `turns:` followed by a host, with `transport` unset or lowercase `tcp` (`udp` too on a `turn:` url). A host-less `turn:`, a user before the host (`turn:user@host` -- the credential goes in `username` and `credential`), a path, a fragment, or any other `transport` value, is refused |
| `username` | string | with `credential` | TURN username |
| `credential` | string | with `username` | TURN credential; `@`-file recommended |
| `credential_type` | enum | no | `password` (default) \| `hmac-sha1`; only with `credential` |

```yaml
connection:
  turn:
    - url: "turns:turn.example.org:443"
      username: alice
      credential: "@/run/secrets/turn.key"
```

**An entry with no `username` or `credential`.** Set both or neither. An entry with neither is for a relay that accepts credentials derived from the exchange's shared secret: each run derives one from the secret it currently holds, valid for one hour, and presents it to the first TURN url it lists ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)). The run's output states when the credential expires. The run waits for its partner in connection attempts of ten minutes, each after the first with a freshly derived credential, so a long [`peer_timeout_ms`](#shared-options) does not outlast the credential. The derived credential and its signing key are never written to the configuration or the key file. A run with no shared secret refuses such an entry, naming its url. The derivation: [PROTOCOL.md](spec/PROTOCOL.md#relay-credential-derivation).

```yaml
connection:
  turn:
    - url: "turns:relay.example.org:443?transport=tcp"
```

### `connection.invitation_relay`

*Type:* object  
*Required:* no  
*Applies to:* `webrtc`

The relay the invitation you accepted named, written here by `alcove accept` and kept by the web app with a saved exchange. An acceptance that keeps an existing configuration refreshes this block from the invitation - set to the relay it names, removed when it names none - and leaves the rest of the connection block as it is. Its keys, any other refused (a `username` or `credential` included):

| Key | Value |
| --- | --- |
| `turn` | List of urls in the grammar of [`connection.turn`](#connectionturn)'s `url` |
| `stun` | List of urls in the grammar of [`connection.stun`](#connectionstun) |
| `websocket` | One `wss://` url in the grammar of [`websocket_relay`](#connectionwebsocket_relay) |
| `websocket_exchange_id` | The id that WebSocket relay holds the exchange's key under, in the grammar of [`relay_registrar`](#connectionrelay_registrar)'s `exchange_id`; only beside `websocket` |
| `registrar` | One `https://` address, a host and an optional port, in the grammar of [`relay_registrar`](#connectionrelay_registrar)'s `url`; only beside `turn` or `websocket` |

A run lists these after your own settings: `turn` urls after your [`turn`](#connectionturn) entries, `stun` urls after your [`stun`](#connectionstun) list, and the `websocket` url after your [`websocket_relay`](#connectionwebsocket_relay). A url both name is listed once, as yours, and only when written identically in both places. A run's proof to that WebSocket relay names `websocket_exchange_id`, or the id derived from the shared secret where it names none. The invitation's TURN urls take the derived one-hour credential described under [`connection.turn`](#connectionturn); nothing is stored. Which of these relays a CLI run allocates on, and when it contacts the `registrar`: [the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator).

**`registrar`** is named by an invitation from a web app built with a [default relay](DEPLOYMENT.md#the-default-relay), beside that relay's TURN url, its WebSocket relay url, or both. A CLI run enrolls the exchange's relay key there, with no token, before it connects, only when it allocates on this relay's TURN url with the derived credential, or dials its `websocket` url where `websocket_exchange_id` is unset ([which run enrolls](spec/PROTOCOL.md#enrolling-at-a-default-relay)); it says on its log when it does not. A refusal, an unreachable registrar, or no answer in time is stated on the terminal and on the [event stream](CLI.md#machine-readable-event-stream), and the run goes on with its other relays. The registrar caps the enrollments it holds for each network address, so a host running many exchanges at once can be refused.

What the relay's and the registrar's operators learn, including on an [`alcove doctor relay`](CLI.md#checking-the-relay-of-a-webrtc-exchange) of a configuration whose run would enroll there, is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe). A run may connect through the invitation's relay where your own would have served. To stop using it, delete the block, or leave it out with [`allowed_relays`](#connectionallowed_relays), which a later acceptance does not rewrite. The format and the credential derivation: [PROTOCOL.md](spec/PROTOCOL.md#the-invitations-relay-locator).

An inviter names its relay from its own settings: the `url` of each `turn` entry that sets no `username` or `credential`, its `stun` list, and its `websocket_relay`. The invitation never holds a username, a credential, or anything derived from the shared secret.

- **A `turn` entry with a static `username` and `credential` is left out**, since your partner cannot authenticate to it. Your own runs still use it.
- **`alcove invite` over a `ws://` or `wss://` URL** takes the relay from `--turn` and `--stun` ([CLI.md](CLI.md#inviting-over-webrtc)), and the configuration it writes holds them as url-only `turn` entries and a `stun` list.
- **An offline `alcove invite` from a configuration whose connection is `webrtc`** names that connection's coordination server and its relay, from `turn` and `stun` as above. A configuration with neither names no relay.

The web app takes the relay from the browser's own relay setting instead and lists it and the invitation's the same way; the STUN urls it lists, its own and the invitation's, replace its default STUN server, as a `stun` list does on the CLI. It also adds a build's default relay where the run uses it: see [WEB_APP.md](WEB_APP.md#relay-settings) and [DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay).

```yaml
connection:
  channel: webrtc
  server:
    host: peers.example.org
  role: acceptor
  invitation_relay:
    turn:
      - "turns:relay.example.org:443?transport=tcp"
    stun:
      - "stun:relay.example.org:3478"
```

### `connection.allowed_relays`

*Type:* array of strings  
*Required:* no  
*Default:* unset, so a run may use every relay it lists  
*Applies to:* `webrtc`

The TURN and WebSocket relays this party may use, among your own [`turn`](#connectionturn) entries and [`websocket_relay`](#connectionwebsocket_relay) and the [`invitation_relay`](#connectioninvitation_relay) an acceptance wrote. Each entry is a host, with a port when given: `relay.example.org`, `relay.example.org:443`, or `[2001:db8::1]:3478`.

- **How an entry matches a url.** An entry matches a TURN or WebSocket relay url whose host it matches, ignoring letter case and a trailing dot, on the port it names when it names one. A url that names no port is on its scheme's default port: 3478 for `turn:`, 5349 for `turns:`, and 443 for `wss:`. A host entry matches the `turn:` and `turns:` forms of that host and every `transport`. No name is resolved: an entry naming an address does not match a url naming a host. An entry with a scheme, a user, a path, or a port outside 1 to 65535 is refused at parse.
- **What it decides.** A CLI run lists only the TURN and WebSocket relay urls an entry names, so it allocates on, presents its credential to, and enrolls at the `registrar` of only the relays the setting keeps. An invitation it creates names only the url-only `turn` entries and the `websocket_relay` the setting keeps. An empty list keeps no relay. STUN servers are not relays, and the setting does not change them.
- **When it keeps no relay.** A run whose every TURN url the setting leaves out continues without a relay and warns, naming the urls left out and the remedy: add the host of a relay to the setting, or remove it. Where the connection lists no `stun` url, the warning also names the default STUN server.
- **What it does not decide.** It does not filter your partner's candidates: your partner's side can still connect through a relay the setting leaves out, and that relay then learns your network address. A run registers its rotated relay key at your own [`relay_registrar`](#connectionrelay_registrar) whatever the setting keeps.
- **What it reports.** Each run states the relay urls it keeps and the ones it leaves out. The review before you accept an invitation into a configuration that sets it marks each of the invitation's relay urls `kept by connection.allowed_relays` or `left out by connection.allowed_relays`. [`alcove doctor relay`](CLI.md#checking-the-relay-of-a-webrtc-exchange) contacts no relay it leaves out, and names each as left out.
- **When a run does not connect.** The failure names the relay urls the setting left out and the remedy: add a host both sides can reach, or remove the setting ([CLI.md](CLI.md#when-a-webrtc-exchange-does-not-connect)).

> **In the browser.** The web app applies the same entry form and matching under Allowed relays: on a saved exchange's page, where it is exported and imported as `connection.allowed_relays` ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-relays-a-saved-exchange-may-use)), and on the review of an invitation being accepted or created ([WEB_APP.md](WEB_APP.md#allowed-relays)). It also leaves out the site's default relay ([DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)), whose registrar a run then does not contact.

```yaml
connection:
  allowed_relays:
    - relay.example.org
    - backup-relay.example.org:443
```

### `connection.relay_registrar`

*Type:* object  
*Required:* no  
*Applies to:* `webrtc`

The registrar of the relay your own [`turn`](#connectionturn) entries name, when that relay runs the reference registrar ([infra/relay/README.md](../infra/relay/README.md#the-registrar)). The relay accepts credentials derived from the relay key it holds for the exchange, and that key changes each time the shared secret rotates, so after each run that rotates it `alcove exchange` registers the key derived from the new secret at this registrar, signed with the key being replaced. The registration lapses after [`authentication.token_max_age_days`](#authenticationtoken_max_age_days) days, or never where that is unset, and each run renews it.

It holds no credential. The relay-owner token is asked for once, by `alcove enroll-relay`, which enrolls the exchange before its first registered run and is the recovery when the registrar holds a key no run has any more ([CLI.md](CLI.md#registering-the-relay-key-at-your-relay)). The token is never written to the configuration or the key file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | The registrar's `https://` address: a host and an optional port. Host case, a default port (`:443`) and a trailing `/` are normalized away; a path, query, fragment, user, or port 0 is refused, an empty `?` or `#` included |
| `exchange_id` | string | yes | The id the registrar holds this exchange's key under: 1 to 128 of `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`, not starting with `-`, not starting with `alcove-verify-`, and holding no run of 64 hex characters. The registrar's refusals let anyone learn whether an id is enrolled, so choose one that reveals nothing about either party; an invitation naming your [`websocket_relay`](#connectionwebsocket_relay) names this id beside it |

It requires a `turn` entry that sets no `username` or `credential`. A run registers here whether or not it also lists the relay an invitation named ([`invitation_relay`](#connectioninvitation_relay)), since it lists your own `turn` entries either way.

```yaml
connection:
  turn:
    - url: "turns:relay.example.org:443?transport=tcp"
  relay_registrar:
    url: "https://registrar.example.org"
    exchange_id: "q3-linkage-7f2c"
```

### `connection.websocket_relay`

*Type:* string  
*Required:* no  
*Applies to:* `webrtc`

The `wss://` address of a [WebSocket relay](COMMUNICATION.md#websocket-relay) your side runs: a relay for networks whose inspection stops WebRTC and TURN, which pairs the two parties of one exchange and forwards their messages unread. It holds no credential: each run proves the exchange's relay key to the relay with a proof made from the shared secret, so a run with no shared secret is refused before it dials (exit 64).

- **Form.** A `wss://` url naming a host, an optional port, and the relay's path, such as `/relay`, written in the form the URL parser gives back, except that a url with no path may leave off its trailing slash: a lowercase host, no `:443`, and no tab, newline, backslash, or percent-encoding the parser would change. A user, a query, a fragment, port 0, or another scheme is a usage error (exit 64), and so is a url in another form, whose message names the form to write.
- **The exchange id.** The relay looks the exchange's key up by the id it is enrolled under: the `exchange_id` of [`relay_registrar`](#connectionrelay_registrar) where that is set, and otherwise the id derived from the shared secret that an enrollment without a token uses ([PROTOCOL.md](spec/PROTOCOL.md#enrolling-without-a-token)). A url the [`invitation_relay`](#connectioninvitation_relay) an acceptance wrote names too takes the id the invitation names for it instead. The relay reads the key table that enrollment wrote ([WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md#the-key-table)).
- **When a run uses it.** A run dials it as it starts waiting for your partner, and moves the exchange onto it only when no WebRTC path opens or your partner's side has already moved there, logging which path carried the exchange ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)).
- **In an invitation.** An invitation you create names it as its relay's `websocket` url where [`allowed_relays`](#connectionallowed_relays) keeps it, with the `exchange_id` of [`relay_registrar`](#connectionrelay_registrar), where that is set, as its `websocket_exchange_id`, so your partner's run proves under the id the relay holds the key under. Your partner's acceptance keeps both in their [`invitation_relay`](#connectioninvitation_relay). A run lists yours before the one an invitation names, a url both name listed once.

```yaml
connection:
  turn:
    - url: "turns:relay.example.org:443?transport=tcp"
  relay_registrar:
    url: "https://registrar.example.org"
    exchange_id: "q3-linkage-7f2c"
  websocket_relay: "wss://wsrelay.example.org/relay"
```

### `connection.ice_provision`

*Type:* object  
*Required:* no  
*Applies to:* `webrtc`

A provisioning endpoint that returns a complete set of ICE servers - STUN and TURN combined - for the current exchange, in the API shape of commercial ICE credential services such as Twilio Network Traversal Service. Mutually exclusive with static `stun` and `turn`.

Neither application calls the endpoint. The web client ignores the field; the CLI refuses a connection that sets it. List the servers directly under `stun` and `turn` instead.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname of the ICE credential API |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | API path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

```yaml
connection:
  ice_provision:
    host: nts.twilio.com
    path: /v1/credentials/ice
    auth:
      username: your-twilio-account-sid
      password: "@/run/secrets/twilio.key"
```

### HTTP service authentication (`auth`)

The `server.provision` and `ice_provision` objects each accept an optional `auth` sub-object. Exactly one authentication method may be specified. `username` and `password` must appear together; neither is valid alone.

| Field | Type | Description |
|-------|------|-------------|
| `bearer` | string | Bearer token; `@`-file recommended |
| `username` | string | Username for HTTP Basic authentication |
| `password` | string | Password for HTTP Basic authentication; `@`-file recommended |

```yaml
connection:
  channel: sftp
  server:
    host: sftp.example.org
    provision:
      host: wake.example.org
      auth:
        bearer: "@/run/secrets/wake.key"
```

### `connection.options`

*Type:* object  
*Required:* no

Channel-agnostic and channel-specific tuning parameters. An SFTP-only field on a `filedrop` connection draws a configuration warning; an SFTP and shared-folder field on a `webrtc` connection is refused as an unrecognized key.

#### Shared options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `peer_timeout_ms` | integer | 3600000 | Milliseconds to wait for the partner to arrive at the rendezvous; a partner that never arrives ends the exchange with a transport error. It bounds arrival only; once the partner is present, silence is bounded by `inactivity_timeout_ms`. The effective limit is the minimum of this and the remaining shared-secret lifetime. A positive integer of at most 604800000 (seven days), the same ceiling as `--peer-timeout`. The 3600000 default is for `sftp` and `filedrop`; on `webrtc` an absent field leaves the transport's own 600000. On `webrtc` the budget is checked as each connection attempt starts, so a partner whose offer arrives up to 30000 past it can still be met, and the wait for the data channel to open after both session descriptions are exchanged is a fixed 30000 that neither timeout reaches ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#budgets)). |
| `inactivity_timeout_ms` | integer | 3600000 | Milliseconds a partner that has arrived may send nothing before the exchange fails with a transport error. It is armed afresh for each wait, so it bounds silence, not run length; raise it for a partner that takes longer than this to compute one step on a large dataset. On `sftp` and `filedrop` it also bounds each single operation on the server or folder. A positive integer of at most 604800000 (seven days), the same ceiling as `--inactivity-timeout`, which sets it from the command line. Teardown runs on a short fixed budget of its own, which this value caps only if set lower ([SFTP connection teardown](#sftp-connection-teardown)). |
| `server_connect_timeout_ms` | integer | 30000 | Milliseconds to wait during each connection attempt to the primary exchange server. A positive integer no greater than 2147483647. On `sftp` it bounds each of an attempt's two phases - the handshake and authentication, then the request that opens the SFTP subsystem - so a stalled attempt ends within about twice this value plus a forced-close wait of at most one second. An attempt whose subsystem request goes unanswered for the whole window ends the connection terminally, reporting the phase that timed out. A server that accepts the connection and then answers nothing is re-dialed, so the whole wait is this value once per attempt plus a second between attempts, `max_reconnect_attempts + 1` attempts: about two minutes at both defaults. For an unattended run whose stated budget should be the whole budget, set `max_reconnect_attempts` to 0. Why it bounds an attempt: [connect-timeout-prior-art.md](notes/connect-timeout-prior-art.md). |
| `max_reconnect_attempts` | integer | 3 | How many times a connection may be re-dialed after a fast transient failure, and on `sftp` how many sessions one exchange may lose mid-run -- one setting spending two separate tallies of the same size. What each bounds, how a lost session is charged, and the ceiling the value itself is capped at are in [SFTP_SESSION_RECOVERY.md](spec/SFTP_SESSION_RECOVERY.md#sftp-mid-exchange-session-recovery); what to set it to is [below](#setting-max_reconnect_attempts). |

#### Setting `max_reconnect_attempts`

**What it governs on each channel.** On `filedrop` it governs the initial connect alone, retrying a fast transient such as the share's permissions still settling, each attempt bounded by `server_connect_timeout_ms`. A share that is not there yet, or a path naming something other than a folder, fails at once with exit 66 or 64 (see [Exit codes](CLI.md#exit-codes)). On `sftp` the same number also caps how many sessions one exchange may lose mid-run: a clean session drop (typically a server-enforced session or idle limit) is re-dialed with the pinned host key and stored credentials and the interrupted operation re-issued. The two tallies are separate counters.

**An exhausted budget** ends the exchange with a terminal non-zero error naming this budget and the run's lost-session tally; every lost session spends one, whether its re-dial succeeded, failed, or was refused. The error names two remedies: raise this setting for a flaky link, or set [`connection_per_poll`](#sftp-only-options) for a server that caps session lifetime. The mid-run tally is cumulative, does not reset on progress, does not apply in `connection_per_poll` mode, and is not charged for the teardown abort-marker write.

**Zero** means connect once without a dialing retry, and treat the first mid-run drop as terminal. A value above the ceiling is a usage error (exit 64) before anything is dialed, from `alcove.yaml` or `--max-reconnect-attempts`.

**What no budget re-dials:** a key exchange the host's crypto provider cannot perform ([Key-exchange algorithms and the host's crypto provider](#key-exchange-algorithms-and-the-hosts-crypto-provider)), a fatal protocol error, a rejected host key, the two peer waits (`peer_timeout_ms`, `inactivity_timeout_ms`), a `filedrop` connect that reaches its per-attempt timeout, and an `sftp` dial whose subsystem request goes unanswered. A dial that times out in its handshake phase is retried ([TRANSPORT_LIVENESS.md](spec/TRANSPORT_LIVENESS.md#connect-probe-bound)).

#### SFTP and shared-folder options

These options apply to both `sftp` and `filedrop` channels.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval_ms` | integer | 5000 on `sftp`, 250 on `filedrop` | Milliseconds between checks for the partner's uploaded file. A positive integer no greater than 2147483647. Every wait for the partner's next file costs up to one interval, and an exchange makes many; on a small exchange it sets the pace, six to ten intervals per linking key ([FILE_SYNC.md](spec/FILE_SYNC.md#poll-interval-and-step-pace)). The `sftp` default stays within SFTP servers' anti-flood limits; lower it (for example to 100 ms) for CI or a demo against a controlled server. The `filedrop` default is shorter because a shared folder has no server to flood. The `--polling-frequency` CLI flag overrides it for a run and accepts a sub-second value such as `100ms` (see [CLI configuration](CLI.md#configuration)). |
| `timestamp_in_filename` | boolean | false | When `true`, each outgoing message filename also encodes a UTC timestamp and a per-session sequence number (see [Message filenames](#message-filenames)), for filename-based logging where a sync tool stamps files with the transfer time. |
| `lockless_rendezvous` | boolean | false | When `true`, the rendezvous uses an ack-handshake barrier (`<id>-hello-<bytes>.json` plus a zero-length [acknowledgment marker](#acknowledgment-markers) `<myId>-<peerId>-hello-<bytes>-ack.json`) instead of the default atomic lock-file race (`<id>-hello-<bytes>.json` + `<peer1>-<peer2>-lock.json`). Required on sync-mediated transports that lack atomic exclusive-create or deletion visibility, such as a cloud sync service reconciling two local mirrors. Both parties must set it identically; the setting is advertised in the hello, and a mismatch fails at rendezvous naming each side's setting ([FILE_SYNC.md](spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate)). The sync glob in lockless mode is `<myId>-*` (upload) / `<partnerId>-*` (download), which excludes in-flight `temp-*.tmp` writes. |
| `peer_id` | string | - | A stable, readable identifier for this party, in every filename it writes and so in server-side logs and transcripts; a stable id also makes this party's runs linkable to each other in the partner's logs. Unset, a UUID is generated per run. **Recommended for unattended and scheduled runs**: a killed run's leftover is then refused at start-up by name (see [Directory exclusivity](#directory-exclusivity)). Requires `timestamp_in_filename: true`. The two parties' ids must differ, and neither may be the other's id extended by `-` (`"site"` and `"site-2"` are rejected at rendezvous; see [FILE_SYNC.md preconditions](spec/FILE_SYNC.md#preconditions-for-a-correct-exchange)). Spaces and `-` are permitted. At most 211 bytes of UTF-8, and the two ids together must keep every file name within 255 bytes. `"temp"` is reserved. Filesystem-unsafe characters (`/` and NUL everywhere; `<`, `>`, `:`, `"`, `\`, `|`, `?`, `*` on Windows NTFS) are not validated and may fail at the transport layer. It may hold fields Alcove fills in for each run (`%Y`, `%m`, `%d`, `%H`, `%M`, `%S` from the UTC date and time, `%K` for 16 random hex characters, `%%` for a literal `%`), for a partner's file transfer that never passes the same file name twice; the rules above then apply to each run's id. See [Fields in `peer_id`](#fields-in-peer_id). |
| `retain_files` | boolean | false | When `true`, no exchange file is deleted as a protocol step: the receiver writes an [acknowledgment marker](#acknowledgment-markers) for each message it consumes, the sender gates its next write on that marker, and the shared folder becomes a permanent transcript. For a transport that does not propagate deletions, or for an auditable record of what flowed each way. Mechanics: [FILE_SYNC.md](spec/FILE_SYNC.md#two-orthogonal-mode-axes); what to set beside it: [below](#setting-retain_files). |
| `unexpected_files` | enum | mode-coupled (see description) | How to handle a file that appears in the shared folder *during* the message loop and is neither part of this exchange nor its own in-flight temporary write - another process sharing the directory, or a sync tool's conflict copy or partial download (see [Directory exclusivity](#directory-exclusivity)). One of `error` (fail with a usage error, exit 64, naming the file and directory), `warn` (log once per distinct file name and continue), or `ignore`. A local setting: the two parties may use different values. Unset, it is `error` on ordinary `sftp`/`filedrop` and `warn` when `retain_files` or `lockless_rendezvous` is set. A malformed *protocol* file (a peer-prefixed, message-shaped name a correct peer cannot produce) is always reported. |
| `write_without_renaming` | boolean | false | When `true`, this party writes every exchange file directly under its final name, instead of writing a temporary `temp-*.tmp` file and renaming it into place. For a server that does not allow renames. Safe only where the shared folder never passes a file to your partner while it is still being written; see [below](#setting-write_without_renaming). The `--write-without-renaming` CLI flag sets it for one run. |

#### Fields in `peer_id`

Some file-transfer systems between two organizations route files by a fixed name prefix and drop any file whose name they have passed before. With a stable `peer_id`, the hello and abort files of every run have the same names, so from the second run on the partner never sees them. Fields in `peer_id` give each run its own id, while the text you write before the first field starts every file name this party writes, so a prefix rule on that text matches them all.

**The fields.** Everything else in `peer_id` is written as is, and a `peer_id` with no `%` is used exactly as written.

| Field | Fills in |
| --- | --- |
| `%Y` | the four-digit year |
| `%m`, `%d` | the two-digit month and day |
| `%H`, `%M`, `%S` | the two-digit hour, minute and second |
| `%K` | 16 random lowercase hex characters |
| `%%` | a literal `%` |

The date and time are UTC whatever the machine's time zone, read once when the connection opens. Alcove fills the fields in only then, never when it reads or writes the configuration, so a saved `alcove.yaml` keeps `peer_id` as you wrote it. No other `%` field is accepted; there are no environment variables, user names or host names.

**Examples.**

- `peer_id: agency-a_%Y%m%d-%H%M%S` gives ids such as `agency-a_20261028-020000`. Two runs that start within the same second get the same id.
- `peer_id: agency-a_%Y%m%d-%K` gives ids such as `agency-a_20261028-3f9a0c1d2b4e5f60`. The random field alone keeps about 5 million runs (one a minute for ten years) apart, with about a one-in-a-million chance that any two share an id; the derivation is in [FILE_SYNC.md](spec/FILE_SYNC.md#per-run-peer-id).

In `alcove.yaml`, quote a `peer_id` that starts with `%`: YAML refuses an unquoted value that does. On the command line, `--peer-id` takes the same fields; a crontab line writes each `%` as `\%`, since cron reads a bare `%` as a line break.

**What is checked when the configuration loads.** The run is refused (exit 64), naming the problem, when `peer_id` holds a `%` field not in the table or a single `%` at the end, or is longer than 211 bytes with its fields filled in. The console's own name field takes no fields; a configuration it opens may hold them, and is then refused if the filled-in name would not fit that field: more than 64 characters, or a character other than ASCII letters, digits, spaces, `-` and `_`.

**A killed run's hello.** This party still recognizes its own leftover hello at start-up, because it knows its `peer_id`: a hello whose id matches `peer_id` with any values in its fields is refused as this party's own, as with a stable `peer_id` (see [Directory exclusivity](#directory-exclusivity)).

**The two parties' ids.** Neither party's id may fit the other's pattern: the other's `peer_id` with any values in its fields, or the `peer_id` as written when it has none. That usually comes from both parties setting the same `peer_id`. Each party then takes the other's hello for its own leftover, and the exchange cannot start:

- A run that finds the partner's hello at start-up refuses it (exit 64). The message names a shared `peer_id` as the likely cause before it suggests removing files.
- A run that sees the partner's hello arrive later under a file name different from its own skips it and stops at the peer timeout. The timeout message names the skipped file and the same cause. When both parties write the same file name (the same `peer_id` with no fields, both starting before either hello exists), the partner's hello looks like this run's own and the timeout message is the plain one.

Give one side a `peer_id` with different text, not only different fields. Removing the hello or re-running with `--sweep-exchange-files` deletes the partner's hello and leaves the two ids matching.

**The partner's view.** The partner sees, logs and adopts the full id of each run. The id-pair rules apply to the full ids: if your id is the partner's id followed by `-` and more text, both parties refuse the pair at rendezvous, as with any two ids. The text before the first field links your runs in the partner's logs, as a stable `peer_id` does.

#### Setting `retain_files`

**What has to be set beside it.** Retain mode requires `timestamp_in_filename: true`, so messages from one party do not share a filename, and `lockless_rendezvous: true`, since lock rendezvous deletes files. The CLI `--retain-files` flag sets both when they are not already set.

**Both parties set it, and a difference fails the run.** Each party advertises its value in its hello, and a difference fails fast with both sides named, as for `lockless_rendezvous` ([FILE_SYNC.md](spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate)). When both flags differ at once, the error names the `retain_files` mismatch.

**Your partner is told before they consent.** An invitation created with retain mode on declares it, and the accepting party's acceptance display shows the retained transcript. The declaration sets nothing on the accepting side, which configures its own half here ([FILE_SYNC.md](spec/FILE_SYNC.md#retain-mode-declaration-on-the-token)).

**Each exchange needs a fresh directory**, enforced before the run. A rendezvous that fails before it completes clears its own files. Reusing a retain directory is a CLI-only recovery; see [Directory exclusivity](#directory-exclusivity).

#### Setting `write_without_renaming`

**When to set it.** Each exchange file is normally written under a temporary name and renamed to its final name, so your partner never sees an incomplete file. Some servers do not allow renames, such as an SFTP server in front of a service-synced network share; there every run fails at the start with an error that the file just written could not be renamed. Turn this option on (or pass `--write-without-renaming`) for that server.

**What you are vouching for.** A file is visible under its final name while it is still being written. Turn it on only where the shared folder never passes a file to your partner in that state, such as a synced share whose sync service does not copy a file while it is being written. Alcove cannot check this. A run with the option on warns before it connects, and its pre-run display states it.

**It is your setting alone.** Your partner need not set it, and nothing you send states it.

**Limits.** A run killed while writing its hello can leave an incomplete `<id>-hello-<bytes>.json`; the next run's start-up check fails on it, and `--sweep-exchange-files` clears it. Whether a sync service delays a directly written file more than a renamed one has not been measured.

How each file is read safely without the rename: [FILE_SYNC.md](spec/FILE_SYNC.md#writing-without-renaming).

#### SFTP-only options

These options apply to the `sftp` channel only. Setting one on `filedrop` (which holds no session) or any other channel is accepted but has no effect, and the CLI warns that it is ignored.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connection_per_poll` | boolean | false | When `true`, a fresh SFTP session is opened at the start of each poll cycle and released before the loop goes idle again, instead of holding one session for the whole exchange. Because each cycle's session then needs only survive that cycle's seconds, the poll loop ordinarily does not reach a server's maximum-session-duration or idle cap. When to set it is below; the session model it runs under is in [FILE_SYNC.md](spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary), and what a run counts and warns about in [SFTP_SESSION_RECOVERY.md](spec/SFTP_SESSION_RECOVERY.md#sftp-mid-exchange-session-recovery). |

**When to set `connection_per_poll`.** Set it when the partner's SFTP server enforces a session-lifetime limit you cannot change and a single exchange spans many idle poll gaps -- a slow peer that reconciles the directory only occasionally, so an exchange lasts hours. Pair it with a minutes-scale `poll_interval_ms`: the mode pays a full SSH handshake every cycle, negligible at a long interval and wasteful at a short one, so a sub-minute interval draws a CLI warning, as does the `--connection-per-poll` flag with no long `--polling-frequency`.

It is a local choice: the two parties may set it differently. The rendezvous wait, and a boundary reached while one of this side's operations is unsettled, still hold a session under the mode; a server cap that cuts either is re-dialed. Leave it unset against a server with no session cap. The server limits themselves are in [DEPLOYMENT.md](DEPLOYMENT.md#server-enforced-session-limits).

#### SFTP connection teardown

Some SFTP servers accept the client's disconnect and then leave the connection half-open. In both session modes, past a short fixed teardown bound, Alcove closes the connection from this side and the command finishes normally. At the end of a run you may see, at most once:

- An informational line naming what left the connection open and stating that this side closed it. It changes neither the results nor the exit code.
- A warning in its place when this side could not close it either. The connection is then left to the operating system and the command may not exit on its own.

Neither is the mid-exchange release warning `connection_per_poll` can draw, which names an idle boundary in the middle of an exchange. Specified in [SFTP_SESSION_RECOVERY.md](spec/SFTP_SESSION_RECOVERY.md#sftp-mid-exchange-session-recovery).

#### Message filenames

On the `sftp` and `filedrop` channels each party writes its outgoing messages as files in the shared folder, and the partner polls for them. A message is the digit-terminal case of the [filename grammar](#filename-grammar) that is not a control file. Two shapes exist, selected by `timestamp_in_filename`.

With `timestamp_in_filename` unset (the default), the format is:

```
<id>-<byteCount>.json
```

With `timestamp_in_filename: true`, the filename additionally holds a timestamp and counter:

```
<id>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>.json
```

`<YYYYMMDDTHHMMSS>` is the UTC write time in compact ISO 8601 form (Windows-safe, and sorting by time). `<NNN>` is a per-session counter from `000`, zero-padded to three digits, widening only after the 1000th message of a session.

Unless [`write_without_renaming`](#setting-write_without_renaming) is set, each file is written under a temporary `.tmp` name and renamed to its final `.json` name once complete. Handshake files (`<id>-hello-<bytes>.json`, `<peer1>-<peer2>-lock.json`, and the rendezvous [acknowledgment marker](#acknowledgment-markers)) are separate from message files ([FILE_SYNC.md](spec/FILE_SYNC.md)).

#### Acknowledgment markers

An acknowledgment marker is a zero-length file the receiver writes to signal that it has taken a message or a hello, in place of deleting it. Two kinds exist and they share one shape: under `retain_files: true` the receiver writes one after consuming each message, and under `lockless_rendezvous: true` each party writes one for the peer hello it has seen. Its terminal segment is the `ack` type word rather than a digit string, so it is never mistaken for a message even though a consumed message's `<NNN>` and `<byteCount>` appear mid-name:

```
<receiverId>-<senderId>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>-ack.json   # a consumed message
<myId>-<peerId>-hello-<bytes>-ack.json                                 # a peer hello
```

Each is named after the file it acknowledges, prefixed with the id of the party that wrote it, so the two parties' markers never collide.

Under `retain_files`, the directory accumulates each message and its ack on every transport, SFTP included, as a durable transcript, together with the hellos and acks of a completed rendezvous. Nothing in the protocol cleans it up; retention, rotation, and archival are the operator's.

How the marker is constructed and gated on, and the retain-mode close-time behavior, are part of the transport state machine and are specified in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-2----message-loop-retain-mode).

#### Directory exclusivity

The shared folder (SFTP path or local filedrop path) must be **dedicated**, for protocol-grammar files, to a single active exchange between exactly two parties. A third process writing protocol-grammar files - `<id>-hello-<bytes>.json`, `<peer1>-<peer2>-lock.json`, a `<id>-...-ack.json` marker, or a message-shaped `<id>-<digits>.json` - into the same path during a session aborts the exchange with a diagnostic error. Separate concurrent exchanges must use separate directories. What the SFTP server must and must not do to the folder is in [DEPLOYMENT.md](DEPLOYMENT.md#sftp-server).

**Foreign (non-protocol) files are tolerated.** A file whose name does not match the protocol grammar - an unrelated file, or a sync tool's conflict copy or partial download - does not abort the exchange. Foreign files present at session start are ignored for the session; one that first appears mid-session is handled by [`unexpected_files`](#sftp-and-shared-folder-options). The protocol never deletes a foreign file. A file whose name matches the message grammar (`<peerId>-<digits>.json`) is treated as a protocol message and rejected.

**Every exchange starts from a fresh directory.** Before a run begins, the directory must hold no protocol files except at most one peer hello, the file a partner who arrived first leaves. Foreign files do not count. The guard applies in both message-loop modes; in retain mode a stale message or ack marker would otherwise corrupt or stall the exchange with no error.

**Recovering a contaminated or reused directory (CLI only).** After a crashed run, or a bilateral-mode mismatch that left protocol files behind, the guard refuses the next run (exit 64), naming the directory, how many offending files it found, and as many of their names as fit. Remove those files after confirming no other session is using the path, or re-run with `--sweep-exchange-files`. What the leftover kinds mean:

- **A lock file (`-lock.json`), a joining sentinel (`-joining-<bytes>.json`), a message, or a hello under your own `peer_id`:** a previous exchange was ended by SIGKILL, an out-of-memory kill, or power loss before its cleanup ran.
- **An ack marker (`-ack.json`):** a crashed lockless rendezvous, or, in retain mode, a directory reused for a second exchange. If a live lockless peer may still be mid-rendezvous, wait for it to complete or time out before clearing the directory.

| Flag | Effect |
| --- | --- |
| `--sweep-exchange-files` | Deletes every protocol file (this party's and the peer's) and starts a fresh exchange. Foreign files are left untouched, and the interrupted run is not resumed. Refuses a directory that may hold a retain-mode transcript |
| `--force-retain-sweep` | With `--sweep-exchange-files` only: also clears a retain-mode transcript, permanently discarding it |

Both flags are CLI-only and apply to one invocation; they are not `connection.options` keys and cannot be set in `alcove.yaml`. What the sweep deletes and refuses: [FILE_SYNC.md](spec/FILE_SYNC.md#the-five-enforcement-sites).

**If both parties sweep, expect a failed round, then retry.** `--sweep-exchange-files` asserts that no other session is using the directory, which the protocol cannot check. When both parties sweep, one deletes files the other has just written and neither run finishes; in the default mode each timed-out run names this as a likely cause. The failed runs leave the directory clear, so run again from both sides with no sweep flag, after resolving any sweep that reported it could not delete every file. To skip the failed round, one party sweeps and stays in the exchange, and the other starts afterwards with no sweep flag; no log line marks when that is safe, so the operators agree on the order and check the directory (the named leftovers gone, a single hello present). See [FILE_SYNC.md](spec/FILE_SYNC.md#invariants).

**An abort marker needs no flag.** A run that fails after the partner handshake leaves `<id>-abort-<bytes>.json` so the waiting partner fails fast instead of sitting out its inactivity timeout. In the default mode the next run in the directory clears it at start-up, whichever party left it. In retain mode it is refused with the transcript until you pass both flags. If the partner may still be running the failed exchange, let it poll once before you retry, or it sits out its full inactivity timeout. See [FILE_SYNC.md](spec/FILE_SYNC.md#file-taxonomy).

**A failed rendezvous leaves no leftover.** A party whose rendezvous fails before it completes removes its own hello and acknowledgment, in either mode, so retry into the same directory. A bilateral-mode mismatch leaves both hellos, so each party reads the other's setting, and a run killed outright never reaches its cleanup ([FILE_SYNC.md](spec/FILE_SYNC.md#phase-1----terminal-rendezvous-failure)).

**A hello left by a killed run.** Unless you set [`peer_id`](#sftp-and-shared-folder-options), the party id is fresh per run, so the next run reads a killed run's `<id>-hello-<bytes>.json` as a partner's hello and cannot succeed:

- **Default (lock) rendezvous.** The run fails in the key exchange, naming the leftover as the likely cause, and consumes it; re-run.
- **`lockless_rendezvous` (and therefore `retain_files`).** The run fails well inside the peer timeout, naming the file, and never deletes it. Re-run first: a slow partner completes the re-run, while residue fails it again. Then delete the named file or pass `--sweep-exchange-files`. With a `peer_timeout_ms` under about 30 seconds, or a handful of poll intervals, the check does not arm and the run reports the ordinary peer timeout ([FILE_SYNC.md](spec/FILE_SYNC.md#phase-1----entry-present-peer-hello)).

Setting `peer_id` avoids this for unattended and scheduled runs: the leftover then holds your own id and is refused at start-up by name, with or without [fields](#fields-in-peer_id) in it. Do not put `--sweep-exchange-files` on a schedule; an unattended run cannot assert on every invocation that no other session is using the directory.

#### Filename grammar

Every protocol file on `sftp` and `filedrop` channels is named `<id>-...-<token>.json`, where `<token>` is the final `-`-delimited segment before `.json`. Every file with contents ends its name with its byte count, and every other file is zero-length:

- If `<token>` is all digits, it is the file's declared byte count. The segment before it tells the two kinds of such file apart. Parsing is right-anchored so a party id containing hyphens does not affect extraction.
  - If that segment is `hello`, `joining`, or `abort`, the file is a **control file with contents**: the rendezvous hello `<id>-hello-<bytes>.json`, the lock-path joiner-arrival sentinel `<id>-joining-<bytes>.json` (briefly present while the joiner deletes the peer hello and renames the sentinel to its own hello), or the marker `<id>-abort-<bytes>.json` a failing party leaves for its partner, described under [Directory exclusivity](#directory-exclusivity) above.
  - Otherwise the file is a **message** (see [Message filenames](#message-filenames)).
- Otherwise `<token>` is a **type word** naming a zero-length file: `ack` (see [Acknowledgment markers](#acknowledgment-markers)) or `lock` (the rendezvous tiebreaker `<peer1>-<peer2>-lock.json`, created in lock mode -- the default `lockless_rendezvous: false` -- when both hellos coexist and one party wins the atomic exclusive-create race; both sides encode the two ids in hello-filename order so they reconstruct the same name).

A control file is never read as a message, and a message ack's mid-name `<NNN>`/`<byteCount>` digits do not route it as a message.

The receiver reads a file only once its on-disk size reaches the byte count its name states, so a partially synced file is never consumed prematurely. A file larger than its name states is refused: a message or hello ends the run; an abort marker listed larger than its name is not believed, and one found larger while being read ends the run as a message does.

#### Moving files out of the folder

An operator who runs a tool that moves files out of the shared folder -- to archive them, or to pass them on -- can tell from a file's name and size alone whether Alcove has finished writing it. This holds whether or not [`write_without_renaming`](#setting-write_without_renaming) is set.

- **Which files.** Every file whose name ends in `.json` and starts with either party's id.
- **When one is complete.** A name ending in `-<digits>.json` is complete only when the file's size in bytes equals that number, so an empty or shorter file under such a name is still being written. Any other `.json` name (an acknowledgment marker or the rendezvous lock) is always zero-length and always complete. The pattern `-([0-9]+)\.json$` matches every name that states a byte count and captures that number; a plain glob cannot require digits only, and `*-[0-9]*.json` also matches an acknowledgment marker. Use the regular expression, or an extended glob (`*-+([0-9]).json` in bash with `extglob`, `*-<->.json` in zsh).
- **Never move a `temp-*.tmp` file.** Without `write_without_renaming`, each file is first written under a temporary name, `temp-<uuid>.tmp` or `temp-hello-<uuid>.tmp`, and renamed to its final name only once complete, so a final name always holds a complete file. A temporary name has no byte count and is not complete until it is renamed.

### `connection.provider_options`

*Type:* object  
*Required:* no  
*Applies to:* `sftp` (accepted on `webrtc` but inert: no WebRTC transport reads it, held by `npm run check:webrtc-provider-options-unread`; see [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#ice))

An opaque key-value map of additional, non-security transport-tuning options for the underlying transport library. Keys and values are defined by the package providing the connection implementation. `@`-file pathing is supported here as well.

Unlike every other map in this spec, the keys here are **not** case-normalized: they are passed exactly as written, so author them in the casing the underlying transport library expects rather than snake_case. For the SFTP channel they are forwarded to `ssh2-sftp-client`, whose options are camelCase.

For the SFTP channel this map is **not** a verbatim passthrough: it is filtered through a default-deny allowlist before reaching `ssh2-sftp-client`. The connection target, credentials, and host-key-verification settings are derived solely from the structured [`connection.server`](#connectionserver) fields and **cannot** be set or overridden here -- so `host`, `port`, `username`, `password`, `private_key`/`privateKey`, `passphrase`, `host_verifier`/`hostVerifier`, `host_hash`/`hostHash`, and the connection-redirecting `sock`/`authHandler` options are all rejected if placed in `provider_options`. Only these benign tuning options are honored:

- `keepaliveInterval`, `keepaliveCountMax` -- SSH-level keepalive cadence.
- `strictVendor` -- ssh2's server-vendor strictness toggle.
- `algorithms` -- accepted, but filtered to its `cipher`, `hmac`, `kex`, and `compress` sub-categories; the `serverHostKey` sub-category is dropped, as host-key-type negotiation is a host-key-trust decision and not operator-overridable here.

Any other key is ignored, with a warning naming it. That includes `readyTimeout`, which Alcove sets from [`connection.options.server_connect_timeout_ms`](#shared-options) and applies again to the subsystem-open phase that follows authentication.

#### Key-exchange algorithms and the host's crypto provider

Alcove withholds from its SSH key-exchange offer every algorithm built on a primitive the running process cannot perform. Today that is X25519, absent from a FIPS-configured OpenSSL provider. Alcove asks the crypto provider rather than looking for a "FIPS mode", so this needs no configuration; on a host that can perform everything, the offer is unchanged. The offer measured in the FIPS image is in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md#the-default-offer-measured-inside-the-image).

The narrowing also applies to `algorithms.kex` set here:

- If some listed algorithms survive, the rest are dropped with a warning naming how many and why.
- If **none** survives, the connection is refused with an error. List at least one available algorithm, or remove the setting.
- An **empty** list means "algorithms unspecified": Alcove warns and offers the defaults minus the unavailable ones.

A server that accepts only algorithms this host cannot perform, such as one restricted to `curve25519-sha256` reached from a host without X25519, fails at the first attempt with an error naming the missing primitive. The remedy is a key exchange enabled server-side, or a different host. [`max_reconnect_attempts`](#shared-options) is not spent on it, and under [`connection_per_poll`](#sftp-only-options) the exchange ends at that cycle with the same error.

---

## Authentication

*Type:* object  
*Required:* no (see note below)  
*Applies to:* all channels (`webrtc`, `sftp`, `filedrop`)

Optional top-level block, a sibling of [`signing`](#signing), holding the partner shared-secret settings. The same shape applies to every channel. It mixes two kinds of field:

- **Secret state loaded at run time** (`shared_secret`, `expires`): read from the key file (`.alcove.key`) into memory before the exchange runs. They never appear in `alcove.yaml`. If `shared_secret`, `sharedSecret`, or `expires` is present in the configuration file, the CLI warns and ignores it; the key file always wins.
- **Operator-policy fields**, set in `alcove.yaml`: today only `token_max_age_days`.

| Field | Type | In `alcove.yaml` | Description |
|-------|------|-------------------|-------------|
| `shared_secret` | string | never; loaded from `.alcove.key` | Shared secret; a base64url-encoded 32-byte value (43 characters). Do not set manually. |
| `expires` | string (ISO 8601) | never; loaded from `.alcove.key` | Expiration of `shared_secret` - an invitation's bounded lifetime or a `token_max_age_days` stamp, enforced identically. Absent when the shared secret does not expire. Do not set manually. |
| `token_max_age_days` | integer (positive) | yes (operator policy) | The shared secret expires after this many days of inactivity (no successful run). See [`authentication.token_max_age_days`](#authenticationtoken_max_age_days). |

The block is validated **strictly**, as the document's top level is: an unrecognized key (for example a misspelled `token_max_age_dayss`) is rejected when the configuration is read, and no exchange runs until it is corrected.

`alcove exchange` requires `shared_secret`: with no key file, the CLI aborts before any connection is attempted. Quick exchanges (the subcommand-less invocation) use no key file and rely on transport-layer authentication. The block itself is never required in a configuration file.

**Provisioning the key file from an invitation.** A configuration downloaded from the web application, like every `alcove.yaml`, holds no secret. Pass `--invitation CODE` to `alcove exchange` (the same invitation `alcove accept` takes) to write your key file from it and run the exchange in one command: the CLI validates the invitation (checksum, schema, and expiry), writes the key file with its shared secret and expiry, and then runs. Use the `@`-file form, `--invitation '@invitation.txt'`, to keep it out of shell history. A malformed or expired invitation fails before anything is written. `--invitation` is refused if a key file already exists at the key path, since the secret rotates after the first exchange; run without it, or re-invite. See [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md).

**Rotation.** The shared secret rotates at the terms exchange that follows each successful authentication handshake, before the data exchange: both parties derive the replacement from the handshake's key agreement and a random value from each party, with no extra round trip, and save it one after the other ([The rotation at the terms exchange](spec/PROTOCOL.md#the-rotation-at-the-terms-exchange)). The CLI persists it; a library consumer of `runExchange` persists it through the `store` of its `rotation` option.

| Failure point | State |
| --- | --- |
| Before either party saves it (a failed handshake, or terms that are refused) | The existing secret stays valid |
| After both parties saved it, during the data exchange | Both parties hold the rotated secret and can retry without re-inviting |
| The first party to save cannot persist it (for example a disk-write error) | Normally neither party holds it, and the same command run again after the fix recovers ([Out-of-sync tokens](CLI.md#out-of-sync-tokens)) |
| The second party cannot persist it, or the run stops between the two saves | The parties are out of sync; both must re-invite |

Invitation tokens expire after 1 hour by default; a rotated secret's lifetime is governed by [`token_max_age_days`](#authenticationtoken_max_age_days). WebRTC peer addressing is configured in [`connection.role`](#connectionrole), not here.

### `authentication.token_max_age_days`

*Type:* integer (positive, at most 36500 -- about 100 years)  
*Required:* no

An operator-policy field. A rotated secret has no expiration by default, so a dormant partnership could hold a valid one indefinitely. When `token_max_age_days` is set, each successful exchange stamps `expires` = (the moment of rotation) + `token_max_age_days` days into the rotated `.alcove.key`, so the secret expires after that many days without a successful run, however often the exchange is scheduled.

The next `alcove exchange` enforces it when it loads the key file:

- If `expires` is in the past, the CLI aborts before opening any connection, with an error naming the expired time and directing both parties to re-invite.
- If the secret is within `token_max_age_days / 3` days of expiry, the CLI warns before the exchange; the warning is suppressed when that exchange succeeds and stamps a later `expires`.

An `expires` already set, by this policy or by an invitation's lifetime, is enforced even if the field is later unset. Setting or changing `token_max_age_days` affects only secrets stamped by later rotations. The policy, and the effect on a schedule, are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#shared-secret-rotation-and-inactivity-limit) and [CLI.md](CLI.md#scheduling-the-run).

```yaml
authentication:
  token_max_age_days: 30
```

---

## Signing

Optional. Configures signing of exchange receipts and trust in the partner's signing identity; absent in exchanges that do not sign receipts. The block holds only non-secret references: the signing **private key is never in the config** but in a separate owner-read-only identity file (`signing.identity_file`), and `signing.partner_fingerprint` is a public value. The trust model and certificate format are in [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning) and [SECURITY_DESIGN.md](SECURITY_DESIGN.md#receipt-signing-identities).

### `signing.mode`

*Type:* string (`none` | `session-derived` | `certificate`)  
*Required:* yes, when a `signing` block is present

The receipt signing mode:

| Value | Behavior |
| --- | --- |
| `none` | No receipt; only the unsigned self-attested record is produced |
| `session-derived` | A MAC under the key-exchange session key: tamper-evident, not non-repudiation, not third-party verifiable. Not implemented: a configuration selecting it is refused before the exchange runs |
| `certificate` | Signs with this party's long-lived signing identity; the only mode with third-party-verifiable non-repudiation |

`certificate` requires a named party ([`linkage_terms.identity`](#linkage_termsidentity)) and is refused before the exchange runs without one. It does not require [`signing.partner_fingerprint`](#signingpartner_fingerprint): a run with none on file pins the certificate the partner presents at the authenticated setup step, and a run with no authenticated setup step to pin on is refused. Under `certificate` mode an authenticated CLI exchange produces a signed receipt: both parties sign the same terms and data-flow facts and swap signatures, each verifying the partner's pinned certificate first (see [PROTOCOL.md](spec/PROTOCOL.md#the-signed-receipt-step)). [`alcove verify-receipt`](CLI.md#verifying-the-signed-receipt) verifies a stored receipt later.

### `signing.identity_file`

*Type:* string (path)  
*Required:* yes under `certificate` mode; not otherwise

Path to this party's signing identity file (the P-256 private key plus its self-signed certificate). There is no default; Alcove resolves no location of its own. Keep it in a mounted directory of its own, separate from the read-write one the rotating key file needs, so this one can be read-only (custody: [SECURITY_DESIGN.md](SECURITY_DESIGN.md#custody-and-persistence); container mounting: [DEPLOYMENT.md](DEPLOYMENT.md#mounting-the-signing-identity)):

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/alcove-signing-identity.json
```

This is a local path, not an [`@`-file reference](#file-references). A leading `~` (or `~/`) is expanded to the home directory.

[`alcove fingerprint --identity-file`](CLI.md#where-the-signing-identity-lives) is the one command that writes the file, owner-read-only. An exchange and [`alcove verify-receipt`](CLI.md#a-verified-verdict-needs-both-certificates-anchored) only read it, so the directory can be mounted read-only for every run but the creating one. `alcove fingerprint --force` regenerates the identity and invalidates any fingerprint a partner has pinned.

Certificate mode with no `identity_file` is refused before the exchange runs (exit 64), naming both spellings of the path and `mode: none` as the way to run unsigned meanwhile. The rule is cross-field, not part of the block's schema, so a partially written config still parses. `alcove verify-receipt` with no path configured leaves this party's own certificate unanchored and grades the verdict `INCOMPLETE` (exit 66).

### `signing.partner_fingerprint`

*Type:* string (43-character unpadded base64url SHA-256)  
*Required:* no; recorded by the first exchange when absent

The partner's pinned certificate fingerprint. A presented partner certificate is trusted only if its self-signature verifies and its fingerprint matches this value; a mismatch rejects the certificate, and any receipt it holds, before any data crosses. The value stays valid until the partner regenerates its identity. Two ways to fill it:

- **Set it yourself, before the first run**, to the value the partner's `alcove fingerprint` prints, received over a channel you trust. The first exchange refuses a partner certificate that does not match it.
- **Leave it out**, and the first exchange adopts the certificate presented at the authenticated setup step, writes its fingerprint here, and states the value on stderr and on the machine-readable warning stream. Compare that value with the partner out of band before relying on the receipts.

What each pin is anchored to: [SECURITY_DESIGN.md](SECURITY_DESIGN.md#pinned-self-signed-trust-model). Only `alcove exchange` writes this field, only into the configuration file named on its command line, and only when the file holds none; a run whose partner presents a different certificate is refused and leaves the file unchanged. No schema rule ties this field to `signing.mode`, so a config with no partner fingerprint yet still parses.

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/alcove-signing-identity.json
  partner_fingerprint: iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg
```

### Where the receipt is written

No setting names the receipt's location. Under `certificate` mode the CLI writes the signed receipt to a timestamped `alcove-receipt-<time>.json` in the run's output folder, or the working directory when the result goes to stdout, with the same stamp as the exchange record ([Where a run's files go](spec/EXCHANGE_RECORD.md#where-a-runs-files-go)). The file is written owner-only. It holds no payload contents and no private keys: only public certificates, signatures, the terms and data-flow attestation, and a copy of the partner's linkage terms. It binds both parties' identities and the agreed terms, so it is not anonymous. What a holder learns: [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md#receipt-privacy-properties).

A receipt is accepted only if the identity the partner used in its agreed terms exactly matches the one its certificate authorizes. A party that uses a different identity string needs a regenerated certificate; see [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning).

---

## Retention and disposition

Optional. A self-facing operator note for the [self-attested exchange record](spec/EXCHANGE_RECORD.md): where this party files its copy of the result and under what retention schedule it is held or disposed of. It is purely local -- written into **this** party's record only, never swapped with the partner, cross-checked, or folded into the agreed-terms hash (unlike [linkage terms](#linkage-terms)) -- so the two parties' notes are independent and need not match. Metadata only: it must contain no protected, linkage-field, or payload value.

### `retention_disposition`

*Type:* string  
*Required:* no  
*Consistency:* none (per-party; not exchanged)

A free-text pointer recorded verbatim in the exchange record, so an auditor can see from the record alone where the result (the association table and any received payload) went and under what retention schedule. When present it must be non-empty; omit the field to record no pointer. The record is unsigned and local, so its own retention and access control are the holder's responsibility.

```yaml
retention_disposition: "Filed in Agency A association DB (links.prod); retained 6 years per records schedule RM-7, then purged."
```

The console sets it on its receipts card. The web application offers it when you save an exchange as a recurring one, and a stored recurring exchange changes it under its settings; each later run of that exchange writes it into its record.

---

## Your own columns in the result

Optional. The result file holds your matched record's identifier, your partner's row index, and the payload columns your partner sent ([PROTOCOL.md](spec/PROTOCOL.md#output)). This key adds columns of your own input beside them, so you do not have to join the result back to your input by hand.

Purely local, like [`retention_disposition`](#retention_disposition): not a linkage term, never sent or cross-checked, and not in the agreed-terms hash. Nothing extra is sent, the disclosure and consent displays are unchanged, and your partner's result file is untouched.

### `include_own_columns`

*Type:* string (`disclosed` or `all`)  
*Required:* no  
*Consistency:* none (per-party; not exchanged)

| Value | Columns written |
|-------|-----------------|
| `disclosed` | The columns you send to your partner: the ones your metadata marks `is_payload: true` with a role other than `ignored` |
| `all` | With a `metadata` block, every column the block declares, matching, payload, and ignored alike, but not a column it leaves [undeclared](#input-metadata). With no `metadata` block, every column of your input file |

Your identifier column is left out of both, since the result's first column already holds it.

```yaml
include_own_columns: all
```

The values come from the matched record each result row addresses and are written after your partner's payload columns. Under a [deduplicating cardinality](spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching) they repeat once per pair, as your identifier does; the row count does not change. A value holding a comma, a double quote, or a newline is escaped like every other result cell.

- A **count-only (`psi-c`)** exchange writes no result file, so the key is refused when the configuration is read (exit 64), naming it. Remove the key, or set the algorithm to `psi`.
- A party whose agreed [`output`](#linkage_termsoutput) gives it **no result** ignores the key silently, since which party receives the result is settled at the terms exchange.

A partner payload column whose name collides with one already written takes a `their_` prefix ([PROTOCOL.md](spec/PROTOCOL.md#output)).

The CLI reads the key, as does the console when it runs a config file. The web application sets it on its "Matching & sharing" step and writes it into every artifact that exchange produces; the control appears only where the exchange gives you a result table. A stored recurring exchange changes it under its settings. Your own columns are not covered by the exchange record's commitments, and verification of a result written with the key is unaffected ([EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md#commitment-scheme)).

---

## The key each match was made on

Optional. Under the `cascade` [linkage strategy](#linkage_termslinkage_strategy) each linkage key runs in turn, in the order listed, so a pair can be accepted on an earlier key or on a later, looser one. This key adds a last column to your result file naming which.

Purely local, like [`include_own_columns`](#include_own_columns): nothing about it is sent or hashed, and your partner's result file is unchanged.

### `include_matching_key`

*Type:* boolean  
*Default:* `false`  
*Required:* no  
*Consistency:* none (per-party; not exchanged)

With `true`, the result file ends with a column headed `matched_on_key` containing, for each pair, the `name` of the linkage key it matched on, as the agreed terms spell it.

```yaml
include_matching_key: true
```

For a [key that runs only where a field is missing](#keys-that-run-only-where-a-field-is-missing), the name is followed by whose record had no valid date of birth: `FN + LN + SSN4 (your record has no valid date of birth)` or `FN + LN + SSN4 (partner's record has no valid date of birth)`.

The column is written last, and verification of a result containing it is unaffected. It is always headed `matched_on_key`: a partner payload column or one of your own with that name is the one renamed, and an identifier column already named `matched_on_key` moves it to `own_matched_on_key` ([PROTOCOL.md](spec/PROTOCOL.md#output)).

`true` is refused when the configuration is read (exit 64), naming the key, on:

- a **count-only (`psi-c`)** exchange, which writes no result file;
- a **`single-pass`** exchange, for either party, since the party that sends first receives the resolved matches without the rounds behind them;
- terms whose [`output`](#linkage_termsoutput) gives you **no result**.

`alcove exchange --include-matching-key` turns the column on for one run and `--no-include-matching-key` turns it off; the flag overrides the key. The web application sets it on its "Matching & sharing" step and writes it into the same artifacts as the own-columns choice, showing the control unavailable, with the reason, where the terms refuse it. The console reads it from an opened configuration and writes it back on a save.

---

## The field delimiter of your files

Optional. The field delimiter Alcove reads your input CSV by and writes your result file with.

Purely local: nothing about it is sent or hashed, and the two parties need not use the same one.

### `csv_delimiter`

*Type:* string (one character, `tab`, or `detect`)  
*Required:* no  
*Default:* a comma  
*Consistency:* none (per-party; not exchanged)

One character: a tab, or a printable ASCII character other than the double quote (`"`). Anything else - more than one character, an empty value, the double quote, a line break, a character outside ASCII - is refused when the configuration is read, before any credential, terms, or data are sent. Write a tab as `tab` or `\t`, or as a literal tab in a double-quoted YAML string.

`detect` takes the delimiter from the file, among the comma, tab, pipe, semicolon, and the ASCII record and unit separators; a file separated by anything else is read with commas.

```yaml
csv_delimiter: "|"
```

The result file is written with the delimiter this key names, so it can be fed back to the system the input came from; under `detect`, or with the key absent, it is written with commas. A field holding the delimiter, a double quote, or a line break is quoted on the way out. A `--csv-delimiter` flag replaces the key for one run, and `alcove init --csv-delimiter` writes the key into its template; see [CLI.md](CLI.md#the-field-delimiter).

A file read with the wrong delimiter parses as a single column, and the linkage-terms column check refuses it, naming the remedy: set the file's separator, or `detect`.

The CLI reads the key, as does the console when it runs a config file. The web application offers the same choice beside the file picker at each file step, starting on the comma; the choice stays in the browser, no invitation contains it, and a recurring exchange stores it so an unattended run reads the file the same way. Changing it under a stored exchange's settings re-reads the stored input file and states whether it still covers every agreed key before saving. The console offers it at its own file steps and writes it as this key in the configuration it composes; its quick exchange passes it as `--csv-delimiter`.

---

## Input metadata

Optional field-level descriptions of the input dataset. If omitted, semantic types are inferred from column names. If no identifier column is specified, output row indices reference positions in the input file.

What a party sends is exactly what its metadata declares:

- A column the metadata does not name is undeclared. Where the block is inferred for a configuration or an invitation, that is every column inference does not recognize (see the table below); a [quick exchange](CLI.md#quick-exchange) declares every column. An undeclared column is never sent and never indexes a record, and is matched on only where a standardization transform names it as its `input`.
- Before it connects, a run names its undeclared columns: `alcove` logs a warning and, with `--event-stream`, emits a `warning` event with source `undeclaredColumns` ([CLI_EVENTS.md](spec/CLI_EVENTS.md#warning-sources)); the console and the web app show the same notice. To send one, declare it with `is_payload: true`; to silence the notice, declare it `role: ignored`. When no column has `role: identifier`, the CLI's and the console's notice also name `role: identifier`.
- A column declared as sent (`is_payload: true` with a role other than `ignored`) that the input file does not hold is refused before the run connects, naming the column (`alcove exchange` exits 64). Add the column to the file, or set `is_payload: false`.

**Column names read from the file:**

- With no `metadata` block, an empty column name, produced by a trailing, leading, or doubled delimiter in the header row, is refused when the file is read, in the CLI and in the web app's file steps. Name the column or remove the empty header field.
- Control and text-direction characters are removed from every header when it is read ([CSV header sanitation](spec/PARSED_INPUT_BOUNDS.md#csv-header-sanitation-at-ingestion)), and the app states which column positions changed. A header made only of them comes back empty and is refused as above, naming the removal as the cause. A `metadata`, `linkage_fields`, or `standardization` name must be written without those characters, as `alcove init` writes it, to name the column.
- A declared name holding those characters is refused by the [name rule](#linkage-terms): the configuration fails to load, naming the field by its issue path (for example `metadata.0.name` from `alcove exchange`) and printing none of the value. A `standardization` `output` or `input` is outside the rule, since neither is sent, but is held to the same 256-character ceiling.
- A transmitted column's name longer than the ceiling is refused during data preparation, before any credential, terms, or data are sent. Shorten the header, or set the column not to transmit (on a [quick exchange](CLI.md#quick-exchange), by writing a configuration with `alcove init URL INPUT_FILE`). A column used only for matching or ignored is not refused over its length, and neither is any column of a party whose partner is entitled to no result. The web app applies the same bound where columns are marked to send, and `alcove invite` refuses an over-long disclosed name (exit 64) before it prints the invitation or writes any file.

`metadata` is a list of column entries directly, not an object wrapping one:

```yaml
metadata:
  - name: "LAST_NAME"
    type: last_name
    role: linkage
    is_payload: false
    description: "Legal last name as recorded at enrollment"
  - name: "DOB"
    type: date_of_birth
    role: linkage
    is_payload: false
  - name: "CLIENT_ID"
    type: identifier
    role: identifier
    is_payload: false
    description: "Internal client identifier"
  - name: "PROGRAM_START_DATE"
    type: other
    role: payload
    is_payload: true
    description: "Date client enrolled in the program"
  - name: "COUNTY"
    type: other
    role: ignored
    is_payload: false
    description: "Present in the input but excluded from this exchange"
```

### Column fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name in the input CSV; must be non-empty, at most 256 characters, unique within the metadata block (matched case-sensitively), and free of control and text-direction characters (the [name rule](#linkage-terms) above). A violation is rejected at config parse |
| `type` | string | yes | Semantic type (see [Semantic Types](#semantic-types) above) |
| `role` | enum | yes | `linkage`, `identifier`, `payload`, or `ignored` |
| `is_payload` | boolean | yes | Whether this column is transmitted as payload data after the intersection is identified |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

**A `metadata` block is all-or-nothing per column.** `type`, `role`, and `is_payload` are required on every column the block lists, and a column missing any of them is rejected when the configuration is read. Inference runs only when the whole `metadata` block is absent, over the input file's header row:

- **Configuration or invitation.** An `alcove exchange` configuration with no `metadata` block, and an invitation composed from an input file, infer only the columns they recognize and send none of them; every other column is undeclared and not sent.
- **Quick exchange.** A run with no invitation and no configuration, on the command line or in the console, declares every column: each column whose name is neither a recognized linkage name nor an id column is sent. A linkage column under an unrecognized name, such as `Given Name`, is sent, and the pre-run display lists it.

| Column | `type` | Configuration or invitation: `role`, `is_payload` | Quick exchange: `role`, `is_payload` |
|--------|--------|------------------------------------|--------------------------------------|
| A recognized linkage name (`ssn`, `dob`, `first_name`, `phone`, `email`, `zip`, and their aliases, among them each SSN, phone, street number, and unit name with the endings `number`, `no`, `num`, and `nbr`, such as `ssn_number`, `HomePhoneNumber`, and `StreetNo`), looked up before the id rules below | the matching semantic type | `linkage`, `false` | `linkage`, `false` |
| `id`, `identifier`, a name ending in `_id`, such as `case_id` or `Member ID`, a name `MRN`, `ClientID`, `PersonID`, `PersonalID`, `PatientID`, `RecordID`, or `MemberID`, or a record number: any other name ending in `number` or `_no`, such as `case_number`, `Record No`, or `CaseNumber`, or in `No` after a lowercase letter, such as `RecordNo`, other than `yes_no` | `identifier` | `identifier`, `false` when it is the record identifier (below); otherwise undeclared and not sent | `identifier` when it is the record identifier (below), otherwise `ignored`; `false` |
| A name the table does not list | `other` | undeclared: no entry, not sent | `payload`, `true` |

The complete list of names that infer each type, with each one's role and payload default, is in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names); no other name is recognized. A header is compared ignoring letter case and any character that is not a letter or digit at either end, with each run of whitespace, `_`, `-`, and `.` inside it read as one `_` and each `#` read as `number`, then matched whole. So `ZIP`, `First Name`, ` ssn`, `(ssn)`, `Tel.`, `SSN #`, and `Date-of-Birth` are recognized, while `Given Name`, `Birthdate`, `E-mail`, `zip_area`, and `ssn_last4` are not. The column keeps its header as written in the display, the bindings, and the result.

**Identifiers.** The first `identifier`-typed column in the header gets `role: identifier`: in a header of `case_id` then `Record ID`, or `case_id` then `id`, `case_id` indexes the records. A record number, which is often not unique to one record, is passed over when an `identifier`-typed column that is not a record number follows it: in a header of `Visit Number` then `client_id`, `client_id` indexes the records, and with only record numbers, the first indexes them. Every other `identifier`-typed column is undeclared, or declared `role: ignored` on a quick exchange. To index by a different column, declare it with `role: identifier` in a `metadata` block. Inference sends no `identifier`-typed column, whatever its name. To send your record identifier for matched records, set `is_payload: true` on its entry in a `metadata` block, or choose **unique record identifier - sent to your partner** in the web app's or console's column settings. A quick exchange sends none; to send one, write a configuration with [`alcove init`](CLI.md#initialization) and run `alcove exchange`.

**`role` and `is_payload`.** A column used for linkage or as an identifier can also have `is_payload: true`: it is matched on *and* delivered to the partner for matched rows. In the web app's and console's column settings, **used to match - sent to your partner** is `role: linkage` with `is_payload: true`, and **unique record identifier - sent to your partner** is `role: identifier` with `is_payload: true`. Any other column is sent only when declared `role: payload` with `is_payload: true`, as a quick exchange declares it.

**`role: ignored`** declares a column used for nothing: never matched, never an identifier, never sent, even with `is_payload: true`. Unlike an undeclared column, a transform naming it binds nothing, and it is dropped from the run's notice. Inference assigns `ignored` only to an `identifier`-typed column that is not the record identifier on a quick exchange; the column settings list an undeclared column as ignored so it can be chosen.

**What is matched on.** A column's standardized value enters a linkage key when it is roled `linkage` and its `type` matches a linkage field, or when a [data standardizing transformation](#data-standardizing-transformations) names it as `input` for that field. An undeclared column named by a transform is matched on as the transform states; a declared column so named binds only when it is roled `linkage`. A column roled `identifier`, `payload`, or `ignored` is never matched on. A linkage field with no column bound to it is reported as unsatisfiable before the exchange runs.

---

## Data standardizing transformations

Optional per-column transformations applied before linkage keys are built. Each transformation reads one input column, applies a sequence of steps, and writes the result under a linkage field name: its `output` must match the `name` of a field in `linkage_terms.linkage_fields`.

```yaml
standardization:
  - output: last_name      # matches linkage_terms.linkage_fields[].name
    input: LAST_NAME
    steps:
      - function: remove_affixes
      - function: remove_punctuation
      - function: to_upper_case

  - output: date_of_birth
    input: DOB
    steps:
      - function: parse_date
        params:
          input_format: "MM/DD/YYYY"
          output_format: "YYYYMMDD"

  - output: ssn
    input: SSN_RAW
    steps:
      - function: remove_dashes
      - function: null_if
        params:
          values: ["000000000", "123456789", "111111111"]

  - output: last_name_variants   # fan-out: one row -> multiple PSI entries (see Fan-out below)
    input: LAST_NAME
    steps:
      - function: to_upper_case
      - function: split_on
        params:
          delimiter: "[-\\s]"
          include_original: true  # keep "SMITH-JONES" as well as "SMITH", "JONES"
```

Each linkage field may have at most one transformation. A field with none is given an identity transformation and bound to an input column by matching the field's semantic type against the column's metadata. A configuration that authors no `standardization` at all is cleaned by the per-type defaults, a cross-party contract specified in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md).

An authored `standardization` that contradicts the linkage terms - an `output` naming no declared linkage field, or a step naming an unknown `function` - fails closed (the CLI exits 64), naming the output or function. `alcove exchange`, and any run that creates no invitation, refuses during data preparation, before any credential, terms, or data are sent; on a quick exchange the first-use host-key probe of an unpinned SFTP server, which presents no credential, can precede it ([SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#sftp-host-key-verification)). A config-source `alcove invite` refuses before it creates the invitation.

A `split_on` step under the count-only algorithm is refused wherever the terms are known; see [Fan-out (multi-value fields)](#fan-out-multi-value-fields).

### Transformation fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output` | string | yes | Name of a linkage field from `linkage_terms.linkage_fields` |
| `input` | string | yes | Column name in the raw input CSV |
| `steps` | array | no | Steps applied in order; if omitted the raw value is used unchanged |
| `max_people_per_value` | integer | no | The most distinct people in your own file who may hold one cleaned value of this field; a value held by more is dropped from every record holding it. If omitted, no value is dropped for being shared |
| `null_if_last_name` | object | no | `values` and `last_names`, two lists of cleaned values: this field's value is dropped from a record when it is one of `values` and the record's cleaned last name is one of `last_names`. If omitted, no value is dropped for its last name |

`max_people_per_value` screens the whole file after the steps have cleaned each record, before keys are built, dropping a value one person could not hold alone, such as one SSN recorded for two people or an organization's phone number recorded for many clients. A person is a record's cleaned first name and date of birth, read from your own columns of those types whether or not the terms use them, so a person's own duplicate records count once. When your own terms set `deduplicate`, a record whose SSN is dropped also loses the `ssn4` value read from the same column. The default cleaning sets it on `ssn`, `phone_number`, and `email_address` fields ([Shared-value screens](spec/DEFAULT_STANDARDIZATION.md#shared-value-screens)).

`null_if_last_name` reads the last name from your own last-name column, cleaned by your `last_name` transformation or the default one, whether or not the terms use it. The default cleaning sets it on a `first_name` field to drop the first name `JOHN` or `JANE` beside the last name `DOE`, so such a record matches only on keys without a first name ([First name beside a listed last name](spec/DEFAULT_STANDARDIZATION.md#first-name-beside-a-listed-last-name)).

Neither setting is sent to your partner, and you may change or remove either default in your own standardization. In the web app and the console, each field's card on the Cleaning tab edits both; an entry cleaning would change, and so never match, is flagged with the form to enter instead, and a limit that is not a whole number of 1 or more blocks the invitation or the exchange.

### Step fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions below) |
| `params` | object | no | Function-specific parameters |

A step declares at most 16 parameters. The invitation's consent summary states each one in the snake_case spelling the document schema uses (`include_original`; a free-form key `keyMaterial` shows as `key_material`), and a refusal names it the same way. Refused where a document is read, from a partner's invitation or your own configuration alike: a private key block in a parameter value, a parameter name, a step's function name, or the `identity`; and a `null_if` step declaring both `value` and `values`. See [TRANSFORM_PARAMETER_BOUNDS.md](spec/TRANSFORM_PARAMETER_BOUNDS.md#transform-parameter-declared-types).

### Unicode normalization

Before the first step of any transformation runs, the input value is normalized to Unicode NFC, for every field, including one with no `steps`. Two parties holding the same value in different normalization forms (precomposed on one side, decomposed on the other) therefore match. NFC, not NFKC, is used: ligatures and full-width forms are preserved.

Literal values a step injects into or compares against the data - `null_if` values, a `coalesce` default, a `replace_regex` replacement, and a `pad_left` character - are normalized to NFC too, and the assembled key string is normalized again after its elements are concatenated. Regex *patterns* (`replace_regex`, `extract_regex`, `filter_regex`, `split_on`) are applied as written; write any non-ASCII in a pattern in NFC.

`to_upper_case` can emit a non-NFC sequence for six code points (on `U+0390` it gives `U+0399 U+0308 U+0301`), so `null_if`, `filter_regex`, `extract_regex`, `replace_regex`, `split_on`, and `parse_date` normalize the value they inspect to NFC before matching. `null_if` and `filter_regex` pass the original value on unchanged; the steps that derive a new value derive it from the normalized form.

### Null propagation

A step may produce `null` to signal that the record has no valid value for this field. Once a step produces `null`, all subsequent steps are skipped and the field is absent from the record's PSI entry for any linkage key that references it. This is the intended mechanism for enforcing `exclude` constraints declared in a linkage field: a `null_if` step actively removes excluded values rather than merely warning.

`coalesce` is the only function that acts on `null`: it substitutes a literal default, allowing a pipeline to recover from an earlier null-producing step.

### Fan-out (multi-value fields)

The `split_on` function produces `set<string>` instead of a single `string`, so the field holds several candidate values. Each value is a separate PSI entry for the row, and every entry keeps the row's identifier, so a match resolves back to the source row.

**Cross-product**: a linkage key over several fan-out fields matches on the cartesian product of their values; a `split_on` on both `first_name` and `last_name` with two parts each produces four key strings per row. The count is capped at the width the agreed terms declare for that key: 20 candidate values for each element that splits, multiplied together. A row over the cap sits that key's round out, as a row with no value does, remains eligible for later keys, and draws a warning; a round names the first few dropped rows and then one line with that key's totals. The cap and its arithmetic: [PROTOCOL.md](spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates).

**Either linkage strategy**: fan-out runs under [`cascade`](#linkage_termslinkage_strategy) and `single-pass` with the same table on the same rows; each strategy keeps its own disclosure. A key whose element splits costs 20 toward the single-pass dataset ceiling in place of 1; a fan-out in your own `standardization` multiplies the record count you declare instead ([PROTOCOL.md](spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare)). The count-only algorithm [`psi-c`](#linkage_termsalgorithm) refuses a fan-out when the terms are authored or written into an invitation, at data preparation, and again once both parties' terms are agreed on. `deduplicate: true` on both parties does not ([`linkage_terms.deduplicate`](#linkage_termsdeduplicate)).

**What the accepting party is told**: an invitation whose linkage keys split a value marks each such key element as matching on several values and states the consequences: matching per candidate, the record leaving later keys once any candidate matches, and the candidate grouping the resolver is handed. A fan-out in your own `standardization` is local and in no invitation.

**Authoring in the web app and the console**: the cleaning-step menu offers `split_on`, in the invite editor and on the accepting party's Cleaning tab, and the linkage-key editor offers it on a key element. Under a count-only invitation the accepting party's menu does not offer it, and a splitting step in its own cleaning blocks the start. A configuration pasted into the import box, or opened in the console, loads its `standardization` as `alcove exchange` reads it; each field whose cleaning could not be loaded is named with the reason.

**Match resolution**: when several entries from one row match in a key's round, the parties do not communicate to resolve it. Both derive the same record pairing locally: a deterministic rule accepts at most one pair per record, and every record whose candidates matched at all leaves the candidate set for later keys, so a record matches once or not at all ([PROTOCOL.md](spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates)).

**Distinction from `generate_fuzzy_comparisons`**: a standardization fan-out says a field has several legitimate canonical values (a hyphenated name and its parts), and several matches from one row may all be meaningful. `generate_fuzzy_comparisons` generates approximate variants of one value to tolerate entry errors, and one match is expected.

### Available functions

Parameter names are written in snake_case in YAML (`input_format`, `include_original`). Unlike `connection.provider_options`, a `params` block is not passed verbatim.

**Each parameter has a type, and a wrong one is refused when the document is read**, in a configuration file and in an invitation alike, naming the parameter and the type it got. A string parameter must be quoted where YAML would read it as something else: an unquoted `0`, `007`, `true`, or `null` is a number, a boolean, or a null. `substring`'s `start` and `length` and `pad_left`'s `length` are whole numbers, and `split_on`'s `include_original` is `true` or `false`. Leave a parameter out to take its default; a `null` is not a default. `pattern` (`replace_regex`, `extract_regex`, `filter_regex`) and `delimiter` (`split_on`) have no default, and a step missing one is refused when the document is read; a missing `start`, `length`, or `pad_left` `length` is caught at acceptance and again at the run.

**Regex patterns run under a linear-time engine** (RE2 semantics), not the JavaScript engine, so no pattern a partner authors can backtrack catastrophically. The cost is still bounded:

- For `filter_regex` and `extract_regex` the cost per row grows with the value length times the pattern size, so pattern size is capped; a pattern over the limit is rejected at terms validation, naming the step. Long counted repeats such as `.{0,999}` and many capture groups are what reach it; `(?:...)` for a group the step does not read lowers the size.
- For `replace_regex` and `split_on` the cost can grow with the square of the value length; avoid a pattern whose preferred alternative can run to the end of the value (such as `(?:[^#]*#|.)`) on long values.
- In a linkage key's element transform, every regex step (`parse_date` included) counts against the work one row may spend deriving a key. A row that runs past it refuses the exchange, naming the step, or, in a key that `split_on` expands, is left out of that key's round with a warning ([TRANSFORM_REGEX_DIALECT.md](spec/TRANSFORM_REGEX_DIALECT.md#transform-regex-linear-time-dialect)).
- Backreferences and lookarounds are not supported, and a few escapes and class semantics differ from JavaScript; a pattern outside the dialect is rejected at terms validation. Nested quantifiers such as `(a+)+` are accepted.

The syntax, the size limit, and the JavaScript differences are specified in [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

#### String transformation

| Function | Description | Parameters |
|----------|-------------|------------|
| `remove_non_ascii` | Remove all characters outside of the ASCII set, including emojii and symbols | - |
| `remove_punctuation` | Remove ASCII punctuation and symbols | - |
| `remove_dashes` | Remove hyphens | - |
| `replace_separators_with_spaces` | Replace hyphens, apostrophes, ampersands, slashes, and underscores with spaces, including the typographic apostrophes and dashes in the [punctuation map](spec/DEFAULT_STANDARDIZATION.md#punctuation-map) | - |
| `squash_spaces` | Replace every run of Unicode whitespace (tab, line break, non-breaking space, and the other Unicode spaces) with a single space | - |
| `trim_whitespace` | Remove leading and trailing whitespace | - |
| `to_upper_case` | Convert to uppercase | - |
| `to_lower_case` | Convert to lowercase | - |
| `remove_accents` | Remove accents and other diacritics, ASCII-ifying the text, and spell out the Latin letters that have no accent to strip (the [letter table](spec/DEFAULT_STANDARDIZATION.md#letter-table)); re-normalizes to NFC after the diacritic strip | - |
| `remove_affixes` | Remove name titles (Mr., Dr., ...) that lead the value and suffixes (Jr., III, ...) that end it, each only while another word remains; a title or suffix word elsewhere is kept, and runs of whitespace collapse to one space. The word lists: [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#affix-removal) | - |
| `substring` | Extract a substring | `start` (integer, 1-indexed, required; negative counts from end), `length` (positive integer, required) |
| `parse_date` | Reformat a date string | `input_format` (default `MM/DD/YYYY`), `output_format` (default `YYYYMMDD`), each at most 256 characters; an empty `output_format` is refused, since it would render every date to the empty string; tokens: `YYYY`, `YY`, `MM`, `DD` |
| `pad_left` | Left-pad the value with a fill character up to a target length; pass-through if already at or above the length | `length` (positive integer, required; capped at 256 in a linkage key element's `transform`, uncapped in a `standardization` step), `char` (single character, default `"0"`) |
| `phonetic` | Apply a phonetic encoding | `algorithm`: `soundex` (default); result is a 4-character string, or `null` for a value carrying no letters |
| `zip3` | Keep the first three digits of a five-digit ZIP code, leading zeros included (`02139` -> `021`); produce `null` for any value that is not exactly five digits | - |
| `state_code` | Replace a US state, District of Columbia, or territory name, in any letter case, with its two-letter USPS code, keeping a code as it is; produce `null` for any other value. The recognized names: [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#state-and-territory-codes) | - |
| `usps_street_name` | Write a street name's suffix and directionals in their USPS Publication 28 forms, read by position: a trailing directional, the suffix before it, and a leading directional are abbreviated (`NORTH BAY STREET` -> `N BAY ST`), and a directional or suffix word that is part of the name is spelled out. Other words are kept as written; words are compared in any letter case, and runs of whitespace collapse to one space. The rules and tables: [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#street-name-abbreviations) | - |
| `replace_regex` | Replace all regex matches | `pattern` (required), `replacement` (default `""`) |
| `extract_regex` | Keep the first capture group, or the whole match if the pattern has none; produce `null` if there is no match or the result is empty | `pattern` (required) |

`parse_date` reads the year from `YYYY` or `YY`. A `YY` value resolves against a fixed cutoff both parties share, so both derive the same year, which may be a year not yet reached. In an `output_format`, `YY` is emitted literally; only `YYYY`, `MM`, and `DD` are substituted. The cutoff: [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

**Steps that can never produce a value are refused before the run.** An exchange is refused unless every agreed linkage key can match, so one dead key stops the run; the CLI reports it before any connection or credential, the web acceptor's confirm-columns step flags the key, and the browser editor badges the key and holds Generate shut. Agree on terms over keys both files can supply. Dead steps:

- a `parse_date` whose `input_format` cannot supply a complete date, such as `MM/DD`;
- a `substring` with `start` or `length` left out, a `start` of `0`, or a `length` of `0`;
- a `substring` with a negative `length` whose window can never open: `start` plus `length` of `1` or more, or a `start` of `-1`.

A window that only overshoots the values a particular file holds is left to the coverage warnings.

**A step that cannot be built is refused when the invitation is created**: a `pad_left` with no `length` or a fill longer than one character, a `phonetic` naming an algorithm this build does not implement, or an unrecognized `function`. A config-source `alcove invite` and the browser editor's Generate both check, naming the step's function where it is recognized and the remedy: correct the step's parameters, or remove it. The browser editor marks a malformed cleaning-step parameter on its input and an unrecognized function on the step, and holds Generate shut until it is fixed; on a linkage-key element only an unrecognized function holds Generate. A document with more transform steps than the limit, counted across all cleaning steps and key element transforms, is refused at the same points with the count and the limit.

#### Null-producing (filter) functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `null_if` | Produce `null` if the value matches | `value` (single string) or `values` (array of strings), one or the other |
| `filter_regex` | Produce `null` if the value does not match the pattern | `pattern` (required) |

#### Recovery

| Function | Description | Parameters |
|----------|-------------|------------|
| `coalesce` | Replace `null` (or an empty list after filtering) with a literal default | `default` (string) |

#### Fan-out

See [Fan-out (multi-value fields)](#fan-out-multi-value-fields) for how the values are matched and when a fan-out is refused.

| Function | Description | Parameters |
|----------|-------------|------------|
| `split_on` | Split the value on a regex delimiter, producing `Set<string>` | `delimiter` (regex pattern, required), `include_original` (boolean, default `false`) |

When `split_on` finds no delimiter it returns the value as a single-element set; with `include_original: true` the unsplit value is prepended to the parts. Either way the value is the NFC-normalized form ([Unicode normalization](#unicode-normalization)).

A `delimiter` that can match the empty string - the empty delimiter, or a pattern such as `-*`, `-?`, or `|` - is refused when the document is read, naming the step. Write a delimiter whose every match is at least one character, such as `-+`. The web app's step editor marks such a delimiter as you type it.

Steps following `split_on` are applied element-wise across all parts. Null-producing steps filter individual elements; if all elements are filtered the field becomes `null` and `coalesce` may recover it.

---

## Where each setting is edited

What each application does with each setting when it opens a configuration. On the command line the editor is `alcove.yaml` itself, which `alcove init` writes with every optional section present as a commented example, so a command-line cell states only whether a command, flag, or prompt also sets the value. The console and the web application edit what they can run, keep the rest unchanged, and refuse a setting they cannot run or cannot write back unchanged; the reasons are under the table.

The columns:

- **Command line** -- whether an `alcove` command, flag, or prompt sets the value. Anything the command line does not set, you set by editing `alcove.yaml`.
- **Console** -- what opening an `alcove.yaml` from the working folder does with the value, and whether a console control changes it afterwards.
- **Web application** -- what importing an `alcove.yaml` as a stored exchange does with the value, and whether that exchange's settings change it afterwards.

The cells:

- **authored** -- you can set the value here: a command, flag, prompt, or control writes it, or the application works it out from your input file ("inferred") or records it when you invite or accept. Terms copied unchanged from a partner's invitation do not count.
- **carried** -- the application keeps the value you wrote and writes it back unchanged, and uses it where it applies, but has no control for it and does not tell you so. Change it by editing the file or in another application.
- **carried with a notice** -- carried, and the application tells you which settings it holds unchanged.
- **refused** -- the application will not open the configuration, or will not run it, while it states the setting, and names the setting.
- **dropped** -- the application opens the configuration but uses its own value in place of the one you wrote, or leaves it out, without telling you. This is a defect, not a design.
- **not applicable** -- the application supplies the value itself, the setting has no effect there, or the setting belongs to a channel the application does not run (see `connection.channel`).

| Setting | Command line | Console | Web application |
|---------|--------------|---------|-----------------|
| **[Linkage terms](#linkage-terms)** | | | |
| `linkage_terms.version` | not applicable | not applicable | carried with a notice |
| `linkage_terms.identity` | authored | authored | carried with a notice |
| `linkage_terms.date` | not applicable | not applicable | carried with a notice |
| `linkage_terms.algorithm` | carried | authored | carried with a notice |
| `linkage_terms.linkage_strategy` | authored | authored | carried with a notice |
| `linkage_terms.output.expects_output` | carried | authored | carried with a notice |
| `linkage_terms.output.share_with_partner` | carried | authored | carried with a notice |
| `linkage_terms.deduplicate` | authored (quick exchange only) | authored | carried with a notice |
| `expected_partner_deduplicate` | authored (recorded on accept) | carried with a notice | carried with a notice |
| `linkage_terms.linkage_fields` (`name`, `type`) | authored (inferred) | authored (inferred) | carried with a notice |
| `linkage_terms.linkage_fields` (`constraints`) | carried | carried with a notice | carried with a notice |
| `linkage_terms.linkage_keys` | authored (inferred) | authored | carried with a notice |
| `linkage_terms.legal_agreement` | carried | authored | carried with a notice |
| `linkage_terms.payload.send` (`name`) | authored (stated from `metadata` on invite and update) | authored (inferred) | carried with a notice |
| `linkage_terms.payload.send` (`description`) | carried | carried with a notice | carried with a notice |
| `linkage_terms.payload.receive` | authored (recorded on accept, on save, or on the first run) | carried with a notice (left out once you choose not to receive the results) | carried with a notice |
| **[Connection](#connection)** | | | |
| `connection.channel` | authored | authored (`sftp`, `filedrop`); `webrtc` runs the file in place | carried (`webrtc`); `sftp` and `filedrop` open but are refused at run |
| `connection.path` (filedrop) | authored | carried with a notice (the run uses the mounted folder; converting replaces it) | not applicable |
| `connection.inbound_path`, `connection.outbound_path` (filedrop) | authored | carried with a notice (the run uses the mounted folders; converting replaces them) | not applicable |
| `connection.server.host` (sftp) | authored | authored | not applicable |
| `connection.server.port` (sftp) | authored | authored | not applicable |
| `connection.server.path` (sftp) | authored | authored | not applicable |
| `connection.server.inbound_path` (sftp) | authored | authored | not applicable |
| `connection.server.outbound_path` (sftp) | authored | authored | not applicable |
| `connection.server.username` (sftp) | authored | authored | not applicable |
| `connection.server.password` | authored | authored (entered again; a warning names it; the recurring-run hand-off states a file reference as read until you convert the configuration) | not applicable |
| `connection.server.private_key` | authored | authored (entered again; a warning names it; the recurring-run hand-off states a file reference as read until you convert the configuration) | not applicable |
| `connection.server.private_key_passphrase` | authored | authored (entered again; a warning names it; the recurring-run hand-off states a file reference as read until you convert the configuration) | not applicable |
| `connection.server.keyboard_interactive` | authored | authored | not applicable |
| `connection.server.host_key_fingerprint` | authored | authored (a rotation list is entered separated by commas; a quick exchange takes one value) | not applicable |
| `connection.server.certificate` | refused | refused | refused |
| `connection.server.known_hosts` | refused | refused | refused |
| `connection.server.provision` (sftp) | carried | refused | not applicable |
| `connection.server.provision` (webrtc) | carried | carried (refused while the server has no `host` yet) | refused |
| `connection.server.host`, `port`, `path` (webrtc) | authored | carried (shown on the review step) | carried |
| `connection.server.secure` (webrtc) | authored | carried (shown on the review step as the address's scheme) | refused |
| `connection.server.key` (webrtc) | carried | carried | refused |
| `connection.server.username` (webrtc) | not applicable | not applicable | refused |
| `connection.role` | authored | carried | carried |
| `connection.stun` | carried | carried | refused |
| `connection.turn` | carried | carried (its urls shown on the review step) | refused, except beside `connection.relay_registrar` (see that row and [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#what-the-exports-write)) |
| `connection.invitation_relay` | authored (recorded on accept) | carried (its turn urls shown on the review step) | carried (recorded on accept; the browser relays through it on each re-run) |
| `connection.relay_registrar` | carried | carried with a notice (the enrollment step) | authored (enrolled under Relay registration; read from a file imported with its key file, refused in one imported alone) |
| `connection.ice_provision` | refused | refused (opens; its run is withheld) | refused |
| `connection.options.peer_timeout_ms` | authored | authored | refused |
| `connection.options.inactivity_timeout_ms` | authored | authored | refused |
| `connection.options.server_connect_timeout_ms` | authored | authored | refused |
| `connection.options.max_reconnect_attempts` | authored | authored | refused |
| `connection.options.poll_interval_ms` | authored | authored | not applicable |
| `connection.options.retain_files` | authored | authored | not applicable |
| `connection.options.timestamp_in_filename` | authored | authored | not applicable |
| `connection.options.lockless_rendezvous` | authored | authored | not applicable |
| `connection.options.peer_id` | authored | authored (a value holding [fields](#fields-in-peer_id) opens and is carried; the name control takes none) | not applicable |
| `connection.options.unexpected_files` | carried | authored | not applicable |
| `connection.options.connection_per_poll` | authored | authored | not applicable |
| `connection.options.write_without_renaming` | authored | authored | not applicable |
| `connection.provider_options` (sftp) | carried | refused | not applicable |
| `connection.provider_options` (webrtc) | not applicable | not applicable | refused |
| **[Authentication](#authentication)** | | | |
| `authentication.shared_secret` | not applicable | refused | refused |
| `authentication.expires` | not applicable | refused | refused |
| `authentication.token_max_age_days` | carried | authored | authored |
| **[Signing](#signing)** | | | |
| `signing.mode` | carried | authored | opens and is carried with a notice, but refused at run (a mode of `none` asks for no receipt and runs) |
| `signing.identity_file` | carried | carried with a notice (a signed run waits for converting, which replaces it with a location you pick in the console) | opens and is carried with a notice, but refused at run |
| `signing.partner_fingerprint` | authored (pinned on first contact) | authored | opens and is carried with a notice, but refused at run |
| **Other top-level settings** | | | |
| `retention_disposition` | carried | authored | authored |
| `include_own_columns` | carried | authored | authored |
| `include_matching_key` | authored (`--include-matching-key` overrides it for one run) | authored | carried |
| `csv_delimiter` | authored | authored | authored |
| **[Input metadata](#input-metadata)** | | | |
| `metadata` (`name`, `type`, `role`, `is_payload`) | authored (inferred) | authored | carried with a notice |
| `metadata` (`description`) | carried | carried | carried with a notice |
| **[Data standardizing transformations](#data-standardizing-transformations)** | | | |
| `standardization` | authored (inferred) | authored | carried with a notice |

A refused cell has one of these reasons:

- **The web application stores no credential and connects with this browser's own settings**, so a connection setting outside the locator the invitation named is refused on import; which settings and why: [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-connection-block-credential-free-by-composition).
- **The console writes the sftp connection block whole from its own controls**, so a setting inside that block with no control cannot be written back and the file is refused rather than the setting dropped; which settings: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#what-it-refuses).
- **No application runs it.** [`connection.ice_provision`](#connectionice_provision) names an endpoint neither application calls, and `authentication.shared_secret` and `authentication.expires` belong in the key file beside the configuration, not in the configuration.

---

## Full example

An end-to-end annotated specification covering every component is planned; see [ROADMAP.md](ROADMAP.md). For the linkage-terms component, the web application's expert authoring surface in the Matching keys tab exports the terms as a JSON or YAML document (and imports one back, round-tripped through the same validation), which serves as a GUI-produced reference. The per-section snippets above are the working reference for the rest.

## See also

- [DESIGN.md](DESIGN.md) - overview of exchange specification purpose and its four components
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - the self-attested exchange record this specification's governance fields and `retention_disposition` pointer feed into
- [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md) - the per-type default cleaning pipelines and the column-name inference table, for a configuration that authors no `standardization` or `metadata` block
- [PROTOCOL.md](spec/PROTOCOL.md) - how linkage terms parameterize the PSI protocol
- [COMMUNICATION.md](COMMUNICATION.md) - how `connection` fields map to channel infrastructure
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services referenced in `connection` fields
- [CLI.md](CLI.md) - CLI commands and configuration files that consume this specification
