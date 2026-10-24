---
title: "Alcove Web App"
---

# Using the Alcove web app

The web app runs an exchange between two browsers. Your file is read and matched inside your browser and never uploaded to our servers. What is sent to your partner is encrypted first. A coordination server helps the two sides find each other. It never sees your data. Open it at [https://psi.data-bridge.org](https://psi.data-bridge.org). There is nothing to install. While you set up or run an exchange, **Help** in the top bar opens this guide in a new tab.

This guide covers one exchange: creating an invitation, accepting one you were sent, reading the results, and keeping and checking the exchange record. Intended readers are analysts and program staff at either party. To run the same exchange again on a schedule, see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md); to run exchanges from the command line or over an SFTP server, see [CLI.md](CLI.md).

## Before you start

- **A CSV file** with a header row and identifier columns, such as names, date of birth, or SSN. Files up to 200 MB are accepted.
- **A partner** with their own CSV and a browser. Agree with them beforehand what you will match on and which columns, if any, each of you will send.
- **A trusted way to send the invitation**, such as secure email. The invitation holds a one-time secret: anyone who has it can take your partner's place.
- **Time with the page open.** Both browsers must be open while the exchange runs.

## Practicing with sample data

On the start page, choose **See how it works with example data**. Alcove starts an invitation with synthetic sample data already loaded. To run the other side, open the invitation link in another tab or window of this browser and use the sample partner file it offers, or open it in a different browser or on a second computer and use the partner's synthetic CSV, `alcove-sample-partner.csv`, which the invite screen offers to download.

The sample files contain synthetic records from two agencies: 100 people in the inviter's file and 200 in the partner's, 50 of them in both. The two rows of a person in both files can differ as two agencies' records often do, by a nickname, a typo, a changed surname, a different ZIP code, or an SSN one file lacks or masks, so some of those 50 match and some do not. Each full SSN in the files is a randomly generated number that the default cleaning keeps, so the matching keys built on the whole SSN can match; a masked SSN can match only on its last four digits.

When you open the invitation in another tab or window of the same browser, the **Consent & your file** step offers **Use the sample partner file** while no file is chosen. It selects the partner sample CSV for you, and from there the steps are the same as with a file you choose. Dropping or choosing another file replaces it, and **Clear**, beside **Sample data (synthetic records)** under **This exchange**, returns the step to no file chosen. The choice appears only in the browser that created the sample invitation: in a different browser or browser profile, or on a second computer, choose the partner CSV you downloaded from the invite screen instead. For this, the browser keeps a note of each invitation it creates from sample data, and drops it after the invitation expires. The note holds neither the invitation nor its secret.

The invite screen offers the same files before you choose one: its **download the inviter sample CSV** and **download the partner sample CSV** links each download one sample file, and **load it into this exchange** loads the inviter sample in place. While the sample is loaded, the **This exchange** panel says that another tab of this browser is offered the sample partner file, names the partner CSV a different browser needs, and offers it for download. The repository's [`test_data/`](../test_data/) folder holds two more synthetic files for the same purpose.

## Creating an invitation

On the start page, choose **Create an invitation**. Three steps follow.

1. **Your file.** Enter your name or your organization's name, which your partner sees on the invitation, and choose your CSV.
2. **Matching & sharing.** For each column, confirm its type and how it is used. A column sent to your partner is sent only for rows that match; your partner never receives the values in rows that do not match.
   - **Used to match - not sent**, or **used to match - sent to your partner.** Either way the column is used to match. A column set to **sent to your partner** instead is sent but is not used to match.
   - **Unique record identifier - not sent**, or **unique record identifier - sent to your partner.** Either way your result file begins with this column, so you can find each matched record in your own data. A column named `id` or `identifier` starts as sent; choose **not sent** to keep it from your partner. Choosing a count-only exchange, or loading or pasting count-only terms, which send no column, sets it to not sent. A record identifier column set to **sent to your partner** instead is sent but is not your identifier, and your result file then begins with each match's row position in your file.
   - **Sent to your partner.**
   - **Ignored.**

   Below the columns, two choices shape only your own result file: which of your own columns it holds beside your partner's values ([`include_own_columns`](EXCHANGE_REFERENCE.md#include_own_columns)), and whether it ends with a column naming the linkage key each match was made on ([`include_matching_key`](EXCHANGE_REFERENCE.md#include_matching_key)). Neither changes what your partner is sent or agrees to. The second is shown unavailable, with the reason, on terms that cannot name the key. A saved recurring exchange offers the same choice among its settings, and a terms update from your partner that leaves you no key to name - count-only, single-pass, or no result for you - turns it off when you accept the update, and says so.
