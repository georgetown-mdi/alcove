---
reader: An IT engineer or IT contact whose organization was sent an invitation
needs: "[Alcove installed](./cli-install.md), the invitation file from your partner, and your input CSV"
partner: "[Invite a partner](./cli-invite.md)"
timing: "Accept and run the first exchange before the invitation expires: 1 hour after it was made, unless your partner set longer. Each side waits 1 hour for the other, 10 minutes on WebRTC. A 20-record test run takes about 1 minute over a shared folder and about 14 minutes over SFTP."
next: "[Schedule it](./cli-schedule.md)"
---

# Accept an invitation

Read your partner's terms, accept them, connect, and run the first exchange together.

## Before you start

Ask your partner for:

- **The invitation, as a file** (`invitation.txt`). `alcove accept` takes one made by `alcove invite`, by the console, or a web app link of the form `https://.../accept#...`.
- **When you both run** the first exchange.
- **On SFTP:** the server's host name and port, your account on it, the exchange directory, and the server's fingerprint, which starts `SHA256:`.

Have ready:

- Alcove installed: [Install and run](./cli-install.md). On a work laptop, installing Docker Desktop needs administrator rights, and Docker's terms may require a paid subscription for your organization: check with your IT department before the agreed date.
- Your input file.

## Accept and run

### 1. Make a folder for this partner

Make one folder for this exchange, and put your input file (`input.csv`) and `invitation.txt` in it. Run every command below from that folder.

> [!WARNING]
> Keep this folder between runs, and run the exchange from one machine only. The key file `.alcove.key` changes after every run; if it is lost or a stale copy runs, both of you must start over with a new invitation.

### 2. Read the terms and accept

Run this with `-it`, since it asks you a question:

```sh
alcove accept --identity "Riverside County CoC" @invitation.txt input.csv
```

With the image, on Windows: `docker run -it --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest accept --identity "Riverside County CoC" '@invitation.txt' input.csv`. The quotes around `@invitation.txt` stop PowerShell reading `@` as its own syntax.

`--identity` is the name your partner sees for you. Alcove prints the terms, about 340 to 380 lines with the built-in keys, then asks:

```text
Accept this invitation and write configuration? [y/N]
```

Just above the question it repeats three lines: `columns you will send`, `inviting party` and `PSI algorithm`. Scroll up for the rest before you answer:

| Line | What to check |
| --- | --- |
| `columns you will send` | What you send for matched records. `(none) -- only matched records` sends nothing beyond the match. |
| `you will receive the result` | `yes` or `no`, as agreed. |
| `the inviting party will receive the result` | `yes` or `no`, as agreed. |
| `PSI algorithm` | `psi` for a list of matched records; `psi-c` for only a count. |
| `columns you will receive` | The columns your partner says it sends you. |
| `columns the inviting party requests from you` | Columns your partner asks for. You send them only once you declare them in step 3. |
| `linkage keys` | Each key. A key marked `(less certain)` matches on a name and date of birth alone. |
| `expires` | The time, in UTC, by which you must accept and run the first exchange. |

The `inviting party` name is your partner's own word; Alcove has not verified it.

| Option | What it does | Pick it when |
| --- | --- | --- |
| **y** | Writes `alcove.yaml` and `.alcove.key`. | The terms match what you agreed on. |
| **N** | Prints `invitation declined; no files were written`. | Anything differs. Ask your partner for a new invitation: the terms cannot be changed here. |

You should see: `wrote config to ./alcove.yaml` and `wrote key file to ./.alcove.key`.

> [!NOTE]
> On a WebRTC invitation from [Invite a partner](./cli-invite.md), add `--no-run`:
>
> ```sh
> alcove accept --no-run --identity "Riverside County CoC" @invitation.txt input.csv
> ```
>
> Accepting then writes `alcove.yaml` and `.alcove.key` and stops, as on SFTP, so you can set your columns in step 3. An invitation that requests a column `alcove.yaml` does not send stops the same way without the flag, and names it. Otherwise, without `--no-run`, the terms open with `This acceptance runs the exchange itself`, the question reads `Accept this invitation and run the exchange now, through <server>?`, and answering `y` runs the exchange at once, with no chance to change the columns you send. Accept that way only at the agreed time, while your partner runs.

### 3. Set your ID column, and the columns your partner asked for

