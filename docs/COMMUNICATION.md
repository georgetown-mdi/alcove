---
title: "Alcove Communication"
---

# Alcove communication

This document covers the communication channels available for Alcove exchanges, how parties synchronize protocol steps, how the web invitation and acceptance flows disclose terms and gate consent, how errors are handled, and what supporting services are required. Authentication and channel security are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), the PSI protocol in [PROTOCOL.md](spec/PROTOCOL.md), and CLI configuration in [CLI.md](CLI.md). Intended readers are IT staff and developers.

## Channels

Three communication channels are supported:

* Peer-to-peer using WebRTC - a protocol primarily used by browsers to communicate with each other, for example in video calls. Behind corporate firewalls and Network Address Translation (NAT), a connection usually needs a supporting server to help establish it or to relay its traffic (see [STUN/TURN](#stunturn)).
* SFTP - an SFTP server one partner already runs is used as a message-passing channel, through polling and a synchronization protocol, with a short delay for each message. The number of messages does not depend on the size of the datasets, so the delay is a fixed cost.
* Shared-folder - a directory both parties can access, for example an NFS or SMB network share provisioned by IT, or a folder backed by an SFTP server and mounted locally. The same file-based polling and synchronization protocol used for SFTP is applied directly to the mounted path. No supporting service is required beyond read/write access to the shared folder. One party can use a shared folder synchronized to a directory served by an SFTP server to which the other party connects.

The configuration block each channel takes, one runnable example apiece, is in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connection-blocks-by-channel).

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle rare race conditions.

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either inviter or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The inviter and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](EXCHANGE_REFERENCE.md#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private coordination server, directory listings can be used.

## Web invitation

On the web, the inviting party composes an invitation from its own data file. The browser reads the file locally and derives the invitation's linkage terms from the file's columns: the default terms, narrowed to the keys those columns can satisfy. The acceptor reviews and consents to those derived terms, and the inviter's own half of the exchange runs on the same terms and the same parsed rows.

### Quick path

The inviter chooses a CSV and enters its name, then follows a short required sequence -- choose the file, confirm what it discloses, review and create -- with the default terms filled in from the file.

- Composing fails closed before any setup secret is created: a file that cannot be read, or that cannot satisfy every linkage key the terms would declare, produces no invitation. This is the rule the run itself enforces.
- Once the invitation is created, the share step shows the invitation as a link to send out of band, its expiry, and the proposed terms summary, and waits for the acceptor to connect. The bare code is offered as well only when the partner will accept through the command-line tool, whose accept takes the code alone; a browser partner pastes the whole link into the accept form.
- The interface previews only the leading and trailing characters of a copy-only value; the full value goes to the clipboard and is shown behind an explicit reveal. On connect the share block gives way to the run status.

Once a file is chosen, the sequence also shows which columns will be sent to the partner for matched rows, adjustable before creating. This informs and does not gate: the displayed set is derived from the same predicate the exchange transmits on, and when no column would be sent it says so. Those columns are also declared in the invitation's payload data dictionary, so the partner's consent screen lists them as columns it will receive.

The names shown are the inviter's own file's headers. Each is shown inside a bidi isolate rather than escaped, as on the acceptor's [Confirm your columns](#confirm-your-columns) step. Text-direction control characters are removed from headers when the file is read, and a notice beside the file names the column positions that changed (see [CSV header sanitation](spec/PARSED_INPUT_BOUNDS.md#csv-header-sanitation-at-ingestion)). A name that reaches a screen through the invitation summary, such as the consent preview of the send this invitation declares, is escaped, as everything from that summary is.

### Customizing the terms

Every part of the default terms is adjustable in place; there is no separate advanced screen. Customization starts from the file's derived values, so it needs the CSV first, and previews the terms with the same component the acceptor's consent screen uses. Validation runs through the linkage-terms schema the exchange enforces; creating is blocked until the terms are valid, every enabled key is satisfiable by the inviter's columns, and no key declares cleaning that drops every record. The inviter can set:

- its name, on the file step, and the invitation duration, on the review-and-create step;
- what the exchange produces -- the matching method, then who receives the matched results: both parties, only the inviter, or only the partner ("neither receives" is not offered) -- at the top of the confirm-disclosure step, grouped as the consent review groups them, ahead of the column choices both constrain;
- a column metadata grid mapping each column to a semantic type and one disclosure choice (used to match, unique record identifier, sent to your partner, or ignored), on the confirm-disclosure step;
- which linkage keys are active and in what order, with a per-key indicator of whether the inviter's columns satisfy it, plus the linkage strategy, in the Matching keys tab. Choosing `single-pass` over the default `cascade` shows its disclosure tradeoff (fewer round trips over a high-latency channel in exchange for disclosing more) and writes terms stating that choice, which both parties must agree on or the exchange aborts. The disclosure mechanics are in [PROTOCOL.md](spec/PROTOCOL.md);
- an optional legal agreement (the partner must enter it identically), in an Agreement tab.

Per-field data cleaning is set in a Cleaning tab: the inviter authors each field's cleaning steps, raw regular-expression steps included (each marked "advanced"), and chooses which column feeds it. A whole-file coverage warning is shown, and a malformed step blocks creation, as in the acceptor's cleaning editor (below).

The matching algorithm is selectable, `psi` or count-only `psi-c`; a count-only draft that deduplicates, sends columns, or keeps a key matching several values per record blocks generation and names what to change, and the count-only choice carries a caveat stating that the party computing the count can learn more than the count. Deduplication is selectable and declares the inviting party's own side alone; generation is blocked only under the linkage strategy that cannot match it. Fuzzy comparison is chosen per element in an expert key (below).

### Expert authoring and import/export

Expert mode adds building linkage keys element by element (each element's field chosen from the declared columns, with a typed-parameter transform pipeline and a two-of-N "match in either order" swap), adding a second field of one semantic type bound to a different column (for example a maiden and a current name), and a JSON/YAML import/export of the whole terms document, validated the same way.

Import refuses a document whose keys use a custom per-field constraint. The rest of an imported declaration is re-emitted as declared, including field order, unreferenced fields, and an empty constraints object. An imported key that references a field the inviter's columns cannot supply loads disabled but visible, so the remaining keys still generate.

### Per-party disclosure

Column disclosure and cleaning are per-party and local: they are threaded into the inviter's own half of the exchange, never embedded in the invitation, so they change only what the inviter discloses and its own match rate, not the agreed terms the acceptor consents to. See [SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality) for how the derived terms disclose column shape (never row values) to the recipient.

## Web acceptance and consent

The acceptor opens the invitation deep link, or pastes the link or the invitation text into the start page's "Review invitation" box; either way the token is in the URL fragment, which never reaches the server. Decoding the token enforces the invitation's expiry: an expired or invalid token fails closed, with no consent action offered. No rendezvous, key-exchange handshake, or PSI frame is set up before consent commits.

### The consent review

The proposed terms are organized around an always-visible core, in this order:

- **What you disclose** -- the acceptor's own outbound send and any request for its data;
- **What the exchange produces** -- the matching method and who receives the result;
- **What you receive** -- the inbound partner data;
- **How records are matched** -- the linkage strategy and the matching keys.

An attached legal agreement is shown last in the core, whole (its reference, purpose, and expiry). Each tier is a labelled group that assistive technology can navigate.

Detail sits behind two collapsed disclosures: "Matching strategies" (one further disclosure per linkage key, holding its elements, transforms, and swaps) and "Other details" (field constraints, payload columns, and the duplicate-matching settings: what the invitation declares for the inviting party's side, and the control for your own). While collapsed, a disclosure's content is hidden from assistive technology. The fields the keys match on are summarized above the matching detail; that summary and each key's one-liner are derived from the schema-validated field types, not the partner's key or field names.

A transform's parameters are displayed as the invitation declares them, sanitized for display (cut at a visible truncation marker, and escaped; see [DISPLAY_ESCAPE.md](spec/DISPLAY_ESCAPE.md#display-sanitization-escape-format)). What runs can differ from what is displayed in two ways ([TRANSFORM_PARAMETER_BOUNDS.md](spec/TRANSFORM_PARAMETER_BOUNDS.md#transform-parameter-declared-types)): a literal a step injects or compares (a `replace_regex` replacement, a `null_if` value, a `pad_left` fill character, or a `coalesce` default) runs in its NFC-normalized form, and a regex step that declares no pattern, or a `split_on` step that declares no delimiter, compiles the literal word `undefined` in that position. An invitation is refused at decode when:

- a step declares a parameter its function cannot read as written;
- private key material sits in a parameter value, a parameter name, a step's function name, or the inviting party's own name;
- a step declares more parameters than its line shows;
- a `null_if` step declares both `value` and `values`.

The core also shows a count of the columns the invitation requests from the acceptor (under "What you disclose"), a count of the columns it will send the acceptor for matched records (under "What you receive", omitted when it sends nothing), and the full legal agreement. Every payload-column count names its direction first. A `single-pass` strategy is shown always-visible with the disclosure note the inviter saw; `cascade` is not flagged.

Before a file is chosen, a fixed line states that the acceptor's own send is confirmed later, when it confirms its columns. Once a file is chosen, the actual send list replaces it, stating how many columns are sent before naming them. Those names are the acceptor's own file's headers and show inside a bidi isolate; every name the invitation declares stays escaped. A send of nothing, and a direction under which nothing is transmitted at all, each say so.

### Consent gate

Having reviewed the terms, the acceptor gives affirmative consent (a checkbox plus its name) and chooses its own CSV on the consent step. Both consent and a name are required before the file is parsed, so choosing a file never pre-empts the consent gate.

The heading ("Invitation from &lt;name&gt;") has a fixed-copy note marking the counterparty identity unverified: the name is free text the sender typed, held in an invitation accepted on a transcription checksum rather than an authenticity guarantee. It informs the decision without gating it and shows on the pre-consent review only. A consent helper beside the checkbox reminds that the invitation should have reached the acceptor over a trusted channel. All partner-controlled text in the terms is escaped at display (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md), "Channel security").

### Confirm your columns

Once consent commits and the file parses, the acceptor confirms its columns through the same column metadata grid the inviter uses (see [Customizing the terms](#customizing-the-terms)), with a running summary of which columns will be sent and a live count of how many agreed linkage keys the current mapping satisfies. A file whose columns fall short of the terms lands here, where the operator remaps columns in place. No column starts sent: a record identifier column, whatever its name ([inference rules](EXCHANGE_REFERENCE.md#input-metadata)), starts not sent, and the operator can set it sent. A column that inference does not recognize is listed as ignored until the operator marks it sent.

Every pre-launch check in the browser applies the rule the run itself enforces: an exchange is refused unless the input satisfies **every** agreed linkage key and none of them declares cleaning that drops every record. Missing coverage is remapped in the quick-fix mapper above the launch button. A key whose cleaning drops every record came with the invitation, so its remedy is a corrected invitation from the partner.

Column names are the operator's own file's headers, shown verbatim inside a bidi isolate wherever this step names one, and not escaped (the boundary is documented in `apps/web/src/components/ColumnName.tsx`). Text-direction control characters were removed at read, and a notice names the positions that changed. A header too long to display is cut and marked. Whether a column name is too long to send is a separate bound on the columns marked to send: its notice names the column positions and closes the launch until they are resolved, and unmarking the column clears it. The console's file picker, the Cleaning tab, and the command line tool's accept prompt escape the same headers instead (see [CLI.md](CLI.md)).

The Cleaning tab, reached from the accept ledger's Customize row, is the inviter's cleaning editor: an ordered, editable list of steps with a live before-and-after preview over a sample of the operator's rows. Two whole-file checks catch failures the sample cannot show:

- a per-field coverage alarm when a transform leaves the field with no value for any row, a failure that otherwise looks like a genuine non-match. The alarm informs and does not block;
- a terms-derived advisory when a linkage key's own cleaning can never produce a value (for example a `parse_date` whose input format omits a component). The launch is closed while it stands, and the remedy is to agree on terms over keys and fields both files can supply.

Constraint violations are reported but not enforced. What blocks launching from this step is a malformed or incomplete cleaning step or shared-value limit, alongside the satisfiability and single-identifier checks, the same gate applied on the inviter's side.

An invitation may declare which columns the inviting party accepts from this party. Where the marks differ from that declaration, the step shows an informational notice listing the columns at issue and does not hold the launch. Before any data is sent, the inviting party's run is offered the difference as a terms change ([When your partner's terms change](CLI.md#when-your-partners-terms-change)): a run that can ask its operator asks, and one that cannot, such as a one-off exchange in the web app, stops the exchange there. Where the declaration names a column this file has but does not send, the notice offers the setting that sends it: a column the file matches on as used to match and sent, the file's record identifier as the identifier sent to the partner, and any other column as sent. While the column settings hold more than one record identifier, each such column is offered as sent, and no other column changes. The declared names are the partner's, so they are escaped; the notice lists a fixed number and counts the rest, and the offer is read from the whole declared set.

A declaration that accepts no column at all is handled the same way while a column is marked to send and the inviting party is entitled to the matched result. Where that party is entitled to no result, nothing is transmitted whatever the marks say, and the step says nothing. The command line tool reports that case on its own acceptance path (see [CLI.md](CLI.md)).

The disabled launch control states what closed the launch, tied to the control for keyboard and screen-reader users, and the reason is announced when it arises mid-session.

Raw patterns run under a bounded, non-backtracking engine, so a pathological pattern cannot freeze the tab; raw patterns inside a partner-authored, token-embedded key transform stay read-only, bounded by the wire dialect (see [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect)).

The running send summary is the last look before launch; there is no separate confirmation. The metadata and cleaning the acceptor prepares are per-party and local, so they change only its own match rate and disclosure, never the agreed terms.

### Running the agreed terms

The exchange runs the inviter's terms with the acceptor's identity substituted and its output direction mirrored: the acceptor's "receives output" is the inviter's "shares with partner" and vice versa, so a one-sided invitation agrees rather than aborting.

The acceptor's own `deduplicate` is never taken from the invitation: no invitation can put the acceptor on the "many" side. The accept screen offers the accepting party its own value, off by default and stated on the terms it reviews, so a deduplicating invitation runs many-to-one with the inviter as the "many" side unless the accepting party declares its own side too. Where both parties deduplicate, the exchange resolves to many-to-many, which both linkage strategies match. A combination the run would refuse is refused at the screen, naming what to change. The value the accepting party consents to is the value its exchange presents: a control moved after consent holds the launch until the operator accepts again or restores the accepted value. The inviter's own side is bound to what the invitation declared: an inviter presenting a different value at the terms exchange is refused before any key or payload moves.

When the agreed terms give a party no result, the exchange withholds from that party, in both the web app and the CLI, both the matched result table and the partner's payload columns; a non-receiving helper is sent none of the partner's payload values and fails closed if it is sent any. Under `psi` it does still learn which of its own records matched (membership); a count-only exchange discloses nothing of the kind, since the party it gives no count computes none and is sent none. The consent copy marks the two result-sharing lines differently:

- the viewer's own non-receipt is enforced (sent none, fails closed on any it is sent);
- the partner's non-receipt is cooperative, resting on the agreed terms being honored ([one-sided-disclosure.md](notes/one-sided-disclosure.md)). The partner's "No" also states the membership disclosure a `psi` exchange makes, and the partner's "Yes" notes that the agreement, not the tool, governs the result's use.

A sentence that qualifies a headline is shown at the same visibility level as that headline:

- `psi-c`'s count-only guarantee, and what bounds it -- what the rounds still disclose, whose word the count arrives on, and what a partner's choice of input defeats -- are always-visible in the core.
- The deduplicate and fuzzy-comparison headlines sit inside a disclosure with what qualifies each. The fuzzy line is flagged only where the exchange will refuse the terms outright, a count-only run, and the swapped key order is flagged the same way. The deduplicate line states what a deduplicating match reveals.
- Which deduplicate statement is shown follows the invitation's output direction. Where the result is shared with the accepting party, that party learns, for each of its own matched records, how many of the inviting party's records share the matched value and which rows they are -- as a count and row positions rather than the value, and as that party's own unverified declaration. Where the inviting party is the sole receiver, the accepting party is sent no result and is shown no group sizes or row positions.
- Beside it: the matching rounds do bring the grouping to the accepting party's software, and it is the client, not the wire, that keeps it off that operator's screen.
- Also beside it: accepting turns deduplication on for the inviting party alone, leaving the accepting party's own records ungrouped; more of the accepting party's records can match than in a plain one-to-one run, each disclosing its membership and any payload columns that party sends; and the per-party configuration sets the other direction.

The rendezvous peer-id derivation that places the two parties on the connection is specified in [PROTOCOL.md](spec/PROTOCOL.md).

### While the matching step runs

On a large file one matching operation can run for minutes with nothing sent or received. A browser party conducting the exchange shows, beneath the current stage, the step's name where the stage does not give it, how many values the step covers, and how long it has been running, updated each second. Between steps, and on an exchange the console conducts through the command-line tool, only the stage is shown. The command line reports the same figures its own way: [CLI.md](CLI.md#progress-while-a-long-run-works).

Under count-only terms the figure is the values the round masks, and the count the run reports is at most that figure. No percentage is shown: the encryption is a single call into the PSI library, which reports nothing until it returns.

## Message delivery and teardown

Each channel passes messages through a common transport contract. A completed send does not mean the peer has received the message; there is no end-to-end delivery acknowledgement at this layer. Every channel must guarantee that the final frame of an exchange survives a clean connection close, in one of two ways.

**A durable send with a draining close.** The file-based channels, SFTP and shared folder, work this way. A send writes the message as a file in the shared folder and does not resolve until that write and its atomic rename into place are durable. Because the sender's close also deletes the files it is responsible for, the close first waits for the peer to consume the last sent file, then cleans up. The drain and its bound are specified in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-3----cleanup-and-close).

**A delivering close.** WebRTC works this way. A send hands the message to the data channel and returns before it is on the wire, so the final frame is protected by the close: a clean close must not tear the connection down until what was handed to the channel has reached the peer. A close caused by an error discards buffered outbound writes. The ordered channel delivers everything already sent ahead of the in-band close signal, but the signal can be queued while the final frame is still in the sender's outbound buffer. Both WebRTC implementations therefore wait for evidence the peer has the frame before the close resolves:

- the browser waits for the peer's own close of the data channel, which the peer performs on reading the close signal behind every frame;
- a CLI process waits for the peer to acknowledge the data, then closes the data channel and waits for that close to complete before tearing down;
- neither waits on the channel's buffered-byte counter reaching zero, which is not a delivery signal ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-clean-close)).

A clean WebRTC close must not be replaced by an abrupt teardown that bypasses it, and a file-based close must not skip the drain.

Any new channel added to the project must provide one of these two: a durable send with a draining close, or a clean close that delivers. A transport that does neither silently drops the final frame of an exchange. The same rule is recorded for implementors in the `Connection` and `TransportHooks` interface documentation in the core library.

Inbound, a frame that has already arrived and been buffered is handed to a waiting `receive()` before any terminal error is reported, whether the connection ended in a clean half-close or an abnormal drop. An errored close discards pending outbound writes, never a received frame in the inbound queue. This is behavior of the shared message queue above every channel, recorded in the `TransportControls` interface documentation.

Each transport wires its own terminal events to the queue's controls. WebRTC is the only close-capable channel, in both implementations (`apps/web/src/psi/transport/peerMessageConnection.ts` and `apps/cli/src/connection/webrtc/webrtcMessageConnection.ts`): it maps the peer's clean close to `finish()` (the clean half-close, which drains a queued final frame before the close is reported) and an error to `fail()` (the abnormal drop). The file-based channels report only `fail()`. Teardown stays driven through the queue's `finish()`/`fail()` controls, not a shared `Connection.close` event: a broadcast event reaches only a listener already attached, so a close with no listener would drop a frame.

## Error handling

In the case of communication channel errors, messages that fail to transmit are retried. The initial connection is retried on a transient failure up to a user-specified limit; a connection attempt that times out is terminal and is not retried. On the SFTP channel a session drop mid-exchange is re-dialed and the interrupted operation re-issued, including a drop by a server that leaves the connection half-open, so the exchange survives a server that drops the held session. The reconnect budget, its cumulative application over the exchange, and the mode exempt from it are in [`max_reconnect_attempts`](EXCHANGE_REFERENCE.md#connectionoptions). An unrecoverable drop still ends the exchange with a terminal error. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

Terminal failures are tagged with a `ConnectionErrorKind` (the kinds and their meanings are documented on that type in the core library) so a consumer can branch on the cause. An intentional local close is reported as `"closed"` (nothing went wrong on this side), while a clean remote close, a dropped link, and a peer timeout are all reported as `"transport"` (the link ended; a retry is reasonable). A partner that deviates from the protocol is reported as `"protocol"` -- a message that fails to validate, a value outside the range the agreed terms fix, or a payload disclosure other than the one consented to -- which is terminal. The rationale for that taxonomy is in [the `ConnectionErrorKind` taxonomy note](notes/connection-error-kind-taxonomy.md).

## Supporting services

The communication channels described above each depend on supporting infrastructure. Each such service is operated by a party, by a third party the parties choose, or -- for peer coordination, the relays, and the relay registrar, run for the hosted web application -- by the project. There is no project-run instance of any other supporting service, so a service a party does not operate is one it selected and answers for ([SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md#third-party-supporting-services)). Deployment guidance is in [DEPLOYMENT.md](DEPLOYMENT.md).

A service reached at a static address needs nothing beyond the address in each party's connection block. For a service brought up per exchange instead, the configuration schema has two provisioning shapes:

- **`server.provision`** brings the primary server up ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#on-demand-server-provisioning)). In `start` mode the server has a fixed address and is started on demand: `alcove exchange` calls the endpoint once before its first connection to the server and stops the run if the call fails, and a run started from a URL or an invitation states it with `--server-provision` and calls it the same way. In `create` mode a fresh server is allocated per invitation: an offline `alcove invite` calls the endpoint once, and the invitation names the server it returns.
- **`ice_provision`** is called by no connect path: a config with one connects straight to its static fields, so that service has to be running before the exchange starts.

Which application ignores which key, and which refuses it outright, is stated per field in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#where-each-setting-is-edited); provision an ICE service out-of-band.

### STUN/TURN

For parties behind NAT or corporate firewalls, the Interactive Connectivity Establishment (ICE) protocol establishes the peer-to-peer WebRTC connection. STUN servers help each party discover its public address; TURN servers relay traffic when no direct path can be found.

The two applications differ in where each takes its servers from:

- **The CLI** builds its peer connection from the connection block's `stun` and `turn` entries, followed by the relay an accepted invitation names, at whose registrar it enrolls when the invitation names one. A configured `stun` list replaces the CLI's default STUN server rather than adding to it ([CLI.md](CLI.md#stun-and-what-it-discloses)); what is verified for a relayed exchange is in [CLI.md](CLI.md#turn), and the url grammar and credentials in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionturn). The console runs the CLI, so the relay set beside its coordination server reaches the run of each invitation it creates as `turn` entries, and its WebSocket relay as `websocket_relay` ([CONSOLE.md](CONSOLE.md#running-a-webrtc-exchange)).
- **The browser client** of the hosted application ignores those entries. It uses the servers on its Relay server page, those the accepted invitation names, and a build's default relay ([WEB_APP.md](WEB_APP.md#relay-settings); [DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)). Each run derives its TURN credential from the exchange's shared secret, valid for one hour ([PROTOCOL.md](spec/PROTOCOL.md#relay-credential-derivation)), so no relay password is stored in the browser. A saved exchange enrolled at the relay's registrar registers the key of each rotated secret there itself ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#when-your-relay-runs-a-registrar)); one that is not enrolled needs its key registered with the relay again after each run that completes its handshake, including a run that then fails. A browser that reaches none of the STUN servers it lists learns no public address of its own, which Google's server might have given it.
- **Which relays a run may use** is set by the CLI's `allowed_relays` and the browser's Allowed relays ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionallowed_relays); [WEB_APP.md](WEB_APP.md#allowed-relays)). Each is the party's own setting: the partner may still connect through a relay it leaves out.
- **The `ice_provision` shape** is called by neither application: the browser ignores it and the CLI refuses a connection that sets it.

What a STUN server's or relay's operator can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

### WebSocket relay

A [WebSocket relay](DESIGN.md#websocket-relay) carries a WebRTC exchange for two parties whose network stops TURN but passes a WebSocket on 443: each party opens one `wss://` connection to it, and it pairs the two connections of one exchange and forwards their messages. Its wire is in [WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md), and the reference deployment beside the TURN relay in [infra/relay/README.md](../infra/relay/README.md#the-websocket-relay).

- **Where a run takes it from.** The CLI takes it from `connection.websocket_relay` and from the invitation it accepted ([A WebSocket relay of your own](CLI.md#a-websocket-relay-of-your-own)); the browser from its Relay server page, the invitation it accepted, and a build's default relay ([DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)). An invitation names the one its inviter uses, and Allowed relays leave out any one they do not name.
- **When a run uses it.** A run connects to each WebSocket relay it lists as it starts waiting for its partner, and moves the exchange onto one only when no WebRTC path opens or the partner has already moved there ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)).
- **What admits a party.** A proof made from the exchange's shared secret, checked against the relay key the relay's registrar or its owner enrolled for the exchange, as for the TURN relay ([PROTOCOL.md](spec/PROTOCOL.md#the-websocket-relay-proof)).

The relay forwards the exchange's messages and stores none of them. All of them cross under the application-layer encryption both applications apply, except the key-exchange messages that set it up, which hold no exchange data. What its operator can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

### WebSocket-to-TCP proxy

No WebSocket-to-TCP proxy is built, and no connection setting names one: the browser conducts WebRTC exchanges only, and a CLI party, including one the console runs, opens its SFTP socket itself ([DEPLOYMENT.md](DEPLOYMENT.md#websocket-to-tcp-proxy)).

### Coordination server

Establishing a WebRTC connection requires a signaling step in which both parties exchange session descriptions and ICE candidates. Alcove uses the PeerJS protocol for it: each party registers with a PeerJS-compatible server under a token-derived peer ID and then locates its partner under the complementary ID. The same protocol also frames the chunked data transfer over the established connection, so signaling and data transport are not independently separable.

Two implementations speak it, and either can be on either end of an exchange. The web application runs the PeerJS client library in the browser. The CLI drives a Node WebRTC stack directly and speaks the same signaling and framing itself; the wire both must match is specified in [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md).

The coordination server sees the signaling it relays and no exchange content: both applications apply the application-layer encryption on every WebRTC exchange, keyed by the parties' authenticated key exchange, which the server cannot complete ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). Which server an exchange uses, and running one, are in [DEPLOYMENT.md](DEPLOYMENT.md#coordination-server).

### SFTP

An SFTP server can be operated as a drop zone for exchanges between parties who prefer file-based communication to WebRTC. Its address is fixed and it can be stopped between exchanges, and directory-level access controls on a shared server can isolate exchanges without dedicated instances. Server requirements are in [DEPLOYMENT.md](DEPLOYMENT.md#sftp-server).

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model and security properties of the channels described here
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - `connection` block reference for configuring the channels described here
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services described here
- [CLI.md](CLI.md) - CLI commands for configuring and running exchanges over these channels
