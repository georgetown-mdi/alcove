---
reader: An IT engineer whose organization creates the invitation
needs: "[Alcove installed](./cli-install.md), your input CSV, the terms you agreed on, and an SFTP directory, shared folder or WebRTC"
before: "[Agree on terms](./agree-on-terms.md)"
partner: "[Accept an invitation](./cli-accept.md)"
timing: "The invitation lasts 1 hour unless you set --expires-in, up to 365d. Each side waits 1 hour for the other, 10 minutes on WebRTC. A 20-record test run takes about 1 minute over a shared folder and about 14 minutes over SFTP."
next: "[Schedule it](./cli-schedule.md)"
---

# Invite a partner

Write the agreed terms into a configuration, create the invitation from it, and run the first exchange with your partner.

## Set up and invite

### 1. Make a folder for this partner

Make one folder for this exchange, put your input file in it as `input.csv`, and run every command below from that folder. It will hold the configuration (`alcove.yaml`), the key file (`.alcove.key`) and each run's results.

> [!WARNING]
> Keep this folder between runs, and run the exchange from one machine only. The key file changes after every run; if it is lost or a stale copy runs, both of you must start over with a new invitation.

### 2. Write the configuration

`alcove init` writes `alcove.yaml` from your file's columns and fills the connection block from the address you give it.

::: tabs channel

== SFTP