**Your ID column.** Set your own ID column, whatever it is called: its entry reads `role: identifier`. Your result then starts each row with your own ID. With `is_payload: false` your partner never receives it; to send it for matched records, change that to `is_payload: true`. Alcove recognizes an ID column when it is named `id`, `identifier`, `ClientID`, `PersonID`, or `PersonalID`, or its name ends in `_id` once spaces, dots, and dashes count as `_` (so `Client ID` counts), and writes its entry with `is_payload: false`. Accepting writes no entry for a column Alcove does not recognize: add your ID column's entry at the end of the `metadata` block, as below, with your column's name. With no ID column, your result holds row numbers only, counting from 0.

```yaml
  - name: Client_Number
    type: identifier
    role: identifier
    is_payload: false
```

**Columns your partner asked for.** Accepting wrote an entry in the `metadata` block for each column under `columns the inviting party requests from you`, and printed the names of those it does not send. An entry with `is_payload: false` is not sent. For each one you agreed to send, change it to `is_payload: true`:

```yaml
  - name: Case_Manager_Phone_Number
    type: other
    role: payload
    is_payload: true
```

If your file has no column of that name, accepting stops instead and names it: add the column to your file, or ask your partner for a new invitation. A column not listed in `metadata`, or listed with `is_payload: false`, is not sent.

A column you do not use, such as `Program`, prints a warning at every run. To stop the warning, give it an entry with `type: other`, `role: ignored` and `is_payload: false`.

### 4. Fill in the connection

Replace the `connection:` block at the top of `alcove.yaml`, which holds `REPLACE_WITH_...` placeholders, with your own:

::: tabs channel

== SFTP

Put your account's password in a file named `passwd` in this folder. In Notepad, choose **All files** when saving, or it names the file `passwd.txt`. Then write:

```yaml
connection:
  channel: sftp
  server:
    host: sftp.example.org
    port: 22
    path: /exchanges/plan-coc
    username: riverside
    password: "@passwd"
    host_key_fingerprint: SHA256:...
```

Use the directory and fingerprint your partner sent. For an SSH key, write `private_key: "@id_ed25519"` in place of `password`.

== Shared folder

```yaml
connection:
  channel: filedrop
  path: /mnt/share/exchanges/plan-coc
```

The path is read inside the container, so mount the shared folder at the same path: add `-v /mnt/share/exchanges/plan-coc:/mnt/share/exchanges/plan-coc` before the image name on every command. On Windows, mount it at a path such as `/share` (`-v "D:\shares\plan-coc:/share"`) and write `path: /share`.

== WebRTC

Nothing to fill in: accepting wrote the connection.

:::

### 5. Both of you: run the first exchange

On WebRTC, if accepting in step 2 ran the exchange, the first exchange is done: skip this step.

At the agreed time, while your partner runs the same command:

```sh
alcove exchange input.csv ./
```

On SFTP with no `host_key_fingerprint` in `alcove.yaml`, the run shows the server's fingerprint and asks `Trust this host key for sftp.example.org? [y/N]`. Answer `y` only if it matches the one your partner sent; Alcove then saves it.

You should see: `exchange complete: 10 records matched, result written to` the results file, with your own count, and the command exits 0. If the terms give you no result, you see `exchange complete: no result file for you under the agreed terms; exchange record written to ...` instead, also with exit 0.

- **Your partner never arrives:** after 1 hour (10 minutes on WebRTC) the run exits 69 and says your partner did not arrive. The key file is unchanged; run again.
- **The server refuses your password or key:** after 3 retries the run exits 69 with `All configured authentication methods failed`. Fix the credential; running again unchanged does not help.
- **The run is interrupted:** it may print `Retry with the same key file; if authentication fails on retry, ask your partner for a new invitation.` Either way, run again with the same key file.
- **Any other failure** prints the error and the next step, and exits with a code from [Exit codes](./cli-schedule.md#exit-codes).

More detail: [Everything the terms display can show](../CLI.md#what-the-display-shows-in-order), [Every connection setting by channel](../EXCHANGE_REFERENCE.md#connection-blocks-by-channel).

## What you get

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove.yaml` | The terms you accepted, and your connection. | Keep; not secret if credentials are `@` file references |
| `.alcove.key` | The shared secret. It changes after every run. | Keep private |
| `alcove-results-<time>.csv` | Your matched records: your ID, `row_id` (your partner's row number, counting from 0), then the columns your partner sends. | Keep private |
| `alcove-record-<time>.json` | The exchange record of this run. | Keep; not secret |
| `alcove-record-<time>.keys.json` | The values that open the record's checks. | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' agreed terms. | Keep; not secret |

If the terms give you no result, or only a count, no results CSV is written, and your record holds no match count unless both of you receive the result. All files: [Install and run](./cli-install.md#what-you-get).
