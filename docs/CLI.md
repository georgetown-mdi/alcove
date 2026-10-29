---
title: "Alcove CLI"
---

# Alcove CLI

This document covers the CLI commands, configuration files, invitations, and recovery procedures for Alcove. The PSI protocol is in [PROTOCOL.md](spec/PROTOCOL.md), the security and authentication model in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), and the supporting services in [DEPLOYMENT.md](DEPLOYMENT.md). Intended readers are IT staff and power users.

Before a first SFTP exchange against a server you do not administer, work through the [SFTP server checklist](DEPLOYMENT.md#sftp-server). A server setting it covers is the usual cause of an SFTP exchange that stalls without an error naming the cause.

## Find your task

| I want to... | Run | Read |
| --- | --- | --- |
| Set up an exchange I will run again with the same partner | `alcove invite`, then `alcove exchange` | [Your first recurring exchange](#your-first-recurring-exchange) |
| Try one exchange with no setup | `alcove URL INPUT_FILE` | [Quick exchange](#quick-exchange) |
| Write a configuration to edit by hand | `alcove init` | [Initialization](#initialization) |
| Invite a partner | `alcove invite` | [Offline invitation](#offline-invitation), [Online invitation](#online-invitation) |
| Accept an invitation I was sent | `alcove accept` | [Offline acceptance](#offline-acceptance), [Online acceptance](#online-acceptance) |
| Exchange with a partner who uses the web app | `alcove invite` with the web app's address | [Inviting over WebRTC](#inviting-over-webrtc) |
| Run an exchange that is already set up | `alcove exchange` | [Recurring exchange](#recurring-exchange) |
| Run it on a schedule | cron or the Task Scheduler | [Scheduling the run](#scheduling-the-run) |
| Read an SFTP server's host key before a scheduled run | `alcove probe-host-key` | [Reading a host key](#reading-a-host-key-with-probe-host-key) |
| Check a network folder before the first exchange over it | `alcove doctor` | [Checking a network shared folder](#checking-a-network-shared-folder) |
| Check that this host reaches a WebRTC exchange's relay | `alcove doctor relay` | [Checking the relay of a WebRTC exchange](#checking-the-relay-of-a-webrtc-exchange) |
| Change the agreed terms with an existing partner | `alcove update`, then `alcove apply` | [Changing the terms](#changing-the-terms-of-an-established-partnership) |
| Check an exchange record or receipt | `alcove verify-receipt` | [Verifying a receipt](#verifying-a-receipt) |
| Recover from a lost or out-of-sync key file | re-invite | [Recovery](#recovery) |
| Find out how large an exchange can be | | [How large an exchange can be](DEPLOYMENT.md#how-large-an-exchange-can-be) |
| Understand an exit code | | [Exit codes](#exit-codes) |

## Your first recurring exchange

Two parties, Agency A and Agency B, set up an exchange once and then run it on a schedule. Agency A invites; Agency B accepts. Each party needs an input CSV, and both need a place to exchange files: a directory on an SFTP server both can reach, or a folder both have mounted (a network share or a shared folder).

The commands below use an installed `alcove`. With the container image, run each one as `docker run -it --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest` followed by the same arguments (see [Running the CLI](DEPLOYMENT.md#running-the-cli)).

### 1. Each party: make a directory for this partner

Make one directory for this exchange and put your input file in it, then run every command below from that directory. It will hold the configuration (`alcove.yaml`), the key file (`.alcove.key`), the results, and each run's exchange record. Keep it between runs: the key file changes after every exchange.

### 2. Agency A: create the invitation

```sh
alcove invite --identity "Agency A" input.csv
```

This reads the column names in `input.csv`, chooses the linkage keys and data cleaning from them, writes `alcove.yaml` and `.alcove.key`, and prints an invitation. Send it to Agency B over a channel you trust, such as encrypted email or a phone call.

The invitation expires one hour after it is created. If Agency B cannot accept and run the first exchange within the hour, pass `--expires-in`, for example `--expires-in 2d`.

### 3. Agency B: accept it

```sh
alcove accept --identity "Agency B" INVITATION input.csv
```

Alcove shows what the exchange will disclose -- the columns each party sends, who receives the result -- and asks you to confirm. Read it before answering. On yes, it writes `alcove.yaml` and `.alcove.key`; on no, it writes nothing. Giving `input.csv` checks that your file has the columns the agreed terms need.

### 4. Each party: fill in the connection

Both configurations have a placeholder `connection` block. Replace it with the block for your channel, from [Connection blocks by channel](EXCHANGE_REFERENCE.md#connection-blocks-by-channel). For a shared folder:

```yaml
connection:
  channel: filedrop
  path: /mnt/share/exchanges/agency-a-agency-b
```

For an SFTP server, give the host, the directory, the username, and the credential as an `@`-file reference so the password or key stays out of the file. Before the first exchange over a network folder, `alcove doctor` checks that it behaves as an exchange needs ([Checking a network shared folder](#checking-a-network-shared-folder)).

### 5. Both parties: run the first exchange by hand

```sh
alcove exchange input.csv ./
```

Both parties run this at about the same time; each waits up to one hour for the other. Agency A must run it before the invitation expires.

- **On SFTP**, the first run shows the server's host-key fingerprint and asks you to confirm it. Check it against the fingerprint your server administrator gives you; on yes, Alcove records it in `alcove.yaml` for later runs ([SFTP host-key trust](#sftp-host-key-trust)).
- **What success looks like.** The command exits with code 0 (`echo $?` prints `0`), and the directory holds the run's matched records as `alcove-results-<time>.csv` beside its exchange record `alcove-record-<time>.json` and verification keys, all named with the same time stamp. The `./` names the folder the run writes its files in, so each run adds files rather than overwriting the last ([The result file](#the-result-file)).
- **What failure looks like.** The command prints the error and the next step, and exits with a code other than 0; [Exit codes](#exit-codes) says what to do with each.

The first run also rotates the shared secret in `.alcove.key`. After that, neither party re-invites unless a key file is lost or the two fall out of step ([Recovery](#recovery)).

### 6. Each party: schedule it

Agree on a time with your partner, then hand the same command to your scheduler. A daily run at 02:00 under cron:

```text
0 2 * * * cd /srv/alcove/agency-b && /usr/local/bin/alcove exchange input.csv ./ --log-file /srv/alcove/agency-b/exchange.log
```

A scheduled run has no terminal to ask at, so settle everything it would ask first: on SFTP, pin the host key, as the first run by hand does or with [`alcove probe-host-key`](#reading-a-host-key-with-probe-host-key). [Scheduling the run](#scheduling-the-run) covers the container form, mailing the owner on failure, the working directory, and the key file's expiry.

## Configuration

Exchange details are stored in two files: a configuration file and an authentication key file. The defaults are `./alcove.yaml` and `./.alcove.key`, and `--config-file` and `--key-file` override them on every command that takes them; they are not listed again below. When these files are first created, the application prints a notice naming both and warns that the key file is private: add it to `.gitignore`. For Docker deployments, mount one directory per exchange partner; the application does not check this layout. A configuration and key file written by a build from before the product was renamed Alcove keep the earlier product's name, which no command looks for; rename them to `alcove.yaml` and `.alcove.key` by hand.

The shared secret and its expiry are stored in the key file, never in the configuration, and the application rotates them; they are not user-editable. Permissions, backup and handling of the key file: [Key file security](SECURITY_DESIGN.md#key-file-security).

Command line arguments take precedence over values in the configuration file, so a scripted run can override one parameter without editing the stored configuration.

**Credentials.** Credential and opaque string fields take `@`-file references: a value beginning with `@` is read from the file at that path, on the command line and in the configuration file (for example `--server-private-key=@/run/secrets/id_rsa`). Use one for every credential, so it stays out of process listings and shell history. Which fields take a reference, and what a leading `@` means in every other field: [File references](EXCHANGE_REFERENCE.md#file-references).

- **A credential typed as a value** -- in `--server-password`, `--server-private-key`, `--server-private-key-passphrase`, `--server-provision-bearer`, or `--server-provision-password`, or as the password in a URL -- draws a warning as soon as the arguments are read, before anything is contacted, naming the `@path` form that command takes. `alcove init`, which has no credential flag, names the configuration-file form instead.
- **What a saved configuration holds.** A command that writes a configuration -- a quick exchange run with `--save`, or `invite`/`accept` -- records the `@path` reference, not the resolved secret. A literal credential is saved as-is, with a warning naming the field and the `@path` form; move the value into a file before you commit or share the configuration. A URL password that begins with `@` cannot be saved, since it would read as a reference: `init`, `invite`, `accept`, and a `--save` run refuse it before connecting, and you pass `--server-password @path` instead.
- **Permissions.** The saved configuration is owner-only (mode `0600`; on Windows, an access list granting only your account).
- **Paths in a reference.** A reference is stored as typed. A `~/`-relative one such as `@~/.ssh/id_rsa` stays valid on another machine; a relative one such as `@secrets/pw` resolves against the working directory of whichever command reads it, so use an absolute or `~/` reference for a command that runs elsewhere.
- **When it is read.** A saved `@path` is resolved when the configuration loads, before any network activity. A file that has been moved, deleted, made unreadable, or emptied fails the load with a usage error naming the reference, and no connection is attempted.

Written with `@path` references, the configuration holds no secret and can be committed to version control. That protects its author, not whoever runs it: never run `alcove exchange` against a configuration from an untrusted source. The run reads every `@path` it names from your disk with your privileges, and for an SFTP exchange sends the resolved `server.password` to the configured `server.host`. An invitation holds no credential, so only a substituted configuration file reaches this. Threat model: [Configuration-file trust boundary](SECURITY_DESIGN.md#configuration-file-trust-boundary).

`alcove exchange` writes no credential. It edits an existing `alcove.yaml` only to record a pin, neither of them secret: the SFTP host key ([SFTP host-key trust](#sftp-host-key-trust)) and the partner's signing certificate fingerprint ([Pinning the partner's certificate](#pinning-the-partners-certificate)).

A command that edits an existing `alcove.yaml` in place -- recording a pin, filling `linkage_terms.payload.receive` on a first run, writing the address of a server `invite` created, applying a terms update -- keeps every line it does not change exactly as written, spacing and comments included. The lines it adds or changes are written in the YAML writer's own style (`{ a: 1 }`, one space before a `#` comment), indented to match the lines around them. The exceptions:

- A comment on the line of a key whose whole value is replaced is dropped with that value.
- A line the writer lays out together with the change is rewritten with it: all of a flow collection written across several lines when the change falls inside it, or a comment the writer moves off its key's line when the change is right below.
- The whole file is rewritten in the writer's style where the change cannot be placed within the file's own layout -- for example inside a sequence entry written with extra space after its dash -- or where the file is too large for the line comparison, a working cap set in the code and raised on request.

Every command removes surrounding whitespace from the `--key-file` value, including the carriage return a path read from a Windows-style text file ends in; a value that is only whitespace is refused.

**Identity.** `--identity IDENTITY` supplies this party's label in the linkage terms: what your partner sees as your name there, in the invitation, and in the exchange record.

| Command | Where the label comes from |
| --- | --- |
| [`alcove invite`](#offline-invitation), [`alcove accept`](#offline-acceptance) writing a new configuration | `--identity`, required; refused (exit 64) without it. `accept` asks for it at a terminal. |
| `alcove invite` from an existing configuration, or `alcove accept` [keeping one](#existing-files) | That file's `linkage_terms.identity`. A typed `--identity` is reported as having no effect. A file holding none, a blank one, or the placeholder is refused, naming the field. |
| [`alcove exchange`](#recurring-exchange) | The configuration's `linkage_terms.identity`; `--identity` replaces it for that one run. With neither, the run is unnamed. |
| [Quick exchange](#quick-exchange) | `--identity` if given; otherwise the run is unnamed. |
| [`alcove init`](#initialization) | `--identity`; otherwise asked at a terminal; otherwise a placeholder. |

- **When a command asks.** Only `init` and `accept` ask, and only with a terminal on standard input and no `--identity`; the answer goes into the configuration the command writes. With no terminal (a pipe, a container started without `-t`, a CI job), `init` writes the placeholder and `accept` refuses (exit 64). Nothing is asked where a command writes no configuration. `invite`, `exchange`, and the quick exchange never ask.
- **Blank means absent.** An empty or blank flag value -- what `--identity "$ORG"` sends when `ORG` is unset -- is absence: a usage error (exit 64) where a label is required, an unnamed run where it is optional. Where a label is required, a blank `linkage_terms.identity` is absence too: a usage error (exit 64). A flag value is trimmed before it is sent; a label read from a configuration is sent as its own bytes, whitespace included.
- **What absence means.** Alcove substitutes no label of its own. The terms and the exchange record omit the field, and every surface that shows a party name shows `(no name given)`. A run with `signing.mode: certificate` needs a label on both sides: this party's absence is refused before the exchange starts (exit 64), and the partner's at terms agreement, before any linkage key or data crosses ([Pinning the partner's certificate](#pinning-the-partners-certificate)).
- **The placeholder.** `alcove init` writes a placeholder into `linkage_terms.identity` when it gets no label. That exact value, matched whole ignoring surrounding whitespace, is refused wherever a label is read, as an absent one is, and as an `--identity` value it exits 64 before anything is sent.
- **Signing.** A certificate authorizes an exact identity string, so a signing identity bound to a padded value diverges from a trimmed flag value, and an exchange that signs under it is refused before it runs ([Signing identity and the agreed terms](#signing-identity-and-the-agreed-terms)).

**Paths.** A leading `~` (or `~/`) in a local path is expanded to the current user's home directory; `~user` is not resolved. Which paths are expanded:

- The path inside an `@`-file reference, wherever one is resolved.
- `--config-file` and `--key-file`, on every command; surrounding whitespace is removed, and a value left empty is a usage error (exit 64).
- On `alcove exchange`, the input and output paths and `signing.identity_file`.
- On `alcove fingerprint`, `--identity-file` and `--export-certificate`; on `alcove verify-receipt`, `RECORD`, `--keys`, `--signed-record`, `--partner-terms`, `--identity-file`, and `signing.identity_file`.
- Not the quick exchange's positionals, and no positional path on `alcove invite` or `alcove accept`: there a `~/` path is taken literally and creates a directory named `~`, so pass an absolute path.

Arguments after a `--` separator are always positional, so a path beginning with `-` is given as `alcove exchange [options] -- -input.csv ./results`. An argument past the last positional a command takes is a usage error (exit 64) that shows the command's usage.

**Connection URLs.** Alcove percent-decodes the host, path, username, and password of a URL into the stored connection fields, so a reserved or non-ASCII character is percent-encoded in the URL and stored decoded: `sftp://user@host/my%20drop` targets the directory `my drop`. A malformed percent-escape (such as a lone `%`) is a usage error (exit 64), with the credential redacted from the message. The path of an `sftp://` or `ssh://` URL names the server directory:

- A path names an absolute directory: `sftp://host/srv/drop` is `/srv/drop`.
- A path under `/~/` names a directory relative to the login directory: `sftp://host/~/drop` is `drop`. Write `%7E` for a first directory literally named `~` (`sftp://host/%7E/drop` is `/~/drop`).
- No path, `/`, or `/~` uses the login directory itself.
- Each path segment is decoded on its own, and a segment holding an encoded slash (`%2F`) is refused (exit 64): separate directories with `/`.

The host must be a server name or an IP address, an IPv6 literal written in brackets (`sftp://[2001:db8::1]/drop`); a port must be 1 to 65535. A URL holding a query or fragment is refused (exit 64), so a `?` or `#` in a directory name is written `%3F` or `%23`.

**Reading the CSV from standard input.** An `INPUT_FILE` given as `-` is read from standard input, for example `cat data.csv | alcove exchange - results/`, on `alcove exchange`, the quick exchange form, `alcove invite`, `alcove init`, and `alcove verify-receipt` (its `INPUT_FILE` only; `RESULT_FILE` must be a path).

- **`alcove accept`** takes `-` only with `--consent-to-terms`, which frees standard input from the confirmation prompt; otherwise a `-` input is refused with guidance to give a file path.
- **`alcove init`** with a `-` input cannot prompt, so when a configuration already exists at the output path it fails closed rather than overwrite.
- **At an interactive terminal**, `-` with nothing piped in is reported as an error rather than left waiting.

**Durations and timeouts.** A duration on the command line is a positive integer and a required one-character unit: `s`, `m`, `h`, or `d` (`45s`, `30m`, `2h`, `1d`). A bare number such as `30` is refused, naming the suffixed form to use. This applies to every duration option, including `--expires-in`, `--accept-timeout`, `--connection-timeout`, `--peer-timeout`, and `--inactivity-timeout`. The defaults of `--connection-timeout`, `--peer-timeout`, and `--inactivity-timeout`, and the configuration fields behind them, are in [Shared options](EXCHANGE_REFERENCE.md#shared-options).

- **Ceiling.** `--connection-timeout`, `--peer-timeout`, `--inactivity-timeout`, `--accept-timeout`, and `probe-host-key`'s `--connect-timeout` are capped at `7d`; a larger value is a usage error naming the flag and the maximum, before any connection, token, or file write. `--expires-in` has its own one-year ceiling.
- **`--polling-frequency`** sets how often the `sftp` and `filedrop` channels poll the shared folder, overriding `poll_interval_ms` (default `5s` on `sftp`, `250ms` on `filedrop`). It also accepts a millisecond unit (`100ms`), which no other duration option does. Every wait for the partner's next file costs up to one interval, so the interval adds up across a run: on a small exchange each linking key takes six to ten intervals ([FILE_SYNC.md](spec/FILE_SYNC.md#poll-interval-and-step-pace)). The `sftp` default stays within SFTP servers' anti-flood limits: lower it only where you control the server. The `filedrop` default is shorter because a shared folder has no server to flood. On `sftp` a value below `1s` is warned about, not blocked, since it can trip a server's anti-flood protection; on `filedrop` no value is warned about. A value above `2147483647ms` (about 24 days) is a usage error, and `poll_interval_ms` has the same maximum.
- **Where the connection flags apply.** `--polling-frequency` and the other connection-tuning flags take effect on the commands that open a live connection: the quick exchange, `alcove exchange`, and the online `invite`/`accept`. On an offline `invite`/`accept` they are reported as ignored; set the field under `connection.options` in the written configuration. The exceptions are `--peer-timeout` and `--inactivity-timeout`, which an [acceptance that runs the exchange itself](#accepting-and-running-a-webrtc-exchange) applies.
- **`--inactivity-timeout`** sets how long a partner that has arrived may send nothing before the exchange fails, overriding `inactivity_timeout_ms` for this run. On `sftp` and `filedrop` it also bounds each single operation on the server or folder. Raise it for a partner that takes longer than the default to compute one step on a large dataset. A command that writes a configuration records it there.

### What the CSV read refuses

An `INPUT_FILE` is checked as it is read, before any credential, terms, or data are sent:

- **A row that cannot be parsed** -- an unterminated quote, or a row whose field count differs from the header -- stops the command with a usage error (exit 64) naming the data row and the reason. Such a file would otherwise reach your partner as a smaller dataset than you meant to send.
- **A CSV with no data rows** -- an empty file, or a header with nothing under it -- stops the same way. Otherwise an unattended run would exchange nothing, rotate the shared secret, and exit 0.

Nothing is disclosed, no configuration or key file is written, and the shared secret does not rotate. Correct the file and run the command again.

The row check applies to `alcove exchange`, the quick exchange form, `alcove invite`, `alcove accept`, and the files `alcove verify-receipt` reads. The empty-dataset check applies to the exchange commands only, since a result CSV with no rows is what a zero-match exchange writes. `alcove init` applies neither: it reads only the header and a sample of one column.

### The field delimiter

`--csv-delimiter` sets the field delimiter of the CSV a command reads and of the result file it writes. The default is a comma. The configuration field is [`csv_delimiter`](EXCHANGE_REFERENCE.md#csv_delimiter); the flag replaces it for one run.

- **Accepted values.** One character -- a tab, or a printable ASCII character other than the double quote -- or `detect`. Anything else is a usage error (exit 64) before anything is sent. Write a tab as `tab` or `\t`: `alcove exchange --csv-delimiter tab data.tsv results.tsv`.
- **The result follows it.** A run that reads pipes writes pipes. A run that names `detect`, or nothing, writes commas. A field holding the delimiter, a double quote, or a line break is quoted.
- **It is local.** The delimiter is not part of the linkage terms, the invitation, or the exchange record, and the two parties need not use the same one.
- **Where it applies.** `alcove exchange`, the quick exchange form, `alcove invite`, `alcove accept`, `alcove init`, and `alcove verify-receipt`. Other commands report it as an unknown option.
- **Where it is recorded.** `alcove init`, a quick exchange run with `--save`, and the configurations `invite`/`accept` write record it as `csv_delimiter`. A flag is never written into a configuration Alcove only read; where that configuration governs later runs, a flag naming a different delimiter is reported, and later runs use the file's value. A run given no flag uses its configuration's `csv_delimiter`: for `alcove invite` and `alcove accept` the one at the config path, for `alcove exchange` the one it runs from, and for `alcove verify-receipt` the one passed as `--config-file`, so pass the exchange's configuration there to re-read its files by the delimiter they were written with.
- **`detect`** takes the delimiter from the file, among the comma, tab, pipe, semicolon, and the ASCII record and unit separators; a file separated by anything else is read with commas.

A file read with the wrong delimiter parses as a single column, which shows up as linkage terms the input cannot satisfy. That refusal names the delimiter and the `detect` choice.

## Initialization

```sh
alcove init [--channel sftp|filedrop] [URL] [INPUT_FILE]
```

This writes a commented configuration template with defaults pre-filled and exits: no exchange, no invitation, no key file, and no network activity on any path. Fields the template leaves out are in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md). Given an input file, `init` infers the column metadata, linkage fields, and data standardizing transformations from it. Edit the file by hand before the first exchange.

```sh
# A connection block that needs only the SFTP credential added
alcove init sftp://alice@sftp.example.org/exchanges/drop input.csv
```

- **Identity.** `--identity` pre-fills `linkage_terms.identity`. Without it, `init` asks at a terminal; with no terminal, or a blank answer, it writes the placeholder, which is refused wherever a label is read until you replace it ([Configuration](#configuration)).
- **Connection from a URL.** An `sftp://` or `ssh://` URL sets the host, port, username, and the server directory as `path` (no directory leaves `path` out, for the login directory); a `file://` URL sets a `filedrop` block's `path`. Add the credential as an `@path` under `connection.server`. A password in the URL is written as typed, with a warning naming the `@path` form. A URL with no username leaves the username placeholder.
- **Connection without a URL.** `--channel sftp` (the default) writes the host, `username`, and `path` as `REPLACE_WITH_...` placeholders, and `--channel filedrop` the shared folder `path`. A `ws://` or `wss://` URL and `--channel webrtc` are refused (exit 64): a `webrtc` block is written by [`alcove invite`](#inviting-over-webrtc) or by accepting an invitation, and the template ends with a commented `webrtc` example.
- **Placeholders are refused.** `alcove exchange` refuses a configuration still holding any `REPLACE_WITH_...` value (exit 64) before it connects, naming the field, for example `connection.server.host`. `--server-username` or `--identity` stands in for its field for one run. An offline `alcove invite` or `alcove accept` that writes an `sftp` connection writes the same username placeholder.
- **Nothing is sent by default.** The inferred `metadata` sends no column, your ID column included: it reads `role: identifier` and `is_payload: false`. Set `is_payload: true` on a column's entry to send it for matched records.
- **Columns not declared.** Input columns the inference does not recognize are left out of `metadata`, so a run from the configuration does not send them (a [quick exchange](#quick-exchange) on the same file does). The template lists each after the `metadata` block as a commented entry; uncomment it to send that column for matched records. The comment also says how to make one of them the record identifier.
- **The console.** The [console](CONSOLE.md) is an alternative to hand-editing: it produces a filled-in `alcove.yaml`, the `alcove exchange` command, and scheduler examples for one exchange, with machine-specific paths left as placeholders.
- **Exit behavior.** On success the command prints a notice naming the file and exits 0; an unreadable or malformed `INPUT_FILE` exits 64.

If a file already exists at the output path, `init` asks before overwriting; declining leaves it untouched. With no terminal to ask at (a non-interactive run, or a `-` input that has claimed standard input), it fails closed with a usage error: delete the file or pass `--config-file`. The identity question comes after that decision, and a `-` input means neither question is asked.

## Quick exchange

```sh
alcove [--identity IDENTITY] [--save] [--linkage-strategy STRATEGY] [--deduplicate] [--csv-delimiter DELIM] [--sweep-exchange-files [--force-retain-sweep]] URL INPUT_FILE [OUTPUT_FOLDER]
```

Both parties run this command against the same server. Each party's linkage terms, metadata, and data standardizing transformations are inferred from its own input file; if the inferred terms disagree, the exchange fails with an error. By default no configuration files are written. Security rests on the transport and file system controls rather than a pre-shared secret: over SFTP or a shared folder, the server or share administrator is trusted.

- **It sends every column that is neither a linkage key nor an id column.** For each matched record, each party sends every input column that is not a linkage key or an id column (`id`, `identifier`, `MRN`, `ClientID`, `PersonID`, `PersonalID`, `PatientID`, `RecordID`, `MemberID`, a name ending in `_id`, such as `case_id` or `Member ID`, or a name ending in `number` or `_no`, such as `case_number` or `Record No`, or in `No` after a lowercase letter, such as `RecordNo`). A name in the [inference table](EXCHANGE_REFERENCE.md#input-metadata) keeps its type first, so `ssn_number` and `StreetNo` are linkage keys, not id columns. Id columns are held back; the first indexes your result, passing over a record number such as `case_number` when an id column of another kind follows it. A column is a linkage key when its header is one Alcove recognizes, such as `first_name`, `date_of_birth`, `ssn`, `phone`, `email`, or `zip` ([inference table](EXCHANGE_REFERENCE.md#input-metadata)); headers are compared ignoring case and any punctuation at either end, with each run of whitespace, `_`, `-`, and `.` inside read as one `_` and each `#` read as `number`. Recognized columns are never sent: a built-in key matches on them, or they are held back. A linkage column under a name the table does not list, such as `Given Name` or `Birthdate`, is sent like any other column, so check the [display](#what-the-run-shows-before-it-starts) the run prints before it connects. To keep such a column back, rename it to a recognized name. To choose the columns sent, write a configuration with [`alcove init URL INPUT_FILE`](#initialization), edit its `metadata`, and run [`alcove exchange`](#recurring-exchange).
- **A phone, email, street number, ZIP, state, or county column in only one file stops it.** The built-in rules build keys over those columns, and the two parties' keys must match. The exchange stops at the terms, before any data is sent, and the party whose file has the column sees its header named. Remove it from that file, or set the exchange up with an invitation ([`alcove invite`](#offline-invitation), then [`alcove accept`](#offline-acceptance)). Renaming the header to one Alcove does not recognize sends the column to your partner instead.
- **It always uses the keys marked less certain.** Where your file has first name, last name, and date of birth columns, the run uses the built-in keys that match on those alone, marked `(less certain)` ([Rules marked less certain](EXCHANGE_REFERENCE.md#rules-marked-less-certain)). To leave them out, write a configuration with `alcove init`, delete them from `linkage_keys`, and set the exchange up with an invitation.
- **It takes a minute or more.** Each step waits up to one poll interval (`--polling-frequency`; by default 5 seconds on `sftp`, 250 milliseconds on `filedrop`) for the partner's next file.

`--linkage-strategy STRATEGY` chooses `cascade` or `single-pass` as for [`alcove invite`](#offline-invitation). Here each party infers its own terms, so both must pass the same value; a mismatch aborts the exchange. An unknown value is a usage error before any connection.

`--deduplicate` lets several of this party's records match one of the partner's ([`linkage_terms.deduplicate`](EXCHANGE_REFERENCE.md#linkage_termsdeduplicate)). It is off by default and is each party's own: the two values need not agree, and the pair decides the exchange's cardinality at the terms exchange. Setting it widens what the partner discloses. Both parties setting it gives a many-to-many match, under either linkage strategy. With `--save` the value is written into the saved configuration.

The URL scheme determines the transport channel:

| Scheme | Channel | Description |
|--------|---------|-------------|
| `sftp://` or `ssh://` | `sftp` | SFTP server; SSH credentials required |
| `ws://` or `wss://` | `webrtc` | WebRTC via a PeerJS coordination server (not available in a quick exchange -- see below) |
| `file://` | `filedrop` | Locally-mounted shared folder (e.g. NFS or SMB share) |

A `ws://` or `wss://` URL is refused here (exit 64). WebRTC parties meet at signaling ids derived from a shared secret, which a quick exchange does not have. Establish one with [`alcove invite`](#offline-invitation) and [`alcove accept`](#offline-acceptance), then run [`alcove exchange`](#webrtc-exchanges).

For SFTP, SSH credentials must be supplied in the URL or as command-line arguments. Embedding credentials in the URL is not recommended as URLs may appear in shell history and process listings; use the `@path` convention instead - see [Configuration](#configuration).

```sh
# SFTP example
alcove --identity "Jane Doe, County Services" sftp://user@sftp.example.org/exchanges/drop input.csv ./results

# Shared folder example, running unnamed (network-mounted folder)
alcove file:///mnt/sftp-share/drop input.csv ./results
```

Before it contacts the server, the run states what it will send and match on, whatever `--log-level` is set ([What the run shows before it starts](#what-the-run-shows-before-it-starts)), followed by a warning that, with no shared secret, anyone who administers the server or shared folder could stand in for your partner. A run refused for a usage error shows neither.

Without `--save`, the run ends by explaining how to set up a recurring exchange with `alcove invite` and `alcove accept`. With `--save`, the intent is advertised to the partner in-band at the start, with the outcomes in [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret). The configuration and key file are saved after the exchange completes and its result is written, so a save that cannot reach disk is a lost local write (exit 73, and a `warning` on the event stream), not a failed exchange ([Exit 73](#exit-73-the-exchange-completed-a-local-write-did-not)). `--config-file` and `--key-file` set the paths it saves to.

Configuration or key files already present are ignored, with a warning to use `alcove exchange` if you meant to use them. With `--save` and no path argument, a file at the default path is an error instead; delete it or name another destination.

## Invitations

Subsequent commands agree to exchanges through invitations. An invitation is a base64url-encoded, unpadded representation of the information needed to agree on an exchange. In particular it contains:
- Linkage terms
- Invitation authentication token (short-lived; rotated to a persistent secret on acceptance)
- Optionally, a credential-free connection endpoint (see below)
- A 4-byte hash of the above, used to check for transcription errors

An invitation MAY include a connection endpoint: a public locator that tells the acceptor where to rendezvous (a PeerJS signaling URL, an SFTP host and port, or a shared folder) so the parties need not arrange that detail over a separate channel. A WebRTC endpoint may also name the inviter's relay by its TURN and STUN urls, which the acceptance shows before you consent and writes as [`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay). The endpoint is the locator only and never includes credentials -- no password, private key, key file, PeerJS API key, or relay credential. Each party still supplies the credential portion of its own `connection` block independently. When an invitation omits the endpoint, both parties configure their `connection` block entirely on their own.

Because an invitation holds the shared authentication token -- and, in the web flow, the rendezvous derived from it -- treat it as confidential and forward it only over a trusted, out-of-band channel (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

Wherever a command reads an invitation, it also takes a web app accept link, `https://app.example.org/accept#<invitation>` (or `http://`): the invitation is the part after `#`, and nothing else of the link is used. A link with nothing after `#` is refused as a malformed invitation.

Invitations beginning with `-` may be misinterpreted as option flags by argument parsers. On `invite`, `accept`, and `init`, a single-`-`-leading token is kept as a positional and validated against the invitation (or file) schema, while a `--`-prefixed token -- which a positional never is -- is rejected as an unrecognized option (exit 64), so a `-`-leading invitation is identified unambiguously and a mistyped flag is still caught.

## Offline invitation

Invite and accept can run without any server connection, when the two parties are not available at the same time or prefer not to use a coordination server.

```sh
alcove invite --identity IDENTITY [--expires-in DURATION] [--linkage-strategy STRATEGY] [INPUT_FILE]
```

This generates a shared secret, saves it with an `expires` field to the key file, prints an invitation (see [Invitations](#invitations)) and instructions for its use, and exits. Forward the invitation over a trusted out-of-band channel.

**Lifetime.** The invitation expires one hour after the shared secret is generated. `--expires-in DURATION` overrides that, up to `365d`; a zero, negative, malformed, or longer value is refused before any invitation is generated. Use the shortest window your coordination allows: a leaked, unaccepted invitation is usable for its whole lifetime. The command states the expiry in local time, with the UTC instant and the time left beside it, and names `--expires-in` when it was not given.

**Linkage strategy.** `--linkage-strategy STRATEGY` is `cascade` (the default) or `single-pass`; any other value is a usage error before anything is generated. `cascade` runs one dependent PSI round per key, so the round-trip count grows with the number of keys; `single-pass` runs every key in one exchange, a constant round-trip count, for a high-latency channel (`filedrop` or `sftp`). Both produce the same matched result. `single-pass` discloses the sender's full per-key value structure to the receiver, which then observes matches on less precise keys that `cascade` would have filtered out. Selecting it prints a note to that effect, the partner sees the same note at consent, and both parties must agree on the strategy or the exchange aborts ([`linkage_terms.linkage_strategy`](EXCHANGE_REFERENCE.md#linkage_termslinkage_strategy)). When the terms come from an existing configuration, the flag has no effect; set `linkage_strategy` there.

**Where the terms come from.** An invitation needs an existing configuration file or an `INPUT_FILE` to infer terms from. With both, the configuration supplies the terms and the input is checked against them on the verdict `alcove exchange` enforces, so an invitation is created only when every agreed linkage key can contribute:

- A key is unsatisfiable when the input's columns cannot be standardized into a linkage field it references.
- A key is dead when its own cleaning can never produce a value, for example a `parse_date` whose input format omits a required component. The remedy is a corrected configuration, not a different input.

The refusal names the keys, the linkage fields they cost, and the configuration the terms came from.

**Identity.** Terms inferred from an `INPUT_FILE` require `--identity`. Terms from a configuration use its `linkage_terms.identity`, and an `--identity` given there is reported as having no effect. A configuration holding no identity is refused.

**A `webrtc` configuration.** When the configuration's connection is `webrtc`, the invitation names its coordination server and relay as its [connection endpoint](#invitations), as an [online invitation over WebRTC](#inviting-over-webrtc) does: the `url` of each `turn` entry that sets no `username` or `credential`, and the `stun` list ([`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay)). That block must be valid; another channel's block may still be a placeholder. A partner who accepts it with an `INPUT_FILE` runs the exchange at once ([Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)), so run `alcove exchange` at the same time, or have them accept with [`--no-run`](#accepting-without-running) and agree on when both of you run it. An invitation requesting a column their configuration does not send stops their acceptance until they declare it, so agree on the time either way.

Given only an `INPUT_FILE`, the command writes the inferred linkage terms, metadata, and data standardizations to a configuration file, and tells you to fill in its connection block before exchanging.

### Abandoning a pending offline invitation

To withdraw a pending offline invitation before its `expires`, delete the key file it wrote (`.alcove.key` at the default path, or the `--key-file` path). The key exchange completes only while the inviting party holds the pending secret, so the invitation you forwarded can no longer authenticate a handshake. Delete only the key file and leave `alcove.yaml` in place. The `invite` command prints this reminder, naming the key file. An invitation you leave alone lapses at its `expires`. Recovering a lost or compromised key is a different procedure ([Recovery](#recovery)).

## Offline acceptance

```sh
alcove accept --identity IDENTITY INVITATION [INPUT_FILE] [OUTPUT_FOLDER]
```

`INVITATION` is the invitation itself or an `@path` reference to a file holding one. The command decodes it, displays what acceptance discloses, and asks you to confirm. On yes, it writes the configuration and key files (with the exceptions below) and, unless the acceptance runs the exchange itself, tells you to fill in your connection parameters; on no, it writes nothing. Anything to settle with the partner, such as unacceptable terms or an expired invitation, is settled out of band.

`--identity` names this party in the terms the acceptance records. Without it, at a terminal, `accept` asks for the label after the invitation decodes and before the terms are displayed.

- **Where nothing can answer** -- no terminal, or [`--consent-to-terms`](#accepting-without-the-prompt) -- an acceptance with no label is refused (exit 64).
- **A kept configuration.** An acceptance that keeps an [existing configuration](#existing-files) asks nothing and proceeds under that file's `linkage_terms.identity`. A `--identity` given there is reported as having no effect, naming both labels; the notice is shown with the terms display on the terminal that asks, at any `--log-level`, and an unattended run at `error` or `silent` reports it nowhere. A kept configuration holding no label, or the placeholder, is refused (exit 64).

`OUTPUT_FOLDER` is the folder for the result and record of an acceptance that runs its own exchange ([Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)); without it the result goes to standard output ([The result file](#the-result-file)). An acceptance that writes only a configuration and key file reports the argument unused.

An argument past the last positional is a usage error (exit 64) on this form and the [online](#online-acceptance) one. The two read the third position differently -- `OUTPUT_FOLDER` here, `INPUT_FILE` there -- so an extra argument is reported with the form's usage.

### When an acceptance runs the exchange

The rule is the same on every channel and on both forms: an acceptance runs the exchange when it has everything a run needs, which is an `INPUT_FILE` and a connection. The connection is the WebRTC coordination server the invitation names on this form, or your own URL on the [online](#online-acceptance) form. Otherwise it writes the configuration and key file and stops. The first three points apply on every channel:

- **The configuration is the same whether it runs or stops.** Given an `INPUT_FILE`, it holds the `metadata` and `standardization` blocks inferred from the file. Each column under `columns the inviting party requests from you` is listed in `metadata`: a column inference leaves out is listed with `role: payload` and `is_payload: false`, which does not send it, and one inference lists stays as inferred.
- **`--no-run` writes the files and stops without connecting** ([Accepting without running](#accepting-without-running)).
- **A requested column the configuration does not send stops an acceptance that would run.** Your partner's run refuses an exchange that does not send the columns it requests. Inference sends no column, your `id` column included, so an inferred configuration sends none of them; a kept configuration's sent columns count as sent, and when every requested column is sent the acceptance runs. Otherwise it writes its files, names each requested column the configuration does not send, and exits 0: set `is_payload: true` on each one you agreed to send, then run `alcove exchange`.
- **A kept configuration decides by its own `metadata`.** An acceptance that keeps an [existing configuration](#existing-files) declaring a `metadata` block lists that block's sent columns under `columns you will send`, on both forms, and names the requested columns it does not send. On the [online](#online-acceptance) form it runs on that block and its `standardization`, so it runs when that block sends every requested column, and otherwise stops the same way, naming that file.

### Enforced, or your partner's word

Every fact the display states includes the basis it rests on, so the two are never told apart by omission:

- `(enforced)` -- Alcove holds the fact itself. Either it is true of the run, or the exchange aborts rather than proceed without it.
- `(your partner's word)` -- the fact is what your partner declared. Alcove shows it faithfully but neither verifies nor enforces it, and a partner that does not honor it is not stopped by this tool.

A fact that needs more than the marker has its explanation on the line below it, in the same wording the web consent screen uses for the same fact.

### What the display shows, in order

The display is an indented outline, one entry per line. It leads with what this party itself discloses, before the terms the invitation proposes.

Two kinds of acceptance add lines above the outline:

- **One that runs the exchange itself** ([Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)) names the coordination server it will dial, host and port, and states that confirming connects to it immediately and runs the exchange from your input file; declining writes nothing and connects to nothing.
- **One that takes its exchange directories from the invitation's endpoint** names the inbound directory (where you read your partner's files) and the outbound directory (where you write yours), which your partner chose, and what confirming does with them. On an [online acceptance](#online-acceptance) the run uses them and your configuration keeps them, and `--outbound-path` uses your own instead. On an offline acceptance the written configuration records them, and editing its connection block before you run uses your own. An offline acceptance that keeps an existing configuration writes no connection and names none.

Under `--consent-to-terms` the same lines state what the recorded consent authorizes, in the log at the default `info` level.

The entries, in order:

- **`columns you will send`** (`enforced`) -- the columns this party sends to your partner for matched records, one per line, derived from your input by the same rule that decides what Alcove transmits. It reads `(none)` when your file discloses no columns, when the invitation gives the inviting party no result (the payload step then transmits nothing), or when the algorithm is `psi-c`, which moves no payload. On an offline acceptance given no input file, the set is not yet known, and the line says your input file decides it when the exchange runs. A later run whose input sends a different set reaches your partner as a [change to your terms](#when-your-partners-terms-change) before any data moves.
- **`inviting party`** (`your partner's word`) -- the name your partner chose, unverified; `(no name given)` when the terms hold none.
- **`PSI algorithm`** (`enforced`) -- `psi` reveals the shared identifiers of matched records to whoever receives the result; `psi-c` reveals only their count. Both parties must end up on the same algorithm. A `psi-c` invitation has three lines beneath it:
  - **`what a count-only exchange still discloses`** (`enforced`) -- each round still carries one encrypted element per value a party contributed, and the terms exchange holds each party's raw row count.
  - **`how the count reaches each of you`** (`your partner's word`) -- shown where both parties are entitled to the count: one party computes it and the other is sent that report, which Alcove does not check.
  - **`what a count-only exchange does not bound`** (`your partner's word`) -- always shown: a crafted list, or a second run differing by one record, turns a count into an answer about one person.
- **`exchange files`** (`enforced` on the mode agreement, `your partner's word` on the retention) -- shown when your partner declared retain mode, or the invitation gives each side its own drop and pickup directory, which runs only in retain mode. The files are then kept at the rendezvous location as a permanent transcript. A run whose two parties configured different modes aborts; what happens to the transcript afterwards rests on your agreement, which the explanation line states. An invitation declaring delete mode, or nothing, prints no line.
- **`linkage strategy`** (`enforced`) -- `cascade` or `single-pass`, with the single-pass disclosure note when it applies.
- **`you will receive the result`** (`enforced`) -- a `no` means you are sent no result and any result sent to you is rejected.
- **`the inviting party will receive the result`** (`enforced` on a `yes`, `your partner's word` on a `no`) -- a `yes` is a disclosure the run makes; a `no` rests on your partner honoring the terms.
- **`what your partner learns about its own records`** (`enforced`) -- shown when your partner does not receive the result of a `psi` exchange. Where the run returns your partner's half of the matched-pair table, an honest partner learns which of its own records are in your data -- never which of your records they met, nor anything else about your set beyond its size. A `single-pass` run whose invitation declares no column for your partner to send withholds even that. Not shown for `psi-c`.
- **`duplicate matches`** (`enforced`) -- whether more than one of your partner's records may match a single one of yours.
- **`matched on`** (`enforced`) -- the fields the linkage keys match on. A field only a [key's missing-field condition](EXCHANGE_REFERENCE.md#keys-that-run-only-where-a-field-is-missing) reads is listed as `date of birth (only whether it is present)`.
- **`allowed-character patterns`** (`your partner's word`) -- shown once when any field declares one: each is a partner-supplied regular expression Alcove has not verified, shown in full under its field.
- **`personal data used`** (`enforced`) -- the categories of personal data the keys are computed over. Under each, **`declared data standards`** (`your partner's word`) lists the standards your partner commits that category to; Alcove does not apply them as filters.
- **`linkage keys`** (`enforced`) -- each key: the fields it matches on and how broadly, the elements it combines, the declared field behind each, every value transform with its parameters, any approximate-match setting, and any swap. A key built only from first name, last name, and date of birth ends its `matches on:` line with `(less certain)`, and a line under the keys says how to leave such keys out: ask your partner for an invitation without them, or on [`alcove apply`](#applying-an-update), do not apply the update ([Rules marked less certain](EXCHANGE_REFERENCE.md#rules-marked-less-certain)). Where the keys are exactly the built-in "highest precision" or "broader matching" keys, in their order, and the fields those keys read are the built-in fields, the display says so.
- **`columns you will receive`** (`your partner's word`, then the column count) -- the columns your partner's terms say it sends, or `(none)`. Absent where the invitation declares nothing (your first exchange then takes the columns your partner's run states: [Your partner's first payload columns](#your-partners-first-payload-columns)) and where you receive no result. Accepting records the set as `linkage_terms.payload.receive`, and every exchange compares it with the columns your partner's run states, before any key or data moves: a difference stops the run, or at a terminal is shown as a [terms change](#when-your-partners-terms-change). Your side does not check the columns again on arrival.
- **`columns the inviting party requests from you`** (`your partner's word`, then the column count) -- a request, not what you send; an acceptance given an `INPUT_FILE` lists each of them in the configuration it writes, not sent, and stops rather than runs while one is not sent ([When an acceptance runs the exchange](#when-an-acceptance-runs-the-exchange)). `(none)` means your partner's run refuses an exchange in which yours states any column. Absent when the invitation makes no request.
- **`legal agreement`** (`your partner's word`) -- the reference, the stated purpose, and the valid-through date. The reference and the date are byte-compared against your own copy before data moves; the text is your partner's.
- **`expires`** (`enforced`) -- the instant past which the invitation is refused, when the token holds one.

Every matching rule is shown here: under `psi`, what is matched decides which identifiers are disclosed. Four kinds of note qualify a rule where it stands:

- **Declared, and refused.** A count-only exchange refuses a term that expands one value into several match candidates -- an approximate-match setting, or a swap -- rather than running a narrower match. The note states the refusal and what to ask your partner for.
- **Applied, and it discloses more.** The `duplicate matches` line states what the grouping discloses, by who receives the result. Where you receive it, you learn, for each of your matched records, how many of your partner's records group onto it and which rows they are. Where your partner alone receives it, it reads that grouping about its own records, and Alcove shows you none of it, although the matching rounds do send it to your machine.
- **Applied to your partner's side, not yours.** Accepting turns duplicate matching on for the inviting party alone; your own records are not grouped, but more of them can match, each disclosing its membership and any payload columns you send. `alcove accept` offers no control for your own side, which stays `false`; to group your records, each party sets `deduplicate` in its own configuration and runs `alcove exchange` (both `true` is a many-to-many match, which runs under `linkage_strategy: cascade`). The web app's accept screen does offer it ([`linkage_terms.deduplicate`](EXCHANGE_REFERENCE.md#linkage_termsdeduplicate)).
- **Not recognized.** A value transform this version does not recognize is marked as unrecognized.

### The decision facts, repeated at the prompt

The outline runs past a terminal screen, so the facts heading it -- the columns you will send, the inviting party with its unverified-name note, the PSI algorithm with any note on it, the count-only lines under `psi-c`, and the `exchange files` line without its explanation -- are printed again, unchanged, immediately before the prompt, followed by any adopted directory lines. The linkage strategy is not repeated. Past roughly nineteen disclosed columns (an estimate) the repetition itself scrolls off a standard terminal, so read the outline before answering. Under `--consent-to-terms` the block is printed under a heading that does not ask.

### Where the display is shown

Wherever acceptance stops to ask, the terms are shown on the terminal it asks on, whatever `--log-file` and `--log-level` are set to, in the same plain rendering at every level. A `--log-file` also records them, at `info` level, so a level above `info` records nothing in the file; where the log already goes to that terminal there is no second copy. The `--identity` no-effect notice over a kept configuration follows the same rule, at `warn` in the log.

Declining prints `invitation declined; no files were written` on the same terminal at every level. Accepting and declining both exit 0. Standard input closing before you answer writes nothing and exits 64, naming `--consent-to-terms`.

Without `--consent-to-terms`, `accept` asks only where standard input is a terminal; from a pipe, a redirect, or a scheduled job it exits 64 before showing the terms, naming the flag. At a terminal the terms go to standard error with the question. Alcove does not verify that the terminal took the whole display: if standard error stops accepting output partway, the remaining lines are dropped and the question is still asked.

### Accepting without the prompt

`--consent-to-terms` records your consent to this invitation's terms in advance and skips the interactive confirmation, so `accept` can run unattended or in a script -- where there is no terminal, `accept` otherwise exits 64 before showing the terms. It bypasses the one human checkpoint before the configuration and linkage key are written from the partner-supplied invitation, so review the terms before using it.

- **Running the exchange itself.** Where the acceptance [runs the exchange itself](#accepting-and-running-a-webrtc-exchange), that same checkpoint is the last one before it connects to the coordination server the invitation names and transmits, so the flag authorizes connecting and running unattended as well as writing the files.
- **The identity question.** It also silences the identity question, for the same reason and by the same rule: the flag is what frees standard input, so nothing may read it there, and an acceptance given no `--identity` is refused rather than asked.
- **Default behavior and logging.** It is off by default: without it, `accept` displays the terms and stops to ask you to confirm them. Since nothing asks, there is nothing to show alongside a question: the terms stay diagnostic output on the routing you chose, so `--log-file` captures them for the unattended run's record and `--log-level silent` drops them.
- **Standard input.** It also frees standard input for a `-` `INPUT_FILE` (see the `-` standard-input note under [Configuration](#configuration)).

### Existing files

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's, and any disagreement fails acceptance, showing which values differ: resolve it and retry with the same invitation, or pass another configuration path. The comparison is byte-exact, on the predicate the exchange applies, so text differing only in its Unicode normalization form differs; for the payload it is stricter than the exchange, and column order alone conflicts. A difference only in a payload column description is not a conflict.

A reused configuration keeps its connection block and linkage terms, its `linkage_terms.identity` included. An acceptance never changes those terms; a partnership changes them with [`alcove update` and `alcove apply`](#changing-the-terms-of-an-established-partnership). Two records are refreshed:

- **The columns you consented to receive** are set to the invitation just accepted. When that invitation declares no disclosed columns, the record is removed, with a warning naming the columns it held: the next `alcove exchange` then accepts whatever columns the partner transmits. To keep the check, ask for an invitation that declares them.
- **[`connection.invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay)** is set to the relay the invitation names, or removed when it names none, and the line reporting the reused configuration says which. Your own `turn`, `stun`, and other connection keys are unchanged. Where the relay names a registrar, the review says a run registers there only when your side sets up its own connection on this relay ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)). Where the configuration sets [`allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays), the review marks each TURN url `kept by connection.allowed_relays` or `left out by connection.allowed_relays`.

A key file is never reused. If `--key-file` is not used and one already exists at the default path, acceptance fails, telling you to delete it or pass a different path.

### Checking your input against the terms

If `INPUT_FILE` is provided, its columns are checked against the invitation's terms before you are asked to confirm. Acceptance stops unless the input can satisfy **every** linkage key the terms declare; there is no partial acceptance. The error names what is short and writes no files. The remedy is a fresh invitation over terms both files can satisfy, agreed on out of band. Three shapes stop it:

- **The input cannot produce a key's fields** -- the columns are absent, or have a type the terms' cleaning cannot bind. The error names the fields and the keys they cost; supply a CSV covering them, or agree on new terms.
- **A key's own cleaning can never produce a value** -- a `parse_date` whose `input_format` omits a component, or a `substring` whose window reads nothing from a value of any length. The key is named even though its columns are present; the fix is a corrected invitation.
- **The terms declare no linkage key at all.**

**The input discloses columns the invitation will not accept.** Where the inviting party is entitled to the result but accepts no payload column, while your input discloses some, a warning names them. Set them not to transmit in the written configuration (`is_payload: false`, or the `ignored` role), or ask for an invitation that accepts them. An acceptance that runs the exchange stops with a configuration error (exit 64) before the terms are displayed, writing nothing; one that writes only a configuration proceeds, and `alcove exchange` refuses later. An invitation that gives the inviting party no result is not this case: nothing is sent to it.

### Accepting and running a WebRTC exchange

An invitation whose [connection endpoint](#invitations) names a WebRTC coordination server holds everything an exchange needs -- the coordination server, the shared secret, and the agreed terms -- and the accepting side takes the `acceptor` role. Given an `INPUT_FILE`, acceptance accepts and runs the exchange in one invocation, writing the same configuration, key file, audit record, and result that `alcove accept` followed by `alcove exchange` writes. The partner of an [online WebRTC invitation](#inviting-over-webrtc) meets the inviter this way within its accept-timeout.

The terms are confirmed, or consented to in advance with [`--consent-to-terms`](#accepting-without-the-prompt), before anything is written or dialed; a decline writes nothing and opens no connection. The display and the question both [name the coordination server](#what-the-display-shows-in-order) the run will dial.

The endpoint passes the same checks as a connection you author yourself. A host or path that could move the signaling socket elsewhere, or an address that does not parse as a WebSocket URL, is a usage error (exit 64) before the terms are displayed; the remedy is a new invitation from your partner.

`--peer-timeout` bounds how long this run waits for the partner to arrive at the rendezvous; a partner who never arrives ends the command with exit 69 ([Exit codes](#exit-codes)) instead of after the ten-minute default. It does not bound the data channel opening, which has a fixed ceiling, or the partner's silence on the open channel, held to the one-hour default of [`inactivity_timeout_ms`](EXCHANGE_REFERENCE.md#shared-options) unless `--inactivity-timeout` sets it. Each value is recorded in the written configuration, as `connection.options.peer_timeout_ms` and `connection.options.inactivity_timeout_ms`, so every later `alcove exchange` from it waits the same until the field is edited.

Five cases keep the two-command shape, and each is reported:

- **`--no-run`.** Acceptance writes the configuration and key file and stops ([Accepting without running](#accepting-without-running)).
- **A requested column the configuration does not send.** Acceptance writes the configuration and key file, names each such column, and stops ([When an acceptance runs the exchange](#when-an-acceptance-runs-the-exchange)).
- **No `INPUT_FILE`.** Acceptance writes the configuration and key file; run `alcove exchange` with your input afterward.
- **An invitation holding no WebRTC endpoint.** An `sftp` or `filedrop` endpoint, or none, leaves a connection block whose credentials you supply.
- **A reused configuration.** The configuration at the path governs its own exchange, so acceptance writes the key file and stops.

In these, `--peer-timeout`, `--inactivity-timeout`, and the other connection-options overrides are reported as having no effect; put them under `connection.options` in the file. Both parties then run `alcove exchange` at their convenience.

### Accepting without running

`--no-run` makes an acceptance that would run the exchange write its configuration and key file and stop instead, so you can review the columns you send before the exchange. It contacts no server, coordination server, relay, or relay registrar. It applies on every channel and on both forms: on this form the connection block is seeded from the invitation's WebRTC endpoint, and on the [online](#online-acceptance) form it is the one your URL and connection flags build.

- **What the configuration holds.** The connection block, the `metadata` and `standardization` blocks Alcove infers from `INPUT_FILE`, and each requested column listed, not sent ([When an acceptance runs the exchange](#when-an-acceptance-runs-the-exchange)). Edit the `metadata` block before the agreed time: set `is_payload: true` on each requested column you agreed to send. Your ID column is not sent unless you set `is_payload: true` on it too.
- **What the display shows.** `columns you will send` lists the columns the written `metadata` block sends, which is none; the requested columns are under `columns the inviting party requests from you`. A run whose send set differs from what your partner requested reaches your partner as a [change to your terms](#when-your-partners-terms-change).
- **A requested column your file lacks.** Any acceptance given an `INPUT_FILE` stops with a usage error (exit 64) naming it, before the terms are displayed, and writes nothing. Add the column to your file, or ask your partner for an invitation that does not request it.
- **Where it has no effect.** On an acceptance that runs no exchange anyway -- no `INPUT_FILE`, an `sftp` or `filedrop` endpoint on this form, or a reused configuration on this form -- the flag is reported as having no effect.
- **Your partner's side.** Both of you then run `alcove exchange` at the agreed time, before the invitation's `expires`. An [offline invitation](#offline-invitation) leaves your partner a configuration and key file to run from. An [online invitation](#online-invitation) waits for you until its `--accept-timeout`, so run `alcove exchange` within that wait; your partner's configuration is saved when you meet it.

## Online invitation

```sh
alcove invite --identity IDENTITY [--accept-timeout=DURATION] [--expires-in DURATION] [--linkage-strategy STRATEGY] [--turn URL]... [--stun URL]... URL INPUT_FILE [OUTPUT_FOLDER]
```

Like the [offline invitation](#offline-invitation), this prints an invitation and instructions to forward over a secure out-of-band channel. The instructions include an `alcove accept` template for the shared server (over WebRTC the partner types no server: [Inviting over WebRTC](#inviting-over-webrtc)); a `file://` folder appears as `file://<YOUR PATH TO THE SHARED FOLDER>`. The template shows the invitation as `<INVITATION>`: the invitation encodes the setup shared secret and is printed on stdout, while the template is a diagnostic on stderr or the `--log-file`. The invitation embeds a [credential-free connection endpoint](#invitations) from this connection -- host, port, and path, or the `inbound_path`/`outbound_path` pair -- so the acceptor supplies only its own credentials. The command then connects to the server and waits for the partner; over WebRTC it connects first and prints the invitation once the coordination server has answered.

### Inviting over WebRTC

An invitation over the [`webrtc` channel](#webrtc-exchanges) names the PeerJS coordination server the two parties meet through. The command takes it in one of two forms:

- **The web app's address**, the one you send a partner who uses the browser:

  ```sh
  alcove invite --identity "Agency A" https://app.example.org/ input.csv
  ```

  The command reads the coordination server the app publishes at `/alcove.json` on the address's origin (the hosted build writes that file from its own setting) and dials that server. The address names only the app: one with a path other than `/` (a pasted `/accept` link, for example), a user, a query, or a fragment is a usage error (exit 64) naming both forms, before the invitation is created.

  An app that publishes no usable `/alcove.json` is refused before the invitation is created: a usage error (exit 64) when the app answers without one, a transport failure (exit 69) when it cannot be reached. The message names the address and the two forms that work instead, the coordination server's own `wss://` URL or `channel: webrtc` in `alcove.yaml`. What the file holds and what the command accepts: [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-published-coordination-server).

  Since a partner invited this way may use the browser, stdout holds the app's accept link, `https://app.example.org/accept#<invitation>`, in place of the bare invitation. Both partners take the whole link: a browser user opens it, and a command-line user passes it to `alcove accept` in place of the invitation, in the template below.
- **The coordination server itself**, as a `ws://` or `wss://` URL such as `wss://peers.example.org/psi`, for a coordination server no web app publishes. Stdout holds the bare invitation; a command-line partner passes it to `alcove accept`, and a browser partner pastes it under "Have an invitation? Paste it here" on the web app's start page.

Either way the invitation holds the resolved host, port, and path as its connection endpoint, and the configuration saved at acceptance holds the same `server` block, so a later [offline invitation](#offline-invitation) from that configuration names the same server.

- **The invitation is printed once the coordination server answers.** A server that does not accept the registration fails the run (exit 69) with no invitation shown.
- **The partner needs no URL, and no second command.** The printed template is `alcove accept --identity <YOUR NAME, YOUR ORGANIZATION> <INVITATION> <INPUT_FILE>`, run while this command waits. Accepting writes the connection block (coordination server and `role`) from the endpoint and dials it in the same invocation ([Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)). The invitation holds no `role`: each command stamps its own end, `inviter` here and `acceptor` there.
- **The URL names the location and nothing else.** A `ws://`/`wss://` URL holding a user, password, query, or fragment, a host or path that could move the signaling socket elsewhere (an `@`, `?`, `#`, `\`, or space, however written), or a port that is not dialable is a usage error (exit 64) before the invitation is created. For a coordination server that needs an API key, author `channel: webrtc` with `server.key` in `alcove.yaml` and use [`alcove exchange`](#webrtc-exchanges).
- **The endpoint always names the path.** A bare-host URL such as `wss://peers.example.org` invites on the root path, and the invitation states it, so the partner's client does not fall back to a different default.
- **A plaintext (`ws://`) coordination server cannot be conveyed.** An endpoint has no `secure` field, so a partner seeded from one dials `wss://`. The command warns, naming the `secure: false` the partner adds by hand, and proceeds.
- **`--turn URL` and `--stun URL` name this party's relay.** Each takes one url in the grammar of [`connection.turn`](EXCHANGE_REFERENCE.md#connectionturn)'s `url` and [`connection.stun`](EXCHANGE_REFERENCE.md#connectionstun); repeat a flag for several. The invitation names them for a partner with no relay of its own ([`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay)), and the configuration saved at acceptance holds them as url-only `turn` entries and a `stun` list, so each run derives the TURN credential from the shared secret ([TURN](#turn)). A url holding a user, or a query parameter other than `transport`, is a usage error (exit 64). A `--stun` list replaces the built-in default STUN server. On an `sftp://`, `ssh://`, or `file://` URL, and on an offline invitation, both flags are reported ignored.
- **The file-sync flags do not apply.** `--retain-files`, `--lockless-rendezvous`, `--polling-frequency`, `--connection-per-poll`, `--peer-id`, `--timestamp-in-filename`, and `--write-without-renaming` are reported ignored, and `--outbound-path` is a usage error.
- **No `--server-*` flag applies except `--server-provision`** ([Starting the server on demand](#starting-the-server-on-demand)). The others, credentials included, are reported ignored and nothing typed at them is sent, saved, or put in the invitation. A coordination server that needs a key takes it from `server.key` in `alcove.yaml`; `server.username` is accepted by the schema and unused on this channel.

`--expires-in DURATION` overrides the one-hour invitation lifetime as in the [offline invitation](#offline-invitation). A lifetime shorter than `--accept-timeout` draws a warning that the token will expire before the wait ends.

`--accept-timeout` (default 15 minutes) is how long this run waits for the partner to arrive at the rendezvous after the invitation is printed. Once the partner has accepted, its silence is bounded by [`inactivity_timeout_ms`](EXCHANGE_REFERENCE.md#shared-options) (default one hour), which `--inactivity-timeout` sets for this run and records in the saved configuration for the runs that follow. The accept-timeout is not saved, so a later `alcove exchange` waits for its partner on its channel's default: the one-hour [`peer_timeout_ms`](EXCHANGE_REFERENCE.md#shared-options) on `sftp` and `filedrop`, and the transport's ten minutes on `webrtc`. `--peer-timeout` sets that later wait instead: it does not bound this invitation's wait, which the command reports, and it is recorded as `connection.options.peer_timeout_ms`. Once the configuration is written, the command reports which of the two it holds.

`--linkage-strategy STRATEGY` works as in the [offline invitation](#offline-invitation).

The command exits when the token expires, when the connection times out, when the user cancels, or when the accept-timeout is reached. The invitation can then no longer be accepted, since the inviter has left the rendezvous, but the secret is not destroyed, so treat a leaked invitation as a compromise ([Compromise response](SECURITY_DESIGN.md#compromise-response)).

On acceptance the two parties run the key exchange, and a fresh shared secret is generated and exchanged. The exchange then runs inside the application-layer encryption on every channel ([CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#which-channels-request-it)). Both sides save the configuration and key files at the terms exchange that follows the handshake, once the terms are agreed on and before the data exchange, so a later failure is retried with `alcove exchange` without re-inviting ([Recurring exchange](#recurring-exchange)). The result is written in `OUTPUT_FOLDER`, or to `stdout` ([The result file](#the-result-file)).

The online path does not read terms from an existing configuration. A configuration file at the configuration path, or a key file at the key path, is a conflict, and the command aborts before any token is created or connection opened; delete it or pass `--config-file` or `--key-file`. The linkage keys, metadata, and cleaning are inferred from the input file, and that configuration is saved only if the partner accepts. An input whose columns support no linkage key (none of the field types the built-in rules match on, such as name, date of birth, or SSN) stops the command (exit 64) before the token is created.

## Online acceptance

```sh
alcove accept --identity IDENTITY URL INVITATION INPUT_FILE [OUTPUT_FOLDER]
```

This works like [offline acceptance](#offline-acceptance), but it connects and runs the exchange, under the same rule: it has an `INPUT_FILE` and its connection is your URL. It shows the same terms outline, and the question states that accepting runs the exchange now.

- **`--consent-to-terms`** skips the confirmation as in offline acceptance, and lets `INPUT_FILE` be `-`. It does not affect [SFTP host-key trust](#sftp-host-key-trust), which has its own non-interactive setup.
- **The satisfiability check.** The input must satisfy every key the invitation's terms declare, checked before any connection ([Checking your input against the terms](#checking-your-input-against-the-terms)).
- **Saving once the terms are agreed on.** The configuration and new keys are saved on both sides at the terms exchange that follows the handshake, before the data exchange, so a later failure is retried with `alcove exchange` without re-inviting.
- **Stopping instead.** Under [`--no-run`](#accepting-without-running), or when the configuration does not send a column the invitation requests ([When an acceptance runs the exchange](#when-an-acceptance-runs-the-exchange)), it writes the configuration, with the connection your URL and flags build, and a key file holding the invitation's secret, then stops without connecting. The question then asks to write the configuration, and no host key is pinned until the first `alcove exchange`.

When the invitation's endpoint names a split inbound/outbound directory pair and you pass no `--outbound-path`, the acceptor adopts the mirrored roles -- where the inviter writes, you read -- and the retain mode a split exchange requires. The host, port, and credentials still come from your own URL and flags, never from the endpoint, so you may reach the rendezvous by a different route from the inviter. An explicit `--outbound-path` overrides the endpoint's pair: the URL's path is your inbound, the flag your outbound. A non-split invitation leaves the connection as the URL builds it. Where the pair is adopted, the terms display names both directories.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared as in [Existing files](#existing-files), and its connection block against the connection target -- the URL, any `--server-*` or `--outbound-path` override, and any directories adopted from the endpoint:

- **A different rendezvous location** -- host or path -- fails acceptance without notifying the inviter, showing which values differ. Delete the file or pass `--config-file`, then retry with the same URL and invitation.
- **A different way of reaching the same drop** -- channel (for example a `file://` configuration accepted against an `sftp://` URL), port, or credentials -- is used for this exchange, with a warning that the saved connection settings are unchanged.
- **A field absent from the URL**, with no override, is never a conflict.

A pre-existing key file is refused as in [Existing files](#existing-files), before any connection is opened.

## Changing the terms of an established partnership

```sh
alcove update [--config-file FILE] [--key-file FILE]
alcove apply [--config-file FILE] [--key-file FILE] [--consent-to-terms] UPDATE
```

Once a partnership is set up with `alcove invite` and `alcove accept`, either party can change its linkage terms or the columns it discloses without re-inviting: no new shared secret, and no change to either party's connection block. One party edits its own configuration and runs `alcove update`; the other runs `alcove apply` on what it prints.

### Making an update

1. **Edit your configuration.** Change `linkage_terms`, or the `metadata` that decides which of your columns are disclosed, in the `alcove.yaml` you exchange with this partner.
2. **Run `alcove update`.** It reads that configuration and the key file beside it, and prints a terms update to stdout. The update holds your linkage terms and the names of the columns you disclose, authenticated under the shared secret in your key file. It holds no secret, no credential, and no connection details.
3. **Send the update to your partner.** Any channel that delivers it unchanged will do: an altered update is refused when it is applied.

Before the update is printed, the command:

- runs the checks an [offline invitation](#offline-invitation) made from the same configuration runs, so it refuses terms your own next exchange would refuse
- writes the columns your `metadata` discloses into `linkage_terms.payload.send` where your configuration leaves it unset, as an offline invitation does, so the update states the columns you send

It refuses (exit 64) when there is no configuration or key file at the paths, when the configuration has no `linkage_terms.identity`, or when the shared secret in the key file has expired. An expired secret cannot authenticate an update; re-establish the partnership as in [Out-of-sync tokens](#out-of-sync-tokens) instead.

Until your partner applies the update, an exchange between you meets the difference as a [change to your terms](#when-your-partners-terms-change): your partner's run asks at a terminal and refuses unattended.

### Applying an update

`UPDATE` is the update string, or an `@path` to a file holding it. Before showing anything, `alcove apply` refuses an update, naming the check, changing nothing, and exiting 64, on any of these:

- **Expiry.** The shared secret in your key file has expired (checked before the update is decoded). Re-establish the partnership as in [Out-of-sync tokens](#out-of-sync-tokens).
- **Partnership.** The update was made under a different shared secret: for another partnership, or before an exchange between you replaced the secret. Ask your partner to run `alcove update` again. Where an exchange that met your partner's changed terms already wrote them beside the configuration ([When your partner's terms change](#when-your-partners-terms-change)), the refusal also names that file and the `alcove apply` command for it.
- **MAC.** The content was changed after the update was made.
- **Own update.** The update was made from your own configuration.

An update that passes is a consent event, shown as an [offline acceptance](#offline-acceptance) shows an invitation:

1. **What changes.** The columns your partner now sends or no longer sends you, the columns you now send or no longer send, your partner's `deduplicate`, and each other term that differs. A change an exchange does not hold your partner to -- the columns you send where the update states none your partner receives, the columns you receive where your configuration lists none -- is shown on its own lines, before and after. A term that changes but that none of these shows is named on a line of its own, `other terms that change: <names>`; its new value is in the terms shown next.
2. **The terms.** The outline an acceptance shows, with your partner as the inviting party.
3. **The question.** Declining leaves the configuration as it was. Confirming and declining both exit 0. Standard input closing before you answer changes nothing and exits 64.

An update is applied without being shown, exiting 0, only when it changes nothing in `linkage_terms` but the `date` or a payload column `description`, and states the `deduplicate` already recorded for your partner in `expected_partner_deduplicate`.

`--consent-to-terms` records your consent in advance and skips the question, so `apply` can run unattended; with no terminal and without it, `apply` exits 64 before it shows the terms, naming the flag, and changes nothing. The checks above still run. The change and the terms are then diagnostic output, as for [an acceptance without the prompt](#accepting-without-the-prompt). The [console](CONSOLE.md#when-your-partners-terms-change) runs `alcove apply` this way when you choose Apply.

Confirming rewrites the configuration in one write. `linkage_terms` becomes the update's terms under your own identity, with the output direction mirrored as an acceptance mirrors it. Your own `deduplicate` is kept, the columns you receive become the ones the update says your partner sends, and `expected_partner_deduplicate` takes the `deduplicate` the update states for your partner. The connection block and every other key keep their values and order, unchanged lines are kept as [Configuration](#configuration) describes, and the key file is not touched. Your next `alcove exchange` runs on the new terms.

## Recurring exchange

```sh
alcove exchange [--invitation INVITATION] [--include-matching-key] [--sweep-exchange-files [--force-retain-sweep]] INPUT_FILE [OUTPUT_FOLDER]
```

The application loads configuration and key files and conducts the exchange without further coordination. The shared secret is rotated at the terms exchange that follows each successful authentication handshake, before the data exchange begins; if the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If `OUTPUT_FOLDER` is given, the results of the exchange are written in that folder; otherwise, they are written to `stdout` ([The result file](#the-result-file)).

All three channels -- `sftp`, `filedrop`, and `webrtc` -- run here. For shared-folder exchanges, the configuration uses `channel: filedrop` and `path` in place of `channel: sftp` and `server`:

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

Topics this command shares with the rest of the CLI have a section apiece below: [Signing identity and the agreed terms](#signing-identity-and-the-agreed-terms), [SFTP host-key trust](#sftp-host-key-trust), [Reading a host key with `probe-host-key`](#reading-a-host-key-with-probe-host-key), and [Scheduling the run](#scheduling-the-run) -- the last of these the recurring production arrangement this command exists for.

### Provisioning the key file from an invitation

`--invitation INVITATION` provisions the key file from an invitation (the one `alcove accept` takes) and then runs the exchange. It serves a party whose configuration holds no secret -- one composed in the web application and downloaded ([EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md)) -- and a re-invited party re-provisioning without `accept` ([Recovery](#recovery)).

`@path` is supported: `--invitation '@invitation.txt'` keeps the invitation out of shell history. The invitation's checksum, schema, and expiry are checked before anything is written. The key file is written once every check the CLI makes before connecting has passed, just before the first network contact:

- **Refused before then**, the run leaves no key file; fix what it names and run the same command again.
- **Failed after then** -- the server wake call, the host-key check, or the connection, including an SFTP private key the connection cannot read -- the key file is written; run the same command again without `--invitation`.
- **A key file already at the path** is an error, not an overwrite.

Every `alcove exchange` run checks the `INPUT_FILE`'s columns against the configuration's linkage terms before anything is sent, as `accept` does. Unless the CSV can satisfy every key, the run exits 64 naming the unsatisfied fields and the keys they cost; a key whose own cleaning drops every record is named the same way, and its fix is the terms. The check honors explicit metadata and column standardization in the configuration. A lasting drift needs new terms agreed on with your partner.

### What the run shows before it starts

An exchange prints what it will disclose before any credential, terms, or data are sent: [`alcove exchange`](#recurring-exchange), whichever command wrote its configuration, and a [quick exchange](#quick-exchange). The lines:

- the columns you send your partner for matched records, resolved from your input as the exchange transmits them;
- which of you receives the result;
- what a partner entitled to no result still learns about its own records, and where the exchange withholds even that;
- the PSI algorithm and the linkage strategy, each with what it discloses;
- whether several of your records may match one of your partner's, and what that grouping tells your partner;
- the fields matched on, each with its column in parentheses where the names differ (`date of birth (dob)`, or `date of birth (dob; only whether it is present)` for a missing-field condition), and the linkage keys. A key built only from first name, last name, and date of birth is marked `(less certain)`, with how to leave such keys out: on `alcove exchange`, delete them from `linkage_keys`, run [`alcove update`](#changing-the-terms-of-an-established-partnership), and have your partner apply it; a quick exchange always uses them ([Rules marked less certain](EXCHANGE_REFERENCE.md#rules-marked-less-certain));
- the input columns neither sent nor matched on, as held back, in input order;
- on a quick exchange, the record identifier: the first column whose name reads as an identifier (such as `id`, `client_id`, or `Client ID`), a record number such as `case_number` only when no id column of another kind follows it, or, where there is none, a `row_id` numbering your rows from 0 ([The result file](#the-result-file));
- on a quick exchange, the rules selected, `broader matching` ([Choosing the built-in rules](EXCHANGE_REFERENCE.md#choosing-the-built-in-rules));
- last, on an `sftp` or `filedrop` run with [`--write-without-renaming`](#a-server-that-does-not-allow-renames) on, a line saying so.

It asks and refuses nothing. The lines print on standard error, terminal or not, at every `--log-level`. `--log-file` keeps a copy at `warn`; `error` and `silent` record none of it. A `--log-file` that is standard error gets no second copy.

An unattended run -- no terminal on stdin, or an `INPUT_FILE` of `-` -- whose `--log-file` already holds the same display writes it to the log file alone, so a scheduler that mails standard error mails the display only when it changes. How far back the run looks: [CLI_EVENTS.md](spec/CLI_EVENTS.md#disclosure-digest).

Where your own terms leave neither party expecting a result, the display says so; that pair is refused at the terms exchange.

On a quick exchange the display is the only statement of what is sent, since nothing was written down: every column Alcove does not recognize as a linkage key or an id column is sent. To change that, author a configuration ([`alcove init`](#initialization)) and run [`alcove exchange`](#recurring-exchange).

### Your partner's first payload columns

A configuration with no `linkage_terms.payload.receive` takes the columns your partner's terms declare it sends on the first run, and records them as `payload.receive` ([Leaving `payload.receive` unset](EXCHANGE_REFERENCE.md#leaving-payloadreceive-unset)). This holds for `alcove exchange`, the online `alcove invite` and `alcove accept`, and a quick exchange run with `--save`. A quick exchange without `--save` records nothing, but asks the same question at a terminal.

- **At a terminal**, the run shows those columns and asks whether to take them. Yes records them and the run continues. No ends the run (exit 64) before any of your linkage keys or data is sent, and records nothing; your partner's run ends with a partner refusal (exit 76). Running again asks again.
- **Unattended** -- no terminal on stdin, an `INPUT_FILE` of `-`, `alcove accept --consent-to-terms`, or a run the [console](CONSOLE.md) drives -- the run takes the columns without asking and writes one line naming each column and the configuration it wrote them to, or saying it wrote them to none. The line is written at every `--log-level`, `silent` included, to stderr or the `--log-file`, without a timestamp prefix. With `--event-stream` the run also emits a `warning` event whose `source` is `payloadReceiveTaken` ([CLI_EVENTS.md](spec/CLI_EVENTS.md#payload-columns-taken-without-asking)).

Nothing is asked where your partner declares no column, or where you already hold a list. A later difference from a list is a terms change.

### When your partner's terms change

A partner that changed its terms since your last exchange -- most often by adding or dropping a payload column -- just runs. Your run meets the change at the terms exchange, before any linkage key or data moves, and shows it: the columns your partner now sends you or no longer sends you, the columns you send that its terms do not receive (its decision, shown for your information), and each other term that differs. What counts as a change, and which party decides which part: [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#when-your-partners-terms-change).

- **At a terminal**, the run asks whether to accept your partner's terms. Yes writes them into the configuration through the write [`alcove apply`](#applying-an-update) makes -- `linkage_terms` and the records that follow from them, except that `expected_partner_deduplicate` is left as it was -- and the same run continues under them. No ends the run before any key moves (exit 64), and the configuration is not changed. Terms your configuration would not load under are refused before you are asked (exit 64), naming the setting they would make invalid.
- **Unattended** -- no terminal on stdin, or an `INPUT_FILE` of `-` -- the run refuses (exit 64) before any key or data moves. It writes your partner's terms beside the configuration as a terms update, `alcove.proposed-terms` beside `alcove.yaml` (named after the configuration file), and its error names, under "To fix", the command that applies it:

  ```sh
  alcove apply @alcove.proposed-terms
  ```

  with `--config-file` and `--key-file` added where you run from other paths. `alcove apply` shows the change and asks, as for any [terms update](#applying-an-update); once it is applied, run the exchange again. This step replaces the generic advice to retry ([CLI_EVENTS.md](spec/CLI_EVENTS.md#a-partner-terms-change-the-run-did-not-take-on)).
- **A change the run cannot continue under** -- to the linkage fields, keys, algorithm, strategy, output direction, or version, which your input was prepared under, or to your partner's `deduplicate`, which widens what your records disclose -- is refused (exit 64) and written as a proposal whether or not a terminal is attached. `alcove apply` shows a changed `deduplicate` among the changes it asks about.

Your partner's run ends with a partner refusal (exit 76) when you decline or your run is unattended; it is not asked anything. To settle a change ahead of the next scheduled run instead, the party that made it sends an [`alcove update`](#changing-the-terms-of-an-established-partnership).

While you decide at the prompt, your partner's run waits within its own inactivity bound, so answer promptly or settle the change through `alcove update` and `alcove apply`.

### WebRTC exchanges

A `webrtc` connection reaches the partner directly over a peer-to-peer data channel, using a PeerJS coordination server only to introduce the two parties. It is the channel the web application uses, so a CLI party and a browser party can exchange with each other.

```yaml
connection:
  channel: webrtc
  server:
    host: peers.example.org
  role: inviter
  stun:
    - stun:stun.example.org:3478
```

- **`role` is required** and the two parties must differ: one `inviter`, one `acceptor`. Each registers with the coordination server under the id its role derives from the shared secret and dials the id the other's derives, so neither needs the other's address. `alcove invite` and `alcove accept` stamp it; a configuration missing it is a usage error (exit 64) before anything is dialed, and one where both parties set the same value fails at the coordination server with an error naming that as the likely cause.
- **`server.secure` defaults to `true`** (a `wss:` socket). Set `secure: false` only for a coordination server you reach without a network in between, such as one on the same machine. The port defaults to 443 or 80 to match, the path to `/`, and the API key to `peerjs`. A connection that resolves to a plain `ws:` socket warns on every run and proceeds, naming what plaintext signaling discloses -- the derived rendezvous ids, both parties' session descriptions, and the candidate addresses they gather -- and how to reconcile it. That disclosure is rendezvous metadata, never exchange content: the two parties authenticate each other over the data channel, which is encrypted end to end either way.
- **Where the connection comes from.** Accepting an invitation seeds the whole block -- coordination server and `role` both -- from the invitation itself, so `alcove accept` writes a ready configuration and, given an input file, [runs the exchange on it in the same invocation](#accepting-and-running-a-webrtc-exchange). That holds for an invitation created by the web application and for one created by [`alcove invite` over a `ws://`/`wss://` URL](#inviting-over-webrtc). Otherwise author it by hand: a `ws://` or `wss://` URL is refused (exit 64) on `alcove accept` and on the [quick exchange](#quick-exchange), which take their end of the rendezvous from an invitation they were given, not from a URL.

Nothing about the exchange itself changes: the same authentication handshake, the same linkage, the same result file and exchange record, and the same application-layer encryption the file-based channels apply, which both parties request on every WebRTC exchange -- the coordination server sees that a session exists, never its content.

#### STUN, and what it discloses

Finding a path between two parties behind NAT needs a STUN server, which tells each party how it appears from the outside. **When a run lists no STUN url, a built-in default (`stun:stun.l.google.com:19302`) is used.** That is the case whenever the connection sets no `stun` and its [`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay) names no STUN url, including a connection that sets only `turn`. A run that lists neither `stun` nor `turn` warns on every run, naming what the default discloses and how to override it; a run that lists only `turn` uses the default without a warning. That disclosure is connection metadata -- this host's public address, and the fact of a session -- never exchange content. Set `stun` to your own server to avoid it; setting `turn` does not.

A `stun` list replaces the built-in default rather than adding to it, so a list you set is the list actually used. An **empty** list is not "no STUN": to the ICE layer an empty list and an absent one both mean "use the default". To gather host candidates only -- for two parties on the same network, or a VPN -- give a single unreachable entry, for example `stun:127.0.0.1:3478`. That is the supported no-STUN idiom; it costs about five seconds of gathering while the unreachable entry times out, and it works only where a direct path exists. Each entry must name a host: a bare `stun:`, which an empty environment substitution can leave behind, is a usage error (exit 64). The same host requirement applies to a `turn` entry's `url`.

What a STUN server's operator observes: [What supporting services can observe](../PRIVACY.md#what-supporting-services-can-observe).

#### TURN

`turn` entries configure a relay for the case where no direct path can be found. The url grammar and credential fields are in [`connection.turn`](EXCHANGE_REFERENCE.md#connectionturn).

```yaml
connection:
  channel: webrtc
  server:
    host: peers.example.org
  role: acceptor
  turn:
    - url: turns:relay.example.org:443?transport=tcp
      username: alcove
      credential: "@/run/secrets/turn"
```

**An entry with only a `url` gets a credential derived each run** from the shared secret in the key file, for a relay that accepts derived credentials, as the relay an invitation names does:

```yaml
  turn:
    - url: turns:relay.example.org:443?transport=tcp
```

- The credential differs each run, since the secret rotates, and nothing derived from it is written to the configuration or the key file.
- It is valid for one hour, and the run states when it expires. Each ten-minute connection attempt while waiting for the partner derives a fresh one, so a `peer_timeout_ms` longer than an hour still reaches the relay. Once the partner connects it is not renewed, so the exchange itself has roughly 42 minutes before the relay refuses it.
- A run with no shared secret refuses the entry, naming its url, before anything is dialed.
- An invitation's relay is listed after these entries ([`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay)). Which relay a run allocates on, and when it enrolls at the invitation's registrar: [the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator).

**A relayed exchange has been verified against the project's standing relay:** a CLI party with UDP blocked outright completed an authenticated exchange whose data-channel traffic the relay transported, over TURN-over-TLS on 443. werift verifies the TURN server's certificate, so a relay presenting a certificate the CLI host does not trust yields no relay candidate and no relayed path. Verify relayed connectivity in your own environment before depending on it. `ice_provision` (an ICE-credential API) is not supported by the CLI and is refused rather than ignored, so a connection that configures it does not silently fall back to the default.

**A relay is a fallback.** A run gathers host, server-reflexive, and relay candidates, and ICE settles on whichever pair works first, which on a network where a direct path exists is a direct one. The relay carries the exchange where no direct path works.

**Refused before anything is dialed** (usage error, exit 64):

- A `url` that names no host.
- A `transport` other than unset, lowercase `tcp`, or `udp` on a `turn:` url -- for example `TCP`, `quic`, an empty value, or `udp` on a `turns:` url -- which the ICE layer would otherwise drop silently.
- A key the connection block does not define, such as `allowed_relay` for `allowed_relays`, or a `server` key written beside `server` rather than under it.

#### Using only the relays you choose

[`allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays) limits the TURN and WebSocket relays your side uses, among your own entries and an invitation's, and each run states the relay urls it keeps and the ones it leaves out.

#### Registering the relay key at your relay

A relay that holds one key per exchange, like the [reference relay](../infra/relay/README.md#per-exchange-keys), accepts only credentials derived from the key it holds, and that key changes each time the shared secret rotates. When your own relay runs the reference registrar, name it in [`connection.relay_registrar`](EXCHANGE_REFERENCE.md#connectionrelay_registrar) and every run keeps it current:

```yaml
connection:
  turn:
    - url: turns:relay.example.org:443?transport=tcp
  relay_registrar:
    url: https://registrar.example.org
    exchange_id: q3-linkage-7f2c
```

**This computer needs outbound access to the registrar's host on the url's port.** The machine that runs `alcove enroll-relay` and every machine that runs the exchange must be able to open an outbound TCP connection to it. A url that names no port, as above, is port 443, the port TURNS uses: a reference relay that sets a name for its registrar answers there under that name, so a network that allows only 443 out both relays and registers; the project's own relay host runs the registrar at `https://registrar.data-bridge.org`, with enrollment without a token on ([infra/relay/README.md, The registrar](../infra/relay/README.md#the-registrar)). A url that names another port, such as the reference registrar's own 8443, needs that port open as well. When the registration fails, the failure names the registrar's host and port and what to check, and the exit codes are those below.

**Enroll the exchange once, with the relay-owner token.** Run `alcove enroll-relay` from the working directory, with the same `--config-file` and `--key-file` your runs use. It checks the configuration and key file, then asks for the relay-owner token on the terminal, without showing it as you type; with no terminal, it reads the token from the first line of standard input (`printf '%s\n' "$TOKEN" | alcove enroll-relay`). It sends the token in the one enrollment request and writes it nowhere -- not to the configuration, the key file, or the log -- and states the registration's lapse. Enroll after `alcove invite` or `alcove accept` and before the first scheduled run. An exchange id the registrar already holds with another key is refused; if the id is this exchange's, run the command again with `--replace-relay-key`, which registers this exchange's current key in place of the one held. A refused token exits 77.

**Each run renews it without the token.** Each run registers the key derived from the rotated secret after the run, signed with the key it replaces, and states when the registration lapses: after [`token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) days, or never where that is unset. A run registers whether or not it also lists the relay your partner's invitation named. A run never asks for the token and never sends it.

**When a registration does not go through.** The key the registrar holds is replaced only by a request signed with that key, and a run keeps the key it signs with in memory only, until it exits. The rotated secret is kept whatever the registrar answers, and the key file records the registration as unconfirmed:

- **The run that rotated** retries a registrar that does not answer, on the schedule in [PROTOCOL.md, Registering the rotated relay key](spec/PROTOCOL.md#registering-the-rotated-relay-key) (its Retries item). A registration still not confirmed after a completed exchange exits 73: the exchange must not be re-run, and the error names the registrar and the next step.
- **The next run** confirms the registration before it contacts your partner. When the registrar already holds the current key -- the registration landed and its answer was lost -- the run goes ahead. When the registrar does not answer, the run exits 69 with the shared secret unchanged; run it again later.
- **When the registrar holds a key no run has any more** -- a registration that never landed, or a run stopped between its rotation and its registration -- the next run exits 77 before it contacts your partner, naming the registrar and the exchange id. Run `alcove enroll-relay --replace-relay-key` with the relay-owner token, then run the exchange again. Your partner does nothing: the shared secret is unchanged.

#### A WebSocket relay of your own

A WebSocket relay carries an exchange over one `wss://` connection from each party, for a network whose inspection stops WebRTC and TURN; when a run uses one and how it is admitted are in [COMMUNICATION.md](COMMUNICATION.md#websocket-relay). Name yours in [`connection.websocket_relay`](EXCHANGE_REFERENCE.md#connectionwebsocket_relay):

```yaml
connection:
  turn:
    - url: turns:relay.example.org:443?transport=tcp
  relay_registrar:
    url: https://registrar.example.org
    exchange_id: q3-linkage-7f2c
  websocket_relay: wss://wsrelay.example.org/relay
```

- **A run falls back to it.** A run dials the relay as it starts waiting for your partner, and moves the exchange onto it only when no WebRTC path opens or your partner's side already moved there; it logs which path carried the exchange. An invitation's WebSocket relay is dialed the same way.
- **Your invitations name it** where [`allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays) keeps it, with the `relay_registrar` `exchange_id` beside it where that is set.
- **The relay needs the exchange's key.** Enroll the exchange at the registrar of the relay's host as [above](#registering-the-relay-key-at-your-relay). A run with no shared secret is refused before it dials (exit 64).
- **A WebSocket relay set alone is enrolled by its owner.** A `relay_registrar` needs a `turn` entry beside it that sets no `username` or `credential`, and is otherwise refused (exit 64). With `websocket_relay` and no such entry, name no registrar.

What the relay's operator sees: [What supporting services can observe](../PRIVACY.md#what-supporting-services-can-observe).

#### When a WebRTC exchange does not connect

A rendezvous that ends without a data channel names what ICE found, so the failures that look alike from the outside can be told apart:

- **No relay candidate was gathered, and no `turn` entry or invitation relay is configured.** A relay that is not configured cannot be gathered, so this is what a direct-only connection reports when no direct path was found. Arrange a direct path between the two parties -- the same network, or a VPN -- or [configure a relay](#turn).
- **No relay candidate was gathered from a configured `turn` entry or invitation relay.** Nothing on this host could reach the one relay the run tries, its first `turn` entry or else the invitation's first TURN url -- the network blocked it, the credentials were wrong, or the relay presented a certificate this host does not trust. Fix the relay, or arrange a direct path; waiting longer changes nothing.
- **A relay candidate was gathered and no candidate pair succeeded.** Both sides had addresses to try and none of the pairs worked. This is a path problem between the two parties, so the partner's side is where to look next.
- **Any of these, with relays left out by [`allowed_relays`](#using-only-the-relays-you-choose).** The failure also names the TURN and WebSocket relay urls the setting left out and the remedy: add a host both sides can reach to `allowed_relays`, or remove the setting.

The failure states whether a relay candidate was gathered, how many remote candidates the partner sent, and how many pairs were tried. A report of no relay candidate is the first case or the second according to your own `turn` configuration and the `invitation_relay` beside it, which the failure does not read. A completed exchange reports the candidate pair it settled on at `--log-level debug`, which is what tells you whether a run that worked went direct or through the relay.

To learn whether this host reaches the relay a run allocates on before the run that needs it, run [`alcove doctor relay`](#checking-the-relay-of-a-webrtc-exchange).

**A failure against the coordination server names a certificate problem when that is what it was.** A `wss://` socket that fails before the server confirms the registration is checked once more against the same endpoint, and a certificate that does not verify on this host is reported as such rather than as a generic connection failure. That failure ends the run at once and exits 77, including on a registration partway through the wait for the partner, since every later dial meets the same certificate. A socket that drops later already completed that handshake, so its failure is reported at once and names no certificate. On a network that intercepts TLS, the remedy is to trust that network's certificate authority -- add it to the host's trust store, or name a file holding it in `NODE_EXTRA_CA_CERTS`.

**A run configured for an environment proxy is told no certificate was checked.** The check dials the coordination server itself and never through a proxy, so on a `wss://` run that turns Node's environment proxying on -- `NODE_USE_ENV_PROXY` set to `1`, or `--use-env-proxy` on the command line or in `NODE_OPTIONS` -- with a proxy address in `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, or `http_proxy`, it cannot tell whether the failed connection went through the proxy, and no certificate verdict is reported at all: the failure states that, and names the same remedy, since an intercepting proxy is the likely cause there too. A run whose `NO_PROXY` or `no_proxy` excludes the signaling host is answered the same way, since that exclusion applies per dial and the check does not read it.

### Naming the key each match was made on

`--include-matching-key`, or [`include_matching_key: true`](EXCHANGE_REFERENCE.md#include_matching_key) in the configuration, adds a last column, `matched_on_key`, to the result file, holding the `name` of the linkage key each pair matched on.

- **It is local to your run.** Nothing extra is sent, and your partner's result, the agreed terms, and the exchange record are unchanged.
- **It requires `cascade`, `psi`, and a result for you.** Under `single-pass`, `psi-c`, or your own `expects_output: false`, the flag is refused (exit 64) before your partner is contacted, and the configuration key when the configuration is read.
- **It names the key, not the value** that matched through `split_on`, `swap`, or `generate_fuzzy_comparisons`. A [key that runs only where a field is missing](EXCHANGE_REFERENCE.md#keys-that-run-only-where-a-field-is-missing) is named with whose record had no valid date of birth.
- **The flag wins over the configuration.** `--include-matching-key` turns the column on for one run and `--no-include-matching-key` turns it off, whatever a valid `include_matching_key` says; a scheduled run that always wants the column sets the key instead.
- **Its name is fixed.** A partner payload column or one of your own named `matched_on_key` is renamed; only an identifier column of that name moves the key column to `own_matched_on_key`.

### Sweeping a stale exchange directory

A crashed or mismatched prior run can leave protocol files in an `sftp`/`filedrop` directory that stall the next rendezvous. `--sweep-exchange-files` deletes every protocol file in the directory before the rendezvous -- this party's and the peer's hellos, acks, locks, joining sentinels, and messages -- and starts a fresh exchange. Foreign (non-protocol) files are never touched. It is accepted by `alcove exchange` and the quick exchange form, is CLI-only, and is never persisted to `alcove.yaml`. Confirm that no other session is using the directory before passing it: a sweep during a live exchange destroys that exchange's state.

`--force-retain-sweep` is DANGEROUS and exists only to escalate a sweep the guard refuses. A directory that is, or whose peer is, in retain mode holds an audit transcript, so `--sweep-exchange-files` alone refuses there; `--force-retain-sweep` permits the deletion, and **the prior transcript is permanently lost**. `--sweep-exchange-files` alone also stops at a partner hello it cannot read because the file is too large or is not a valid hello. `--force-retain-sweep` deletes that hello with the rest, since retain mode cannot be ruled out, and its warning names the file, its size and why it could not be read. It requires `--sweep-exchange-files` and is rejected on its own. Use it only when discarding the transcript is the intent.

### A server that does not allow renames

An `sftp` or `filedrop` exchange writes each file under a temporary name and renames it. Against a server that refuses renames, the run fails at its first write, quoting the server's answer and naming `--write-without-renaming` as a possible cause; the same answer can mean a missing file or a permissions problem.

`--write-without-renaming` (or `write_without_renaming: true` under `connection.options`) writes every file directly under its final name. Use it only where the shared folder never passes a partly written file to your partner: Alcove cannot check that, and warns before it connects (a `warning` event with `source` `writeWithoutRenaming` on the [event stream](spec/CLI_EVENTS.md#warning-sources)); the pre-run display says so too. Your partner does not need the option. Limits: [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#setting-write_without_renaming).

## The result file

An exchange writes its matched records to a file in the `OUTPUT_FOLDER` it was given, or to `stdout` when it was given none, on `alcove exchange`, the quick exchange form, an online `alcove invite`, and an [acceptance that runs its own exchange](#accepting-and-running-a-webrtc-exchange). Its columns, left to right:

- **Your own matched record** -- the identifier value of the record that matched, under the name of your identifier column.
- **`row_id`** -- your partner's 0-based row index for that match, on every run.
- **The partner's payload columns**, then any of your own columns [`include_own_columns`](EXCHANGE_REFERENCE.md#include_own_columns) selects. A name already taken is written as `their_<name>` or `own_<name>`, then numbered.
- **`matched_on_key`**, last, with [`--include-matching-key`](#naming-the-key-each-match-was-made-on).
- **With no identifier column declared**, the first column is `row_id` holding your own 0-based row index, and your partner's index moves to `their_row_id`.
- **One row per matched pair**: one per matched record under `one-to-one`, more under a deduplicating cardinality.

Header derivation, column order, and row count: [PROTOCOL.md](spec/PROTOCOL.md#output).

**`OUTPUT_FOLDER` is the folder for every file the run writes:** the result as `alcove-results-<time>.csv`, and beside it the exchange record `alcove-record-<time>.json`, its verification keys and agreed-terms file, and a signed run's receipt `alcove-receipt-<time>.json`, all with the same time stamp. Each run adds files rather than replacing the last run's. No setting moves the receipt. Anything that reads the output folder -- a sync service, a network share, a downstream job -- receives the record files too, so name a folder only this machine's user reads, or pass `--no-record`.

- **A missing folder is created**, parents included, before your partner is contacted.
- **A path that names a file**, or a folder Alcove cannot create or write in, is refused with exit 64 before anything is sent. Change the argument to a folder, for example `./`.
- **Without `OUTPUT_FOLDER`** the result goes to `stdout`, and the record, its keys and terms file, and the receipt go to the working directory.
- **A folder inside the shared folder is warned about.** On `filedrop`, an output folder (or, without one, the working directory) or a key file inside `path`, `inbound_path`, or `outbound_path` draws a warning before the exchange starts: anyone who can read the shared folder, your partner included, can read those files. The run continues.

A scheduler line naming the folder needs no command substitution and no `%` escaping, under cron, launchd, and Windows Task Scheduler alike ([EXCHANGE_RECORD.md, Where a run's files go](spec/EXCHANGE_RECORD.md#where-a-runs-files-go)).

**Values survive the round trip.** Every header and value is written as an RFC 4180 field: one holding the [field delimiter](#the-field-delimiter), a double quote, CR, or LF is quoted with embedded quotes doubled. A payload cell holding commas, or a whole JSON document, reads back byte-identical, which is what lets `alcove verify-receipt` reproduce what the exchange committed to. The exception: a committed null and a committed empty string are both written as an empty cell and read back as an empty string ([Verifying a receipt](#verifying-a-receipt)).

**One CSV line may not exceed 8 MiB.** A data row or header line past that is refused, naming the limit, in your input on every command and in the result file `alcove verify-receipt` re-supplies ([PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md#csv-read-single-line-byte-ceiling)).

## Signing identity and the agreed terms

A first-time setup, step by step, is in [From a quick exchange to signed receipts](#from-a-quick-exchange-to-signed-receipts). This section and the ones it points at are the reference behind each step.

Under `signing.mode: certificate` the run loads this party's signing identity from the path `signing.identity_file` names, before any credential, terms, or data are sent. Alcove chooses no location for it ([Where the signing identity lives](#where-the-signing-identity-lives)): a configuration that names none is refused from the configuration alone (exit 64), before the run prepares your input or reaches the server, and so is a path that holds no identity file. Set `signing.identity_file` -- `/run/signing/alcove-signing-identity.json` is the usual shape, created there by `alcove fingerprint --identity-file` -- or run `signing.mode: none` unsigned.

A partner verifies a receipt against the identity in the agreed terms, so the identity bound into your certificate must equal the run's `linkage_terms.identity`, or the `--identity` that replaces it for the run. A mismatch is refused where the identity is loaded (exit 64), naming both values, before anything is sent. Reconcile them with [`alcove fingerprint --force --identity`](#signing-identity-fingerprint) naming the terms identity, which changes the fingerprint your partner has pinned and needs a coordinated re-pin, or by editing `linkage_terms.identity` to the bound value. The exchange also checks the binding at terms agreement: a diverging run ends there, before any linkage key or data crosses, and ends the partner's run promptly too.

### Pinning the partner's certificate

Both parties present their signing certificate during the authenticated setup step that opens the exchange, before the first linkage key or payload row crosses. What your side does with it depends on whether `signing.partner_fingerprint` is set.

- **It is set.** The presented certificate must match it. A different certificate ends the run there, with no result, no receipt, nothing disclosed, and the configuration unchanged. The match reads the certificate's body alone: one that matches the pin but fails its own signature, or names a party other than the one under which your partner agreed on the terms, is refused at the receipt swap, after the linkage keys and payload have crossed. Re-pinning is an edit you make after confirming the new value with the partner out of band.
- **It is not set.** The run pins the presented fingerprint, records it in the configuration file passed to `alcove exchange`, and prints the value and the file; the line also rides the [machine-readable event stream](#machine-readable-event-stream) as `partnerCertificatePinned`. It pins only a certificate that verifies under its own key and names the party under which your partner agreed on the terms; anything else ends the run with nothing pinned and nothing disclosed. The write renames a new file over the configuration, so the directory holding it must be writable: on a read-only configuration mount the run exits 64 before it connects, telling you to set `signing.partner_fingerprint` yourself or mount the configuration writable for the first run ([DEPLOYMENT.md](DEPLOYMENT.md#key-file-permissions-in-containers)).

A first-contact pin is only as trustworthy as the channel your invitation and shared secret travelled. **Compare the printed fingerprint with the one your partner's [`alcove fingerprint`](#signing-identity-fingerprint) prints, over a channel you trust, before you rely on the receipts**, or set `signing.partner_fingerprint` yourself before the first run. Nothing is asked interactively, so a scheduled exchange pins and reports without a terminal. Trust model: [Pinned self-signed trust model](SECURITY_DESIGN.md#pinned-self-signed-trust-model).

Two other outcomes end the run at the same point, with nothing disclosed and exit 76 (partner refusal): a partner that presents no certificate (it is not signing receipts), and a certificate this build cannot read. Both name what to ask the partner for.

An unnamed party is refused too. With no `linkage_terms.identity` and no `--identity`, a `certificate`-mode exchange exits 64 before anything is sent; name this party, or run `signing.mode: none`. A partner whose terms name no party stops the run at terms agreement, before any linkage key or data crosses, with no result, record, or receipt, and exit 76.

### Signing without an exchange record

`--no-record` suppresses the exchange record, not the receipt. A signed receipt without its run's record can never verify above `INCOMPLETE` on any verifier ([Pairing the receipt to one run](#pairing-the-receipt-to-one-run)), and the record cannot be reconstructed afterward. The run warns before anything is sent, on the operator log and the [event stream](#machine-readable-event-stream), naming both ways out (keep the record, or drop the signing block), and then proceeds.

### When the receipt swap fails

The signature swap is the last step of an exchange, so a run that fails there -- a fingerprint that does not match the pin, a partner that re-keyed, a connection that drops mid-swap -- has already sent and received its data. The same holds for a partner that sends payload columns to a run whose terms receive none (a count-only exchange, or one where you receive no result), which is refused after both payloads have crossed.

Such a run writes its **exchange record and verification keys**, to the usual path, and no receipt; the record states that no receipt accompanies it. The run still fails with its own exit code. `--no-record` suppresses that record too.

## Starting the server on demand

A server kept down between exchanges is started through an HTTPS endpoint before the run's first connection to it, stated as [`connection.server.provision`](EXCHANGE_REFERENCE.md#on-demand-server-provisioning) in a configuration, or, on a run that builds its connection from a URL or an invitation, with `--server-provision URL` and its credential, `--server-provision-bearer TOKEN` or `--server-provision-username NAME` with `--server-provision-password PASSWORD`, each as an `@path`.

- **`--server-provision URL`** is an `https://` URL with a host and, optionally, a port and path. A URL with a user, query, or fragment, or with a host the URL parser would rewrite, is a usage error (exit 64).
- **The credential is read first.** The command reads the `@path` file before it does anything else, so a missing or empty file is a usage error (exit 64) before an invitation is printed. The configuration it writes records the reference, not the secret.
- **Where the flags apply.** On the `sftp` and `webrtc` channels; a `file://` URL refuses them, and an offline `invite` or `accept` reports them ignored. On `alcove exchange`, `--server-provision` replaces the configuration's block for that run. The call and its exit codes: [How `alcove exchange` calls a start-mode endpoint](EXCHANGE_REFERENCE.md#how-alcove-exchange-calls-a-start-mode-endpoint).

## SFTP host-key trust

Every command that opens an SFTP connection -- `alcove exchange`, an online `alcove invite`/`accept`, and a quick exchange -- verifies the server's SSH host key before sending any credential, so a man-in-the-middle or a substituted server is detected rather than trusted. You can pin the key out-of-band by setting `connection.server.host_key_fingerprint` to the server's OpenSSH SHA256 fingerprint (the value `ssh-keygen -lf` prints; `@path` is supported). If you cannot obtain it out-of-band, the first interactive run establishes it on first use, the way `ssh` does:

- The first time you connect to an unpinned SFTP server from an interactive terminal, the command shows the presented host key's fingerprint and asks you to confirm. The fingerprint line goes to the terminal with the question at every `--log-level` and with a `--log-file` (which also gets a copy at `warn`, unless the file is stderr itself). On confirmation it records the fingerprint and connects; every later run then verifies it silently. Verify the fingerprint against the server's published value if you can before confirming. Reading the key takes a single connection attempt, bounded by `--connection-timeout` (`connection.options.server_connect_timeout_ms`), and is not re-dialed: if it fails, the command stops before prompting and sends no credential, so run it again, raising the timeout if the server is slow to answer. Where the command writes a configuration -- `exchange` (into the existing `alcove.yaml`, preserving your comments), the online `invite`/`accept`, and a quick exchange run with `--save` -- the pin is saved there; a quick exchange run without `--save` trusts the key for that one exchange only (like `ssh` to a host you do not add to `known_hosts`).
- A run with no terminal -- an automated or scheduled run, or one piping its input CSV through stdin -- does not prompt and does not silently accept: it fails closed with an error telling you to run once interactively to pin the key, or to set `host_key_fingerprint` yourself. So pin the key (out-of-band or via one interactive run) before scheduling unattended exchanges.
- If the server legitimately rotates its host key, a later run fails with a mismatch error rather than silently trusting the new key. Verify the new fingerprint out-of-band, then re-pin: set `host_key_fingerprint` to the new value, or remove it from `alcove.yaml` and run once interactively to confirm and re-pin (the same as removing a changed host from `~/.ssh/known_hosts`).

A configuration whose `connection.server` states a start-mode `provision` endpoint, or a run given `--server-provision`, has the run wake the server through it before this step, so the probe reaches a server that is up ([On-demand server provisioning](EXCHANGE_REFERENCE.md#on-demand-server-provisioning)).

The command-line spelling of the same pin is `--server-host-key-fingerprint` (accepted by every command above): it sets `host_key_fingerprint` for that run, overriding any value in the configuration, so a supervised or scripted run that already knows the fingerprint connects with no prompt while a server presenting a different key still fails closed with a mismatch error.

## Reading a host key with `probe-host-key`

```sh
alcove probe-host-key SFTP_URL [--json] [--connect-timeout <duration>]
```

`probe-host-key` reads and prints the host-key fingerprint an SFTP server presents, without authenticating: it connects only far enough to observe the key, then refuses before any credential is sent (the `ssh-keyscan` analogue). Use it to obtain a fingerprint to pin -- compare the printed value against the one the server's operator published, then set it as `host_key_fingerprint` (or pass `--server-host-key-fingerprint`). It establishes no trust on its own: it reads the key over the same network the exchange will use, so a value it prints is a candidate to verify out-of-band, not a vouched-for key.

`SFTP_URL` is an `sftp://host[:port]` address; you supply no username, path, or credential, and none is sent to the server (the probe refuses before authenticating). A non-sftp scheme is a usage error. `--connect-timeout` bounds the single dial (e.g. `10s`), enforced as the SSH ready timeout: the probe dials once and is not re-dialed, so a host that accepts the connection and then answers nothing costs that value and no more. A dial that fails before the peer identifies itself as SSH adds one further bounded diagnosis read of at most two seconds or the connect budget, whichever is smaller. This is what distinguishes it from the exchange's [`--connection-timeout`](#configuration), which bounds each attempt of a dial that is retried; re-run the probe rather than waiting on a retry it does not make. By default the command prints a human-readable summary; `--json` instead prints one line of machine-readable JSON -- `{"fingerprint":"SHA256:...","key_type":"..."}` -- on stdout for a script to consume. A transport failure (unreachable, refused, or timed out) exits 69; a usage error exits 64. On the exit-69 path `--json` may print a diagnosis line instead (see the section below). The console's "read the fingerprint from the server" affordance runs this command for the operator.

### When something other than an SSH server answers the port

An SSH server announces itself before anything else, so a connection that ends before that announcement is reported by what answered, not as an unreachable host:

- **Non-SSH data** -- a web page, TLS, or anything else -- is reported as such, with a short excerpt of what it sent. Most often a proxy or gateway is intercepting the port.
- **A connection closed with nothing sent** is reported separately. Most often a firewall or IP allowlist stands in front of the server; a connection throttle reads the same way.

The verdict rests on the peer's first bytes within a short read budget, so an SSH server that sends a long or late banner before its announcement is reported the same way; the message names that bound.

Under `--json`, the verdict also arrives on stdout as one line before the exit-69 failure: `{"diagnosis":"non_ssh","shape":"http"|"tls-alert"|"unrecognized","excerpt":"..."}`, or `{"diagnosis":"closed_unanswered"}`. A failure with no verdict prints no line. The `excerpt` is escaped to printable ASCII in the emitted line only: `JSON.parse` returns the peer's original bytes, so escape the parsed value at your own display. Private-key material is redacted from the excerpt on both routes ([Console and log hygiene](SECURITY_DESIGN.md#console-and-log-hygiene)); the byte bound and escape form are in [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#sftp-host-key-verification).

This covers every SFTP connection Alcove makes: `probe-host-key`, the first-use host-key prompt, and an `exchange` run's connection, including a reconnection in connection-per-poll mode. The check runs once per run; a later reconnection answered the same way is reported as a plain connection failure.

## Scheduling the run

`alcove exchange` conducts one exchange and exits. Repeating it on a cadence is the host scheduler's job -- cron on Linux and macOS, the Task Scheduler on Windows: Alcove schedules nothing itself and leaves no process running between runs. Every scheduled run is a fresh process that reads the configuration and key file, exchanges, rotates the shared secret, writes its result, and exits.

A daily run at 02:00, from the directory holding this exchange's files:

```text
0 2 * * * cd /srv/alcove/agency-b && /usr/local/bin/alcove exchange input.csv ./ --log-file /srv/alcove/agency-b/exchange.log
```

The container form mounts that directory at the image's working directory (`/work`) and so needs no `cd` (see [Running the CLI](DEPLOYMENT.md#running-the-cli)):

```text
0 2 * * * /usr/bin/docker run --rm -v /srv/alcove/agency-b:/work ghcr.io/georgetown-mdi/alcove exchange input.csv ./ --log-file exchange.log
```

To be told when a run fails, let cron mail what the job prints, and have the job print one line when the exit code is not 0:

```text
MAILTO=alcove-owner@example.org
0 2 * * * cd /srv/alcove/agency-b && /usr/local/bin/alcove exchange input.csv ./ --log-file /srv/alcove/agency-b/exchange.log || echo "alcove exchange failed with exit code $?; see /srv/alcove/agency-b/exchange.log"
```

With `--log-file`, a run that succeeds prints nothing, except the [display of what it sends](#what-the-run-shows-before-it-starts) on the first run and whenever that display changes. A run that fails prints its error and the next step on stderr -- the error-level lines, which `--log-file` also records -- and the `echo` adds the exit code, so the mail states what failed, what to do, and the code, whose action [Exit codes](#exit-codes) lists. To mail the `echo` line alone, add `2>/dev/null` before the `||`; the error stays in the log file, and so does a changed display, which is then mailed to nobody. Cron mails only where the host can deliver mail; where it cannot, put a command that alerts you in place of the `echo`.

Both lines name the program by absolute path. A scheduled job runs under the scheduler's environment rather than your shell's, so a bare `alcove` or `docker` may not resolve there -- under cron's minimal `PATH`, or a Task Scheduler service account's -- and the job then fails without ever reaching Alcove. Give the full path, or put the program on the scheduling account's `PATH`.

For the container form, the mounted directory must be readable and writable by the account inside the container, which is a question of host-side ownership rather than of mode: see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as), and [Key file permissions in containers](DEPLOYMENT.md#key-file-permissions-in-containers) for mounting the key file (including the read-only-configuration, read-write-secret split).

### The working directory

The configuration and key files default to `./alcove.yaml` and `./.alcove.key` -- relative paths, resolved against the working directory of the process that reads them. A scheduled job does not inherit the directory you edited the schedule in; the scheduler decides what it starts in. Make it explicit: `cd` into the exchange's directory first, as the lines above do, or pass absolute `--config-file` and `--key-file` paths.

Everything else the run reads or writes by a relative path resolves the same way -- the `INPUT_FILE` and `OUTPUT_FOLDER` positionals, `--log-file`, `signing.identity_file`, and any `@path` credential reference stored in the configuration (see [Configuration](#configuration)). One directory per exchange partner is the intended layout, and it is what makes the single `cd` enough.

That directory has to be writable by the scheduling account, not merely readable: each successful run rewrites `.alcove.key` with the rotated secret, and an SFTP run may edit `alcove.yaml` to record a host-key pin. The run verifies up front that the key file can be written, before any key exchange, so a mis-owned directory stops the run rather than desynchronizing the two parties' tokens.

Give the results an `OUTPUT_FOLDER` (`./` above) rather than redirecting `stdout`: Alcove creates the result file owner-only, while a shell `>` redirect leaves it at the scheduling account's umask (see [Key file security](SECURITY_DESIGN.md#key-file-security)). Each run's result, exchange record, verification keys, and receipt accumulate in that folder under that run's time stamp ([The result file](#the-result-file)); rotating and archiving what accumulates is an operator responsibility.

### The key file on the scheduling machine

`.alcove.key` authenticates every run of this exchange. On the scheduling machine it belongs to the account the scheduler runs the job as, readable by nobody else: mode `0600` on Unix, an owner-only ACL on Windows. The CLI writes it that way and warns on load about an over-permissive file, but at `warn` level, so a job at `--log-level error` or `silent` does not see the warning. Required permissions and corrections: [Key file security](SECURITY_DESIGN.md#key-file-security).

From the time an exchange moves onto a scheduling machine -- from another host, or from the [console](CONSOLE.md)'s hand-off -- exactly one machine may run it. Move the key file over an encrypted transfer, take it as it stands after the last run on the old machine, and stop running the exchange there. The secret rotates on each run whose terms are agreed on, so a second copy still running holds a secret the partner has replaced; its next key exchange fails, and both parties must re-invite ([Out-of-sync tokens](#out-of-sync-tokens)).

### Cadence and the token's expiry

A key file may hold an `expires`, and that instant bounds the schedule. `alcove exchange` checks it at load time, before opening any connection: an expired token aborts the run with a usage error (exit 64), and the recovery is for both parties to re-invite ([Key lifecycle](#key-lifecycle)). Two mechanisms write it:

- **An invitation's setup lifetime** -- one hour by default, up to a year with `--expires-in`. The inviting party's key file holds it, written by `alcove invite` or by [`alcove exchange --invitation`](#provisioning-the-key-file-from-an-invitation); the accepting party's does not. The first exchange has to happen inside that window, so run it once by hand before handing it to a schedule.
- **The inactivity limit.** With [`authentication.token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) set, each successful exchange stamps `expires` that many days past the rotation. The interval between *successful* runs has to fit inside it: a monthly cadence under `token_max_age_days: 30` expires the secret the first time a run fails or is missed, and a weekly run under a 30-day limit tolerates three consecutive failures.

The "expiring soon" warning (within `token_max_age_days / 3` days of expiry) is suppressed by any run that refreshes the token, so on a schedule it appears only when runs have stopped completing. Route it somewhere a person reads.

Keep the scheduling host's clock synchronized: expiry is evaluated against local time on each side, and a lagging clock can expire a token between the key exchange's round trips, leaving the parties out of sync ([Out-of-sync tokens](#out-of-sync-tokens)). Each party sets its policy independently, so a partner whose secret expired appears from this side as a silent peer. Policy: [Shared secret rotation and inactivity limit](SECURITY_DESIGN.md#shared-secret-rotation-and-inactivity-limit).

### What an unattended run refuses rather than asking

A scheduled run has no terminal, and Alcove never reads that as consent: a question it cannot ask becomes a refusal (exit 64) that fails the job, before any credential, terms, or data are sent. Settle each before the first scheduled run:

| Case | Unattended behavior | Settle it by |
| --- | --- | --- |
| An unpinned SFTP host key | Fails closed rather than trusting the presented key ([SFTP host-key trust](#sftp-host-key-trust)) | Pinning `connection.server.host_key_fingerprint` from a fingerprint verified out of band, read with [`alcove probe-host-key`](#reading-a-host-key-with-probe-host-key), or confirmed in one interactive run |
| `alcove accept` without `--consent-to-terms` | Exits 64 before showing the terms ([Where the display is shown](#where-the-display-is-shown)) | Reviewing the terms, then passing [`--consent-to-terms`](#accepting-without-the-prompt) |
| `alcove accept` writing a new configuration, with no `--identity` | Exits 64 rather than asking ([Offline acceptance](#offline-acceptance)) | Passing `--identity` |
| `alcove apply` without `--consent-to-terms` | Exits 64 and changes nothing ([Applying an update](#applying-an-update)) | Reviewing the update, then passing `--consent-to-terms` |
| `alcove init` over an existing file | Fails closed rather than overwriting ([Initialization](#initialization)) | Deleting the file, or passing `--config-file` |
| Your partner's changed terms | Exits 64 and writes `alcove.proposed-terms` beside the configuration ([When your partner's terms change](#when-your-partners-terms-change)) | Running the `alcove apply` command the error names, or having the partner send an `alcove update` ahead of the run |

Two cases proceed unattended where an attended run would ask or tell a person:

- **Your partner's first payload columns** are taken without asking, and one line records them ([Your partner's first payload columns](#your-partners-first-payload-columns)).
- **The default STUN server.** On `webrtc`, a run that lists no STUN url uses the built-in default ([STUN, and what it discloses](#stun-and-what-it-discloses)); a run that sets neither `stun` nor `turn` warns, and on a schedule that warning goes only to a log. Decide the disclosure when you set the schedule up: accept it, or set `stun` to a server of your own.

### Runs that overlap, and runs that wait

Both parties have to be running at once for an exchange to happen, on every channel: each side waits at the rendezvous only for its own budget -- `--peer-timeout`, or the transport's default where the field is unset -- and then gives up. Agree on the cadence and the window with your partner, with a margin for a late start on either side.

Two runs of the same exchange must not overlap: they share one key file, whose secret each rotates, and on `sftp` and `filedrop` one shared folder, which has to be dedicated to a single active exchange between exactly two parties ([Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity)). A scheduler starts the next run on time whether or not the previous one has finished, so set an interval longer than the run's own waiting budget -- `--peer-timeout` defaults to one hour on `sftp` and `filedrop`, and a partner that never appears waits it out -- or serialize the job with a lock so the scheduler skips a start while a run is still going. An outer timeout in the job line is a worthwhile safety check either way.

On `sftp` and `filedrop`, set a stable [`peer_id`](EXCHANGE_REFERENCE.md#connectionoptions) for a scheduled exchange: a protocol file a killed run leaves behind then becomes an immediate start-up refusal naming that file. It requires `timestamp_in_filename: true`, and a stable id makes this party's runs linkable to each other in the partner's logs. Neither party's id may fit the other's `peer_id` pattern, which usually comes from both setting the same `peer_id`. Each party then takes the other's hello for its own leftover, and the start-up refusal or peer timeout says so: give one side a `peer_id` with different text ([Fields in `peer_id`](EXCHANGE_REFERENCE.md#fields-in-peer_id)). If the partner's file transfer refuses a file name it has passed before, put [fields](EXCHANGE_REFERENCE.md#fields-in-peer_id) such as `%Y%m%d-%H%M%S` in `peer_id` or `--peer-id`, which Alcove fills in for each run; a crontab line writes each `%` as `\%`.

On `webrtc`, a longer `--peer-timeout` is made of fresh connection attempts of about ten minutes, each a new registration with the coordination server, so a partner who starts at any point in it is met ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#connection-attempts)). The budget is checked as each attempt starts, so a partner whose offer arrives up to 30 s past its end can still be met. A partner that appears and then goes quiet is held to [`inactivity_timeout_ms`](EXCHANGE_REFERENCE.md#shared-options) instead (one hour unless set in the configuration or by `--inactivity-timeout`). Teardown after a successful exchange inherits neither budget and is bounded separately.

A rendezvous that finds a partner hello already in the folder and never gets an answer behind it fails well inside the timeout, naming the file: the shape a run killed outright leaves. Recovery: [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity).

### Logs, and what the exit code tells the scheduler

Diagnostics go to `stderr` and the result to `stdout`, so capture what you need. `--log-file PATH` appends timestamped lines to a file Alcove creates owner-only, whose parent directory must already exist ([Logging](#logging)); its error-level lines also go to `stderr`, which is what the [cron recipe above](#scheduling-the-run) mails. `--log-level error` or `silent` discards the notices a schedule depends on, including the over-permissive key-file warning and the expiring-soon advisory; `silent` also discards the notice of a transport that did not finish closing, which reaches no other channel. A supervising process can read structured events on file descriptor 3 with [`--event-stream`](#machine-readable-event-stream).

A supervisor acts on the [exit code](#exit-codes) alone, not on the log text; each code names one action, in that table's last column. Only 69 is retried, a small fixed number of times before the failure goes to a person; 66 from `alcove exchange` waits for the input file. Every other failure code repeats on a retry, and re-running a 73 conducts a second exchange.

#### How long a run waits before it exits

Every file the run writes to a path (the result, the exchange record, the receipt) is written and waited for with no time limit. Two waits are bounded, and after them the process returns within three seconds:

- **The transport closing**, at a per-channel ceiling, after the run has reported its outcome. A close that reaches the ceiling costs only the wait: Alcove states on stderr, at error level, how long it waited and what was still open, and the exit code stays the exchange's own. On a shared-folder or SFTP exchange that deletes its protocol files, it also tells you to check the exchange directory for any the abandoned close left there.
- **A result sent to `stdout`.** Alcove waits for the reader to take the last line, and gives up only after 60 seconds with none of the result leaving the process, so a slow reader is never cut off, only a stopped one.

The notice after an abandoned close says which of the run's files -- the result, the exchange record, the receipt, and a setup run's configuration -- are on disk. A configuration an [online invitation](#online-invitation) or [acceptance](#online-acceptance) lost earlier is reported where it happened, by its own warning and exit 73.

A reader that stopped, or one that closes the pipe before the last line (`| head -1` on a result past the pipe's buffer), ends the run with exit 73: the result partly delivered, the record and receipt written, and anything the run would have saved after the result (a `--save` configuration and key file) unwritten and named as skipped. Do not re-run it.

If something inside the process still holds it after the three seconds, Alcove names the kinds of resource still open on stderr and exits with the status the run already reached; report that line as a fault.

### Windows Task Scheduler

The same rules apply under the Task Scheduler, with the account the task runs as in place of the cron account: it must own `.alcove.key` under an owner-only ACL, own the working directory, and reach the program -- by its full path, or by having it on that account's `PATH`. The equivalent of the daily cron line above, run in Command Prompt, which assumes Alcove is on the task account's `PATH` (name it by full path there otherwise):

```cmd
schtasks /Create /TN "alcove exchange" /SC DAILY /ST 02:00 /TR "cmd /c cd /d C:\alcove\agency-b && alcove exchange input.csv ./"
```

For a folder or arguments holding a `'`, or a task that needs a start date, register the task from PowerShell with `Register-ScheduledTask` instead, as the web app's [command-line export](MANAGED_EXCHANGE.md#exporting-to-the-command-line) does: `schtasks` stores a `'` in `/TR` as `"`, and reads a `/SD` date in the machine's own date format ([why](spec/MANAGED_EXCHANGE_RECORD.md#the-command-line-exports-scheduled-lines)).

An exchange folder that lives on a Windows network location -- a mapped drive, a UNC path, or a DFS namespace -- is not bind-mountable into the container by its drive letter: the container reaches it through a CIFS volume instead, which the Windows shared-folder setup script provisions with the ownership the image needs (see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as)).

## Checking a network shared folder

```sh
alcove doctor probe
alcove doctor mount DIRECTORY
```

`doctor` checks a shared folder before an exchange is attempted, in the two places the answer can differ:

- **`doctor probe`** asks the SMB server directly over TCP, with nothing mounted: whether the name resolves from inside the container, whether port 445 is reachable, whether the credentials are accepted, whether the share and the folder open, and whether a file can be created, renamed, and deleted there.
- **`doctor mount`** checks an already-mounted directory as the kernel presents it -- the operations Alcove's rendezvous is built on, which a share can refuse after passing every network check.

Run both: the probe leaves a marker file and the mount check looks for it, which establishes that both point at the same directory. A wrong server, share, or subfolder (a DFS path is the usual cause) is caught there.

Neither mode changes anything on the share beyond its own working files. The probe removes every file it creates except the marker, and sweeps any `alcove-probe` working file already present; the mount check consumes the marker and removes the rest. On a share that refuses deletes, or a connection that dies mid-run, an `alcove-probe-*.tmp*` file can remain until the next run ([cleanup limits](spec/CLI_DOCTOR.md#cleanup-limits)).

Stopping a probe with `Ctrl-C` or `SIGTERM` makes it clean up first, which takes up to 8 seconds. Give a supervisor at least that between stop and kill: `docker stop`'s default 10 seconds is enough, and a lower Kubernetes `terminationGracePeriodSeconds` or kill timeout is not. A probe killed sooner leaves its credentials file in an `alcove-doctor-*` directory under `/tmp`, which `docker run --rm` discards with the container.

### Inputs

`doctor probe` takes its connection details from the environment, not from flags, so the password never becomes an argv value that any process listing on the machine can read:

| Variable | Meaning |
| -------- | ------- |
| `SMB_SERVER` | Server name or address (required) |
| `SMB_SHARE` | Share name -- the first path component only (required) |
| `SMB_USER` | Account username (required) |
| `SMB_PATH` | Subdirectory under the share the exchange runs in; omit to run the checks against the share root itself |
| `SMB_DOMAIN` | Account domain, for a domain account |
| `SMB_PASS` | Account password |
| `SMB_DIALECT` | `SMB3`, `SMB2`, or `NT1` to pin a dialect; omit to negotiate |
| `SMB_MARKER` | Filename of the marker to leave for `doctor mount`; omit to skip it |
| `SMB_TOKEN` | Per-run value written into the marker; omit to skip the cross-check |

`doctor mount` takes the mounted directory as its argument and reads `SMB_MARKER` and `SMB_TOKEN` for the cross-check; without them it runs its other checks and reports the cross-check as skipped. A missing required variable, or one whose value could change what a command means (a path separator in the server or share name, a line break in a credential, a marker or token that is not a plain identifier), is a usage error and exits 64 with no verdict printed -- the checks never ran.

### Output

Each check prints a line on stderr -- `OK:`, `WARN:`, `FAIL:`, or `SKIP:` -- with `MEANING:` and `ACTION:` lines under anything that needs one, then a summary line. The lines are plain, with no timestamp, level, or command name, so they can be passed on as written; `--log-file` captures them, and `--log-level` governs them (`silent` prints none, leaving the exit code). A `WARN:` does not stop an exchange; it names something worth knowing, such as a share that works only with `--lockless-rendezvous` or one nearly out of space. Change what the `ACTION:` lines name and run the command again. After a failure, every later check prints `SKIP:`, with the shared reason printed once.

`--json` prints the verdict as one line of JSON on stdout instead of the check lines. Either way the exit code states the verdict ([Exit codes](#exit-codes)). Every field, the schema version, the vocabularies, each mode's check list, and the exit-code mapping: [docs/spec/CLI_DOCTOR.md](spec/CLI_DOCTOR.md).

## Checking the relay of a WebRTC exchange

```sh
alcove doctor relay
```

`doctor relay` checks whether this host reaches the relays a [WebRTC exchange](#webrtc-exchanges) uses -- the TURN relay a run allocates on, and each WebSocket relay a run dials -- so a network that blocks one is found at setup. Run it after `alcove invite` or `alcove accept` has written the configuration and key file; it takes the same `--config-file` and `--key-file` a run takes, and sends each relay what a run sends it: the TURN relay the credential derived from the exchange's shared secret, or the entry's own `username` and `credential`; a WebSocket relay the proof a run makes from that secret.

- **It runs only when you name it.** `alcove doctor probe` and `alcove doctor mount` contact no relay. These are refused, exit 64, with nothing contacted: a configuration whose channel is not `webrtc`; one with no relay (no `turn` entry, no `websocket_relay`, and no turn or websocket url in [`invitation_relay`](EXCHANGE_REFERENCE.md#connectioninvitation_relay)); one whose every relay url [`allowed_relays`](#using-only-the-relays-you-choose) leaves out; and one that lists a WebSocket relay and sets no `role`, since the proof names your side's role.
- **It contacts no host a run does not contact.** A run allocates on the first TURN url it lists ([PROTOCOL.md](spec/PROTOCOL.md#the-invitations-relay-locator)), so the check asks that TURN relay alone. A run dials every WebSocket relay it lists, so the check asks each of them. It enrolls at the registrar your partner's invitation names only where a run would ([PROTOCOL.md](spec/PROTOCOL.md#enrolling-at-a-default-relay)). It does not contact later TURN urls, your own [`relay_registrar`](EXCHANGE_REFERENCE.md#connectionrelay_registrar), or any coordination server.
- **It names the hosts first.** It prints the hosts it will contact -- the first TURN url with its transport and source, each WebSocket relay and its source, and the registrar where a run would enroll -- noting that whoever runs each learns this machine's network address, then each configured host it will not contact, with the reason. This statement goes to stderr or the `--log-file` at every `--log-level`, with or without `--json`.
- **It enrolls first where a run would.** It enrolls the exchange's relay key at the invitation's registrar with no token, as a run does just before it connects, and prints `OK:` with the lapse the registrar states, or `WARN:` with the registrar's answer and the action to run the check again and, if it keeps failing, ask your partner whether the registrar is up. A run goes on without the enrollment, but the invitation's relay refuses the run's credential until either of you enrolls the exchange there. A failed enrollment does not stop the check: the relay is still asked, and where it is then not reached, its line names the failed enrollment as the likely cause. A registrar a run would not enroll at prints `SKIP:`.
- **The first relay decides.** The check gathers relay candidates for that url alone, under one time limit, and prints `OK:` when the relay gave an address, or `FAIL:` with `no relay candidate gathered` and the remedy in [When a WebRTC exchange does not connect](#when-a-webrtc-exchange-does-not-connect). Each later url prints `SKIP:`, which does not block the result; to check one, list it first under [`turn`](#turn).
- **A `turn:` url is asked over UDP, then TCP**, as a run does, so its `OK:` does not show that UDP gets through. `?transport=tcp` is asked over TCP alone, and a `turns:` url over TLS.
- **A `FAIL:` does not say why.** A blocked network, a refused credential, and an untrusted relay certificate print the same line. A relay that takes enrolled keys refuses a derived credential until the exchange's relay key is enrolled: at the relay your partner's invitation named, the check's own enrollment does that where the invitation names a registrar; at your own relay, [`alcove enroll-relay`](#registering-the-relay-key-at-your-relay) does.
- **Each WebSocket relay is asked whether it admits the run.** The check opens two connections to the relay through the client a run uses, each presenting the proof a run presents, and closes both once the relay answers. It does not wait for your partner, so it shows that the relay accepts this exchange, not that the exchange would pass through it. Its line is `OK:` where the relay admitted the proof, or `FAIL:` with one of four answers: not admitted, with what the relay's refusal means and what to do; its TLS certificate did not verify, which on a network that intercepts TLS means this machine does not trust that network's certificate authority (add it to the trust store, or name a file holding it in `NODE_EXTRA_CA_CERTS`); not reached; or not an Alcove WebSocket relay. Where your partner is already waiting at the relay, the check takes their place in the pairing for a moment, and their run dials the relay again.

The output and exit codes are those of the other checks ([Output](#output)): a `FAIL:` exits 78, and a `WARN:` or `SKIP:` alone exits 0. `--json` gives each WebSocket relay's answer and refusal code on its own check. The `--json` fields: [docs/spec/CLI_DOCTOR.md](spec/CLI_DOCTOR.md#the-relay-check).

## Signing identity fingerprint

```sh
alcove fingerprint [--identity-file PATH] [--identity STRING] [--config-file PATH] [--force] [--export-certificate PATH]
```

Print this party's signing certificate fingerprint, creating the signing identity on first use: the long-lived keypair and self-signed certificate behind a certificate-backed receipt, which a partner pins once ([Receipt signing identities](SECURITY_DESIGN.md#receipt-signing-identities)). Share the value out of band, as you would an SFTP host-key fingerprint.

Creation is announced on stderr. The identity string bound into the certificate comes from `--identity`, or from `linkage_terms.identity` in the configuration; once an identity exists, `--identity` is ignored without `--force`. A label containing a control character, one of the nine Unicode text-direction formatting characters, or a PEM or OpenSSH private-key block, or longer than the linkage terms allow, is refused. The direction marks `U+200E`, `U+200F`, and `U+061C` are admitted.

### Where the signing identity lives

You choose, and Alcove never does. The path comes from `--identity-file`, or from `signing.identity_file` in the configuration named by `--config-file`. With neither, the command refuses and prints nothing on stdout, so `FP=$(alcove fingerprint)` is empty and the status nonzero.

```sh
alcove fingerprint --identity-file /run/signing/alcove-signing-identity.json --identity "Agency A, a@agency-a.gov"
```

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/alcove-signing-identity.json
```

Give the identity a mounted directory of its own, separate from the key file's, which must be writable for the shared secret's rotation. Only `alcove fingerprint` writes the identity, so the directory needs to be writable only for the creating run and can be mounted read-only after ([Mounting the signing identity](DEPLOYMENT.md#mounting-the-signing-identity)). Keep it on durable storage: losing the file means a new identity with a new fingerprint, which every partner must re-pin before your receipts verify again. Never put it in a directory your partner syncs into. A `~`-relative path is expanded; in a container that home is usually ephemeral, which creates a new key and fingerprint on every run. If you already hold an identity file, name it rather than creating a second, which every partner would have to re-pin. Custody requirements: [Custody and persistence](SECURITY_DESIGN.md#custody-and-persistence).

### The identity bound into the certificate

Bind the identity that matches `linkage_terms.identity` in your configuration: a partner verifies a receipt against the identity in the agreed terms, so a certificate bound to any other string signs receipts the partner rejects. Binding a divergent one warns and proceeds, since this command sends nothing, and so does every later invocation while the two differ; the fingerprint on stdout is unaffected. Reconcile them before you share the fingerprint. [`alcove exchange`](#signing-identity-and-the-agreed-terms) refuses to run under a divergent pair.

### Regenerating and exporting

`--force` regenerates the identity: a new key with a new fingerprint, which every partner must re-pin before your receipts verify again. Coordinate it with them. It is also the only way out of an identity bound to a label the linkage terms refuse; bind an admitted label with `--force --identity`.

`--export-certificate PATH` also writes this party's public certificate, never the private key, to `PATH` for sending to a partner. Naming the signing identity file itself is refused, by any spelling or link that reaches it. Any other existing file at `PATH` is replaced only with `--force` (which also regenerates the identity); otherwise the run exits 64 and leaves it, unless it already holds this certificate.

## Verifying a receipt

```sh
alcove verify-receipt RECORD [INPUT_FILE] [RESULT_FILE]
```

Read a stored exchange artifact and report what holds up. It is read-only: it never modifies or re-signs an artifact. An exchange produces two, and this command verifies either or both:

- The **exchange record** (`alcove-record-<time>.json`), self-attested and unsigned. Verifying it is an internal-consistency check: it says nothing about the partner.
- The **signed receipt** (`alcove-receipt-<time>.json`), written when the exchange ran with `signing.mode: certificate`. This is the evidence against the partner: both parties' signatures and certificates over the terms and the data that flowed, beside a copy of the partner's linkage terms that no signature covers and verification re-derives the agreed-terms hash from.

`RECORD` may be either file; the command tells them apart by their format `version`. To check both artifacts of one exchange, name the exchange record as `RECORD` and pass the signed receipt to `--signed-record`, which also pairs the receipt to that run ([Pairing the receipt to one run](#pairing-the-receipt-to-one-run)). The verification keys are read from the record path with a `.keys.json` suffix, or from `--keys`; both parties' agreed terms from the `.terms.json` file the exchange wrote beside the record. An unrecognized `version` on any of these is rejected (exit 64).

**Re-supplied data.** The record holds salted commitments, not matched data, so pass the `INPUT_FILE` you contributed and the `RESULT_FILE` you kept, and the command opens every commitment: the sent payload, the received payload, and the pairing. Only **unmodified** files reproduce; a result re-sorted or re-exported in a spreadsheet does not. A duplicate identifier value is reported as a note. A received cell your partner committed as null reads back as an empty string and reports a received-payload mismatch; a note then names that as a possible cause, and the verdict stays a mismatch.

**Result size.** When the record's pairing opens against your result, the command recounts it against the record's stated size; a disagreement is a definite failure on its own line. Where no pairing stands behind the figure (no result supplied, nothing to open, or a count-only exchange), the size is reported as not checked; a record that states no size gets no line.

**Agreed-terms hash.** With both parties' linkage terms, the command re-derives the agreed-terms hash. Every exchange writes both parties' terms to `alcove-record-<time>.terms.json` (owner-only), so `alcove verify-receipt RECORD INPUT_FILE RESULT_FILE` checks it with no other file. Each half comes from the first source that supplies it: the flag (`--config-file` for yours, `--partner-terms` for your partner's), then for your partner's half the copy in the receipt named by `--signed-record`, then the terms file. Without both halves, the hash is reported as not checked, naming the flags that would supply them. A terms file that is unreadable, invalid, or larger than 1 MiB is reported on stderr and supplies nothing.

- **Payload columns.** The hash covers the payload columns your exchange stated, read from the configuration's `metadata`, else from the re-supplied `INPUT_FILE` header, else from a `payload.send` as written. With none of those, the command warns that the hash will not match; re-supply the input or add the metadata block. A `--partner-terms` file is read the same way, and the remedy is the partner's metadata block.
- **Named files.** `--config-file` is never auto-loaded. A named file that is missing is a usage error. A `--partner-terms` file that defines no `linkage_terms` is refused; a `--config-file` that defines none is accepted for its `signing` fields, with a note.

With neither `INPUT_FILE` nor `RESULT_FILE` -- the third-party-auditor case -- the command checks the record's structure and version and reports each commitment as not opened.

**The verdict.** Each commitment, and the size line, **opened and matches**, was **not opened**, or **does not match**, rolling up to `VERIFIED` (everything checked and passed), `INCOMPLETE` (nothing failed, but some checks could not run), or `VERIFICATION FAILED`. The command exits 0 only on `VERIFIED`; a definite failure exits 65 (`EX_DATAERR`) and `INCOMPLETE` 66 (`EX_NOINPUT`). A failed opening reads "Either the exchange record was altered, or an input, result, or terms file you supplied is not from this exchange", since the two cannot be told apart. Where only the result size is at fault, the headline says the record's figure disagrees with the pairing it commits to. Without a signed receipt, the output says it checked no partner signature.

**A result file from another run.** When the failures fit a result a later run overwrote, the headline says so first (`VERIFICATION FAILED: the result file is not from this exchange record's run. Most often, a later run overwrote it.`), still exit 65. Supply the files from this record's run, which its `OUTPUT_FOLDER` keeps under the record's stamp ([The result file](#the-result-file)); if those are the files you gave, the record was altered. Exact conditions: [EXCHANGE_RECORD.md, Re-supplied files from another run](spec/EXCHANGE_RECORD.md#re-supplied-files-from-another-run).

### Verifying the signed receipt

For a signed receipt the command reports, per party: the **receipt signature** against the certificate the record holds, the **certificate identity binding** (its self-signature), what **anchors the certificate** outside the record, and the **asserted identity** against the identities of this exchange. Beside those it reports the **agreed-terms hash** and the **receipt-record pairing**. The **run identifier** is printed but not recomputed, since that needs the session key only the two parties held. The verdict rolls up the same way, prefixed `SIGNED RECEIPT`, with the same exit codes; a run verifying both artifacts exits with the worse verdict's code.

The pinned fingerprint comes from `--partner-fingerprint`, or from `signing.partner_fingerprint` in the `--config-file` (the flag wins), so an auditor given a fingerprint out of band needs no configuration. A config named for its pin need define nothing else, and a `--config-file` path that does not exist is a usage error. A value that is not a fingerprint (an unpadded base64url SHA-256 digest, 43 characters) is a usage error. A pin matching **neither** certificate is a failure.

#### Pairing the receipt to one run

Recurring exchanges between the same parties under the same terms produce receipts whose signed values are identical, so both artifacts of a run hold a shared **run identifier**, compared when you name the exchange record. The pairing line reports:

- **from the same run** -- the same run identifier.
- **`DOES NOT MATCH`** -- different run identifiers: artifacts of two runs. A failure (exit 65), on its own line; a note points at the time stamp a run's record and receipt share.
- **no run identifier in the record** -- the record is of an exchange that produced no signed receipt. A failure.
- **not checked** -- no exchange record was named. The verdict stays `INCOMPLETE` (exit 66), even with both certificates anchored and the terms hash checked; name the record as `RECORD` and pass the receipt to `--signed-record`.

A receipt from a run with `--no-record` is always the **not checked** case, on any verifier ([Signing without an exchange record](#signing-without-an-exchange-record)). An artifact written before Alcove included the run identifier is refused on its format `version` (exit 64), naming the version this build recognizes.

#### A verified verdict needs both certificates anchored

`SIGNED RECEIPT VERIFIED` is reached only when something outside the record anchors **each** of its two certificates, and the pairing ran and passed. It names what anchored each, for example: `something outside the receipt anchors each certificate: the initiator's by your own signing identity, and the responder's by a fingerprint you pinned out-of-band`. Two sources anchor a certificate:

- **Your own signing identity**, from `--identity-file`, else `signing.identity_file` in `--config-file`; the command computes the fingerprint itself. With neither, your certificate is left unanchored and the verdict is `INCOMPLETE` (exit 66). Only the certificate half of the file is read and nothing is written, so a read-only mount works. A file named with `--identity-file` that matches neither certificate fails the run; one from the config is reported instead.
- **A pinned fingerprint.** Repeat `--partner-fingerprint` to pin both signers, as a verifier who was party to no exchange does; a third value is refused. Each value anchors at most one certificate, and your own fingerprint pinned beside your identity anchors only one.

An unanchored certificate is still checked against itself and the identities you supplied, which whoever assembled the record could satisfy with a certificate of their own. So anchoring one certificate says that party signed and nothing about the other: the command reports `INCOMPLETE` (exit 66), naming it (`Nothing you supplied confirms who holds the initiator's certificate`) and what would anchor it. With nothing anchoring either, it reports `nothing you supplied confirms whose certificates these are`, also `INCOMPLETE`. Ask your partner for their `alcove fingerprint` value over a trusted channel and pass it. Trust model: [Pinned self-signed trust model](SECURITY_DESIGN.md#pinned-self-signed-trust-model).

## From a quick exchange to signed receipts

A quick exchange run with `--save` leaves an `alcove.yaml` and a `.alcove.key` that [`alcove exchange`](#recurring-exchange) runs from. The saved configuration holds no `signing` block, so every run writes an unsigned [exchange record](spec/EXCHANGE_RECORD.md) and no receipt. These steps turn that partnership into one that produces certificate-backed receipts.

- **Both parties do it.** A partner still running unsigned presents no certificate, and the run stops at the setup step with nothing disclosed and exit 76. Agree on the change before either side makes it.
- **`alcove exchange` is what signs.** The receipt is bound to the session key the authenticated key exchange produces, which the quick exchange form does not have.

### Name this party

`certificate` mode signs under the name in the agreed terms. A quick exchange given `--identity` saved it into `linkage_terms.identity`; one that ran unnamed saved none. Set it, and tell your partner the value:

```yaml
linkage_terms:
  identity: "Agency A, a@agency-a.gov"
```

### Create the signing identity

The identity is a long-lived P-256 private key and its self-signed certificate, reused with every partner, so keep it where your other credentials live ([Where the signing identity lives](#where-the-signing-identity-lives)). [`alcove fingerprint`](#signing-identity-fingerprint) creates it at the path you name:

```sh
alcove fingerprint \
  --identity-file /run/signing/alcove-signing-identity.json \
  --identity "Agency A, a@agency-a.gov"
```

- **`--identity` is the label from the step above, exactly**; otherwise the exchange is refused before it runs ([Signing identity and the agreed terms](#signing-identity-and-the-agreed-terms)).
- **The fingerprint alone goes to stdout**, so `FP=$(alcove fingerprint --identity-file /run/signing/alcove-signing-identity.json)` captures it; the action, path, and bound identity go to stderr.
- **Its directory is writable for this run only**; mount it read-only afterward ([Mounting the signing identity](DEPLOYMENT.md#mounting-the-signing-identity)).
- **Run it once.** A second identity has a second fingerprint for every partner to re-pin.

### Reference the identity from the configuration

Add the block to the `alcove.yaml` the save wrote:

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/alcove-signing-identity.json
```

Certificate mode naming no `identity_file`, or a path that holds no identity file, is refused from the configuration alone (exit 64). Leave `signing.partner_fingerprint` out for the first contact to record it, or write in a value your partner read to you over a channel you trust ([What the setup step authenticates](#what-the-setup-step-authenticates)).

### Run the first signed exchange

```sh
alcove exchange input.csv ./
```

With no `signing.partner_fingerprint` on file, your side pins the certificate it is presented, records the fingerprint in the `alcove.yaml` the command was given, and states the value, the file, what the pin is authenticated by, and the comparison to make; the line also rides the [event stream](#machine-readable-event-stream) as `partnerCertificatePinned`. Nothing is asked interactively. Recording the pin needs the configuration's directory writable; on a read-only mount the run exits 64 before it connects ([Pinning the partner's certificate](#pinning-the-partners-certificate)).

#### What the setup step authenticates

The pin is authenticated only by the channel the shared secret travelled: after a `--save` bootstrap, the SFTP server or shared folder's access controls; after `alcove invite` and `alcove accept`, the out-of-band channel the invitation went over ([Pinned self-signed trust model](SECURITY_DESIGN.md#pinned-self-signed-trust-model)). Either action anchors it outside that channel:

- **Compare the printed fingerprint with your partner**, over a channel you trust, before you rely on the receipts. Their value is what `alcove fingerprint` prints on their side.
- **Pin it before the first run.** Ask for their value first and write it into `signing.partner_fingerprint`; the first exchange then holds the presented certificate to it. Take this where a third party is meant to rely on the receipt.

### Every run after it

A later exchange verifies the presented certificate against the pin and prints nothing on a match; it writes the exchange record, its verification keys, and the signed receipt. A different certificate ends the run before any linkage key or payload row is sent, leaving `signing.partner_fingerprint` unchanged. A partner who regenerated their identity is the usual cause; re-pin after confirming the new value with them out of band.

### Check a receipt

Keep the input file and the result file (`alcove-results-<time>.csv` with the record's stamp): verification re-supplies them.

```sh
alcove verify-receipt alcove-record-<time>.json input.csv alcove-results-<time>.csv \
  --signed-record alcove-receipt-<time>.json \
  --config-file alcove.yaml
```

- **`--config-file` anchors both certificates**: yours from its `signing.identity_file`, your partner's from its `signing.partner_fingerprint`.
- **Naming the record as `RECORD` and the receipt as `--signed-record`** pairs the receipt to this run.
- **The agreed-terms hash** uses your terms from `--config-file` and your partner's from the receipt. For a receipt holding none, pass `--partner-terms`; otherwise the hash is not checked and the verdict is `INCOMPLETE` (exit 66).

Every line of the verdict: [Verifying a receipt](#verifying-a-receipt).

## Recovery

### Key lifecycle

A key file passes through four stages:

1. **Creation** - `alcove invite` or `alcove accept` writes a fresh `.alcove.key`, owner-only, with a short-lived invitation token ([CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)).
2. **Rotation** - `alcove exchange` replaces the token at the terms exchange that follows each successful authentication handshake, before the data exchange. If the write fails, the error is immediate and states whether running the same command again can recover or both parties must re-invite ([Out-of-sync tokens](#out-of-sync-tokens)).
3. **Loss** - both parties re-invite. A backup may be restored instead if the partner confirms out of band that it reflects the exchange they last completed; if in doubt, re-invite.
4. **Compromise** - follow [Compromise response](SECURITY_DESIGN.md#compromise-response).

With [`authentication.token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) set, each rotated token is stamped with an expiry that many days out; without it, rotated tokens do not expire. Any token holding an `expires`, invitation tokens included, is checked at load: an expired one aborts the run, naming the time and directing both parties to re-invite. A stamped `expires` is honored even after the field is removed. The expiring-soon warning and its effect on a schedule: [Cadence and the token's expiry](#cadence-and-the-tokens-expiry).

### Out-of-sync tokens

The two parties save the rotated token one after the other. If the first to save fails to write it, its partner has not changed its token: that run exits 69 and states the key file it could not write, and the next run after that is fixed normally succeeds. A write that fails only when the directory is flushed after the rename has already put the new token in that key file, so the next run fails authentication; the error says to ask the partner for a new invitation if it does. If the second fails to write it, or a crash or power loss falls between the two saves, the two hold different tokens and the next key exchange fails. The run whose save failed, and every later run that fails authentication, exits 77, which a supervisor does not retry ([Exit codes](#exit-codes)). So does the first party's run when its partner reports that its save failed: the error says your partner could not save the new secret, that this side saved it, and to ask for a new invitation. Neither side can tell which token is newer, so both reset. Clock skew does not split the two: a token that expires during the run is refused before either party saves, and once the first has saved, the second saves whatever its own clock reads ([The rotation at the terms exchange](spec/PROTOCOL.md#the-rotation-at-the-terms-exchange)). The error for a failed key-exchange authentication says how to re-invite. The connection information is already shared, so recovery re-establishes only the shared secret, through the [offline invitation](#offline-invitation) pair:

1. **Both parties remove their key file** (`.alcove.key`, or the `--key-file` path). The offline `invite` and `accept` used below each refuse to overwrite an existing one with a usage error (exit 64), so the out-of-sync token has to go before either command will run.
2. **The inviting party runs `alcove invite`** -- the offline form, with no URL. Its pre-existing `alcove.yaml` supplies the linkage terms; the command writes a fresh key file and prints a new invitation to forward out-of-band.
3. **The partner runs `alcove accept INVITATION [INPUT_FILE]`**, which reuses their own `alcove.yaml` the same way and writes their key file.
4. **Both parties run `alcove exchange`** at their convenience, as for any [recurring exchange](#recurring-exchange).

Each side's configuration is reused, and only the key file is recreated. Neither command takes `--identity`: each runs under the label its configuration holds, and a flag is reported as having no effect.

The [online invitation](#online-invitation) is not a recovery route: it refuses the existing configuration that recovery keeps.

A party that holds its configuration can instead re-provision with [`alcove exchange --invitation`](#provisioning-the-key-file-from-an-invitation), which replaces its step 3 and its run in step 4.

#### A key exchange that stopped partway

Before its key exchange starts, `alcove exchange` records in the key file that a rotation is in flight; saving the rotated token, or a key exchange that fails authentication, removes the record. A run stopped between the two -- killed, out of power, or losing its connection -- leaves it, and the next run warns that an earlier key exchange began at the time it names and did not save its rotated token, so your partner may hold a token this key file does not. If the run after the warning fails authentication or never meets your partner, re-invite as above. An authentication failure with no stopped run is unexplained: confirm with your partner over a channel you trust before re-inviting. The warning stops once a key exchange completes.

### Token loss

If a key file is lost and no backup is available, reset as in [Out-of-sync tokens](#out-of-sync-tokens).

### Token compromise

Follow [Compromise response](SECURITY_DESIGN.md#compromise-response).

## Memory for a large exchange

Every exchange-running command (the quick exchange, `alcove exchange`, the online `alcove invite`, and an `alcove accept` that runs the exchange) logs one line before it contacts the server or your partner, stating the heap limits the matching and the input reading run under, the memory a matching round over your input needs, and the memory the run has. It is at `debug` when the run has enough and at `info` when it does not:

```text
memory: the PSI engine runs in a worker thread under a heap limit of 20.00 GB, and this process's main thread, which reads the input, under 20.10 GB; a round over this run's 1,000,000 records needs about 1.45 GB, and this process has 20.00 GB (host memory 25.42 GB, no container memory limit)
```

What the run has is the least of the matching's heap limit, the machine's memory, and the container's memory limit. The need includes a fixed 271 MB, so a container memory limit below about 272 MB refuses every run without `--allow-memory-shortfall`. How the need is computed: [FILE_SYNC.md](spec/FILE_SYNC.md#memory-a-psi-round-needs).

**When the need is over what the run has**, the run exits 64 before any network contact, naming both figures. To go ahead:

- **Give the run more memory.** In a container, raise `docker run --memory` or remove it ([Giving a run more memory](DEPLOYMENT.md#giving-a-run-more-memory)).
- **Split the input** and run one exchange per file.
- **Pass `--allow-memory-shortfall`.** A warning names the shortfall on `stderr` and, with `--event-stream`, as `memoryShortfall`; the run may end with exit 134. The flag also covers the input-size check below.

**An installed `alcove`** runs its main thread, which reads your input, under the heap limit `node` starts with -- at Node's default, about six million records of a four-column input. Set the container image's larger limit for a large input:

```sh
NODE_OPTIONS=--max-old-space-size=19075 alcove exchange input.csv ./results
```

- **An input too large for the main thread's heap is refused** before it is read (exit 64), stating the record count and size, the heap needed, the limit, and the `NODE_OPTIONS` line to set. The check counts the file's lines; input from stdin is not checked and runs out of heap (exit 134) instead.
- **A heap option you give is kept**, and the memory line states it.
- **The figure assumes four columns a record**; an input with more or longer columns can run out of heap below the count the check admits.

## Logging

Every command that produces diagnostic output - `init`, `invite`, `accept`, `exchange`, the quick exchange form, `fingerprint`, `probe-host-key`, `doctor`, and `verify-receipt` - accepts `--log-level` and `--log-file`.

**Streams.** A command's result goes to `stdout`; every diagnostic, `info` and `debug` included, and the interactive prompts go to `stderr`. So `alcove accept --identity IDENTITY URL INVITATION 2>/dev/null > matched.csv` writes only the matched-records CSV to `matched.csv`. The result on `stdout` is an exchange's CSV (when no `OUTPUT_FOLDER` is given), the invitation token `invite` prints, the fingerprint value `fingerprint` prints, and the verdict `verify-receipt` prints.

**`--log-level <level>`** is `silent`, `error`, `warn`, `info` (the default), `debug`, or `trace`, matched without regard to case; any other value exits 64, naming it. It governs every diagnostic once logging is set up, including the low-level warnings from data cleaning and file handling. Two lines are outside it and never reach a `--log-file`: a usage error in the command line itself, and the last-resort line for an uncaught error (exit 1).

- **The outcome line.** A completed exchange ends with one line, without a timestamp prefix, at every level but `silent`, stating how many records matched, the absolute paths of the result and the exchange record, and whether the shared secret rotated, for example `exchange complete: 1,204 records matched, result written to /data/matched/alcove-results-2026-10-03T14-02-11-512Z.csv; exchange record written to /data/alcove-record-2026-10-03T14-02-11-512Z.json; shared secret rotated and saved to /data/.alcove.key`. A run in which nothing matched warns before it and still exits 0. A run a signal stops writes no outcome line. With `--event-stream`, the `result` event has the same count and path ([CLI_EVENTS.md](spec/CLI_EVENTS.md#result)).
- **What it does not suppress.** The terms `accept` shows when it asks, the line recording the answer, and the SFTP host-key fingerprint shown with the [first-use trust](#sftp-host-key-trust) question reach the terminal at every level, since they go with a question. The unattended line recording [your partner's first payload columns](#your-partners-first-payload-columns) is written at every level too.
- **The SSH handshake trace.** `--log-level trace` adds the SSH stack's diagnostics for an `sftp` connection under the context name `ssh`: the server's identification string, the algorithms each side offered and the ones negotiated, and the packet flow, roughly what `ssh -vvv` reports. It continues at one line per SSH packet, so give such a run a `--log-file`. The server's text is escaped before it reaches a terminal or file ([Console and log hygiene](SECURITY_DESIGN.md#console-and-log-hygiene)).

**`--log-file <path>`** appends log output to `<path>` instead of the terminal. Error-level lines -- a failed run's error and its next step -- also go to `stderr`, so a scheduler that reports `stderr` reports the failure; no other level does. `--log-file /dev/stderr` writes each line once. Each line has an ISO-8601 timestamp, so successive runs stay distinguishable. The parent directory must exist; a missing one is a usage error (exit 64) before any exchange work.

- **File permissions.** A log file Alcove creates is owner-only (mode `0600`; on Windows, an access list granting only your account), since at `debug`/`trace` it can record partner identity, linkage keys, and data categories. An existing file's permissions are left as they are.
- **macOS extended ACLs.** On a regular file named by its own path, Alcove clears any extended ACL before the first line. A terminal or pipe is written without that step, as is a `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, or `/dev/fd/N` path that is the file `stderr` already goes to; any other such path to a regular file is refused ([the exceptions](spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip)). A file whose ACL cannot be cleared is refused (exit 64) before any exchange work. Inspect one with `ls -le <file>` and clear it with `chmod -N <file>`.
- **What is captured.** `--log-level` still applies, so `--log-level silent --log-file run.log` writes nothing. `alcove doctor`'s check lines are captured as their plain rendering. A multi-line diagnostic keeps its line breaks, with the timestamp on its first line. Results on `stdout` are not log output.
- **A file that stops taking lines.** When a write fails partway -- a full disk, a mount that went away -- the first failure is reported on `stderr` and the rest counted. Before the outcome, `stderr` gets a line stating how many lines the file is missing, and with `--event-stream` a `warning` event whose `source` is `logFileLoss` ([CLI_EVENTS.md](spec/CLI_EVENTS.md#warning-sources)). The exit code is the run's own.

Waiting budgets for unattended runs, `--peer-timeout` and `--inactivity-timeout`: [Runs that overlap, and runs that wait](#runs-that-overlap-and-runs-that-wait).

### Progress while a long run works

On a large dataset one matching operation can run for minutes with nothing sent or received. Two things report on it:

- **One line per completed operation**, on every run: an operation that takes at least a second logs a line when it finishes, stating the values it covered, how long it took, and the rate. It is an ordinary log line, so it follows `--log-file` and `--log-level`.
- **One line redrawn each second** while an operation runs, naming it, its value count, and its elapsed time. It is shown only when stderr is a terminal, no `--log-file` is given, `TERM` is not `dumb`, and the run is at the default `--log-level info` without `-v`. To turn it off -- for a screen reader, or a terminal that prints the cursor escapes -- give `--log-file` or set `TERM=dumb`.

Under `psi-c`, a line's figure is the values the round masks, not the matches. Neither line states a percentage: the PSI library reports nothing until the operation returns.

### Machine-readable event stream

`--event-stream` emits newline-delimited JSON on **file descriptor 3**, one event per line, for a supervising process that needs structured progress and outcome rather than log lines. It is available on every exchange-running command -- the quick exchange, `alcove exchange`, the online `alcove invite`/`accept`, and an [acceptance that runs the exchange itself](#accepting-and-running-a-webrtc-exchange) -- and is off by default. An `accept` that runs no exchange, on either form, writes nothing to fd 3 ([When an acceptance runs the exchange](#when-an-acceptance-runs-the-exchange)).

The events: a stage list up front; a stage event at each protocol step and a stage-end event with its duration; a `warning` event per non-fatal warning, with a machine-readable `source` ([values](spec/CLI_EVENTS.md#warning-sources)); a metrics event (records processed, transport retries, reconnections); and exactly one terminal event, the last line:

- **`result`** on success: whether a result file was written, the count on a count-only run, and the `deduplicate` values and resolved cardinality.
- **`error`** on failure, with a category (`exchange`, `output`, `security`, `config`) and `exitCode`. A `security` failure is an authentication failure (exit 77), a partner receipt or certificate that does not verify (exit 76), or a frame failing its integrity check on the authenticated channel (exit 69, retried like a transport failure). Which refusals come before the fd-3 check: [CLI_EVENTS.md](spec/CLI_EVENTS.md#file-descriptor). Every failure after the fd-3 check emits an `error` event, a refusal before the exchange starts included (a configuration that cannot be read, an unpinned SFTP host, a failed wake call). A signal exit and a crash outside every handler emit no terminal event, so a supervisor that reads none falls back to the exit status.

A run interrupted by a signal exits 130/143 with no terminal event, except a signal during the transport close after the outcome was reported. Nothing the close raises reaches the stream.

`stdout` and `stderr` are unchanged by the flag. Wire fd 3 to a pipe when you spawn Alcove (in Node, `stdio: ["inherit", "pipe", "pipe", "pipe"]`), or from a shell write it to a file with `3>events.ndjson`. With fd 3 not wired, the command exits 64 before any exchange work, naming that redirect. Framing, schema version, every field, and the category rules: [docs/spec/CLI_EVENTS.md](spec/CLI_EVENTS.md).

## Exit codes

Every `alcove` command exits with one of the following codes. The failure classes 64, 65, 66, 69, 70, 73, 76, and 77 follow the BSD `sysexits` convention. The last column names the one action each code calls for, so a supervisor such as cron needs nothing from `--event-stream` to choose.

| Code | Name | Meaning | What to do |
| ---- | ---- | ------- | ---------- |
| `0` | success | The command completed; for an exchange, any result was written. A warning on `stderr` may name housekeeping that did not finish, such as protocol files left in the exchange directory or a `--log-file` that stopped taking lines. | Nothing. Read any warning at your convenience. |
| `64` | `EX_USAGE` | Invalid caller input or configuration: a bad flag or positional, an unrecognized or repeated option, a missing, unreadable, or malformed config or key file, an unsupported channel, a shared folder path that names something other than a folder (`ENOTDIR`), an `OUTPUT_FOLDER` that names a file or cannot be created or written in, or fd 3 not wired for `--event-stream`. Also: a key file path the rotated key cannot be saved to; an offline `invite` or `accept` whose files cannot be written; an invitation expiry not in the future; linkage terms past the maximum invitation length; an installed SFTP library missing what the connection's deadlines depend on; a run short of memory ([Memory for a large exchange](#memory-for-a-large-exchange)); and a [server provisioning endpoint](EXCHANGE_REFERENCE.md#on-demand-server-provisioning) that refused its credential, redirected, or refused the request, or answered a create-mode `alcove invite` with a body that is too large, not JSON, or not a server address. Also a mid-run refusal whose remedy is a settings, directory, or terms change, including a partner terms change the run did not take on (see below). | Fix what the message names; do not retry unchanged. On a key file in a directory on a network mount, check the mount first: an `EIO` the up-front key-file check meets is reported as 64. |
| `65` | `EX_DATAERR` | `alcove verify-receipt` only: a definite verification failure -- a commitment, signature, certificate binding, identity, terms hash, or pairing check did not match ([Verifying a receipt](#verifying-a-receipt)). | Alert: the receipt did not verify. |
| `66` | `EX_NOINPUT` | A CSV file the command reads does not exist, or is a link whose target does not exist (`alcove init` exits 64 instead), such as a scheduled run's input that has not landed yet; or a shared folder that does not exist (`ENOENT`), refused at once. Nothing is sent. An input the command cannot check, such as one under a directory it cannot search, exits 69 instead. From `alcove verify-receipt`: the verdict is incomplete, because an input a check needs was not supplied or could not be read; a run that also found a definite failure exits 65. | From `alcove exchange`, retry once the input lands, then alert if it stays missing; from `alcove verify-receipt`, supply what the report names as not checked. |
| `69` | `EX_UNAVAILABLE` | A transport or availability failure: the exchange server, peer, or shared storage was unreachable, rejected an operation, or went silent, or the partner never arrived. Also a server provisioning endpoint that could not be reached, timed out, or answered `408`, `429`, or `5xx`. A condition that does not clear reports 69 on every attempt ([Exit 69 on a shared-folder path](#exit-69-on-a-shared-folder-path)). From `alcove doctor`: something the checks depend on was unavailable, so nothing was established. Also a key file this side could not write before either party saved the rotated secret ([Out-of-sync tokens](#out-of-sync-tokens)). | Retry up to a small fixed cap, then alert. |
| `70` | `EX_SOFTWARE` | An internal fault in Alcove: a check on its own state failed. Nothing in your configuration or data is at fault, and a retry reaches the same refusal while conducting another exchange. | Report it with the message; do not retry. |
| `73` | `EX_CANTCREAT` | The exchange completed and a local write did not: the result file, an audit artifact, the configuration and consent records an online `invite`/`accept` writes, or the configuration and key a quick exchange with `--save` writes. Also a completed exchange whose rotated relay key your relay's registrar did not register. The data was exchanged. | Do not re-run; fix the local write the message names. |
| `76` | `EX_PROTOCOL` | The partner or the agreed terms refused the run: incompatible terms, an incompatible Alcove version, a malformed or unconsented frame or payload, or a signing certificate that is absent, unreadable, or not the pinned one. Also a partner abort, whose cause the partner's own error states, and a completed exchange whose result table could not be built from the partner's payload. A refusal before the key exchange authenticated the partner -- an unreadable file-sync envelope version byte, or an out-of-bounds WebRTC frame during the key exchange -- may come from the storage or network in between; check them when the partner reports no failure. | Do not retry; contact the partner. |
| `77` | `EX_NOPERM` | Authentication failed: the key exchange rejected the shared secret or the peer, the rotated secret could not be saved after the partner saved it or the partner could not save the one this side saved, the SFTP server presented a host key other than the pinned one, or the WebRTC coordination server's TLS certificate did not verify on this host. Also a relay registrar refusing the relay-owner token `alcove enroll-relay` sent, or refusing to confirm the relay key an earlier run rotated to. | Do not retry. Re-invite for the shared secret ([Out-of-sync tokens](#out-of-sync-tokens)); verify the server out of band and re-pin for the host key ([SFTP host-key trust](#sftp-host-key-trust)); trust the certificate authority the error names for the coordination server; run `alcove enroll-relay --replace-relay-key` for the registrar ([Registering the relay key at your relay](#registering-the-relay-key-at-your-relay)). Treat an unexpected one as a possible security event. |
| `78` | `EX_CONFIG` | `alcove doctor` only: the checks ran and found something to change before an exchange will work ([Checking a network shared folder](#checking-a-network-shared-folder)). | Fix what the checks found, then run them again. |
| `130` | interrupted (SIGINT) | Interrupted by `SIGINT` (Ctrl-C), 128 + 2. Before the exchange installs its signal handlers, and in a command that runs no exchange, the signal ends the process itself: a shell reports 130, a supervisor reading the wait status sees the signal. During the PSI crypto, an interrupt first finishes the current step (at most one encryption chunk, or the current match response piece). A second signal exits at once and can end with another code, such as 134 ([details](spec/DEPENDENCY_PINS.md#the-vendored-openminedpsijs-addon)). | Nothing: someone or something sent the signal. |
| `143` | terminated (SIGTERM) | Terminated by `SIGTERM`, 128 + 15. Outside the exchange's handlers, as for 130. | Nothing: someone or something sent the signal. |
| `134` | aborted (SIGABRT) | Not set by Alcove: aborted by `SIGABRT`, as when Node.js runs out of memory. Nothing the run owed is known to be on disk. | Alert. |
| `137` | killed (SIGKILL) | Not set by Alcove: killed by `SIGKILL`, as when a memory limit or `docker kill` ends it. Nothing the run owed is known to be on disk. | Alert. |
| `1` | unexpected error | A last-resort code for an error that escaped every command handler. | Alert. |

A failure wrapped as a transport failure keeps its own class (64, 66, 70, 76, or 77); any other failure at the command boundary takes its own exit code or 69. 78 is set only by `alcove doctor`; 130 and 143 by the exchange's signal handlers; 134 and 137 by the platform.

### Exit 64 mid-run: a refusal the next attempt repeats

Most 64s are caught before anything is dialed. A run that has already started reaches 64 too, when the refusal is decided by what was supplied, so the next attempt ends at the same place. **Do not retry a mid-run 64 unchanged.** The conditions:

- **The connection settings.** An SFTP exchange that uses up the reconnections `max_reconnect_attempts` allows. A WebRTC coordination-server address that could move the socket off the configured server, a peer id the server reports as already registered (usually both parties running the same `role`), or a `key` the server rejects. A `retain_files` or `lockless_rendezvous` value the two parties disagree on.
- **The shared folder's state**, on `sftp` and `filedrop`. A stray or foreign file appearing during the exchange; more than one hello, lock, or message file where one is expected; a peer hello left from an earlier run; a malformed control or message file; or two peer ids where one is a prefix-extension of the other. The directory must be dedicated to a single exchange between exactly two parties.
- **A channel bound the peer or server crossed.** A frame above the maximum frame size, a directory listing past its entry-count or filename-length bound, or a server-driven operation that made no progress within its liveness bound. The message names the next step.
- **Your partner's terms changed and this run did not take them on.** Apply the proposal the error names with `alcove apply`, then run again; the terminal event's category is `config` ([When your partner's terms change](#when-your-partners-terms-change)).
- **The agreed terms name something this build cannot run**: a key element transform naming a standardization function this build does not recognize, or an algorithm other than `psi` or `psi-c`. Agree on terms this build can run, or move both parties to a version that includes them.
- **A row cannot be passed through the agreed terms**: a key element value above the per-value ceiling, or a row whose key strings cross the per-row bound with no declared fan-out producer. The message names the element, step, and row; bind the element to a shorter column, or shorten the field in your own standardization. Under single-pass, also a record contributing more candidates to one key than allowed, rows expanding past the width the terms account for, or datasets crossing the single-pass size ceiling.
- **A guard on Alcove's own use of the connection fired**, a fault in Alcove or its packaging: a session key of the wrong length, a value with no JSON representation handed to a send, a send or receive on a closed connection, or an installed WebRTC or SFTP dependency missing what the transport's close or deadlines depend on. A first dial that expires before that SFTP check runs fails with exit 69 instead, with a warning that the connection is left to the operating system. Report one with the message it printed.

### Exit 69 on a shared-folder path

A `file://` directory that exists but cannot be read or written exits 69: a refused permission on a network mount can still be settling, so the connect retries within [`max_reconnect_attempts`](EXCHANGE_REFERENCE.md#connectionoptions) and then reports the path and the reason. Nothing is sent and nothing local is written. A permission that stays wrong reports 69 on every attempt, so the supervisor's retry cap is what stops the loop.

Two conditions on the path are refused on the first attempt, naming the path with the OS error code:

- **Nothing at the path (`ENOENT`)** exits 66: a typo, or a share not mounted yet. Run again once the folder is in place, and alert if it stays missing.
- **The path names something other than a folder (`ENOTDIR`)** exits 64. Correct the path.

### Exit 73: the exchange completed, a local write did not

**Do not re-run a 73.** The data was exchanged; a repeat conducts a second exchange, re-sending this party's records, and does not perform the lost write. The conditions:

- **The result file could not be written.** Fix the destination (a full disk, an unwritable directory, a revoked mount) before the next run, which is a fresh exchange. A result streamed to stdout is lost past the hand-off (a truncated redirect on a full disk) without detection, and exits 0.
- **An audit artifact could not be written** -- the exchange record and its verification keys, or the signed receipt. Fix what blocked the write; the next exchange records normally.
- **An online `alcove invite` or `alcove accept` could not write its configuration.** The rotated key is on disk, so recreate the configuration rather than re-inviting.
- **A quick exchange with `--save` could not write the configuration or key file.** The result is written. Fix what blocked the write, or point `--config-file`/`--key-file` elsewhere, and set up the recurring exchange with `alcove invite`. The report names what became of each file; move or remove a configuration it left on disk, or `alcove invite` refuses to overwrite it.
- **An online `alcove accept` could not refresh a consent record, or an online `alcove invite` could not record the payload columns it observed.** The configuration stands, and the next run holds your partner to the older record, or to none.
- **Your relay's registrar did not register the rotated relay key.** The next run confirms the registration before it contacts your partner ([Registering the relay key at your relay](#registering-the-relay-key-at-your-relay)).
- **The result was not delivered**, so what the run saves after it -- a `--save` configuration and key file, or the payload columns an online `invite` records -- was skipped and is named beside the lost result. Your partner may have saved a recurring exchange this side did not: confirm with them before setting one up.

What failed is named on stderr and, with `--event-stream`, on fd 3: a lost result is the terminal `error` event with `category: "output"`, the persistence it skipped a `warning` before it, and every other condition a `warning` beside a terminal `result` ([Terminal-event guarantees](spec/CLI_EVENTS.md#terminal-event-guarantees)).

Cap automatic retries at a small fixed number of attempts -- three, say -- and then page an operator. Each attempt re-runs the exchange protocol against the same set from the start, and repeated exchanges against the same set are outside what the protocol's privacy guarantee is scoped to ([Threat model](SECURITY_DESIGN.md#threat-model)). 64, 70, 73, 76, and 77 are outside that budget: no attempt after the first ends differently ([The internal-fault code](spec/CLI_EVENTS.md#the-internal-fault-code)).

**Other usage errors (exit 64).** For `alcove exchange`, a missing, malformed, or unreadable configuration or key file, including a malformed stored token. An unsupported channel or URL scheme: a `ws://` URL where none is accepted (the quick exchange and acceptance paths) or holding more than the server's location, an `http://` or `https://` address to `alcove invite` naming more than the web app's own address, a `webrtc` connection with no `role` or an undialable coordination-server address, an unknown scheme, or a malformed `file://` authority. An invalid connection option, such as a negative, fractional, non-numeric, or above-ceiling `--max-reconnect-attempts`, a `--server-port` outside `0..65535`, a reserved `peer_id`, or a `retain_files`/`lockless_rendezvous` contradiction. Failures during the exchange itself exit 69 unless they fall in another class above.

A single-value option given more than once -- `alcove invite --accept-timeout 60s --accept-timeout 120s`, or a repeated `--log-level`, `--log-file`, `--server-port`, `--peer-timeout`, or `--linkage-strategy` -- exits 64 (`--<flag> may be given only once`). Count flags (`-v`/`--verbose`) and boolean flags with their `--no-` forms may repeat.

An unrecognized option -- `--server-user` for `--server-username`, say -- exits 64 before any connection or file write, naming the closest option, and is reported ahead of a missing positional. On `invite`, `accept`, `init`, and `apply`, which take a positional that may begin with `-`, only a `--`-prefixed unknown token is rejected.

Running `alcove` with no arguments prints the common tasks and exits 64. A first argument that is a single word, names no existing file, and is not a command (`alcove exchnage in.csv`) exits 64, naming the closest command, rather than being taken for a quick exchange URL.

## See also

- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - exchange specification format consumed by the CLI
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - authentication model underlying the invitation and recurring exchange flow
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels (WebRTC, SFTP, filedrop) and supporting services
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