If you run the server, set it up first: [If you run the SFTP server](#if-you-run-the-sftp-server).

```sh
alcove init --identity "Northside Health Plan" sftp://alcove@sftp.example.org/exchanges/plan-coc input.csv
```

For a port other than 22, put it after the host: `sftp://alcove@sftp.example.org:2222/exchanges/plan-coc`.

Then put the account's password in a file named `passwd` in this folder, and add this line under `connection.server` in `alcove.yaml`:

```yaml
    password: "@passwd"
```

For an SSH key, write `private_key: "@id_ed25519"` instead, with the key file in this folder.

== Shared folder

```sh
alcove init --identity "Northside Health Plan" file:///mnt/share/exchanges/plan-coc input.csv
```

The path is read inside the container, so mount the shared folder at the same path: add `-v /mnt/share/exchanges/plan-coc:/mnt/share/exchanges/plan-coc` before the image name on every command. On Windows, mount it at a path such as `/share` (`-v "D:\shares\plan-coc:/share"`) and give `alcove init` the address `file:///share`.

== WebRTC

```sh
alcove init --identity "Northside Health Plan" input.csv
```

Then replace the whole `connection:` block at the top of `alcove.yaml` with this one, which names the coordination server of the hosted web app. `signal.data-bridge.org` is the coordination server of the web app at `psi.data-bridge.org`.

```yaml
connection:
  channel: webrtc
  server:
    host: signal.data-bridge.org
    path: /api/
  role: inviter
```

:::

You should see: `wrote a configuration template to ./alcove.yaml`.

### 3. Set the terms in alcove.yaml

Make each edit you agreed on. What each one means: [Agree on terms](./agree-on-terms.md).

**Columns you send** ([What each of you sends](./agree-on-terms.md#what-each-of-you-sends)). Columns `alcove init` did not recognize are listed, commented out, at the end of the `metadata` block. Remove the `#` marks from each one you agreed to send:

```yaml
  - name: Renewal.Date
    type: other
    role: payload
    is_payload: true
```

A column with `is_payload: false`, or not listed, is not sent.

**Your ID column.** Set your own ID column, whatever it is called: its entry reads `role: identifier`. Your result then starts each row with your own ID. With `is_payload: false` your partner never receives it; to send it for matched records, change that to `is_payload: true`. Alcove recognizes an ID column when it is named `id`, `identifier`, `MRN`, `ClientID`, `PersonID`, `PersonalID`, `PatientID`, `RecordID`, or `MemberID`, or its name ends in `_id` once spaces, dots, and dashes count as `_` (so `Client ID` counts), or in `number` or `no` as a word of its own (so `case_number` and `RecordNo` count, but not `phone_no`), and writes its entry with `is_payload: false`. A name Alcove does not recognize is listed commented out at the end of `metadata` with `is_payload: true`. Do not just remove the `#` marks from its listed entry: that entry sends it. Write its entry as below in place of the listed one, with your column's name. With no ID column, your result holds row numbers only, counting from 0.

```yaml
  - name: Client_Number
    type: identifier
    role: identifier
    is_payload: false
```

**Columns you ask your partner for.** Optional. Under `linkage_terms`, add the columns your partner agreed to send, and your partner sees them as a request when accepting; if `linkage_terms` already has a `payload:` line, add `receive:` under it. Without the request, the first exchange records whichever columns your partner sends, and later runs refuse a different list. For example:

```yaml
  payload:
    receive:
      - name: Case_Manager_Phone_Number
```

**Keys** ([What you match on](./agree-on-terms.md#what-you-match-on)). `linkage_terms.linkage_keys` holds the Broader matching keys your file supports. To leave out the three less certain keys, delete the entries named `LN + FN + DOB`, `swap(LN, FN) + DOB` and `split(LN) + FN + DOB`, each with every line under it. The comment above `linkage_keys` that begins "To run the highest-precision rules only" names the further keys to delete.

**Who receives the result** ([Who receives the result](./agree-on-terms.md#who-receives-the-result)). Set `linkage_terms.output`:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **`expects_output: true`, `share_with_partner: true`** | Both of you get a results file. | Usual: both of you act on the matches. |
| **`expects_output: true`, `share_with_partner: false`** | Only you get one. You send no columns. | Only you need the list. Your partner sees no list, and no count outside a debug log ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)). |
| **`expects_output: false`, `share_with_partner: true`** | Only your partner gets one. Your partner sends no columns, so leave out `payload.receive`. | Only your partner needs the list. |

**A list or only a count** ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)). For a count, set `algorithm: psi-c`, delete every key in `linkage_keys` but one, set every column to `is_payload: false`, and add no `payload.receive`.

### 4. Create the invitation

`alcove invite` takes its terms from `alcove.yaml` and prints the invitation. Run it without `-it`, so only the invitation goes into the file:

::: tabs platform

== Linux

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --expires-in 2d input.csv > invitation.txt
```

== Windows

```powershell
docker run --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest invite --expires-in 2d input.csv | Set-Content -Encoding ascii invitation.txt
```

Windows PowerShell's `>` writes the file as UTF-16, which `alcove accept` refuses with `invalid invitation: the invitation contains characters an invitation cannot hold`.

== macOS

```sh
docker run --rm -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --expires-in 2d input.csv > invitation.txt
```

== Podman

```sh
podman run --rm --userns=keep-id:uid=1000,gid=1000 -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --expires-in 2d input.csv > invitation.txt
```

:::

The invitation lasts 1 hour without `--expires-in`. Give it time for your partner to accept and for the first exchange: `2d` is 2 days, and `365d` is the longest.

You should see: `derived the invitation's linkage terms from ./alcove.yaml`, then the expiry in your local time. `.alcove.key` is now in the folder.

The terms are fixed once the invitation exists. To change them, delete `.alcove.key`, which also withdraws the invitation, edit `alcove.yaml`, and run `alcove invite` again.

### 5. Send your partner the invitation

Send:

- **`invitation.txt`**, as an attachment over encrypted email or your secure file transfer. It runs to about 9,000 to 10,300 characters, so it cannot be read aloud. It holds a one-time secret: anyone who has it can take your partner's place.
- **The page to follow:** [Accept an invitation](./cli-accept.md) for a partner on the command line. For the console or the web app, see [If your partner uses the console or the web app](#if-your-partner-uses-the-console-or-the-web-app).
- **On SFTP:** the server's host name and port, their account, the directory, and the server's fingerprint (below, [If you run the SFTP server](#if-you-run-the-sftp-server)).
- **When you both run** the first exchange, before the invitation expires.

### 6. Both of you: run the first exchange

Your partner accepts first and, on SFTP or a shared folder, fills in the connection in their `alcove.yaml` with what you sent in step 5 ([Fill in the connection](./cli-accept.md#4-fill-in-the-connection)). Then, at the agreed time:

::: tabs channel

== SFTP

```sh
alcove exchange input.csv ./
```

The first run shows the server's fingerprint and asks `Trust this host key for sftp.example.org? [y/N]`. Check it against the one from your server's administrator before answering `y`; Alcove saves it in `alcove.yaml`. To skip the question, add `host_key_fingerprint: SHA256:...` under `connection.server` first.

== Shared folder

```sh
alcove exchange input.csv ./
```

== WebRTC

```sh
alcove exchange input.csv ./
```

Your partner's `alcove exchange` runs it if they accepted with `--no-run`, as [Accept an invitation](./cli-accept.md) has them do, or if you requested a column their configuration does not send; otherwise their `alcove accept` runs the exchange as soon as they answer yes. Start yours at the agreed time, within 10 minutes of theirs.

:::

You should see: `exchange complete: 10 records matched, result written to` the results file, with your own count, and the command exits 0. If the terms give you no result, you see `exchange complete: no result file for you under the agreed terms; exchange record written to ...` instead, also with exit 0.

- **Your partner never arrives:** after 1 hour (10 minutes on WebRTC) the run exits 69 and says your partner did not arrive. The key file is unchanged; run again.
- **The server refuses your password or key:** after 3 retries the run exits 69 with `All configured authentication methods failed`. Fix the credential; running again unchanged does not help.
- **The run is interrupted:** it may print `Retry with the same key file; if authentication fails on retry, ask your partner for a new invitation.` Either way, run again with the same key file.
- **Any other failure** prints the error and the next step, and exits with a code from [Exit codes](./cli-schedule.md#exit-codes).

## Practice, then go live

Practice first with a test file: about 20 made-up records under the same column names as your real file. Your partner does the same with theirs. Run steps 1 to 6 with it.

For the real exchange, start again in a new folder, so the test's key file and results stay apart from the real ones.

### 1. Copy the configuration

Make a new folder. Copy `alcove.yaml` and any password or key file into it, and put your real `input.csv` beside them.

### 2. Invite again

From the new folder, run step 4 and send the new invitation as in step 5. On SFTP or a shared folder, check the directory is empty before the real run: a file from another exchange stops it.

### 3. Your partner: accept in a new folder

Your partner follows [Accept an invitation](./cli-accept.md) again, in a new folder with their real file.

## If your partner uses the console or the web app

The console and the web app run an invitation only if it names where the exchange happens. An invitation from step 4 names it only on the WebRTC channel.

| Channel | Your partner uses the web app | Your partner uses the console |
| --- | --- | --- |
| WebRTC | Steps 1 to 6, WebRTC tab | Steps 1 to 6, WebRTC tab |
| SFTP or a shared folder | Not possible: the web app runs WebRTC only | Your partner invites from the console ([Invite from the console](./console-invite.md)), and you accept with [Accept an invitation](./cli-accept.md). Or, on SFTP, if the default terms are what you agreed on, invite with the server's address on the command, below. |

Send the invitation text with [Accept with the web app](./web-accept.md) or [Accept in the console](./console-accept.md). In the web app, your partner pastes it under **Have an invitation? Paste it here**.

### 1. Invite a console partner with the server's address on the command

This one command prints the invitation, waits for your partner to accept, and runs the exchange. It takes its terms from your file's columns, not from `alcove.yaml`: Broader matching, both of you receive the result, a list of matched records, and each column's use as Alcove infers it from its name. No column is sent to your partner, your ID column included. Run it in a new folder holding only `input.csv` and `passwd`: it stops if `alcove.yaml` or `.alcove.key` is there.

::: tabs platform

== Linux

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --identity "Northside Health Plan" --expires-in 2h --accept-timeout 2h --server-password @passwd --server-host-key-fingerprint SHA256:... sftp://alcove@sftp.example.org/exchanges/plan-coc input.csv ./ > invitation.txt
```

== Windows

Not tested on Windows. Let your partner invite from the console instead.

== macOS

```sh
docker run --rm -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --identity "Northside Health Plan" --expires-in 2h --accept-timeout 2h --server-password @passwd --server-host-key-fingerprint SHA256:... sftp://alcove@sftp.example.org/exchanges/plan-coc input.csv ./ > invitation.txt
```

== Podman

```sh
podman run --rm --userns=keep-id:uid=1000,gid=1000 -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest invite --identity "Northside Health Plan" --expires-in 2h --accept-timeout 2h --server-password @passwd --server-host-key-fingerprint SHA256:... sftp://alcove@sftp.example.org/exchanges/plan-coc input.csv ./ > invitation.txt
```

:::

`--accept-timeout` is how long it waits for your partner to accept (15 minutes without it). Set `--expires-in` at least as long, or the invitation expires first. The fingerprint is the server's, from [Read the fingerprint](#3-read-the-fingerprint). Leave the command running and send `invitation.txt`: it already holds the whole invitation.

You should see: `exchange complete: 10 records matched, result written to` the results file, and the command exits 0. It saves `alcove.yaml`, with the password as `"@passwd"` and the fingerprint pinned, and `.alcove.key`, so later runs use `alcove exchange input.csv ./` from this folder.

## If you run the SFTP server

Set these up before you send the invitation.

### 1. Make the accounts

Make an account on the server for your partner, and one for you.

### 2. Make the directory

Make one directory both accounts can read and write, used by this exchange only. A file from another exchange in it stops the run.

### 3. Read the fingerprint

```sh
alcove probe-host-key sftp://sftp.example.org
```

It prints `sftp.example.org presented a ... host key with fingerprint SHA256:...`. Confirm it against the server itself, then send it to your partner and put it in your own `host_key_fingerprint`.

More detail: [How host-key pinning works](../CLI.md#sftp-host-key-trust), [Every connection setting by channel](../EXCHANGE_REFERENCE.md#connection-blocks-by-channel).

## What you get

| File | What it holds | Share or keep |
| --- | --- | --- |
| `invitation.txt` | The invitation, with its one-time secret. | Send to your partner only |
| `alcove.yaml` | The terms and connection. | Keep; not secret if credentials are `@` file references |
| `.alcove.key` | The shared secret. It changes after every run. | Keep private |
| `alcove-results-<time>.csv` | Your matched records: your ID, `row_id` (your partner's row number, counting from 0), then the columns your partner sends. | Keep private |
| `alcove-record-<time>.json` | The exchange record of this run. | Keep; not secret |
| `alcove-record-<time>.keys.json` | The values that open the record's checks. | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' agreed terms. | Keep; not secret |

A count-only run writes no results CSV. All files: [Install and run](./cli-install.md#what-you-get).
