---
title: "Transport Memory Bounds"
---

# Transport memory bounds

This document specifies the memory bounds Alcove's transports hold against what a hostile party writes for them to read, with their constant values and enforcement points: the file-sync inbound frame-size bound and the per-exchange and per-part bounds beneath it, the directory-listing bound, the rendezvous symlink refusal, and the WebRTC data-channel inbound bound.
It is the implementation-level complement to the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), which covers what each control protects against and why the design is sufficient.
It does not cover how long a transport operation may take (see [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md)), the application-layer encryption and the bounds on partner-parsed input (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)), or the coordination server's bounds (see [SIGNALING_SERVER_BOUNDS.md](SIGNALING_SERVER_BOUNDS.md)).
Intended readers are security auditors and implementors.

## Inbound frame-size bound

The first of these transport bounds caps inbound frame size.
Left unbounded, the transport read path loads an entire frame into memory before any integrity check runs, so a hostile filedrop/SFTP server admin -- an adversary under the threat model (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model)) -- could write an arbitrarily large file and exhaust memory: a denial of service that allocates a byte array proportional to the attacker-chosen file size.
The transport refuses any inbound file larger than a maximum frame size of **536,870,888 bytes (~512 MiB)** before it is read into memory, reporting a clear terminal error (a `FrameSizeExceededError`, exit 64) rather than allocating proportionally to the attacker-chosen size.