3. **Review & create.** Choose how long the invitation can be accepted (one hour by default, up to one year) and who receives the matched results: you and your partner, only you, or only your partner. Leave **How will this exchange run?** at **live, in this browser**. Under it, where the exchange would use a relay server, **Allowed relays** is one line allowing every relay the run lists; **Set Allowed relays** limits them to the hosts you list, and the invitation names only those relays ([Allowed relays](#allowed-relays)). Check every term in the exchange proposal, then choose **Create the invitation**. The terms cannot be changed after this.

The next screen, **Your invitation is ready**, shows the invitation as a link, and a message you can copy that explains it to your partner. Send them the link over your trusted channel.

If the page you created it on runs on your own computer or inside your network, the screen warns that the link works only there. It recognizes loopback and private-range addresses and the common internal name endings, such as `.local`, `.lan`, and `.corp`. A name only your network resolves under some other ending gets no warning, so before you send the link, check that your partner can open that address.

**Keep this tab open.** Your browser waits for your partner to accept, and the screen says until what time: about 10 minutes, or until the invitation expires if that is sooner. Closing the tab cancels the invitation. Agree a time with your partner so that both of you are at your computers.

- **If your partner has not connected by then**, the screen says so. Choose **Keep waiting** to wait again while the invitation is still valid, or **Start over with a fresh invitation** once it has expired.
- **If you reload the page**, the first step offers the invitation back while it is still valid: choose the same file again to keep waiting, or discard the invitation. The file must have the same columns, in the same order, and the same number of rows as the one you created the invitation from. Alcove keeps the invitation in this tab's session storage for this, with your file's column names and row count but never its rows, and removes it when the exchange completes, when you discard it or start over, and when the invitation expires: at expiry while this page is open, and otherwise the next time Alcove loads in this tab or you come back to this page. An expired invitation is never offered.

### Choosing the matching keys

The invitation starts with the built-in rules your file supplies under broader matching. To choose others, open **Customize > Matching keys** before you create the invitation. The console's invitation editor offers the same choices.

- **Built-in rules.** **Highest precision** selects only the highest-precision rules. **Broader matching** selects those rules first, then rules that find more people, with a few more wrong matches. The info button beside the choice says what each one matches on, with a link to how the rules were chosen.
- **When highest precision is not available.** While your file's columns supply none of its rules, highest precision is dimmed and cannot be selected, and it shows this reason: "Needs stronger identifiers in your file, such as an SSN, ZIP code, or phone number." If it was already selected, it stays selected and the key list is empty. The invitation cannot be created until you select broader matching, or set a column's type or use on **Matching & sharing** so that the file supplies one of its rules. Then the list fills again.
- **Rules marked less certain.** A key built only from first name, last name, and date of birth fields is marked **(less certain)** in the list, with an info button beside it that says why: different people share these more often the more people the two files cover. Under broader matching the three built-in rules of that kind are listed and turned on. Turn them off when your files cover many people. A file of one age group, such as one school class, counts as covering many people, because its members share birth years.

Changing the choice lists the rules it selects that your file supplies, in the built-in order. A key you turned off stays off while the choice keeps it, and a key the choice adds is turned on; you can then turn keys off or reorder them. The choice is not sent to your partner: the terms hold the keys, and **Review & create** names the choice they were selected with. The bands, the rules, and the mark are described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#choosing-rules-by-precision-floor).

Keys you write in **expert authoring**, or load from a document, were selected by no choice of built-in rules, so the control is not shown for them; a key among them built only from first name, last name, and date of birth fields is still marked. **Use the built-in rules** in their place replaces the keys, fields, and cleaning, after you confirm, with the ones a new invitation starts with for your file, and makes the terms cite the built-in rules; it is not offered where the built-in rules cover no column of your file. To write every key yourself, **Remove all keys** in expert authoring empties the key list in one step. Where the list holds a key that **Use the built-in rules** would not put back, such as one you added, changed, or loaded from a document, it asks you to confirm first, because that key is lost.

Terms drawn from the built-in rules cite them. Moving a key out of the built-in order, or adding or changing a key in expert authoring, leaves the terms without that citation, and both steps say so; turning some keys off does not.

**Match only where a field is missing.** In expert authoring, each key has a **Match only where a field is missing** choice that lists your date of birth fields. Choosing one makes the key match only pairs where one side's record has no valid date of birth, so a key on first name, last name, and the last four SSN digits can match records whose date is missing or a 01/01 filler without matching two people whose dates differ. Clear the choice to match every record. Put the keys that match on the date before it, since they claim the pairs whose dates agree. A key loaded from a document keeps the choice it states. The built-in rules on a name and a phone or email with no date of birth are keys of this kind, and they run on a file with no date of birth column too, every record counting as having none. The invitation cannot be created while the key also matches on that date of birth, or while the exchange is count-only. The review, and your partner's consent screen, state under the key that a match through it tells whoever receives the result which of the two records had no valid date of birth, and that each party's partner learns how many of that party's records not yet matched have none. The setting is described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#keys-that-run-only-where-a-field-is-missing).

## Accepting an invitation

You received a link from a partner. Open it in your browser, or paste the whole link or the code under **Have an invitation? Paste it here** on the start page and choose **Review invitation**. The production and staging sites refuse a pasted link made on the demo site, saying to open the link itself; the code alone is taken. Your partner's browser must be open on their invitation while you accept.

1. **Review the terms.** The page shows who sent the invitation, what you would disclose, what the exchange produces, what you receive, and how records are matched. The sender's name is what your partner typed; Alcove does not verify it. If the invitation names a legal agreement, check its reference, purpose, and expiration against the agreement you signed. A matching key marked **(less certain)** is built only from first name, last name, and date of birth fields. A line under the fields matched on says that some keys are marked, and its info button, like the one beside each marked key under **Matching strategies**, says why and that to leave such keys out you ask your partner for an invitation without them. A key that matches only where one side has no valid date of birth says so under its fields, that a match through it tells whoever receives the result which record had none, and that your partner learns how many of your records not yet matched have none. The same statement is under the fields matched on, once for all the keys it applies to and after their names, one name to a row, so it shows with **Matching strategies** closed. Where no other key matches on the date of birth, the fields matched on list it as `date of birth (only whether it is present)`. Below the terms, where the exchange would use a relay server, **Allowed relays** is one line allowing every relay the run lists; **Set Allowed relays** limits them to the hosts you list, and the terms then mark each relay the invitation names as kept or left out ([Allowed relays](#allowed-relays)).
2. **Consent & your file.** Tick the box to consent to the terms, enter your name or your organization's name, and choose your CSV. For an invitation this browser created from sample data, the step also offers **Use the sample partner file** while no file is chosen; see [Practicing with sample data](#practicing-with-sample-data).
3. **Confirm your columns.** Check how each column is used. Only the columns set to a use ending "sent to your partner" are sent to your partner. Then choose **Start the exchange**.

**Keep this tab open** while the exchange runs: closing or reloading it stops the exchange for both of you. If your partner's page does not answer within about 10 minutes, the screen says so. Ask your partner to open their invitation page again and choose **Keep waiting**, or ask them for a new invitation.

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

Under the downloads, a note says the record is a shareable account of what you and your partner agreed to and what matched, and that the keys are private and belong with the record. Its **Verify page** link opens the Verify page in a new tab, leaving this page and its downloads in place.

**Download what you need before you leave the page.** The results are kept only in this page. Closing the tab, or choosing **Set up another exchange**, discards them. Until you have downloaded each file, the page asks first and names the files you have not downloaded.

### The exchange record and its keys

The record is your own account of what this exchange disclosed: who the parties were, the agreement it ran under, the categories of data sent, your record count, and the number of matches. It is meant for a disclosure log, such as a HIPAA accounting of disclosures or a FERPA disclosure record. It holds no matched data. In place of the data, it holds fingerprints of what you sent, what you received, and which records matched. You can keep it or give it to an auditor.

The verification keys open those fingerprints. With the keys, your original input file, and your result file, anyone can confirm that the record describes exactly that exchange and that none of the files has changed since. Without the keys, no one can, and they cannot be recreated later. Keep the keys private, as you would the data itself: someone holding the keys and the record could test guesses at the matched values.

Keep the record, the keys, your input, and your result together, for as long as your records schedule requires. The record is not signed: it shows what your side recorded, not proof of what your partner did. The format is specified in [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

## Checking a record later

The Verify page, at [https://psi.data-bridge.org/verify](https://psi.data-bridge.org/verify) and titled **Verify an exchange record**, checks a record in your browser without uploading anything. The completion screen links to it under the record downloads.

1. Choose the record and its verification keys, and choose **Verify**. This checks the files' structure.
2. To check the record against the data, also supply your input CSV and your result CSV under **Re-supply your files to open the commitments**, and choose **Verify with these files**.

The page reports **Verified**, **Incomplete** (some checks could not run, for example without your files), or **Verification failed**. A failure means the record was changed or one of the files is not from this exchange; the page cannot tell which, so check that you chose the right files first. The section on a signed receipt applies to exchanges run with the command line app or the console with signing set up; a web app exchange writes no signed receipt.

## Running it again

To exchange with the same partner on a schedule, choose **Save as a recurring exchange** on the exchange screen once the exchange completes, before you leave it. The offer is not shown to either side of a practice run with sample data. Scheduled runs happen only in the web app installed on your computer and left running; see [Installing the app](MANAGED_EXCHANGE.md#installing-the-app) and [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md).

## Relay settings

The **relay settings** link on the start page opens the Relay server page. What you save there is kept in this browser for this site. The relay servers you save apply to every exchange the browser starts from then on, the runs of a saved recurring exchange included. An invitation you create names the servers you saved, less any relay its Allowed relays leave out, so your partner's browser uses them too. The coordination server you set applies to the invitations you create, as its own item below says.

- **Use this site's relay server** is on a site that offers its own relay switched off, as the project's production and staging sites do. It applies to the exchanges this browser runs and the invitations you create. It starts off; turned on, the exchanges this browser starts use the site's relay, and the invitations you create name it, so your partner's exchange can use it too. Off, an exchange in this browser uses it only where an invitation you accept names it, whichever site or app made the invitation, or where your own TURN server urls name its address exactly, and then only the relay's servers they name. An exchange that uses the relay's TURN server registers with the relay before it connects, as it does with the switch on. Your partner can still bring the relay into an exchange whatever you choose, through their own settings or by using the demo site, so its operator can learn your network address too. To keep it out of an exchange, both of you leave it out. The review of an invitation naming the relay's TURN server, and the review of an exchange whose own TURN server urls name it, say the exchange may connect through it. The switch states what the relay's operator learns. When a run's connection does not open while it is off, the failure message says that turning it on and trying again may let the exchange connect, unless the exchange's Allowed relays leave the relay out. The demo site uses its relay in every exchange and has no switch ([DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)).
- **TURN server urls** name a relay for when a firewall blocks a direct connection to your partner. The page states what the relay's operator learns, and can test the relays you saved ([COMMUNICATION.md](COMMUNICATION.md#stunturn)).
- **STUN server urls** name the servers that find your browser's public network address before it connects. A STUN server learns the network address of each party that uses it. Unless you name your own here, the web app uses Google's public STUN server. The servers you name replace it rather than adding to it, as a `stun` list does in the command line app ([CLI.md](CLI.md#stun-and-what-it-discloses)). Your partner's browser follows its own setting, so to keep Google's server out of an exchange, both of you name your own. STUN servers named in an invitation you accept are used as well, beside yours or Google's.
- **Coordination server** names the server your browser and your partner's use to find each other, for the invitations you create from then on. It learns the network address of each party that uses it, and none of your data.
  - Enter a coordination server's `wss://` address, such as `wss://signaling.example.org/api/`. An address of another form is refused with a message saying what to enter, and a web app's `https://` address with a message that it is a web page's address. The address is not checked when you set it.
  - With none set, your invitations name this site's coordination server. If this browser cannot read the address you saved, the relay settings page and the **Review & create** step say so, and your new invitations name this site's server until you set the address again.
  - An invitation you already sent, a saved recurring exchange, and an invitation you accept keep the server they name, so setting, changing, or clearing the address moves none of them. Re-inviting your partner from a recurring exchange you created names the server set here, or this site's where none is set, and that exchange's later runs use it. If this browser cannot read the address you saved, a re-invite names the server the exchange already uses. If the address that exchange saved cannot be used either, the re-invite stops and says to set your address again or clear it here first.
  - If the server you set does not answer when you invite, the exchange stops with a message naming it, and your partner cannot use that invitation until the server answers. Ask whoever runs it to check it, then choose **Try again**. Or clear the address, choose **Start over with a fresh invitation**, and send your partner the new one. The message links to relay settings in a new tab.
  - The command line app given this site's address (`alcove invite https://psi.data-bridge.org`) uses the site's own coordination server, not your browser's setting ([DEPLOYMENT.md](DEPLOYMENT.md#coordination-server)).

### Allowed relays

An exchange's **Allowed relays** limit the relay servers your side of that exchange uses to the hosts you list. They are set for each exchange, not on the Relay server page: on the **Review & create** step of an invitation you create, under **live, in this browser**; on the review of an invitation you accept, below the terms; and on a saved exchange's page, under Local settings ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-relays-a-saved-exchange-may-use)).

- **Where they are offered.** Only where the exchange's run would list a relay for them to keep or leave out: a TURN server or WebSocket relay saved on the Relay server page, the relay an invitation you accept names, or this site's relay server where the exchange uses it. A [command-line configuration brought back](MANAGED_EXCHANGE.md#bringing-a-command-line-configuration-back), whose runs happen on the command line, is offered them where it names a relay. A list already set, or a field you have edited on the page, is always shown.
- **One line until you set them.** Unset, they show as one line saying every relay a run lists is allowed, and **Set Allowed relays** opens the field. **Done** closes it; a line the field cannot read keeps it open. Once set, the line lists the hosts, with **Change** to open the field again and **Remove** to remove the list. After the invitation is created, or the accepted exchange starts, the review shows the list the exchange took, with no action.
- **What to enter.** One host per line, with a port where needed, such as `relay.example.org` or `relay.example.org:443`. The entry form and how an entry matches a relay's url are those of [`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays).
- **What they decide.** Your side of the exchange connects through, and enrolls at, only the relays an entry names, and an invitation you create names only those relays. Unset, your side may use every relay its run lists.
- **What they do not decide.** Your partner's side can still connect through a relay your list leaves out, and that relay then learns your network address. STUN servers are not relays, so an exchange still contacts the STUN servers it lists. A run still registers each new key at your own relay's registrar whatever the list keeps.

## How large an exchange can be

Each figure below is a fixed limit or a measured run recorded in the specification, linked beside it. A size with no measured run is named as not measured rather than estimated. The times are for whole runs on the machines the sources name; yours will differ with the hardware, the network between the parties, and the number of linkage keys.

### In the browser

- **The input file is at most 200 MiB.** That held 3.18 million rows of a six-column identifier file and 6.22 million rows of a two-column one in the measured runs ([The memory ceiling, and the CSV intake cap](spec/PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)).
- **A set the browser receives holds at most 8,388,608 values**, about one per record for each linkage key. Your partner's run refuses to send a larger set, before sending it, and names the remedies: split the input, or run the exchange with the command line app ([The receive ceiling](spec/PROTOCOL.md#the-receive-ceiling)).
- **The largest browser round measured to completion is 8,388,608 records a side, with the browser in either role.** Each took about 95 minutes on a 6-CPU machine with 31 GB of memory in headless Chromium ([What a browser tab can match](spec/PROTOCOL.md#what-a-browser-tab-can-match)). An exchange runs one such round for each linkage key, over the records an earlier key has not matched. At 10,000,000 records a side the round completed only with the browser as the joiner.

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
