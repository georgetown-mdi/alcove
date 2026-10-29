---
reader: An IT engineer who wants a one-off test, or whose partner uses the web app in a browser
needs: "[Alcove installed](./cli-install.md) and your input CSV"
timing: "A quick exchange of 20 records took about 1 minute over a shared folder. A browser invitation waits 15 minutes for your partner to accept; a 20-record WebRTC run took 3 to 5 seconds."
---

# Other ways to exchange

Run one exchange with no setup, or invite a partner who uses the web app.

## Try one exchange with no setup

A quick exchange needs no invitation and keeps no configuration. Both of you point the same command at the same SFTP directory or shared folder.

> [!WARNING]
> For each matched record, a quick exchange sends your partner every column whose name Alcove does not recognize as a linkage key or an ID column. It lists those columns before it connects: check them. With no shared secret, the exchange files are not encrypted on the server: anyone who administers the server or folder can read the columns sent for matched records, and could stand in for your partner.

### 1. Both of you: run the same command

::: tabs channel

== SFTP

With the account's password in a file named `passwd` in your folder:

```sh
alcove sftp://user@sftp.example.org/exchanges/drop --server-password=@passwd input.csv ./results
```

== Shared folder

```sh
alcove file:///mnt/share/drop input.csv ./results
```

Mount the shared folder into the container at the same path, as on [Invite a partner](./cli-invite.md).

== WebRTC

A quick exchange runs over SFTP or a shared folder only. For WebRTC, see [A partner in the browser](#a-partner-in-the-browser).

:::

The run lists what goes to your partner under `columns you will send`, before it connects.

You should see: `exchange complete: 10 records matched, result written to` a file in `./results`, with your own count.

To choose the columns sent, set up an exchange with [Invite a partner](./cli-invite.md) instead.

## A partner in the browser

This invites a partner who uses the web app at `https://psi.data-bridge.org/`. Alcove takes the terms from your file's columns and sends your partner no column, your ID column included. To set the terms first, use [Invite a partner](./cli-invite.md) with its WebRTC tab instead: your partner pastes that invitation under **Have an invitation? Paste it here** in the web app.

### 1. Create the invitation and wait

From a new folder holding only your input file, run this without `-it`, so the link goes to a file:

```sh
alcove invite --identity "Northside Health Plan" https://psi.data-bridge.org/ input.csv ./ > link.txt
```

`link.txt` holds an accept link of about 10,300 characters, `https://psi.data-bridge.org/accept#...`. The command then waits 15 minutes for your partner; leave it running.

### 2. Send your partner the link

Send `link.txt` over encrypted email or your secure file transfer, with the page [Accept with the web app](./web-accept.md). Anyone who has the link can take your partner's place.

### 3. Your partner: open the link and accept

The exchange runs as soon as your partner accepts.

You should see: `exchange complete: 10 records matched, result written to` a file in this folder, with your own count. `alcove.yaml` and `.alcove.key` are saved beside it.

If your partner does not accept within 15 minutes, the invitation lapses. Run the command again for a new link.

Later runs use `alcove exchange input.csv ./` from the same folder, at a time you both agree on.

> [!NOTE]
> With no `stun` set in `alcove.yaml`, a WebRTC run asks `stun.l.google.com` for this machine's public address, which discloses that address and the fact of a session to that server, not the exchange's content.

## What you get

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<time>.csv` | Your matched records: your ID, `row_id` (your partner's row number, counting from 0), then the columns your partner sent. With no ID column, `row_id` is your own row number and `their_row_id` your partner's. In `./results` for a quick exchange. | Keep private |
| `alcove-record-<time>.json` | The exchange record of this run. | Keep; not secret |
| `alcove-record-<time>.keys.json` | The values that open the record's checks. | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' terms. | Keep; not secret |
| `link.txt` | The browser invitation's accept link, with its one-time secret. | Send to your partner only |
| `alcove.yaml` | After a browser invitation: the terms and the coordination server. A quick exchange writes none. | Keep; not secret |
| `.alcove.key` | After a browser invitation: the shared secret, which changes after every run. A quick exchange writes none. | Keep private |

More detail: [How a WebRTC invitation names its server](../CLI.md#inviting-over-webrtc), [What STUN discloses, and how to use your own](../CLI.md#stun-and-what-it-discloses).