**The value is a chosen memory bound, not a derived platform ceiling.**
No platform limit anchors it: the transport sends a frame as raw bytes and never stringifies it (the AEAD envelope and the file-sync message body are both binary; see [Application-layer AEAD](CHANNEL_SECURITY.md#application-layer-aead)), so no string-length ceiling binds the read, and ~512 MiB stands as a reasonable single-frame memory cap on its own terms.

This is the static safety check for every frame.
The single-pass reply is bounded by a tighter per-exchange cap derived from the exchanged record counts (see [Single-pass per-exchange cap](#single-pass-per-exchange-cap) below), which can only ever tighten this value for that one read, never widen it.
As a headroom check against the realistic worst-case legitimate frame: the largest PSI frame is one part of a party's encrypted set sent as raw elliptic-curve points, **35 bytes per element** on the wire (see [PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)), encoded with no base64url expansion, and a sender fills each part to this bound and no further (see [PSI set parts: the combined bound](#psi-set-parts-the-combined-bound) below).
512 MiB is therefore on the order of 15 million elements a part -- already more than the single-frame single-pass transport practically ships before the separate single-pass dataset ceiling binds.

**Enforcement.**
The bound is enforced at the transport read layer, which is the meaningful enforcement point.
The poll loop refuses a message file whose listed or declared size exceeds the cap before calling `get()`.
The rendezvous gate holds a peer hello to a much smaller control-file cap of **1,024 bytes** (`HELLO_MAX_BYTES`), since it may re-read the hello every poll cycle: it refuses a hello listed over that size before calling `get()`, with a terminal `FrameSizeExceededError`, and passes the same value as the read's byte cap.
In both cases -- so a server that under-reports a file's size in its directory listing cannot slip past that check -- each `FileTransportClient` adapter also enforces a hard per-read byte cap.
The local-filesystem adapter `fstat`s the open handle and reads exactly that many bytes, closing the append-after-stat TOCTOU; the SFTP adapter streams into a counting sink that aborts the transfer once the running total crosses the cap, buffering at most one stream chunk past it.
A binary length check on the AEAD decorator's inbound envelope caps it at the same single value -- a byte-length check on the raw envelope -- but that is documented defense-in-depth only, not the primary control: by the time the decorator runs, the inner transport has already read the frame, so the dominant allocation has already happened.

The bound is a fixed constant rather than a configurable option: a configurable bound risks an operator raising it high enough to reintroduce the DoS.

### Single-pass per-exchange cap

The single-pass reply (message 2 of the single-pass strategy) holds both parties' encrypted value sets and the sender's index table in one frame, whose legitimate size grows with the dataset.
Rather than bound it by the static ~512 MiB cap above, single-pass derives a **per-exchange cap from the exchanged record counts and the agreed key count** -- authenticated session state both parties hold after the terms exchange, never any byte, name, or transport-listed size of the inbound file.
So a small exchange's reply is held to a small bound (a hostile transport admin cannot pad it up to the static ceiling) while a large legitimate one is admitted up to a fixed maximum dataset size.

The derivation, its constants, and the deterministic operation order are specified in [PROTOCOL.md](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).
The security-relevant properties here:

- **One shared computation, two enforcement points.**
  A single exported integer function (`singlePassReplyByteCap`, `packages/core/src/connection/frameSize.ts`) yields the value the receiver enforces at its transport read gate and the value the sender checks its built reply against before sending.
  The receiver threads it into the file-sync poll loop's `get()` read gate (via `setInboundFrameCap`), where it **replaces** the static `MAX_FRAME_SIZE_BYTES` for that one read rather than layering a second check above a still-static cap; the threaded value is clamped so it can only tighten, never widen, the static safety check.
  The receiver sets it before it builds its request, since a peer can write the reply at any point while the request is masked, and checks the reply's length against the same value after the read, which holds the cap for a frame read before the set and on a transport whose read gate ignores it.
- **The real ceiling is a memory budget, fixed and non-configurable.**
  An exchange aborts when either party's `effectiveKeyCount * recordCount` -- its value slot count, the upper bound on its distinct-value count, over the effective key count both parties derive from the agreed terms and the record count that party declared, which for a width-free party is its `keyCount * recordCount` -- exceeds [`MAX_SINGLE_PASS_CELLS`](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).
  Its value, its derivation from the heavier party's measured peak, and the constraint that binds it -- the WebRTC per-frame envelope below, not memory -- are specified there, under the single-pass dataset ceiling.
  It is a fixed constant, not an operator-configurable option, for the same reason as the frame-size bound: a configurable maximum risks being raised high enough to reintroduce the memory-exhaustion DoS.
- **Transport-aware via per-transport clamps.**
  File-sync gets the `MAX_SINGLE_PASS_CELLS`-derived bound up to `MAX_FRAME_SIZE_BYTES`; the WebRTC data channel keeps its fixed browser-tab envelope [`MAX_WEBRTC_FRAME_BYTES`](#webrtc-data-channel-inbound-bound) at its reassembly read gate (`apps/web/src/psi/transport/boundedReassembly.ts`) and relies on the shared count-budget check, run identically on both transports, plus the decode-time coherence checks below.
  At the ceiling the derived reply frame, whose size there [PROTOCOL.md](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute) derives, sits below both envelopes -- the WebRTC one is the nearer -- so a legitimate single-pass reply the count budget admits is never rejected by a transport clamp.
  An over-ceiling exchange fails closed with the same actionable guidance -- which does not recommend cascade -- on both transports.
  The cap is held below the point where the derived reply cap would reach the WebRTC envelope precisely so this stays true; raising it past that point would require reworking the WebRTC reassembly path to fail closed rather than mid-frame.
- **Decoded counts are validated against authenticated state before allocation.**
  The receiver checks the row count packed into the reply against the record count the sender sent on the terms exchange -- no greater, and dividing it into a whole fan-out factor -- and checks the index-table length the frame actually holds, both before either count drives any allocation.
  Combined with the truncated/oversized-length decode guards, the reply decode stays bounded against malformed or adversarial framing.
  Each decoded record count additionally has an explicit [`MAX_RECORD_COUNT`](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute) upper bound at its wire schema (`recordCountField` on the terms-exchange envelope, `packages/core/src/protocolSetup.ts`), so a count above it is a clean `protocol` abort at decode; its value and what that bound buys the cell-count gate are specified there.
- **Declared PSI element counts are bounded by a wire-format scan before deserialization.**
  Both the single-pass and the cascade decode paths hand a partner-supplied PSI setup / request / response to `@openmined/psi.js` `deserializeBinary`, which allocates one JS byte-slice object per declared repeated `bytes` entry.
  So a frame *within* the byte cap yet packed with minimal empty entries (up to ~frameBytes/2 of them) would exhaust memory **inside `deserializeBinary` itself**, before any post-deserialize count could run.
  The measured per-entry allocation, the amplification factor it implies, and the worst-case allocation this ceiling holds it to are specified in [PROTOCOL.md](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).
  The enforcement point is here: the participant scans the protobuf wire format and counts the declared elements without materializing them (`countDeclaredPsiElements`, `packages/core/src/connection/psiElementScan.ts`), rejecting an over-declared frame at the call site in `participant.ts` **before `deserializeBinary` is called**; the scan stops as soon as the count exceeds the ceiling, so an over-declared frame costs O(ceiling), not O(frame).
  The ceiling is the smallest of up to three bounds.
  The first, on a setup or a request, is the value slot count `effectiveKeyCount * recordCount` for the relevant party (the sender's set for a setup, the receiver's for a request -- `psiElementBounds`, `frameSize.ts`), read from the agreed terms and the exchanged record counts alone so both parties compute it identically and it never rejects a legitimate frame; on a response, which re-encrypts this party's own request, it is that request's element count (below).
  The second is the absolute `MAX_PSI_DECODE_ELEMENTS`, the protocol's per-set maximum of 2^24 elements ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)), which is what binds a cascade frame whose partner over-declares its record count (the authenticated bound alone is inflatable there, up to `MAX_RECORD_COUNT`).
  The third, on a cascade or count-only setup or request, which hold the partner's own set, is this party's receive ceiling, the figure it stated on the terms exchange ([PROTOCOL.md, The receive ceiling](PROTOCOL.md#the-receive-ceiling)).
  The scan reads only the stable protobuf wire format (never the library API) but assumes the message structure (the element list is top-level on a Request/Response, one submessage deep on a ServerSetup); an equivalence test pins the scan count against the library's and must be re-verified on an `@openmined/psi.js` upgrade.
  This is the raw-protobuf analogue of the WebRTC path's BinaryPack structure scan below, and it governs both transports (the web path sends the PSI frame as a `bin` whose size the WebRTC bound caps, but whose inner protobuf this scan is what bounds).
  A non-Raw server setup holds a single bounded byte blob rather than a repeated element list, so it cannot amplify; it is rejected downstream as a clean protocol abort (it is not the reveal-intersection Raw structure this protocol uses), not by the scan.

As net-new security behavior modifying the channel-hardening frame-size control, this is subject to the explicit security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy) before release.

### PSI set parts: the combined bound

A cascade or count-only round sends each PSI set in parts, each its own frame.
The receiver joins a request's or a response's parts before the element scan above, and scans a setup's part by part as it hands each to the engine's streamed match, never joining it ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts), where the header, the part size, and the refusals are specified).
The bounds that hold over partner content:

- **Each part is held to the per-frame bound.**
  A part is an ordinary frame at the transport read gate -- `MAX_FRAME_SIZE_BYTES` on file-sync, [`MAX_WEBRTC_FRAME_BYTES`](#webrtc-data-channel-inbound-bound) on the WebRTC data channel -- so splitting widens no per-frame bound.
- **The joined set is held to the authenticated record counts.**
  The first part declares the set's byte length, and the receiver refuses a length over `min(n, MAX_PSI_DECODE_ELEMENTS) * 35 + 6` (`psiSetByteBound`, `packages/core/src/psi/psiSetParts.ts`), `n` being the element bound `psiElementBounds` derives from the agreed terms and the exchanged record counts, before it allocates the buffer a set is joined into or hands any of a setup to the engine; a response is held to the request this party sent instead (below).
  Each party also holds a setup or a request, the sets that hold the partner's values, to its own receive ceiling there (below).
  Every later part must declare the same length and part count, and no part may run past that length, so across all parts a partner cannot make this party hold more set bytes than the counts admit.
  A sender refuses its own set over `MAX_PSI_DECODE_ELEMENTS` values, or over the receive ceiling the partner stated, before sending any part, with an abort in its place, so a conforming party's oversized set ends as its own too-large refusal rather than as this refusal on the receiver.
- **Missing, repeated, and out-of-turn parts are refused from the header alone**, each with a `ProtocolRefusalError`, and an abort frame in place of any part ends the round as a peer termination.
  None of these, nor any part after it, reaches the element scan, the decode or the engine.
- **A setup's element count is held part by part.**
  The element scan runs over each part of a setup as it arrives, carried from part to part, and a part that takes the declared count past the bound is refused before it reaches the engine, so the engine never holds more of the partner's setup elements than the bound admits.

While a request or a response is joined the receiver holds its buffer, and while a setup arrives the engine holds the elements of the parts before the current one; either way the receiver also holds the parts the transport has delivered but the round has not yet read; the inbound queue bounds the latter by count, as the [WebRTC data-channel inbound bound](#webrtc-data-channel-inbound-bound) states for every frame.

**A browser holds a partner's set to the measured ceiling.**
The combined bound admits a set of up to 587,202,566 bytes at `MAX_PSI_DECODE_ELEMENTS`, more than twice the 256 MiB browser-tab memory envelope the [wire-byte cap](#webrtc-data-channel-inbound-bound) justifies for one frame.
A browser party states a receive ceiling of `BROWSER_PSI_SET_MAX_ELEMENTS` = 8,388,608 on the terms exchange, the largest same-size round measured to complete in a browser tab in both PSI roles ([PROTOCOL.md, What a browser tab can match](PROTOCOL.md#what-a-browser-tab-can-match), [The receive ceiling](PROTOCOL.md#the-receive-ceiling)).
It holds a setup or a request to `min(n, MAX_PSI_DECODE_ELEMENTS, 8,388,608) * 35 + 6` bytes, at most 293,601,286, at the first part, before a joined buffer is allocated or any of a setup reaches the engine, and the set's declared element count to `min(n, MAX_PSI_DECODE_ELEMENTS, 8,388,608)` at the element scan above.
A set at the ceiling is past one frame, so the partner sends it in two parts, each held to the per-frame bound; the set the browser holds is then up to 293,601,286 bytes, above the one-frame envelope, and that size is what the measured rounds held.
A declared length over the combined bound stays a `ProtocolRefusalError`; one within it but over the ceiling is refused as this party's capacity, a `RoundCapacityError` with the fixed abort reason sent to the partner, before any allocation either way.

- **The ceiling is measured in both roles.**
  The browser's engine sizes each masking call to its memory budget and holds the setup at a fixed slot per element (below).
  A same-size round completed in Chromium at 8,388,608 a side with the browser as the starter and as the joiner, on a host with 31 GB of memory; at 10,000,000 a side the joiner completed and the starter's worker ran out of JavaScript heap answering the partner's request.
  The rounds handed each set to the tab directly rather than over the data channel, so the two-part receive at the ceiling is outside what they measured ([PROTOCOL.md, What a browser tab can match](PROTOCOL.md#what-a-browser-tab-can-match)).
- **A response is held to the request this party sent.**
  A response re-encrypts the request element for element and drops the request's framing, so it is never longer.
  A receiver refuses a response whose declared length exceeds the byte length of the request it sent, naming both lengths, at the first part before it allocates the joined buffer, and again before decode, where the element scan holds the response to the request's element count (`participant.ts`).
  A response arriving when every request this party sent has already been answered, or before it sent any, is refused.
  A partner can therefore make a party allocate no more for a response than the request that party built itself, below any receive ceiling it stated.
- **The command-line application states the protocol's maximum** as its receive ceiling, so it holds every set to the combined bound, and its memory below that is checked against the partner's record count rather than stated ([FILE_SYNC.md, The partner's round](FILE_SYNC.md#the-partners-round)).
- **The ceiling a partner states bounds only what this party sends it.**
  A partner that states a ceiling above what it can hold meets its own receive checks; one that states a ceiling below the truth only stops an exchange it is party to.
  Either party's receive checks read its own ceiling, never the partner's statement.

### Matched-record lists in parts: the aggregate bound

A cascade sends each list naming matched records -- a mapped-element list, the returned list, and the payload rows -- in parts, each its own frame ([PROTOCOL.md, A list of matched records is sent in parts](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts), where the header, the part size, and the refusals are specified).
The bounds that hold over partner content across the whole list:

- **Each part is held to the per-frame bound.**
  A part is an ordinary frame at the transport read gate -- `MAX_FRAME_SIZE_BYTES` (536,870,888 bytes) on file-sync, [`MAX_WEBRTC_FRAME_BYTES`](#webrtc-data-channel-inbound-bound) (268,435,456 bytes) on the WebRTC data channel.
- **An index list's part is held to its entries' bytes.**
  A part of either mapped-element list is refused, before its body is parsed, past the bytes the entries it can still hold take at their longest, a bound PROTOCOL.md derives from the agreed terms and the record counts ([The bytes a receiver admits](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts)).
  The transport has read the part whole by then, so this bounds what is parsed, not what the transport reads; a payload part has no such bound.
- **The receiver holds one unparsed part at a time.**
  Each part's header is checked and its body parsed as the part arrives, before the next part is read (`receiveMatchedListParts`, `packages/core/src/psi/matchedListParts.ts`).
  The unparsed bytes a list holds at any moment are therefore at most one per-frame bound, whatever its part count, and a part refused on its header or its body ends the receive at that part.
- **The parsed list is held to the declared entry count.**
  The first part's declared entry count is held to the bound PROTOCOL.md derives from the agreed terms and this party's own result, and the part count to at most that entry count (1 for an empty list).
  Every part of a non-empty list holds at least one entry and no part runs past the declared count, so the parsed parts hold at most that many entries between them, each part parsed under the [application-layer parsed-input bounds](CHANNEL_SECURITY.md#application-layer-parsed-input-bounds).

Frames the transport has delivered but the receive has not yet read sit in the inbound queue, which bounds them by count, as the [WebRTC data-channel inbound bound](#webrtc-data-channel-inbound-bound) states for every frame.
`packages/core/test/psi/matchedListParts.test.ts` drives a refused part ending the receive before the next is read, and a part parsed before the next one arrives.

### The streamed match and masking chunks: no wire change

The joiner's engine matches with the streamed match, fed the setup's parts as they arrive and the response in pieces, and a PSI worker on the WebAssembly engine masks in chunks sized to a fixed engine memory budget ([PROTOCOL.md, The single-pass dataset ceiling: receiver memory and masking compute](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute)).
Each is the receiving engine's own call pattern:

- **No wire bound changes.**
  Every frame, its bytes and their order are what an engine running each operation as one call sends and receives, so the per-frame bound, the combined bound and the receive ceiling above hold as stated.
  The association table the streamed match returns is put in the order the library's one-call match returns it before the joiner sends it.
- **Nothing more is disclosed.**
  The count-only response, which holds the byte-order shuffle, is fed to the streamed match whole and in its own order; the engine counts the setup elements it marks once the whole response is fed, and no per-piece count leaves it.
  The result equals the one-call result ([PROTOCOL.md, PSI-C](PROTOCOL.md#psi-c)).
- **The engine reads the partner's bytes itself.**
  The streamed match's reader walks the setup and the response across piece boundaries and refuses any field but an element entry, an entry over 33 bytes, an over-wide length, bytes after the setup's one `Raw` data structure, and a setup or response ending inside an entry.
  A refused setup is discarded.
  The element scan has bounded the setup's element count before each part reaches the reader.
- **A setup not strictly ascending is refused.**
  The streamed match refuses it as the setup arrives, at the piece that shows it and before the joiner sends its request, as a protocol error whose text holds no partner bytes ([PROTOCOL.md, The single-pass dataset ceiling: receiver memory and masking compute](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute)); the check is linear in a count the element scan has already bounded.
- **The streamed match decrypts the response once.**
  Its cost follows the response's element count, which the request this party sent bounds, whatever the partner sends.
- **A partner's request size sets only the number of masking chunks.**
  Answering a larger request takes more chunks, not more curve operations: each element is masked once.

## Directory-listing bound

A companion transport-read control bounds the directory listing itself.
This one is independent of the AEAD layer and of file contents: the two parties rendezvous through a shared directory the adversary controls, and the transport's `list()` call enumerates it.
Left unbounded, a hostile filedrop/SFTP server admin can write a very large number of files, or files with very long names, and drive the listing to allocate an array and per-entry metadata proportional to the attacker-chosen directory contents.
This is the same memory-exhaustion impact class as the frame-size DoS, reached through a different vector (directory enumeration - entry count and name length - rather than a per-file body read).
The transport refuses a listing that breaches either of two bounds - more than **8,192 directory entries**, or any single entry whose filename exceeds **255 bytes** of UTF-8 - with the same kind of terminal, typed error as the frame-size bound (a `DirectoryListingBoundsError`, a `UsageError` subclass, exit 64).
The refusal fails the exchange rather than silently truncating the listing to the cap and processing it: against a hostile rendezvous directory, refusal is the safer default, since truncation risks dropping a legitimate exchange file an attacker buried under filler.

Both bounds are derived, not round numbers, and both comfortably exceed what a legitimate exchange produces.
The **8,192-entry** cap is set from a memory envelope: the worst-case at-cap allocation is the retained entries, each a name of up to the 255-byte limit plus per-entry object overhead, so the listing allocation is bounded to roughly 5 MiB.
Measured 2026-10-08 in the development container (Linux arm64) as heap retained after listing, a list of 8,192 files with 255-byte names retained about 645 to 650 bytes of heap per entry through the SFTP adapter against the in-process harness server, and about 360 through the local-filesystem adapter, so 5.1 MiB at most.
That is about two orders of magnitude below the 512 MiB single-frame budget the frame-size bound already governs, so directory enumeration cannot become the dominant memory vector.
It still exceeds the order-of-ten files a legitimate exchange produces (the two `-hello.json` files, at most one `-lock.json` or the `-ack.json` markers, transient `-joining.json` sentinels and `temp-*.tmp` writes, and the bounded set of PSI message frames) by roughly three orders of magnitude.
That leaves generous headroom for a retain-mode directory that accumulates message and ack files across many sequential exchanges before the operator rotates it (retention is an out-of-band operator responsibility).

The **255-byte** filename cap is the POSIX `NAME_MAX`, the per-path-component limit every mainstream filesystem enforces (ext4, XFS, APFS, NTFS).
It is measured in UTF-8 bytes rather than as a JavaScript string length, which counts UTF-16 code units and would admit a name of multi-byte characters up to three times the limit.
The longest filename a legitimate exchange writes - the ack marker of a timestamped message - is on the order of 120 characters, and a name longer than 255 cannot exist on a conformant filesystem.
So it is necessarily synthetic: the SFTP protocol imposes no name-length limit, so a hostile server can return such a name in a READDIR response even though its own filesystem could not hold it.
Both bounds are fixed constants rather than configurable options, for the same reason as the frame-size bound: a configurable cap risks an operator raising it high enough to reintroduce the DoS.

The bound is enforced at the transport `list()` layer in both adapters - the point before the listing is materialized - not at a higher layer that has already consumed it.
The local-filesystem adapter streams entries through `fs.opendir` (which yields entries in bounded batches) rather than `fs.readdir` (which materializes the whole directory into one array, on top of the per-file `stat` fan-out that follows).
The entry-count check therefore stops the walk - capping both the retained array and the stat fan-out - at the bound regardless of how many entries the directory holds.
The SFTP adapter does not delegate to ssh2-sftp-client's `list()` (which passes the directory path to `readdir`, accumulating the entire remote listing into one array before returning).
Instead it opens a directory handle and reads one server batch at a time through the low-level `opendir`/`readdir`/`close` protocol, applying the checks as entries arrive, so a single READDIR response - itself bounded by the SSH transport's maximum packet size - bounds the allocation to at most the cap plus one batch.
Guarding only the local adapter would leave the SFTP path - the one with the explicitly in-scope adversary, the server admin - exposed, so both adapters are bounded.

## Rendezvous symlink refusal

A companion control on the same partner-writable rendezvous directory refuses a symlink planted at an entry, rather than following it.
The two parties rendezvous through a shared directory an adversary can write into; in the filedrop / synced-folder case the partner's writes sync into the local operator's own copy of that directory.
An entry planted there as a **symlink**, if the transport followed it, would redirect a rendezvous read or write out of the directory to an arbitrary path on the local filesystem the partner does not otherwise control.
A followed read could pull a local file (a credential, an unrelated document) into the read path, and -- the sharper impact -- a followed write could truncate or clobber a local file outside the rendezvous directory with exchange bytes.
The directory's contents are partner-supplied but the surrounding local filesystem is the trusted operator's, so this is a partner-reachable path-redirection vector distinct in kind from the memory bounds above and the liveness bounds in [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md) (a confidentiality/integrity break, not a resource exhaustion).

The local-filesystem adapter refuses it at the open: every rendezvous read/write primitive -- `get()`, `put()`, and `createExclusive()` -- opens its target through `openNoFollow` (`localFSClient.ts`), which adds `O_NOFOLLOW` to the open flags, so an open whose final path component is a symlink is refused (POSIX `ELOOP`) rather than resolved to the link target.
This mirrors the `O_NOFOLLOW` temp-file discipline the credential and result writers use (see [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md#posix-write-discipline)).
`O_NOFOLLOW` is absent on Windows, where it drops from the open mask and leaves the open otherwise unchanged.
It refuses only a symlinked final *entry*, not an intermediate directory component, so a legitimately symlinked share root or mount point is still traversed and a rendezvous directory that is itself a mounted symlink is unaffected.

The critical control on the read path is not `O_NOFOLLOW` but the directory listing's own symlink filter.
`list()` enumerates through `fs.opendir` and retains only `Dirent.isFile()` entries (see [Directory-listing bound](#directory-listing-bound) above), so a symlink is dropped before its name is ever handed to `get()`, and every `get()` call site -- the poll loop's message reads and the rendezvous gate's hello read alike -- reads only a name the listing reported.
`O_NOFOLLOW` is the primitive-level safety check there, for a symlink swapped in at a name the listing already committed as a regular file, a time-of-check/time-of-use race the filter alone cannot close.
On the write path there is no such filter: `put()` and `createExclusive()` destinations are built from authenticated protocol state at predictable rendezvous names, never from a listing, so `O_NOFOLLOW` is the *primary* defense against a symlink pre-planted at one of those names, not a safety check.
`createExclusive()` additionally opens with `O_EXCL`, which already refuses any pre-existing entry -- a planted symlink included -- so its `O_NOFOLLOW` is redundant defense in depth on the same open.

Every exchange file is a regular file, and `openNoFollow` holds its opens to that.
Each open also passes `O_NONBLOCK`, which is absent on Windows and has no effect on a regular file.
After the open, `openNoFollow` `fstat`s the handle, and when the handle is not a regular file it closes the handle and refuses with a `UsageError`.
The read path therefore applies the listing's `isFile()` filter a second time on the handle it actually reads.
The lock joiner's `<id>-joining.json` sentinel is published temp-then-rename, the same as the hello (see [FILE_SYNC.md](FILE_SYNC.md)).

The control is scoped to the local-filesystem adapter.
The SFTP adapter resolves every path on the server, where the server admin is already the in-scope adversary with full control of the files it serves (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model)), so a server-side symlink grants no capability the threat model does not already cede.
The local-filesystem adapter is the one case where the rendezvous directory's contents are adversary-supplied while the surrounding filesystem is the trusted operator's.

## WebRTC data-channel inbound bound

The [Web signaling surface bounds](SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds) cover the signaling *socket* -- the broker the two browsers rendezvous through.
The PSI payload itself never crosses that socket: it flows peer-to-peer over the WebRTC *data channel*, which is the surface this bound covers.
The adversary here is the exchange counterparty, a mutually-distrusting peer (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model)) -- authenticated by the P-256 handshake, but free to be hostile or buggy thereafter.
The data channel is end-to-end confidential under DTLS, so neither the broker nor a TURN relay is in scope; the peer is.

No existing control reaches this transport.
The web path discards the rotated key and declines the application-layer AEAD wrap under DTLS (`apps/web/src/psi/authenticateExchange.ts`, `requestEncryption: false`), so core's `EncryptedMessageConnection` and its ~512 MiB `MAX_FRAME_SIZE_BYTES` envelope -- a file-sync transport control -- never bind on the web path.
(If deferred web-encryption work ever forces the AEAD wrap on, that envelope would come into scope and could subsume part of this need; while the wrap is declined, this control stands on its own and waits on no encryption rework.)
The only inbound limiters that do apply are core's count/structure bounds on the *parsed* payload-exchange message (the web wire is BinaryPack, not JSON, but those bounds act on the deserialized structure either way) and the `QueuedMessageConnection` message-count capacity -- none a byte-size bound.
The large raw PSI set frame -- one party's full encrypted set as raw elliptic-curve points, **35 bytes per element** on the wire (see [PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)) -- is sent as a single binary `Uint8Array` that, left unbounded, PeerJS reassembles with no byte cap.

The control is in two halves.
Its transport-agnostic half -- the fixed constants below and the `scanFrameStructure` structural pre-scan they parameterize -- lives in `@alcove/core` (`packages/core/src/connection/binaryPackBounds.ts`), so every WebRTC transport enforces one implementation of them rather than a per-transport re-derivation.
Its transport-coupled half -- the wrapping of a specific reassembler's internals, which is where the bounds are actually applied -- lives with that transport: for the web that is `apps/web/src/psi/transport/boundedReassembly.ts`.
The control bounds the receive path on several axes, each a fixed constant (not a configurable option, since a configurable bound risks being raised to reintroduce the denial of service) and each fail-closed with a terminal `protocol` `ConnectionError` -- the same class as core's inbound-buffer overflow, since every bound sits far above any legitimate frame so an over-bound frame is never benign.
Each refusal names the rule that fired -- the nesting-depth cap, the per-string cap, the byte-backed-elements check, the cumulative element rule, or the map-key rule -- so the failure an operator (or a support thread) reads identifies the control that refused the frame.
The wording of those five rules is rendered once in `@alcove/core` (`describeFrameStructureRefusal`), so both transport halves word each of them identically, and is composed from that rule's own fixed limit: no length, count, depth, or byte the peer chose reaches an operator through it.
(The wire-byte and chunk-count caps below compose their own predicates at each transport, from the same fixed limits.)
PeerJS chunks a binary frame larger than its ~16 KiB MTU into slices and reassembles them in `_handleChunk` (accumulating slices keyed by message id, `_chunkedData`), and `unpack`s every frame -- an unchunked one directly, or the reassembled buffer on completion -- into a JS structure in `_handleDataMessage`.
It has no cap on any of total wire bytes, deserialized structure size, retained chunk count, or concurrent reassemblies, and no eviction of a never-completed partial.
`boundChunkReassembly` wraps *both* methods to add all of these *before* delegating to the original, so the offending chunk is never stored and the offending frame is never unpacked.
Wrapping `_handleDataMessage` -- the sole unpack point, which both an unchunked frame and the reassembled-completion path flow through -- rather than only `_handleChunk` is critical: the deserialized-structure attack below needs only a tiny frame, which is sent unchunked and never reaches `_handleChunk`.

**Chunk envelope shape.**
Every field of a chunk envelope is peer-chosen, and PeerJS stores a slice as `new Uint8Array(data)`, which for a number or a numeric string allocates a zero-filled buffer of that many bytes.
So before any bound below charges a chunk, the wrap refuses an envelope whose message id is not an integer, whose chunk count is not a positive integer, whose index is outside that count, or whose `data` is not binary (a typed-array view or an `ArrayBuffer`) or is empty.
The binary test is a brand check, not a prototype check: BinaryPack's `unpack` assigns a map's `__proto__` key as the decoded object's prototype, so a plain object can inherit from a real `ArrayBuffer`.
This is the same shape rule the CLI's reassembler applies, and a shared fixture set drives both transports so they refuse the same envelopes.
The charge itself fails closed: a charge or running total that is not a finite number refuses the chunk rather than comparing false against the cap.
So does any throw during chunk handling, which fails the connection rather than leaving it open to the next chunk.
Within one frame the wrap also refuses a chunk whose count differs from the frame's first chunk, or whose index was already received: PeerJS keeps the first count and completes a frame on the number of chunks received, so either would complete it with a hole or a missing tail.
The CLI's reassembler refuses the second count too, but drops a repeated index rather than refusing it, since it completes a frame only once every distinct index has arrived.
A refusal releases every partial the wrap is tracking.

**Wire-byte cap.**
A running total of bytes across all in-flight reassemblies is bounded by **`MAX_WEBRTC_FRAME_BYTES` = 268,435,456 (256 MiB)**; a slice that would push it over fails closed rather than allocating proportional to the peer-chosen size.
The total spans every in-flight reassembly, so this single bound caps a single oversized frame, a single big never-completed partial, and the aggregate of concurrent partials alike.
Like the file-sync frame-size cap it is a chosen memory bound rather than a derived platform ceiling, but sized against a different envelope: this one is a browser-tab *memory envelope*, in the spirit of the directory-listing cap -- above the realistic largest legitimate frame, below a tab-crashing allocation.
The largest legitimate inbound frame is the raw set frame above, sent as binary with no base64url 4/3 inflation (both this wire and the file-sync wire send a frame as raw bytes).
The 200 MiB CSV upload cap (`MAX_CSV_FILE_BYTES`) admits about 6.3 million unique key values at the narrowest measured row shape, about 210 MiB at 35 bytes per element, and a unit test holds that set inside this cap; a file narrower than any measured -- one short identifier column, or a `split_on` fan-out of several elements per row -- can produce a set frame over this cap below the upload cap.
The party holding such a set refuses it before sending when it is the first round's, and sends a later round's in parts each within this cap (_Sender-side sizing_ below), so this bound meets a larger frame only from a partner that does not size its frames.
So 256 MiB -- which at that element size admits about 7.67 million elements -- sits above any realistic set while half the file-sync 512 MiB cap in deference to the tab's smaller heap.
This counts *wire* bytes; what those bytes unpack to is a multiple of them, stated next.

**Sender-side sizing.**
Each WebRTC transport also states this bound for its own sends (`outboundWebRtcFrameBound`: the web app's `openPeerMessageConnection` and the CLI's `webRtcMessageConnection`, each returning the bound its receive path applies), and a party weighs its PSI set frames against it before they go on the wire -- once at the start of the exchange from the count of its first round, refusing a set that cannot fit one message, and at every round by sending each set in parts each within the bound ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)).
A connection wrapped by the channel-encryption layer (`EncryptedMessageConnection`) states the same bound and adds its envelope's bytes (`outboundFrameOverheadBytes`) to each frame's length before the check, since the envelope is on the wire too.
What each check weighs, and the charge that makes a frame the sender admits one no receiver refuses, are specified in [PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap).
The refusal is the sender's own and holds no partner-authored text: its figures are frame sizes and the fixed bound.

**Deserialized-structure rules.**
The wire-byte cap does not by itself say what a frame retains, because BinaryPack `unpack`s a frame into a JS structure _synchronously, before delivery and before any schema validation_, and that structure is a multiple of the wire.
BinaryPack encodes an empty object or array in one byte but `unpack` allocates a real JS value per element; an `array32` header eagerly allocates `new Array(N)` for its declared count _even when the elements are absent_, because `unpack` reads past the end of the buffer as zero rather than throwing; and `unpack_string` builds a string one code point at a time, leaving a cons-string tree per character.
So a small frame of object/array headers -- an in-protocol shape, since the association-table and mapped-element frames are arrays of numbers/objects -- deserializes to far more than its wire size.

Before delegating to `unpack`, `scanFrameStructure` walks the frame's BinaryPack bytes and refuses it on any of five rules:

- **Nesting depth**, above **`MAX_WEBRTC_REASSEMBLY_DEPTH` = 256**.
  This bounds the scan's own working stack, and with it the number of levels that can each reserve a backing store over the same wire bytes.
- **Per-string declared length**, above **`MAX_WEBRTC_STRING_BYTES`**, which is the web app's CSV intake cap `MAX_CSV_FILE_BYTES` (`apps/web/src/components/csvIntake.ts`).
  A payload cell is not length-bounded upstream -- only column names are (see [Linkage-terms name-class character rule](CHANNEL_SECURITY.md#linkage-terms-name-class-character-rule)) -- so a cap below the intake cap could refuse a cell that reached the wire from an admitted file, while a cap at it bounds one value's retention at the largest file a party can bring.
  The two constants are held equal by a unit test, core having no import of an app.
  That sizing answers the browser dropzone, whose gate counts bytes; the other two input paths are bounded differently, and the cap covers them only as far as their own bounds reach.
  The CLI reads its input file from disk under no file-size gate at all -- what bounds a row there is the 8 MiB [single-line byte ceiling](CHANNEL_SECURITY.md#csv-read-single-line-byte-ceiling), which a quoted field of embedded newlines does not trip -- and the job-intent route bounds a request body at `MAX_JOB_BODY_BYTES` (424 MiB) while `MAX_INPUT_CSV_LENGTH` counts UTF-16 code units rather than bytes.
  A cell that reaches the wire from either path above 200 MiB of UTF-8 is refused by the receiving party's scan: a stated limit of what the cap's sizing covers, not a hole in the rule.
- **Byte-backed elements**: no container may declare more elements than the bytes that follow it can encode, each element needing at least one byte.
  This ties a container's declared count to the wire.
- **Cumulative elements**: the containers of one frame may not declare more elements between them than the whole frame's bytes can encode.
  This is what ties the frame's total declared count to the wire, which the per-container rule alone does not: nested containers can each be byte-backed against the same trailing bytes, and `unpack_array` reserves the declared width once per level, so 200 levels declaring 700,000 children over 701,000 wire bytes reserve 1.12 GB (1,598x).
  A legitimate frame always satisfies the sum, because each declared child is a value of its own that costs at least one wire byte to encode; the largest frames Alcove sends declare about a quarter of their wire bytes (see _The largest legitimate frames_ below).
- **Map keys**: a map key that is not a string on the wire is refused rather than read.

The walk reads only container headers and payload lengths -- never materializing the payload, so it skips a large binary set frame in O(1) -- and refuses at the offending header before `unpack` allocates.
A read past the end (a truncated frame that passed the rules) is delegated: the bytes past the end unpack as zero-valued integers into stores an ancestor's declared count already committed, and PeerJS's own unpack errors on it.

_Why a map key is refused rather than read._
`unpack_map` assigns `map[key] = value`, so a key that is not already a string is retained as its _coerced string form_: a container key coerces to the joined string forms of every value below it, including the declared descendants `unpack` zero-fills past the end of the buffer.
That name's size grows with what the frame _declares_, not with the bytes it spends -- a sub-megabyte frame of nested `array32` headers at a key position coerces into a property name of hundreds of megabytes, an amplification the differential suite measures on the real unpacker.
The scan therefore refuses the frame the moment it reads a map key whose marker is not a string marker, deciding on that marker byte alone, before descending into the key, so a truncated frame cannot get one past the check.

Refusing is safe because no legitimate frame holds such a key: the pinned packer emits a map only for a plain JS object, whose own keys are strings by construction, and refuses a `Map` or `Set` outright.
That is a dependency assumption, so it is enforced as a check rather than recorded here alone -- the differential suite packs every value Alcove sends on the data channel with the real packer and requires the scan to accept each (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md)).

_The envelope these rules leave._
The cumulative element rule admits at most one declared node per wire byte, so what an admitted frame retains is **(its wire bytes) x (the worst retention of one declared node)**.
Both quantities are measured against the pinned unpacker rather than modelled (`packages/core/test/connection/binaryPackRetention.test.ts`, run with `--expose-gc`; the figures below are from that harness on Node 26/x64, each frame decoded, measured, dropped and re-measured):

| Admitted value | Retained bytes |
| --- | --- |
| an empty `bin`, one wire byte | ~208 per declared node -- the per-value copy `unpack_raw` returns, and the worst of every one-byte marker |
| an empty `fixmap`, one wire byte | ~64 per declared node |
| an empty `fixarray`, one wire byte | ~40 per declared node |
| a declared array slot the wire does not fill | 8 per declared node |
| a string, whatever length it is split into | ~32 per wire byte -- the cons-string tree, per character |

A string is the one value whose retention is not per node, and its per-byte figure sits below the per-node worst, so the per-node worst is what the envelope multiplies by: **about 208x the admitted wire bytes**, or **52 GiB at the 256 MiB wire cap**.
That is a stated, measured limit and not a promise that the receiving tab survives every frame these rules admit -- 52 GiB is far more memory than a browser tab has.
What the control does is make a frame's retention a stated multiple of its wire bytes, and refuse the shapes whose retention no wire quantity bounds at all: a coerced map key, and a nested chain that re-reserves the same wire bytes at every level.
The exchange partner is an authenticated party under a signed legal agreement who can abort the exchange at will, so what remains is availability defense in depth; the only lever that would tighten it further is a cap on non-binary wire bytes below the 256 MiB the binary set frame needs.

_The shape that reaches it._
It is a flat frame rather than a nested one.
An `array32` of empty `bin` markers spends one wire byte per value, exactly the density the cumulative element rule admits, so a frame filling the wire cap -- 268 MB -- declares 268,435,451 of them and retains ~52 GiB.
No rule below the wire cap constrains it: the cumulative rule is a bound on declared nodes per wire byte, and one node per byte is the shape that meets it.
That is the stated limit of this control, accepted rather than closed -- the party who can send it is the authenticated counterparty, who can end the exchange outright at any point, so the defense sized against it is depth rather than a memory guarantee.

_The largest legitimate frames._
Measured the same way, once rather than as a standing check (a frame this size is too large for the unit run), at the single-pass ceiling (`MAX_SINGLE_PASS_CELLS`, [PROTOCOL.md](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute)) with 3,000,000 records: the mapped-element frame (`Array<{theirIndex, iteration}>`) is 84.0 MB of wire retaining 192 MB (2.3x), a payload frame of 3,000,000 short cells is 48.0 MB retaining 287 MB (6.0x), and an association table of the same width is 30.0 MB retaining 48 MB (1.6x).
All three sit inside the wire cap with room to spare, and none is near the amplification of the hostile shapes above -- a legitimate frame spends its wire bytes on values rather than on declarations.
They sit as far inside the cumulative element rule.
Measured at that ceiling, the mapped-element frame declares 0.18 elements per wire byte, the payload frame's rows array -- the tightest part of that message, and the part the check builds -- 0.29, and the association table 0.20, so the narrowest of the three has a factor of 3.5 of headroom against the one-per-byte the rule refuses at.
That margin is held as a standing check rather than only recorded here: `packages/core/test/connection/binaryPackBounds.test.ts` builds all three shapes at two record counts with the real packer, packing each record index at the width it has at the ceiling, extrapolates each per-record slope to the ceiling -- a frame of that size being too large for the unit run -- and requires every shape to keep a factor of three, with the measured ratio in the assertion message.

**Retained chunk-count cap.**
Each receiver retains each chunk as its own `Uint8Array`, which holds several hundred bytes resident even for a one-byte slice, an overhead the wire-byte cap -- which counts only payload bytes -- undercounts, so a flood of tiny chunks could exhaust memory while staying under the byte cap.
Each chunk is therefore charged at least **`MIN_CHUNK_RESIDENT_BYTES` = 768** against the byte cap, and the chunks per reassembly -- both the count an envelope declares and the count retained -- are bounded by **`MAX_CHUNKS_PER_REASSEMBLY` = 131,072 (2^17)** -- ~8x the ~16,500 chunks a 256 MiB frame produces at the ~16 KiB (16,300-byte) MTU, so a legitimate frame is never rejected while a tiny-chunk flood is bounded.
Legitimate chunks (~16 KiB) far exceed the 768-byte floor; a frame's last chunk can be shorter, and the sender's own frame check charges it the same floor ([PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)), so the floor never refuses a frame the sender admitted.

_The floor's measurement._
The most chunks a receiver retains at once, with every cap in force, is `min(MAX_CONCURRENT_REASSEMBLIES * (MAX_CHUNKS_PER_REASSEMBLY - 1), floor(MAX_WEBRTC_FRAME_BYTES / MIN_CHUNK_RESIDENT_BYTES))`: a reassembly completes, and releases its chunks, at its declared count, so it holds at most one fewer than the count cap, while the byte budget is shared by every reassembly in flight.
Both receivers apply the same three caps, so the count is the same for each: `min(1,048,568, 349,525)` = 349,525 at the 768-byte floor.
The count cap holds one frame to 131,071 retained chunks, so a flood reaches that count across three or more concurrent reassemblies, and the byte cap refuses the next chunk.
The floor is set at or above the per-chunk overhead of a minimal (one-byte) chunk at that count.
Measured 2026-10-08 in the development container: resident set growth per one-byte chunk, after forced collections, past a warm-up phase that unpacked as many chunks and retained none (a control that retained none in the measured phase too grew 0 to 62 bytes a chunk).
The 349,525 row was measured with every cap at its default, chunks spread round-robin across three and across eight reassemblies, each declaring 131,072 chunks, until the byte cap refused one; it shows the larger of the two layouts.
The other rows lifted the count and byte caps to show how the cost moves with the count.

| Chunks retained | Node, CLI receive path | Chromium, web receive path |
| --- | --- | --- |
| 262,144 | 632 | 701 |
| 349,525 | 586 | 668 |
| 524,288 | 520 | 625 |
| 1,048,576 | 460 | 610 |

- **Node** (26.10): the CLI's datagram path, `toFrameBytes` then `BoundedInboundFrames.accept`.
  Driven over a real werift loopback data channel at 100,000 chunks it grew 972 and 1,029 bytes a chunk, and the same path fed in-process grew 1,005; the retained slice is a copy that never shares the delivered datagram's buffer, so the larger counts above were fed in-process.
  The V8 heap holds about 208 bytes of each chunk.
- **Chromium** (151.0.7922.34, Playwright's headless shell): two peer connections in one page, the receiving end PeerJS's binary `DataConnection` with `boundChunkReassembly` installed, fed each message as PeerJS's own listener does; renderer resident set from `/proc`.
  The V8 heap holds about 127 bytes of each chunk, and reverse chunk order retains the same (661 bytes for 349,525 chunks of one frame, with the count cap lifted).

The cost per chunk falls as the count grows, so the figure that bounds the floor is the one at the most chunks a receiver can retain: Chromium's 668 bytes at 349,525; the floor is 15% above it.
A flood of one-byte chunks that fills the cap holds about 234 MB resident in Chromium and 205 MB in Node, against the 256 MiB cap.
A floor of 256 bytes let the count cap bind instead, at 1,048,568 chunks, about 482 MB resident in Node and 640 MB in Chromium.
`binaryPackBounds.test.ts` (core) computes that count from the constants and holds the floor at or above the figure measured at the nearest count at or below it.
The floor must also not exceed the last chunk's charge on the largest frame a sender admits, `MAX_WEBRTC_FRAME_BYTES` modulo a full chunk's charge, 841 bytes; above it the floor would lower that frame, and `webrtcOutboundBound.test.ts` (core) holds the floor at or below it.

_A limit of the floor._
The charge is max(length, floor), so a chunk just under the floor holds its payload plus a fixed overhead of about 600 bytes beyond its charge.
The measured worst case on the CLI path is about 466 MB resident at 349,525 chunks of 735 bytes (2026-10-08), about 1.7 times the 256 MiB budget.
Charging length plus overhead would close it, but it lowers the largest admitted frame and the browser receive ceiling.
This is a stated limit of the control, accepted rather than closed.

**Concurrent-reassembly cap.**
The number of concurrent incomplete reassemblies is bounded by **`MAX_CONCURRENT_REASSEMBLIES` = 8**; a new message id beyond the cap evicts the oldest incomplete partial (deleting its `_chunkedData` entry and releasing its bytes).
The PSI protocol is strictly lockstep (see [PROTOCOL.md](PROTOCOL.md)) and the data channel is reliable and ordered, so at most one frame is ever mid-reassembly on an honest exchange.
8 is generous headroom, and the cap bounds a flood of partials from many distinct ids -- the metadata-overhead case the byte running-total does not catch, since many tiny partials stay under it.
Eviction is silent and non-fatal: a legitimate exchange never has a second partial, so eviction only drops adversarial data, and logging per eviction would itself be a spray-amplified log-flood vector.

**Datagram shape.**
Before the structural scan, both transports refuse a datagram that is not binary and one of zero length: a data channel types each message on its own, so a text message can arrive on a binary channel, and BinaryPack decodes a text or an empty message to the number `0` (measured in Chromium) rather than refusing it.
Both also refuse, rather than drop, a frame the real unpacker throws on, such as a string declaring more bytes than the frame holds, which the scan admits as a read past the end.
Only a throw from the unpack call itself is refused this way: the web wrap decodes each frame itself and then routes it as PeerJS would, and a throw from a `data` listener or from PeerJS's close fails the connection with that error behind a `transport` wrap, keeping its own class rather than reporting a frame the peer did not send.
Each refusal is a `protocol` failure worded the same on both transports (`the peer sent a malformed WebRTC frame: ...`); the shared parity fixtures (`WEBRTC_MALFORMED_DATAGRAM_FIXTURES`, `packages/testkit/src/webrtcInboundFrames.ts`) hold both transports to the four shapes, and `apps/web/test/browser/webrtcInboundDatagramShapes.test.ts` sends them over a real data channel.

**Delivered-frame safety check.**
Finally, at the stable `data` event (`checkDeliveredFrameBound`): a fully delivered binary frame (a `Uint8Array`/`ArrayBuffer`) over the byte cap is refused there too, regardless of how -- or whether -- PeerJS chunked it, so the bound holds at the public layer even if the internal reassembly assumption below ever breaks.
A parsed object/array is not byte-measured here (the reassembly bounds above govern it before delivery, and core's count/structure bounds after); only binary frames are, which is exactly the raw set frame this is sized for.

The bounds above are *per frame*.
A delivered frame is then queued in core's `QueuedMessageConnection`, whose capacity is a message *count* (`DEFAULT_CAPACITY` = 1024), so the aggregate retained across queued-but-unconsumed frames is in principle the per-frame envelope times that depth.
The queue is **a count bound** rather than a byte one: the lockstep protocol drains one frame before sending the next, so the queue sits at depth ~1 in practice, and a peer that floods frames out of turn trips the count capacity (a `protocol` failure) rather than accumulating.
So the theoretical per-frame x depth aggregate requires both proportional wire bytes per frame *and* the consumer to stall, and is the count capacity's concern rather than this control's.
A byte-aware queue bound (or a smaller web-transport capacity) would close the theoretical multiplier but buys little against a practical depth of ~1.
Unlike the per-frame scan, whose constants are WebRTC-specific, it would land on `QueuedMessageConnection`, which every transport shares, so it is a decision about all of them rather than this one, better made when a transport actually needs it.
The per-frame rules and the wire cap are therefore what state the byte envelope; the queue stays bounded by count.

The wrap reaches past the public `DataConnection` API into PeerJS internals, so it rests on two dependency assumptions a `peerjs`/`peerjs-js-binarypack` upgrade could silently break.
The first is the reassembly/unpack shape on the binary/chunked connection class (the one `peer.connect` and an incoming connection use by default): `_handleChunk` reassembling slices keyed by `__peerData` into `_chunkedData` and deleting the entry on completion, and `_handleDataMessage` as the sole point each frame is unpacked (an unchunked frame directly, the reassembled buffer via the completion recursion), which the wrap replaces with its own unpack and a copy of the close/chunk/`data` dispatch that follows it.
This is encoded as a runtime check, not a comment: `assertChunkReassemblySupported` (called before any listener is attached) throws at install time if any of those internals are absent, so the live browser exchange test -- which installs the guard on every web exchange -- fails loud rather than running with no inbound bound.
The second is the BinaryPack wire format the structural scan parses (the marker dispatch in `peerjs-js-binarypack`'s `Unpacker.unpack`: fixint/fixraw/fixstr/fixarray/fixmap and the `0xc0`-`0xdf` markers, with maps declaring two child values per pair).
A format change there would not silently disable the bound -- a misparse either refuses the frame early (fail-closed) or runs the cursor off the end (treated as a malformed frame and delegated to the unpacker, which would itself error); it never admits a frame it did not walk -- but it would weaken the scan's precision, so re-verify the marker table on a `peerjs-js-binarypack` bump.
On a `peerjs` bump, re-verify both assumptions.
