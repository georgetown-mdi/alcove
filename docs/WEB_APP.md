---
title: "Alcove Web App"
---

# Using the Alcove web app

The web app runs an exchange between two browsers. Your file is read and matched inside your browser and is never uploaded; your browser connects directly to your partner's. Open it at [https://psi.data-bridge.org](https://psi.data-bridge.org). There is nothing to install.

This guide covers one exchange: creating an invitation, accepting one you were sent, reading the results, and keeping and checking the exchange record. Intended readers are analysts and program staff at either party. To run the same exchange again on a schedule, see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md); to run exchanges from the command line or over an SFTP server, see [CLI.md](CLI.md).

## Before you start

- **A CSV file** with a header row and identifier columns, such as names, date of birth, or SSN. Files up to 200 MB are accepted.
- **A partner** with their own CSV and a browser. Agree with them beforehand what you will match on and which columns, if any, each of you will send.
- **A trusted way to send the invitation**, such as secure email. The invitation holds a one-time secret: anyone who has it can take your partner's place.
- **Time with the page open.** Both browsers must be open while the exchange runs.

## Practicing with sample data

On the start page, choose **Start with sample data**. Alcove downloads two synthetic CSVs, `alcove-sample-inviter.csv` and `alcove-sample-partner.csv`, and starts an invitation using the first. Open the invitation link in a second browser window or on a second computer, and use the second file there. The repository's [`test_data/`](../test_data/) folder holds two more synthetic files for the same purpose.

## Creating an invitation

On the start page, choose **Create an invitation**. Three steps follow.

1. **Your file.** Enter your name or your organization's name, which your partner sees on the invitation, and choose your CSV.
2. **Matching & sharing.** For each column, confirm its type and how it is used: **Used to match - not sent**, **Unique record identifier - not sent**, **Sent to your partner**, or **Ignored**. A column sent to your partner is sent only for rows that match; your partner never receives the values in rows that do not match.
3. **Review & create.** Choose how long the invitation can be accepted (one hour by default, up to one year) and who receives the matched results: you and your partner, only you, or only your partner. Leave **How will this exchange run?** at **Live, in this browser**. Check every term in the exchange proposal, then choose **Create the invitation**. The terms cannot be changed after this.

The next screen, **Your invitation is ready**, shows the invitation link and a message you can copy that explains it to your partner. Send them the link over your trusted channel.

**Keep this tab open.** Your browser waits for your partner to accept; closing the tab cancels the invitation, and reloading it starts over. If your partner has not connected within 10 minutes, the exchange stops. Choose **Try again** to wait again while the invitation is still valid, or **Start over with a fresh invitation** once it has expired. Agree a time with your partner so that both of you are at your computers.

## Accepting an invitation

You received a link from a partner. Open it in your browser, or paste the whole link or the code under **Accept an invitation you were sent** on the start page and choose **Review invitation**. Your partner's browser must be open on their invitation while you accept.

1. **Review the terms.** The page shows who sent the invitation, what you would disclose, what the exchange produces, what you receive, and how records are matched. The sender's name is what your partner typed; Alcove does not verify it. If the invitation names a legal agreement, check its reference, purpose, and expiration against the agreement you signed.
2. **Consent & your file.** Tick the box to consent to the terms, enter your name or your organization's name, and choose your CSV.
3. **Confirm your columns.** Check how each column is used. Only the columns you mark as shared are sent to your partner. Then choose **Start the exchange**.

**If the link does not open an invitation**, the page says what went wrong:

- **"This link looks incomplete or changed in transit."** Copy the whole link from your partner's message again and paste it on the start page, or ask your partner to send it again.
- **"This invitation could not be read."** Ask your partner for a new one.
- **The invitation has expired.** Ask your partner to create a new one.

