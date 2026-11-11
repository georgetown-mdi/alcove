---
title: "Web Acceptance and Consent"
---

# Web acceptance and consent

This document specifies what the web application shows and enforces for the party that accepts an invitation, from opening the link to launching the exchange: the consent review, the consent gate, the confirm-your-columns step and its launch checks, the terms the exchange runs, and the progress shown while one matching step runs.
It is the implementation-level complement to the summary in [COMMUNICATION.md](../COMMUNICATION.md#web-acceptance-and-consent).
It does not cover how the inviting party composes an invitation (see [Web invitation](../COMMUNICATION.md#web-invitation)), the token's encoding and decode checks (see [INVITATION_TOKEN.md](INVITATION_TOKEN.md)), or the command line tool's accept (see [CLI.md](../CLI.md)).
Intended readers are developers and security auditors.

The acceptor opens the invitation deep link, or pastes the link or the invitation text into the start page's "Review invitation" box; either way the token is in the URL fragment, which never reaches the server.
Decoding the token enforces the invitation's expiry: an expired or invalid token fails closed, with no consent action offered.
No rendezvous, key-exchange handshake, or PSI frame is set up before consent commits.

## The consent review

The proposed terms are organized around an always-visible core, in this order:

- **What you disclose** -- the acceptor's own outbound send and any request for its data;
- **What the exchange produces** -- the matching method and who receives the result;
- **What you receive** -- the inbound partner data;
- **How records are matched** -- the linkage strategy and the matching keys.

An attached legal agreement is shown last in the core, whole (its reference, purpose, and expiry). Each tier is a labelled group that assistive technology can navigate.

Detail sits behind two collapsed disclosures: "Matching strategies" (one further disclosure per linkage key, holding its elements, transforms, and swaps) and "Other details" (field constraints, payload columns, and the duplicate-matching settings: what the invitation declares for the inviting party's side, and the control for your own). While collapsed, a disclosure's content is hidden from assistive technology. The fields the keys match on are summarized above the matching detail; that summary and each key's one-liner are derived from the schema-validated field types, not the partner's key or field names.

A transform's parameters are displayed as the invitation declares them, sanitized for display (cut at a visible truncation marker, and escaped; see [DISPLAY_ESCAPE.md](DISPLAY_ESCAPE.md#display-sanitization-escape-format)). What runs can differ from what is displayed in one way ([TRANSFORM_PARAMETER_BOUNDS.md](TRANSFORM_PARAMETER_BOUNDS.md#transform-parameter-declared-types)): a literal a step injects or compares (a `replace_regex` replacement, a `null_if` value, a `pad_left` fill character, or a `coalesce` default) runs in its NFC-normalized form. An invitation is refused at decode when:

- a step declares a parameter its function cannot read as written;
- a regex step declares no pattern, or a `split_on` step declares no delimiter, since the function has no default to fall back on;
- private key material sits in a parameter value, a parameter name, a step's function name, or the inviting party's own name;
- a step declares more parameters than its line shows;
- a `null_if` step declares both `value` and `values`.

The core also shows a count of the columns the invitation requests from the acceptor (under "What you disclose") and a count of the columns it will send the acceptor for matched records (under "What you receive", omitted when it sends nothing). Every payload-column count names its direction first. A `single-pass` strategy is shown always-visible with the disclosure note the inviter saw; `cascade` is not flagged.

On this review a fixed line states that the acceptor's own send is confirmed later, when it confirms its columns. The send summary on that step names the columns marked to send as the acceptor's own file's headers, each inside a bidi isolate; every name the invitation declares stays escaped. A send of nothing, and a direction under which nothing is transmitted at all, each say so.

## Consent gate

Having reviewed the terms, the acceptor gives affirmative consent (a checkbox plus its name) and chooses its own CSV on the consent step. Both consent and a name are required before the browser parses the file, so choosing a file never pre-empts the consent gate. On the console, choosing a mounted file profiles it on the server before consent, and consent still gates the step that follows.

The heading ("Invitation from &lt;name&gt;") has a fixed-copy note marking the counterparty identity unverified: the name is free text the sender typed, held in an invitation accepted on a transcription checksum rather than an authenticity guarantee. It informs the decision without gating it and shows on the pre-consent review only. A line under the consent step's heading reminds that the invitation should have reached the acceptor over a trusted channel. All partner-controlled text in the terms is escaped at display (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md), "Channel security").

## Confirm your columns

Once consent commits and the file parses, the acceptor confirms its columns through the same column metadata grid the inviter uses (see [Customizing the terms](../COMMUNICATION.md#customizing-the-terms)), with a running summary of which columns will be sent and a live count of how many agreed linkage keys the current mapping satisfies. A file whose columns fall short of the terms lands here, where the operator remaps columns in place. No column starts sent: a record identifier column, whatever its name ([inference rules](../EXCHANGE_REFERENCE.md#input-metadata)), starts not sent, and the operator can set it sent. A column that inference does not recognize is listed as ignored until the operator marks it sent.

Every pre-launch check in the browser applies the rule the run itself enforces: an exchange is refused unless the input satisfies **every** agreed linkage key and none of them declares cleaning that drops every record. Missing coverage is remapped in the quick-fix mapper above the launch button. A key whose cleaning drops every record came with the invitation, so its remedy is a corrected invitation from the partner.

Column names are the operator's own file's headers, shown verbatim inside a bidi isolate wherever this step names one, and not escaped (the boundary is documented in `apps/web/src/components/ColumnName.tsx`). Text-direction control characters were removed at read, and a notice names the positions that changed. A header too long to display is cut and marked. Whether a column name is too long to send is a separate bound on the columns marked to send: its notice names the column positions and closes the launch until they are resolved, and unmarking the column clears it. The console's file picker, the Cleaning tab, and the command line tool's accept prompt escape the same headers instead (see [CLI.md](../CLI.md)).

The Cleaning tab, reached from the accept ledger's Customize row, is the inviter's cleaning editor: an ordered, editable list of steps with a live before-and-after preview over a sample of the operator's rows. Two whole-file checks catch failures the sample cannot show:

- a per-field coverage alarm when a transform leaves the field with no value for any row, a failure that otherwise looks like a genuine non-match. The alarm informs and does not block;
- a terms-derived advisory when a linkage key's own cleaning can never produce a value (for example a `parse_date` whose input format omits a component). The launch is closed while it stands, and the remedy is to agree on terms over keys and fields both files can supply.

Constraint violations are reported but not enforced. What blocks launching from this step is a malformed or incomplete cleaning step or shared-value limit, alongside the satisfiability and single-identifier checks, the same gate applied on the inviter's side.

An invitation may declare which columns the inviting party accepts from this party. Where the marks differ from that declaration, the step shows an informational notice listing the columns at issue and does not hold the launch. Before any data is sent, the inviting party's run is offered the difference as a terms change ([When your partner's terms change](../CLI.md#when-your-partners-terms-change)): a run that can ask its operator asks, and one that cannot, such as a one-off exchange in the web app, stops the exchange there. Where the declaration names a column this file has but does not send, the notice offers the setting that sends it: a column the file matches on as used to match and sent, the file's record identifier as the identifier sent to the partner, and any other column as sent. While the column settings hold more than one record identifier, each such column is offered as sent, and no other column changes. The declared names are the partner's, so they are escaped; the notice lists a fixed number and counts the rest, and the offer is read from the whole declared set.

A declaration that accepts no column at all is handled the same way while a column is marked to send and the inviting party is entitled to the matched result. Where that party is entitled to no result, nothing is transmitted whatever the marks say, and the step says nothing. The command line tool reports that case on its own acceptance path (see [CLI.md](../CLI.md)).

The disabled launch control states what closed the launch, tied to the control for keyboard and screen-reader users, and the reason is announced when it arises mid-session.

Raw patterns run under a bounded, non-backtracking engine, so a pathological pattern cannot freeze the tab; raw patterns inside a partner-authored, token-embedded key transform stay read-only, bounded by the wire dialect (see [PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect)).

The running send summary is the last look before launch; there is no separate confirmation. The metadata and cleaning the acceptor prepares are per-party and local, so they change only its own match rate and disclosure, never the agreed terms.

## Running the agreed terms

The exchange runs the inviter's terms with the acceptor's identity substituted and its output direction mirrored: the acceptor's "receives output" is the inviter's "shares with partner" and vice versa, so a one-sided invitation agrees rather than aborting.

The acceptor's own `deduplicate` is never taken from the invitation: no invitation can put the acceptor on the "many" side. The accept screen offers the accepting party its own value, off by default and stated on the terms it reviews, so a deduplicating invitation runs many-to-one with the inviter as the "many" side unless the accepting party declares its own side too. Where both parties deduplicate, the exchange resolves to many-to-many, which both linkage strategies match. A combination the run would refuse is refused at the screen, naming what to change. The value the accepting party consents to is the value its exchange presents: a control moved after consent holds the launch until the operator accepts again or restores the accepted value. The inviter's own side is bound to what the invitation declared: an inviter presenting a different value at the terms exchange is refused before any key or payload moves.

When the agreed terms give a party no result, the exchange withholds from that party, in both the web app and the CLI, both the matched result table and the partner's payload columns; a non-receiving helper is sent none of the partner's payload values and fails closed if it is sent any. Under `psi` it does still learn which of its own records matched (membership), except in a single-pass run that withholds its half of the matched-pair table; a count-only exchange discloses nothing of the kind, since the party it gives no count computes none and is sent none. The consent copy marks both result-sharing lines enforced:

- the viewer's own non-receipt: it is sent none and fails closed on any it is sent;
- the partner's non-receipt: the partner is the sender ([Role resolution and work minimization](PROTOCOL.md#role-resolution-and-work-minimization)), is sent none of the viewer's payload columns, and saves no result ([one-sided-disclosure.md](../notes/one-sided-disclosure.md)). The partner's "No" also states the membership disclosure a `psi` exchange makes, and the partner's "Yes" notes that the agreement, not the tool, governs the result's use.

A sentence that qualifies a headline is shown at the same visibility level as that headline:

- `psi-c`'s count-only guarantee, and what bounds it -- what the rounds still disclose, whose word the count arrives on, and what a partner's choice of input defeats -- are always-visible in the core.
- The deduplicate and fuzzy-comparison headlines sit inside a disclosure with what qualifies each. The fuzzy line is flagged only where the exchange will refuse the terms outright, under a linkage strategy that cannot match several values per record. The deduplicate line states what a deduplicating match reveals.
- Which deduplicate statement is shown follows the invitation's output direction. Where the result is shared with the accepting party, that party learns, for each of its own matched records, how many of the inviting party's records share the matched value and which rows they are -- as a count and row positions rather than the value, and as that party's own unverified declaration. Where the inviting party is the sole receiver, the accepting party is sent no result and is shown no group sizes or row positions.
- Beside it: the matching rounds do bring the grouping to the accepting party's software, and it is the client, not the wire, that keeps it off that operator's screen.
- Also beside it: accepting turns deduplication on for the inviting party alone, leaving the accepting party's own records ungrouped; more of the accepting party's records can match than in a plain one-to-one run, each disclosing its membership and any payload columns that party sends; and the per-party configuration sets the other direction.

The rendezvous peer-id derivation that places the two parties on the connection is specified in [KEY_EXCHANGE.md](KEY_EXCHANGE.md#webrtc-rendezvous-peer-id-derivation).

## While the matching step runs

On a large file one matching operation can run for minutes with nothing sent or received. A browser party conducting the exchange shows, beneath the current stage, the step's name where the stage does not give it, how many values the step covers, how many it has processed and their share once the step reports a count, and how long it has been running, updated each second. While this party waits on its partner's step, the line shows the partner's percentage when the partner states one. Otherwise, between steps and on an exchange the console conducts through the command-line tool, only the stage is shown. The command line reports the same figures its own way: [CLI.md](../CLI.md#progress-while-a-long-run-works).

Under count-only terms the figure is the values the round masks, and the count the run reports is at most that figure.
