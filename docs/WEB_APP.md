---
title: "Alcove Web App"
---

# Using the Alcove web app

The web app runs an exchange between two browsers. Your file is read and matched inside your browser and never uploaded to our servers. What is sent to your partner is encrypted first. A coordination server helps the two sides find each other. It never sees your data. Open it at [https://psi.data-bridge.org](https://psi.data-bridge.org). There is nothing to install. While you set up or run an exchange, **Help** in the top bar opens the step-by-step instructions on the project site in a new tab.

This page is the reference for one exchange in the web app: what it needs, what each step decides, what its messages mean, its connection settings, and the files it gives you, with how to check the exchange record. The steps are in the guides [Invite with the web app](../site/guides/web-invite.md) and [Accept with the web app](../site/guides/web-accept.md). Intended readers are analysts and program staff at either party. To run the same exchange again on a schedule, see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md); to run exchanges from the command line or over an SFTP server, see [CLI.md](CLI.md).

## Before you start

- **A CSV file** with a header row and identifier columns, such as names, date of birth, or SSN. Files up to 200 MiB are accepted. Larger exchanges, and how long they take: [How large an exchange can be](DEPLOYMENT.md#how-large-an-exchange-can-be).
- **A partner** with their own CSV and a browser. Agree with them beforehand on what you will match on and which columns, if any, each of you will send.
- **A trusted way to send the invitation**, such as secure email. The invitation holds a one-time secret: anyone who has it can take your partner's place.
- **Time with the page open.** Both browsers must be open while the exchange runs.

## Practicing with sample data

**See how it works with example data** on the start page starts an invitation with synthetic sample data already loaded, and you play both parties; the steps are in [Practice with sample data](../site/guides/web-invite.md#practice-with-sample-data). To accept in a different browser or on a second computer, use the partner's synthetic CSV, `alcove-sample-partner.csv`, which the invite screen offers to download.

The sample files contain synthetic records from two agencies: 100 people in the inviter's file and 200 in the partner's, 50 of them in both. The two rows of a person in both files can differ as two agencies' records often do, by a nickname, a typo, a changed surname, a different ZIP code, or an SSN one file lacks or masks, so some of those 50 match and some do not. Each full SSN in the files is a randomly generated number that the default cleaning keeps, so the matching keys built on the whole SSN can match; a masked SSN can match only on its last four digits.

When you open the invitation in another tab or window of the same browser, the **Consent & your file** step offers **Use the sample partner file** while no file is chosen. It selects the partner sample CSV for you, and from there the steps are the same as with a file you choose. Dropping or choosing another file replaces it, and **Clear**, beside **Sample data (synthetic records)** under **This exchange**, returns the step to no file chosen. The choice appears only in the browser that created the sample invitation: in a different browser or browser profile, or on a second computer, choose the partner CSV you downloaded from the invite screen instead. For this, the browser keeps a note of each invitation it creates from sample data, and drops it after the invitation expires. The note holds neither the invitation nor its secret.

The invite screen offers the same files before you choose one: its **download the inviter sample CSV** and **download the partner sample CSV** links each download one sample file, and **load it into this exchange** loads the inviter sample in place. While the sample is loaded, the **This exchange** panel says that another tab of this browser is offered the sample partner file, names the partner CSV a different browser needs, and offers it for download. The repository's [`test_data/`](../test_data/) folder holds two more synthetic files for the same purpose.

## Creating an invitation

The steps are in [Create the invitation](../site/guides/web-invite.md#create-the-invitation), which starts from **Create an invitation** on the start page. What each step decides beyond what the guide shows:

- **Matching & sharing** ([step 2](../site/guides/web-invite.md#2-matching--sharing)).
  - **Matching method.** A count-only exchange, **reveal only the count (psi-c)**, counts across every matching key, each record once, sends no columns, and is intended only for research ([`linkage_terms.algorithm`](EXCHANGE_REFERENCE.md#linkage_termsalgorithm)). The choice states what the party that computes the count can learn beside it; in the console it also links to the configuration key it is written into.
  - **Columns.** A column sent to your partner is sent only for rows that match; your partner never receives the values in rows that do not match. Your ID column starts as **not sent**, whatever it is called, and count-only terms, which send no column, set it to not sent. A record identifier column set to **sent to your partner** instead is sent but is not your identifier, and your result file then begins with each match's row position in your file.
  - **Your own result file.** Two choices below the columns shape only your own result file: which of your own columns it holds beside your partner's values ([`include_own_columns`](EXCHANGE_REFERENCE.md#include_own_columns)), and whether it ends with a column naming the linkage key each match was made on ([`include_matching_key`](EXCHANGE_REFERENCE.md#include_matching_key)). Neither changes what your partner is sent or agrees to. The second is shown unavailable, with the reason, on terms that cannot name the key.
- **Review & create** ([step 4](../site/guides/web-invite.md#4-review--create)). The invitation can be accepted for one hour by default, and for up to one year. Under **live, in this browser**, you can change the exchange's [Connection settings](#connection-settings) and, where the exchange would use a relay server, set its [Allowed relays](#allowed-relays). The exchange proposal states what the terms disclose in the words your partner reads before accepting, under the row each concerns.
- **Your invitation is ready** ([step 5](../site/guides/web-invite.md#5-send-the-invitation)). The screen shows the invitation as a link, and a message you can copy that explains it to your partner. If the page you created it on runs on your own computer or inside your network, the screen warns that the link works only there. It recognizes loopback and private-range addresses and the common internal name endings, such as `.local`, `.lan`, and `.corp`. It gives no warning for another internal name, so check that your partner can open that address before you send the link.
- **While it waits** ([step 6](../site/guides/web-invite.md#6-your-partner-open-the-link-while-your-page-waits)). The screen says until what time your browser waits for your partner: about 10 minutes, or until the invitation expires if that is sooner. **Replace this invitation** stops the waiting, so the link you sent no longer connects. After a reload, the first step offers the invitation back while it is still valid; the file you choose again must have the same columns, in the same order, and the same number of rows. Alcove keeps the invitation in this tab's session storage for this, with your file's column names and row count but never its rows, and removes it when the exchange completes, when you discard it or start over, and when the invitation expires. An expired invitation is never offered.

### Choosing the matching keys

The invitation starts with the built-in rules your file supplies under broader matching. To choose others, open **Customize > Matching keys** before you create the invitation. The console's invitation editor offers the same choices. The bands, the rules, and the mark are described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#choosing-the-built-in-rules).

- **Built-in rules.** **Highest precision** selects only the highest-precision rules. **Broader matching** selects those rules first, then rules that find more people, with a few more wrong matches. The info button beside the choice says what each one matches on.
- **When highest precision is not available.** While your file's columns supply none of its rules, highest precision is dimmed, with the reason "Needs stronger identifiers in your file, such as an SSN, ZIP code, or phone number." If it was already selected, the key list is empty, and the invitation cannot be created until you select broader matching or set a column's type or use on **Matching & sharing** so that the file supplies one of its rules.
- **Rules marked less certain.** A key built only from first name, last name, and date of birth fields is marked **(less certain)**: different people share these more often the more people the two files cover. Broader matching turns on the three built-in rules of that kind. Turn them off when your files cover many people. A file of one age group, such as one school class, counts as covering many people.

Changing the choice lists the rules it selects that your file supplies, in the built-in order. A key you turned off stays off while the choice keeps it, and a key the choice adds is turned on; you can then turn keys off or reorder them. The choice is not sent to your partner: the terms hold the keys, and **Review & create** names the choice they were selected with.

For keys you write in **expert authoring**, or load from a document, the control is not shown; a key among them built only from first name, last name, and date of birth fields is still marked. **Use the built-in rules** replaces the keys, fields, and cleaning, after you confirm, with the ones a new invitation starts with for your file. **Remove all keys** empties the key list, and asks you to confirm first where the list holds a key that is not a built-in key.

**Match only where a field is missing.** In expert authoring, each key has a **Match only where a field is missing** choice that lists your date of birth fields. Choosing one makes the key match only pairs where one side's record has no valid date of birth (missing, or a 01/01 filler), so it cannot match two people whose dates differ. Put the keys that match on the date before it. The built-in rules on a name and a phone or email with no date of birth are keys of this kind, and they run on a file with no date of birth column too, every record counting as having none. The invitation cannot be created while the key also matches on that date of birth. The review, and your partner's consent screen, state under the key that a match through it tells whoever receives the result which of the two records had no valid date of birth, and that each party's partner learns how many of that party's records not yet matched have none. The setting is described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#keys-that-run-only-where-a-field-is-missing).

## Accepting an invitation

The steps are in [Accept the invitation](../site/guides/web-accept.md#accept-the-invitation). What each step decides beyond what the guide shows:

- **Opening it** ([step 1](../site/guides/web-accept.md#1-open-the-link)). The production and staging sites refuse a pasted link made on the demo site, saying to open the link itself; the code alone is taken.
- **Review the terms** ([step 2](../site/guides/web-accept.md#2-review-the-terms)). If the invitation names a legal agreement, check its reference, purpose, and expiration against the agreement you signed. A matching key marked **(less certain)** is built only from first name, last name, and date of birth fields; to leave such keys out, ask your partner for an invitation without them. A key that matches only where one side has no valid date of birth says so under its fields, with what a match through it discloses (see [Choosing the matching keys](#choosing-the-matching-keys)). Where no other key matches on the date of birth, the fields matched on list it as `date of birth (only whether it is present)`. Below the terms, where the exchange would use a relay server, you can set [Allowed relays](#allowed-relays), and the terms then mark each relay the invitation names as kept or left out.
- **Consent & your file** ([step 3](../site/guides/web-accept.md#3-consent--your-file)). For an invitation this browser created from sample data, the step also offers **Use the sample partner file** while no file is chosen; see [Practicing with sample data](#practicing-with-sample-data).
- **Start the exchange** ([step 5](../site/guides/web-accept.md#5-start-the-exchange)). If your partner's page does not answer within about 10 minutes, the screen says so.

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

Under the downloads, a note says to check the record with the keys on the Verify page. Its **Verify page** link opens the Verify page in a new tab, leaving this page and its downloads in place.

**Download what you need before you leave the page.** The results are kept only in this page. Closing the tab, or choosing **Set up another exchange**, discards them. Until you have downloaded each file, the page asks first and names the files you have not downloaded.

### The exchange record and its keys

The record is your own account of what this exchange disclosed: who the parties were, the agreement it ran under, the categories of data sent, your record count, and, when the terms give both parties the result, the number of matches. It is meant for a disclosure log, such as a HIPAA accounting of disclosures or a FERPA disclosure record. It holds no matched data. In place of the data, it holds fingerprints of what you sent, what you received, and which records matched. You can keep it or give it to an auditor.

The verification keys open those fingerprints. With the keys, your original input file, and your result file, anyone can confirm that the record describes exactly that exchange and that none of the files has changed since. Without the keys, no one can, and they cannot be recreated later. Keep the keys private, as you would the data itself: someone holding the keys and the record could test guesses at the matched values.

Keep the record, the keys, your input, and your result together, for as long as your records schedule requires. The record is not signed: it shows what your side recorded, not proof of what your partner did. The format is specified in [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

## Checking a record later

The Verify page, at [https://psi.data-bridge.org/verify](https://psi.data-bridge.org/verify) and titled **Verify an exchange record**, checks a record in your browser without uploading anything. The completion screen links to it under the record downloads.

1. Choose the record and its verification keys, and choose **Verify**. This checks the files' structure.
2. To check the record against the data, also supply your input CSV and your result CSV under **Re-supply your files to open the commitments**, and choose **Verify with these files**.

The page reports **Verified**, **Incomplete** (some checks could not run, for example without your files), or **Verification failed**. A failure means the record was changed or one of the files is not from this exchange; the page cannot tell which, so check that you chose the right files first. The section on a signed receipt applies to exchanges run with the command line app or the console with signing set up; a web app exchange writes no signed receipt.

## Running it again

To exchange with the same partner on a schedule, choose **Save as a recurring exchange** on the exchange screen once the exchange completes, before you leave it. The offer is not shown to either side of a practice run with sample data. Scheduled runs happen only in the web app installed on your computer and left running; see [Installing the app](MANAGED_EXCHANGE.md#installing-the-app) and [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md).

## Connection settings

Each exchange has its own **Connection settings**: on the **Review & create** step of an invitation you create, under **live, in this browser**; on the review of an invitation you accept, below the terms; and on a saved exchange's page ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#connection-settings)). They apply to that exchange only, and nothing is kept for the next one. Once the invitation is created, or the accepted exchange starts, they are fixed; a saved exchange keeps the ones it was created with. The relay fields show as one line until you choose **Set a relay**. What each of these servers learns: [What supporting services can observe](../PRIVACY.md#what-supporting-services-can-observe).

- **Coordination server** (on an invitation you create, and on a saved exchange's page) is the server your browser and your partner's use to find each other. It starts as this site's server.
  - Enter a coordination server's `wss://` address, such as `wss://signaling.example.org/api/`. An address of another form is refused with a message saying what to enter. The address is not checked when you set it.
  - The invitation names it, and an invitation you accept keeps the server it names. Re-inviting your partner from a recurring exchange you created names the server on that exchange's page.
  - If the server does not answer when you invite, the exchange stops with a message naming it. Ask whoever runs it to check it, then choose **Try again**, or choose **Start over with a fresh invitation** and change the address.
  - The command line app given this site's address (`alcove invite https://psi.data-bridge.org`) uses the site's own coordination server ([DEPLOYMENT.md](DEPLOYMENT.md#coordination-server)).
- **Use this site's relay server** is shown on a site that offers its own relay switched off. It starts off. Turned on, the exchange uses the site's relay, and an invitation you create names it. Off, the exchange uses it only where an invitation you accept names it, or where your own TURN server urls name its address exactly. Your partner can still bring the relay into an exchange, so to keep it out, both of you leave it out. When a connection does not open while the switch is off, the failure message says how to turn it on, unless the exchange's Allowed relays leave the relay out. When the site's relay server cannot take an exchange, the run says why and how long to wait, then connects without it, and a saved exchange's run history says the same of a scheduled run. Which sites offer the switch, and the demo site's relay: [The default relay](DEPLOYMENT.md#the-default-relay).
- **TURN server urls** name a relay for when a firewall blocks a direct connection to your partner, one per line ([COMMUNICATION.md](COMMUNICATION.md#stunturn)). An invitation you create names them, less any relay its Allowed relays leave out, so your partner's browser uses them too.
- **STUN server urls** name the servers that find your browser's public network address before it connects.
  - The web app uses Google's public STUN server only where neither these urls nor the invitation you accept names a STUN server.
  - The STUN servers you name and those an invitation you accept names are used together, each once, in place of Google's, as a `stun` list is in the command line app ([CLI.md](CLI.md#stun-and-what-it-discloses)).
  - An invitation you create names your STUN servers, so your partner's browser uses them in place of Google's too. To keep Google's server out of an exchange, the one who invites names their own.
  - If your browser cannot reach any STUN server it lists, a direct connection to your partner is less likely to open. Name a STUN server your browser can reach, Google's `stun:stun.l.google.com:19302` included: it is used beside the invitation's.
- **WebSocket relay url** names a relay for networks that block connections through a TURN relay, such as `wss://relay.example.org/relay`. The exchange connects to it as it starts, so its operator learns your network address, and the exchange passes through it, encrypted, only when no other connection opens ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)). An invitation you create names it, less where its Allowed relays leave it out.

### Checking the relays

**Check the relays**, below the Connection settings of an invitation you accept and on a saved exchange's page, checks whether each relay the exchange lists carries its traffic, under the exchange's own credential. It is offered where a run of the exchange would list a relay: one in the Connection settings, one the invitation names, or this site's relay server where the exchange uses it. A saved exchange's check uses its settings as last saved. An invitation you create offers it on the share screen.

- **Before it starts.** It lists the hosts it will contact, the hosts a run of the exchange contacts, and contacts nothing until you choose **Start the check**. Each operator it lists learns your network address.
- **What it does.** Where the exchange uses this site's relay server, it first sets that relay up for the exchange as a run does. It then opens two connections through each relay and passes one message between them.
- **What it reports.** For each relay, that it works, or that it does not work with the reason and what to change. A relay that refuses the exchange's credential does not work. Above the lines, it says whether any relay works.
- **What to do.** Each line says what the check saw and a step you can take on the page, such as Relay registration or a Connection setting, or ask your partner to take. It names no command-line command.
- **On an invitation you create.** The share screen offers it until your partner connects, where the exchange uses a WebSocket relay, and again after **Try again**. It reads the connections your page already holds open for your partner and contacts nothing else. It reports whether each WebSocket relay accepts the exchange from your page, and shows one that does as waiting for your partner. It does not check your partner's side, or a TURN relay, which your page first uses when your partner connects; it lists this site's TURN relay only where this site's relay server did not set up the exchange. To change a relay, choose **Replace this invitation**: the Connection settings are fixed once you create the invitation, so a remedy that changes them goes through it.

The protocol and its limits: [PROTOCOL.md](spec/PROTOCOL.md#the-web-applications-relay-check).

### Allowed relays

An exchange's **Allowed relays** limit the relay servers your side of that exchange uses to the hosts you list. They are set for each exchange: on the **Review & create** step of an invitation you create, under **live, in this browser**; on the review of an invitation you accept, below the terms; and on a saved exchange's page, under Local settings ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-relays-a-saved-exchange-may-use)). How an entry matches a relay, and what the list does and does not decide: [`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays).

- **Where they are offered.** Only where the exchange's run would list a relay for them to keep or leave out: a TURN server or WebSocket relay in the exchange's Connection settings, the relay an invitation you accept names, or this site's relay server where the exchange uses it. A [command-line configuration brought back](MANAGED_EXCHANGE.md#bringing-a-command-line-configuration-back) is offered them where it names a relay. A list already set, or a field you have edited on the page, is always shown.
- **One line until you set them.** Unset, they show as one line saying every relay a run lists is allowed, and **Set Allowed relays** opens the field. Once set, the line lists the hosts, with **Change** and **Remove**. After the invitation is created, or the accepted exchange starts, the review shows the list the exchange took.
- **What to enter.** One host per line, with a port where needed, such as `relay.example.org` or `relay.example.org:443`.
- **What they decide.** Your side of the exchange connects through, and enrolls at, only the relays an entry names, and an invitation you create names only those relays. Your partner's side can still connect through a relay your list leaves out, STUN servers are not affected, and a run still registers each new key at your own relay's registrar.