A partner whose IT staff run the command line app accepts a web invitation with `alcove accept` instead; see [Accepting and running a WebRTC exchange](CLI.md#accepting-and-running-a-webrtc-exchange).

## The completion screen

When the exchange finishes, the screen shows **Exchange complete** and the number of matched records, and a **Downloads** section:

- **Download result** - `results.csv`, the matched records the terms let you receive. Its columns are described in [Output](spec/PROTOCOL.md#output). If the terms give you no result, there is nothing to download, and the screen says so.
- **Download record (safe to share)** - `alcove-record-<date>.json`, the exchange record.
- **Download verification keys (keep private)** - `alcove-record-<date>.keys.json`, the keys that go with the record.

**Download what you need before you leave the page.** The results are kept only in this page. Closing the tab, or choosing **Set up another exchange**, discards them, and the page does not ask first.

### The exchange record and its keys

The record is your own account of what this exchange disclosed: who the parties were, the agreement it ran under, the categories of data sent, your record count, and the number of matches. It is meant for a disclosure log, such as a HIPAA accounting of disclosures or a FERPA disclosure record. It holds no matched data. In place of the data, it holds fingerprints of what you sent, what you received, and which records matched. You can keep it or give it to an auditor.

The verification keys open those fingerprints. With the keys, your original input file, and your result file, anyone can confirm that the record describes exactly that exchange and that none of the files has changed since. Without the keys, no one can, and they cannot be recreated later. Keep the keys private, as you would the data itself: someone holding the keys and the record could test guesses at the matched values.

Keep the record, the keys, your input, and your result together, for as long as your records schedule requires. The record is not signed: it shows what your side recorded, not proof of what your partner did. The format is specified in [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

## Checking a record later

The Verify page, at [https://psi.data-bridge.org/verify](https://psi.data-bridge.org/verify) and titled **Verify a receipt**, checks a record in your browser without uploading anything.

1. Choose the record and its verification keys, and choose **Verify**. This checks the files' structure.
2. To check the record against the data, also supply your input CSV and your result CSV under **Re-supply your files to open the commitments**, and choose **Verify with these files**.

The page reports **Verified**, **Incomplete** (some checks could not run, for example without your files), or **Verification failed**. A failure means the record was changed or one of the files does not belong to this exchange; the page cannot tell which, so check that you chose the right files first. The section on a dual-signed record applies to exchanges run with the command line app or the console with signing set up; a web app exchange has no signed record.

## Running it again

To exchange with the same partner on a schedule, choose **Save as a recurring exchange** on the exchange screen before you leave it. The offer is not shown for a practice run with sample data. Scheduled runs happen only in the web app installed on your computer and left running; see [Installing the app](MANAGED_EXCHANGE.md#installing-the-app) and [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md).

## How large an exchange can be

Each figure below is a fixed limit or a measured run recorded in the specification, linked beside it. A size with no measured run is named as not measured rather than estimated. The times are for whole runs on the machines the sources name; yours will differ with the hardware, the network between the parties, and the number of linkage keys.

### In the browser

- **The input file is at most 200 MiB.** That held 3.18 million rows of a six-column identifier file and 6.22 million rows of a two-column one in the measured runs ([The memory ceiling, and the CSV intake cap](spec/PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)).
- **A set the browser receives holds at most 7,643,790 values**, about one per record for each linkage key. Your partner's run refuses to send a larger set, before sending it, and names the remedies: split the input, or run the exchange with the command line app ([The receive ceiling](spec/PROTOCOL.md#the-receive-ceiling)).
- **The largest browser match measured to completion is 1,048,576 records a side.** Its match step took 444.5 s, about 7.5 minutes, on a 10-CPU machine in headless Chromium ([What a browser tab can match](spec/PROTOCOL.md#what-a-browser-tab-can-match)). An exchange runs one such round for each linkage key, over the records an earlier key has not matched. A same-size browser round larger than that is not measured.

A command line party exchanging with a browser partner is held to the browser's limits above.

### Command line app over WebRTC

Two command line parties, measured to completion; the runs at 1 to 4 million records and the two-machine run used four linkage keys ([The main thread on an open channel](spec/WEBRTC_TRANSPORT.md#the-main-thread-on-an-open-channel), [The receive ceiling](spec/PROTOCOL.md#the-receive-ceiling), [A round between two hosts](spec/WEBRTC_TRANSPORT.md#a-round-between-two-hosts)):

| Records a side | Where the parties ran | Whole run | Peak memory a party |
| --- | --- | --- | --- |
| 1,000,000 | one machine | 229 s, about 4 minutes | not recorded |
| 2,000,000 | one machine | 379 s and 401 s in two runs, under 7 minutes | not recorded |
| 4,000,000 | one machine | 888 s, about 15 minutes | not recorded |
| 7,700,000 | one machine | 1,178,964 ms, about 20 minutes | 12.2 GB and 13.3 GB |
| 7,700,000 | two machines on one local network | 1,486,794 ms and 1,488,196 ms, about 25 minutes | 15.3 GB and 17.1 GB |

### Command line app over SFTP or a shared folder

- **A set holds at most 16,777,216 values**, the protocol's maximum ([Round set size limits](spec/FILE_SYNC.md#round-set-size-limits)).
- **Measured to completion at that maximum, 16,777,216 records a side**, one party on each of two machines on one local network, one reaching the folder directly and the other over SFTP: about 64 minutes (3,826,025 ms and 3,760,626 ms), with a peak memory of 29.9 GB and at least 22.5 GB a party ([Measured runs at 2^24](spec/FILE_SYNC.md#measured-runs-at-224)).
- **Preparing the input** at that size, from reading the file to the start of the first round, took within 27 s per million records on one 10-CPU machine ([Preparing the input at 2^24](spec/FILE_SYNC.md#preparing-the-input-at-224)).
- **Memory is checked before the run contacts anyone.** The matching needs about 271 MB plus 1.2 KB a record, and a run without that much stops with exit 64 naming both figures ([Memory for a large exchange](CLI.md#memory-for-a-large-exchange)). A whole run holds more than the matching alone, as the peak memory above shows.
- **Smaller sizes over SFTP or a shared folder are not measured** as whole runs. Each round waits on the partner's files, so the folder's polling interval and sync delay add to every round ([`poll_interval_ms`](EXCHANGE_REFERENCE.md#connectionoptions)).
