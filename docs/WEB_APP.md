---
title: "Alcove Web App"
---

# Using the Alcove web app

The web app runs an exchange between two browsers. Your file is read and matched inside your browser and never uploaded to our servers. What is sent to your partner is encrypted first. A coordination server helps the two sides find each other. It never sees your data. Open it at [https://psi.data-bridge.org](https://psi.data-bridge.org). There is nothing to install. While you set up or run an exchange, **Help** in the top bar opens this guide in a new tab.

This guide covers one exchange: creating an invitation, accepting one you were sent, reading the results, and keeping and checking the exchange record. Intended readers are analysts and program staff at either party. To run the same exchange again on a schedule, see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md); to run exchanges from the command line or over an SFTP server, see [CLI.md](CLI.md).

## Before you start

- **A CSV file** with a header row and identifier columns, such as names, date of birth, or SSN. Files up to 200 MiB are accepted. Larger exchanges, and how long they take: [How large an exchange can be](DEPLOYMENT.md#how-large-an-exchange-can-be).
- **A partner** with their own CSV and a browser. Agree with them beforehand on what you will match on and which columns, if any, each of you will send.
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
2. **Matching & sharing.** The step opens with **What the exchange produces**:
   - **Matching method.** Choose **reveal the matched identifiers (standard)**, or **reveal only the count (psi-c)** to learn how many records you have in common and not which ones. A count-only exchange matches on one key and sends no columns ([`linkage_terms.algorithm`](EXCHANGE_REFERENCE.md#linkage_termsalgorithm)).
   - **Who receives the matched results**: you and your partner, only you, or only your partner.

   Then, for each column, confirm its type and how it is used. A column sent to your partner is sent only for rows that match; your partner never receives the values in rows that do not match.
   - **Used to match - not sent**, or **used to match - sent to your partner.** Either way the column is used to match. A column set to **sent to your partner** instead is sent but is not used to match.
   - **Unique record identifier - not sent**, or **unique record identifier - sent to your partner.** Either way your result file begins with this column, so you can find each matched record in your own data. Your ID column starts as **not sent**, whatever it is called; choose **sent to your partner** to send it. Count-only terms, which send no column, set it to not sent. A record identifier column set to **sent to your partner** instead is sent but is not your identifier, and your result file then begins with each match's row position in your file.
   - **Sent to your partner.**
   - **Ignored.**

   Below the columns, two choices shape only your own result file: which of your own columns it holds beside your partner's values ([`include_own_columns`](EXCHANGE_REFERENCE.md#include_own_columns)), and whether it ends with a column naming the linkage key each match was made on ([`include_matching_key`](EXCHANGE_REFERENCE.md#include_matching_key)). Neither changes what your partner is sent or agrees to. The second is shown unavailable, with the reason, on terms that cannot name the key.
3. **Review & create.** Choose how long the invitation can be accepted (one hour by default, up to one year). Leave **How will this exchange run?** at **live, in this browser**. Under it, where the exchange would use a relay server, you can set its [Allowed relays](#allowed-relays). Check every term in the exchange proposal, then choose **Create the invitation**. The terms cannot be changed after this.

The next screen, **Your invitation is ready**, shows the invitation as a link, and a message you can copy that explains it to your partner. Send them the link over your trusted channel.

If the page you created it on runs on your own computer or inside your network, the screen warns that the link works only there. It recognizes loopback and private-range addresses and the common internal name endings, such as `.local`, `.lan`, and `.corp`. It gives no warning for another internal name, so check that your partner can open that address before you send the link.

**Keep this tab open.** Your browser waits for your partner to accept, and the screen says until what time: about 10 minutes, or until the invitation expires if that is sooner. Closing the tab cancels the invitation. Agree on a time with your partner so that both of you are at your computers.

- **If your partner has not connected by then**, the screen says so. Choose **Keep waiting** to wait again while the invitation is still valid, or **Start over with a fresh invitation** once it has expired.
- **If you reload the page**, the first step offers the invitation back while it is still valid: choose the same file again to keep waiting, or discard the invitation. The file must have the same columns, in the same order, and the same number of rows. Alcove keeps the invitation in this tab's session storage for this, with your file's column names and row count but never its rows, and removes it when the exchange completes, when you discard it or start over, and when the invitation expires. An expired invitation is never offered.

### Choosing the matching keys

The invitation starts with the built-in rules your file supplies under broader matching. To choose others, open **Customize > Matching keys** before you create the invitation. The console's invitation editor offers the same choices. The bands, the rules, and the mark are described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#choosing-the-built-in-rules).

- **Built-in rules.** **Highest precision** selects only the highest-precision rules. **Broader matching** selects those rules first, then rules that find more people, with a few more wrong matches. The info button beside the choice says what each one matches on.
- **When highest precision is not available.** While your file's columns supply none of its rules, highest precision is dimmed, with the reason "Needs stronger identifiers in your file, such as an SSN, ZIP code, or phone number." If it was already selected, the key list is empty, and the invitation cannot be created until you select broader matching or set a column's type or use on **Matching & sharing** so that the file supplies one of its rules.
- **Rules marked less certain.** A key built only from first name, last name, and date of birth fields is marked **(less certain)**: different people share these more often the more people the two files cover. Broader matching turns on the three built-in rules of that kind. Turn them off when your files cover many people. A file of one age group, such as one school class, counts as covering many people.

Changing the choice lists the rules it selects that your file supplies, in the built-in order. A key you turned off stays off while the choice keeps it, and a key the choice adds is turned on; you can then turn keys off or reorder them. The choice is not sent to your partner: the terms hold the keys, and **Review & create** names the choice they were selected with.

For keys you write in **expert authoring**, or load from a document, the control is not shown; a key among them built only from first name, last name, and date of birth fields is still marked. **Use the built-in rules** replaces the keys, fields, and cleaning, after you confirm, with the ones a new invitation starts with for your file. **Remove all keys** empties the key list, and asks you to confirm first where the list holds a key that is not a built-in key.

**Match only where a field is missing.** In expert authoring, each key has a **Match only where a field is missing** choice that lists your date of birth fields. Choosing one makes the key match only pairs where one side's record has no valid date of birth (missing, or a 01/01 filler), so it cannot match two people whose dates differ. Put the keys that match on the date before it. The built-in rules on a name and a phone or email with no date of birth are keys of this kind, and they run on a file with no date of birth column too, every record counting as having none. The invitation cannot be created while the key also matches on that date of birth, or while the exchange is count-only. The review, and your partner's consent screen, state under the key that a match through it tells whoever receives the result which of the two records had no valid date of birth, and that each party's partner learns how many of that party's records not yet matched have none. The setting is described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#keys-that-run-only-where-a-field-is-missing).

## Accepting an invitation

You received a link from a partner. Open it in your browser, or paste the whole link or the code under **Have an invitation? Paste it here** on the start page and choose **Review invitation**. The production and staging sites refuse a pasted link made on the demo site, saying to open the link itself; the code alone is taken. Your partner's browser must be open on their invitation while you accept.

1. **Review the terms.** The page shows who sent the invitation, what you would disclose, what the exchange produces, what you receive, and how records are matched. The sender's name is what your partner typed; Alcove does not verify it. If the invitation names a legal agreement, check its reference, purpose, and expiration against the agreement you signed. A matching key marked **(less certain)** is built only from first name, last name, and date of birth fields; to leave such keys out, ask your partner for an invitation without them. A key that matches only where one side has no valid date of birth says so under its fields, with what a match through it discloses (see [Choosing the matching keys](#choosing-the-matching-keys)). Where no other key matches on the date of birth, the fields matched on list it as `date of birth (only whether it is present)`. Below the terms, where the exchange would use a relay server, you can set [Allowed relays](#allowed-relays), and the terms then mark each relay the invitation names as kept or left out.
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

The **relay settings** link on the start page opens the Relay server page. What you save there is kept in this browser for this site. The relay servers you save apply to every exchange the browser starts from then on, the runs of a saved recurring exchange included. An invitation you create names the servers you saved, less any relay its Allowed relays leave out, so your partner's browser uses them too. The coordination server you set applies to the invitations you create, as its own item below says. What each of these servers learns: [What supporting services can observe](../PRIVACY.md#what-supporting-services-can-observe).

- **Use this site's relay server** is shown on a site that offers its own relay switched off. It starts off. Turned on, the exchanges this browser starts use the site's relay, and the invitations you create name it. Off, an exchange in this browser uses it only where an invitation you accept names it, or where your own TURN server urls name its address exactly. Your partner can still bring the relay into an exchange, so to keep it out, both of you leave it out. When a connection does not open while the switch is off, the failure message suggests turning it on, unless the exchange's Allowed relays leave the relay out. Which sites offer the switch, and the demo site's relay: [The default relay](DEPLOYMENT.md#the-default-relay).
- **TURN server urls** name a relay for when a firewall blocks a direct connection to your partner. The page can test the relays you saved ([COMMUNICATION.md](COMMUNICATION.md#stunturn)).
- **STUN server urls** name the servers that find your browser's public network address before it connects.
  - The web app uses Google's public STUN server only where neither this setting nor the invitation you accept names a STUN server.
  - The STUN servers you name here and those an invitation you accept names are used together, each once, in place of Google's, as a `stun` list is in the command line app ([CLI.md](CLI.md#stun-and-what-it-discloses)).
  - An invitation you create names your STUN servers, so your partner's browser uses them in place of Google's too. To keep Google's server out of an exchange, the one who invites names their own.
  - If your browser cannot reach any STUN server it lists, a direct connection to your partner is less likely to open. Name a STUN server your browser can reach here, Google's `stun:stun.l.google.com:19302` included: it is used beside the invitation's.
- **Coordination server** names the server your browser and your partner's use to find each other, for the invitations you create from then on.
  - Enter a coordination server's `wss://` address, such as `wss://signaling.example.org/api/`. An address of another form is refused with a message saying what to enter. The address is not checked when you set it.
  - With none set, your invitations name this site's coordination server. If this browser cannot read the address you saved, the relay settings page and the **Review & create** step say so, and new invitations name this site's server until you set it again.
  - An invitation you already sent, a saved recurring exchange, and an invitation you accept keep the server they name. Re-inviting your partner from a recurring exchange you created names the server set here, or this site's where none is set, and that exchange's later runs use it; where this browser cannot read the address you saved, the re-invite names the server the exchange already uses. If the address that exchange saved cannot be used either, the re-invite stops and says to set your address again or clear it here first.
  - If the server you set does not answer when you invite, the exchange stops with a message naming it. Ask whoever runs it to check it, then choose **Try again**, or clear the address and choose **Start over with a fresh invitation**.
  - The command line app given this site's address (`alcove invite https://psi.data-bridge.org`) uses the site's own coordination server, not your browser's setting ([DEPLOYMENT.md](DEPLOYMENT.md#coordination-server)).

### Allowed relays

An exchange's **Allowed relays** limit the relay servers your side of that exchange uses to the hosts you list. They are set for each exchange, not on the Relay server page: on the **Review & create** step of an invitation you create, under **live, in this browser**; on the review of an invitation you accept, below the terms; and on a saved exchange's page, under Local settings ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-relays-a-saved-exchange-may-use)). How an entry matches a relay, and what the list does and does not decide: [`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays).

- **Where they are offered.** Only where the exchange's run would list a relay for them to keep or leave out: a TURN server or WebSocket relay saved on the Relay server page, the relay an invitation you accept names, or this site's relay server where the exchange uses it. A [command-line configuration brought back](MANAGED_EXCHANGE.md#bringing-a-command-line-configuration-back) is offered them where it names a relay. A list already set, or a field you have edited on the page, is always shown.
- **One line until you set them.** Unset, they show as one line saying every relay a run lists is allowed, and **Set Allowed relays** opens the field. Once set, the line lists the hosts, with **Change** and **Remove**. After the invitation is created, or the accepted exchange starts, the review shows the list the exchange took.
- **What to enter.** One host per line, with a port where needed, such as `relay.example.org` or `relay.example.org:443`.
- **What they decide.** Your side of the exchange connects through, and enrolls at, only the relays an entry names, and an invitation you create names only those relays. Your partner's side can still connect through a relay your list leaves out, STUN servers are not affected, and a run still registers each new key at your own relay's registrar.
