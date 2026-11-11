---
title: "PSI round memory and set size limits"
---

# PSI round memory and set size limits

This document specifies the memory bounds of a PSI round on the command-line application: the one bound on a round's set size on the file-sync channels, the heap ceiling the PSI worker runs under, the checks that refuse a run before contact and before each frame is read, and the measured per-element costs those figures rest on.
It does not cover the file-sync state machine, its filenames and its enforcement sites (see [FILE_SYNC.md](FILE_SYNC.md)), the transport-level frame and reassembly bounds (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md)), or the single-pass and browser ceilings (see [PROTOCOL.md](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute) and [PROTOCOL.md](PROTOCOL.md#what-a-browser-tab-can-match)).
Intended readers are developers and designers.

## Round set size limits

A linkage key round sends its set of values as one PSI message, in as many message files as the set needs ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)). One bound caps how many values the first round's set can hold on the file-sync channels. It is not configurable. A single-pass exchange sends one set a party in one message and is held to the reply's fixed widths instead ([PROTOCOL.md, The limits over file-sync](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute)).

- **One PSI set: 16,777,216 values.** The protocol's per-set maximum, `MAX_PSI_DECODE_ELEMENTS` = 2^24 ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)). Every sender refuses a set of its own over it before sending any part, and every receiver refuses a set declaring more. A file-sync exchange at the maximum completes with one party on each of two hosts, in about 64 minutes on the hosts measured, the starter peaking at 29.9 GB and the joiner at 22.5 GB or more ([Measured runs at 2^24](#measured-runs-at-224)).

A set is sent in as many message files as it needs, each part's file filled to `MAX_FRAME_SIZE_BYTES` (536,870,888 bytes; [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md#inbound-frame-size-bound)) as described below, so a set at the per-set maximum takes two ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)). A set of `n` values takes at most `n` times `PSI_ENCODED_ELEMENT_BYTES` (35: a 33-byte compressed point plus its protobuf tag and length) plus `PSI_SET_MAX_FRAMING_BYTES` (6), the most a PSI message adds to its elements. The framing is measured on the vendored library: a server setup adds 5 bytes at 10^6 values and 6 from 7,669,585 values up, where its element list's length prefix reaches 5 bytes; a request adds 2 and a response none.

**Deduplication holds any number of distinct values.** A round keeps one map entry per distinct value, and a V8 `Map` holds at most 2^24 entries: on Node 26.10, inserting the 16,777,217th entry throws `RangeError: Map maximum size exceeded` (a `Set` stops at the same count). The round's deduplication and the first-round count below therefore index their values in shards of 2^24 (`DistinctValues` over `ShardedMap`, `packages/core/src/utils/distinctValues.ts` and `packages/core/src/psi/shardedMap.ts`; the index itself is described under [The practical input bound](#the-practical-input-bound)), filled in turn so the round's values keep their row-major order ([PROTOCOL.md, The per-round grouping the two frames hold](PROTOCOL.md#the-per-round-grouping-the-two-frames-hold)). The record verifier's index of the input's identifier column is sharded the same way (`reconstructCommittedData`, `packages/core/src/records/recordVerification.ts`), so a record over an input of more than 2^24 rows verifies. No distinct-value count refuses a round; the per-set maximum is the binding limit on the first round's set.

**Where the limits are checked.** Before the transport is built, and so before any file is written for the partner, the command-line application counts the values this party's first round sends and refuses a count over the per-set maximum (`assertFirstRoundWithinSetMaximum`), in both PSI roles, the same count every channel takes ([PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)). The count follows this party's own terms: every distinct value when they set `deduplicate`, and otherwise only the values exactly one of its records holds. The check runs with the other refusals decided from local input, before the SFTP host-key step contacts the server. Where the count was taken, the refusal names it -- for a party that keeps its duplicates, the count at which it passed the bound, as the least the round sends -- the per-set maximum, and the remedy: split the input into smaller files and run one exchange for each. A later round's set is known only once the earlier rounds have matched, so it is not checked there; the round refuses a set of its own over the maximum before sending any part. A first round over one message file and within the maximum is written as several files.

**Every round sends a set in parts sized to the message file.** Each part's file -- the part, the AEAD envelope, and the file header -- is filled to `MAX_FRAME_SIZE_BYTES`, the bound the receiver's read gate applies (`psiSetPartPayloadBytes`, through the transport's `outboundFileSyncFrameBound`), so a set larger than one file is written as several rather than refused. The receiver's read gate still refuses any one file over that bound, and the joined set is held to the bound the agreed record counts admit ([PROTOCOL.md, A PSI set is sent in parts](PROTOCOL.md#a-psi-set-is-sent-in-parts)).

**The lists of matched records go in parts the same way.** Each round's association table, original-index list and groupings, and after the last round each party's mapped-element list, the list it returns with the partner's rows, and its payload rows go in parts whose message files are filled to the same bound, so no list is bounded by one message file ([PROTOCOL.md, A list of matched records is sent in parts](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts)).

**Measured run past the `Map` limit.** In the development container (10 cores, 23 GB, Node 26.10, default heap), with other workloads running beside it, deduplicating 2^24 + 1 distinct short values takes about 26 s dropping duplicates and 24 s grouping them, and counting them about 12 s dropping and 16 s keeping; the file's peak RSS, input included, is about 4.1 GB. `packages/core/test/stress/roundDedupPastMapLimit.stress.test.ts` holds these cases and the raw `Map` limit in the opt-in stress tier (`npm run test:stress -w packages/core`), about 90 s; the unit tier pins the shards at a lowered bound. `psiSetFraming.stress.test.ts` in the same tier builds a server setup of 2^24 values and holds its framing to `PSI_SET_MAX_FRAMING_BYTES`, about 10 s; the unit tier holds every PSI message of a few values within it.

## Memory a PSI round needs

A command-line party runs its PSI set operations in a `worker_threads` worker (`apps/cli/src/psiWorkerHost.ts`). At Node's default heap limit that worker runs out of heap well below the file-sync message-file bound above, so the CLI runs it under a heap ceiling sized from measured per-element costs, and refuses, before any network contact, a run whose input needs more memory than the process has. The constants and the check are in `apps/cli/src/psiMemoryBudget.ts`.

### The measured costs

Measured 2026-09-30 in the development container: aarch64 Linux, 10 CPUs, 23 GB of memory, Node v26.10.0, the native PSI engine in the CLI's own worker, one phase per process. Each figure is the least-squares slope of peak process RSS (the last row: peak worker V8 heap) against the set size `n`, above the process's own baseline. The runs past 5,242,880 elements ran with the heap raised.

| Operation | Bytes per element | Intercept | Runs |
| --- | --- | --- | --- |
| Joiner, full round (setup of `n`, response of `n`) | 1,176 | 209 MB | 4, from 2^20 to 2^23 |
| Starter, request received and response built | 983 | 80 MB | 4, from 2^20 to 2^23 |
| Setup decoded and held | 378 | 45 MB | 6, from 2^20 to 2^24 |
| Worker V8 heap, joiner full round | 709 | 298 MB | 3 |
| Single-pass sender's own setup, its creation's peak | 884 | none | 12, from 2^20 to 2^24 |
| Single-pass sender's own setup, what it adds to masking a 140,000,002-byte request | 401 | none | 12, from 2^20 to 2^24 |

The last two rows were measured on 2026-11-10 under Node v26.13.0, and each is the largest figure measured, not a slope ([The sender's own setup](#the-senders-own-setup), which also gives the WebAssembly library's figures).

The process holds 62 MB before it reads any frame. These are the PSI set operations alone: an exchange also holds its dataset, the round's value maps and the result, so the figures are a lower bound on a whole run.

**Node's default heap limit binds first.** On this build `v8.getHeapStatistics().heap_size_limit` is 4,395,630,592 bytes, the same in a worker as on the main thread. At that limit the largest symmetric round that completed was 5,242,880 elements a side; at 6,291,456 both the starter's request and the joiner's match failed with `ERR_WORKER_OUT_OF_MEMORY`.

### The budget

A round over `n` elements a side needs `271,000,000 + 1,176 * n` bytes: the joiner's full-round cost, the costlier role, plus the 209 MB intercept and the 62 MB baseline (`psiRoundMemoryNeedBytes`).

The heap ceiling is that need at the protocol's per-set maximum, 2^24 = 16,777,216 elements a side (`MAX_PSI_DECODE_ELEMENTS`, [Round set size limits](#round-set-size-limits)): **20,001,006,016 bytes** (`PSI_HEAP_CEILING_BYTES`), passed to V8 as `--max-old-space-size=19075` (`PSI_HEAP_CEILING_MIB`, the byte figure in MiB rounded up). A unit test holds the ceiling at or above the need at that maximum, so the two cannot drift apart. A browser partner's first round is smaller, held to its receive ceiling of 8,388,608 ([PROTOCOL.md, The receive ceiling](PROTOCOL.md#the-receive-ceiling)). V8 reserves heap as it is used, so a ceiling above the host's memory costs nothing by itself; the check below is what guards a small host.

### How the ceiling reaches the engine

- **An installed CLI** calls `v8.setFlagsFromString("--max-old-space-size=19075")` immediately before it starts the PSI worker, or, on a single-pass run, with the heap the counts need ([The worker's heap, from the counts](#the-workers-heap-from-the-counts)), unless the process already runs under a larger limit (`raisePsiWorkerHeapLimit`). A worker created after the call is created with that limit; the main thread keeps the one it started with. A unit test starts a worker through the production call and reads the worker's own `heap_size_limit`.
- **An installed CLI's main thread**, which reads and prepares the input, keeps the limit node started it with: the CLI never raises it and never starts a second `node`. A heap option the operator gives, in `NODE_OPTIONS` or on node's own command line, is honored as given. Before the input is parsed, the CLI refuses an input that limit cannot hold ([The main thread's heap](#the-main-threads-heap)), and the refusal names the `NODE_OPTIONS=--max-old-space-size=19075` setting the images use.
- **The container images** export `NODE_OPTIONS=--max-old-space-size=19075` in `docker-entrypoint.sh` before starting the CLI, which the FIPS variant's entrypoint also runs. It raises the main thread and the worker alike, and an operator's own `NODE_OPTIONS` follows it in the variable, so a larger value given with `docker run --env NODE_OPTIONS=...` takes precedence. A unit test runs the real entrypoint under the real shell with a stand-in `node` that reports both threads' limits.

Two other routes do not reach the worker on Node v26.10.0, driven in real Node:

- `resourceLimits.maxOldGenerationSizeMb` on the `Worker` leaves the worker's `heap_size_limit` at 4,395,630,592.
- `execArgv: ["--max-old-space-size=..."]` on the `Worker` is refused with `ERR_WORKER_INVALID_EXEC_ARGV`.

### The main thread's heap

Before it parses an input file, every command that reads one (`loadInputRows`, `apps/cli/src/onlineBootstrap.ts`) estimates the main thread's need from the file's record count and refuses, with a usage error (exit 64), an input whose need is over the main thread's `heap_size_limit` (`checkInputFitsMainThreadHeap`, `apps/cli/src/inputHeapCheck.ts`). Without the check such a run reads for minutes and then ends in a V8 abort (exit 134) with no message. The refusal states the record count and the file's size, the need, the limit, and the `NODE_OPTIONS=--max-old-space-size=19075` line to set, or a larger value when the need is over the ceiling, and names `--allow-memory-shortfall`, which turns the refusal into a warning on stderr and reads the input anyway.

- **The need** is 760 bytes a record (`MAIN_THREAD_HEAP_BYTES_PER_RECORD`). At Node's default limit of 4,395,630,592 bytes it admits 5,783,724 records, below the 6,500,000 measured to complete. The limit is V8's `heap_size_limit`, which counts the young generation's reserve beside `--max-old-space-size`; at a limit of several gigabytes the reserve is a few percent of it.
- **The record count** is the file's line count less the header, read without parsing. The parser takes one line ending from the start of the file -- LF, CRLF, or CR -- and reads the others as text, so the line count is the larger of the lines ended by an LF or a lone CR and the lines ended by a CR. A file too small to hold that many records at 2 bytes a record is not read. A quoted field holding a line break counts as an extra record, so the count is never under the parser's; a unit test holds it there for each ending.
- **Not checked:** an input read from stdin, and a path the check cannot stat or read, which the read itself then reports.

**The figure is a record count, not a file size.** At 1,000,000 records, four shapes of input were measured through the same stages: the four-column input below; the same with a 120-character free-text column; with six short code columns; and with a last name of about 40 characters. The file's size varied 4.4-fold; the peak heap varied by 8%. A figure in bytes of file would refuse the free-text input at a quarter of the records it holds.

| Input shape | File | Heap after the constraint pass | Peak heap |
| --- | --- | --- | --- |
| Four columns | 35.7 MB | 474 MiB | 881 MiB |
| With a free-text column | 156.6 MB | 725 MiB | 950 MiB |
| With six code columns | 51.4 MB | 548 MiB | 875 MiB |
| With a long last name | 72.7 MB | 631 MiB | 895 MiB |

**The wall it is calibrated to.** Measured 2026-10-04 in the development container (aarch64 Linux, 10 CPUs, 23 GB shared with other workloads, Node v26.10.0) at Node's default heap, no heap option given: the stages of `packages/core/test/stress/inputPreparation.stress.test.ts`'s probe, from reading the four-column input through the first-round count that walks every record (the count stands in for the first round's set, which the main thread builds next), one size a process. Heap figures are V8's `used_heap_size`, sampled every 250 ms.

| Records | File | Outcome | Heap after the constraint pass | Peak heap | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| 6,000,000 | 219.8 MB | completed | not sampled | 3,861 MiB | 4,069 MiB |
| 6,500,000 | 238.2 MB | completed | 2,614 MiB | 4,030 MiB | 4,210 MiB |
| 6,750,000 | 247.4 MB | out of heap during the count, exit 134 | 2,905 MiB | 4,091 MiB | 4,243 MiB |
| 7,000,000 | 256.6 MB | out of heap during the count, exit 134 | 2,991 MiB | 4,093 MiB | 4,242 MiB |

`apps/cli/test/stress/mainThreadHeap.stress.test.ts` holds the figure in the CLI's opt-in stress tier: at Node's default heap, with `NODE_OPTIONS` cleared, an input of the records the check admits passes the check and completes the CLI's read, the preparation, the constraint pass and the count. On the host above, an input of 5,940,041 records, the count 740 bytes a record admits, completed in 758 s at a peak heap of 4,157,901,960 bytes of the 4,395,630,592 limit and a peak RSS of 4,379,045,888 bytes; the figure admits 156,317 fewer records than that run. A unit test holds the records the figure admits at the measured default limit at or under 6,500,000.

**Limits of the figure.** It is measured for the four-column shape only. A wider or longer record keeps more of the main thread's heap after the constraint pass (725 MiB at 1,000,000 records with the free-text column, against 474 MiB), so such an input can run out of heap below the count the check admits. It covers the main thread through the first-round count, not the rest of the run.

### The pre-contact check

Every exchange-running command (`alcove exchange`, zero-setup, the online `invite`, and an `accept` in the URL or `endpointRun` mode) logs one line before any network contact stating the heap limit the PSI engine runs under, the memory a round over this party's input needs, and the memory the process has (`checkRunMemoryBudget`, `apps/cli/src/run/prepare.ts`). With the engine in a worker, the line states the worker's limit and the main thread's measured `heap_size_limit` separately. It runs with the other refusals decided from local input, on every command before the first-round size check: the check reads only the record count, while the count walks every record, so a host short of memory is refused without waiting for it.

- **The need** is `psiRoundMemoryNeedBytes` of this party's own record count, known before contact.
- **What the process has** is the least of three figures: the heap limit of the thread that runs the engine (the raised worker limit, or the process's own when no bundled worker is present), the host's total memory (`os.totalmem()`), and the container's memory limit as Node reports it (`process.constrainedMemory()`, the cgroup limit), counted only when it is below the host's memory.
- **A need over it is refused** as a usage error (exit 64) naming both figures, which of the three limits it, and the remedies: more memory, a smaller input, or `--allow-memory-shortfall`.
- **`--allow-memory-shortfall`** turns the refusal into a warning, on stderr and on the event stream under `memoryShortfall` ([CLI_EVENTS.md](CLI_EVENTS.md#warning-sources)). The statement line is logged either way.

The need for a small input is the 271 MB fixed part plus about 1.2 KB a record: a thousand records need 0.27 GB, which a unit test holds passing against a 512 MB container limit. A container memory limit below about 272 MB therefore refuses every run until `--allow-memory-shortfall` is given; the fixed part is not lowered for small inputs because it is the measured fit's intercept plus the process's baseline, not a margin.

### The partner's round

Once the terms are exchanged and before any PSI set moves, a cascade or count-only exchange makes the same check on the partner's round (`checkPartnerRoundMemory`, `apps/cli/src/psiMemoryBudget.ts`):

- **The need** is `psiRoundMemoryNeedBytes` of an upper bound on the values a conforming partner's set for one linkage key holds (`partnerRoundValues`, `packages/core/src/exchange.ts`): its declared record count, which includes its fan-out, times the widest key's declared width, held to the per-set maximum, `MAX_PSI_DECODE_ELEMENTS`, over which no sender sends a set. The declared width applies in either PSI role. A sender's key read holds a row to the declared width times its local fan-out factor, and `split_on` has no per-element cap, so a sender partner whose agreed or local cleaning fans out can realize more than the width its own key read applies without a fan-out; its local cleaning is not in the agreed terms, so it is weighed at the declared width whatever its terms declare. A unit test realizes a sender's and a receiver's key read on swapped keys with `split_on` in the agreed terms and in local cleaning, and holds each count at or under the figure (`packages/core/test/partnerRoundCapacity.test.ts`). Every figure is authenticated session state. A partner whose records repeat values, or whose terms drop a value several records hold, sends fewer. Count-only terms declare no candidate set, so for them the figure is the partner's declared record count.
- **What the process has** is the same least of three figures.
- **A need over it is refused** as a `RoundCapacityError` (a usage error, exit 64) naming the count, both figures and the remedies: a host with more memory, or the partner splitting their input into smaller files. It is this party's own limit, not a fault in anything the partner sent, and the partner is sent a fixed abort reason.
- **`--allow-memory-shortfall`** turns it into a warning, on stderr and on the event stream under `memoryShortfall`, as before contact.

The partner's figure is an authenticated upper bound for a conforming partner, not the size of the set it sends: duplicate values and empty cells shrink the real set below it. A command-line party whose memory sits near the bound is therefore refused unless `--allow-memory-shortfall` is passed, though the set it would receive could fit. Under the [PSI-C](PSI_C.md#psi-c) construction the figure is the size of the set itself: every round's set has one element for each of the partner's declared records, so one check covers every round.

A single-pass exchange is left to the checks in [Memory an inbound frame takes](#memory-an-inbound-frame-takes), and where a browser is its partner to that partner's ceiling too. A browser party refuses against a fixed ceiling instead, on the same upper bound, and has no override ([PROTOCOL.md, What a browser tab can match](PROTOCOL.md#what-a-browser-tab-can-match)).

### Memory an inbound frame takes

A command-line party weighs each partner frame against `process.availableMemory()`, which follows the host's memory and a container's limit and falls as the process uses memory. It weighs a frame at measured multiples of its size (`INBOUND_FRAME_MEMORY_MULTIPLES`, `packages/core/src/connection/inboundFrameMemory.ts`), which a unit test holds to this table:

| Step | Multiple | Measured |
| --- | --- | --- |
| Reading a frame and decrypting it with AES-GCM in one call, envelope version 1, the frame and its plaintext included (`aeadOpen`) | 4 | 3.1 to 4.0 for 2,147,483,584 bytes through `crypto.subtle`, on Darwin arm64 and in Linux arm64 containers (2026-11-02); 3.00 for a 536,870,904-byte file read and decrypted in one process, in the development container under Node 26.13.0 (2026-11-04) |
| Decoding a PSI request, beyond the frame (`psiDecode`) | 7.65 | 267.1 to 267.8 bytes retained for each element of 35 frame bytes, two runs of 2,000,000 elements on the WebAssembly library (2026-11-02 and 2026-11-03; [PROTOCOL.md, The single-pass dataset ceiling](PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute), "Every element is 33 bytes") |
| A setup or a response the engine takes in pieces, beyond the frame (`streamedSetup`) | 1 | a 2.31 GB setup of 66,000,000 elements taken, sealed and matched at 2.2 GiB RSS on the native library, Darwin arm64 (2026-11-02) |
| The PSI worker's copy of a frame (`workerClone`) | 1 | 1.00 held and 2.00 at the peak of the post, for a 536,870,888-byte array posted to a worker in the development container under Node 26.13.0 (2026-11-04) |
| A single-pass reply handed over to the PSI worker over file-sync, beyond the frame (`handedOverReply`) | 1.2 | 1.17 at most, for replies of 156,035,017 to 312,035,018 bytes, in the development container under Node 26.13.0 on the native library (2026-11-07; [The hand-off over file-sync](#the-hand-off-over-file-sync)) |
| A single-pass reply in one frame copied to the PSI worker, beyond the frame (`copiedReply`) | 3.9 | 3.82 at most, for replies of 156,035,017 to 312,035,018 bytes, in the development container under Node 26.13.0 on the native library (2026-11-07; [The hand-off over file-sync](#the-hand-off-over-file-sync)) |
| A single-pass request handed over to the PSI worker over file-sync and masked there, beyond the frame (`handedOverRequest`) | 30.1 | 30.03 at most, for requests of 35,000,002 to 140,000,002 bytes on the native library and 35,000,002 to 70,000,002 bytes on the WebAssembly library, in the development container under Node 26.13.0 (2026-11-08; [The masking of a request](#the-masking-of-a-request)) |
| A single-pass request copied to the PSI worker and masked there, beyond the frame (`copiedRequest`) | 31 | 30.99 at most, for requests of 35,000,002 to 140,000,002 bytes on the native library and 35,000,002 to 70,000,002 bytes on the WebAssembly library, in the development container under Node 26.13.0 (2026-11-08; [The masking of a request](#the-masking-of-a-request)) |

Each multiple is the largest figure measured for what it counts, over the sizes its row names; a smaller request can run above its multiple ([The masking of a request](#the-masking-of-a-request)). The checks:

- **Before each read, over file-sync.** The read gate weighs a message file before reading it (`inboundFrameMemoryCheck` on `FileSyncConnection`): the files already read that the exchange has not received, plus this file at its own size before the connection is encrypted, and once it is, at a charge that follows the envelope version the key exchange negotiated (`inboundFrameReadBytes`). Under version 2 the charge is the file's own bytes and `CHUNKED_OPEN_PEAK_BYTES`, 101,023,744 bytes: a version-2 frame decrypts one chunk at a time into its own bytes, and that is the largest peak above the envelope measured while one decrypted, in a fresh process with no forced garbage collection, at frames from 16 MiB to 2,147,487,744 bytes ([TRANSPORT_BOUNDS.md, Inbound frame-size bound](TRANSPORT_BOUNDS.md#inbound-frame-size-bound)). Under version 1, or for a file read before a version is negotiated, it is `aeadOpen` times the file's size.
- **Before the worker takes a frame.** On every channel and in every round, a cascade's, a count-only run's or a single-pass run's, each partner set is weighed before the worker takes it. A request the worker decodes is weighed at `workerClone + psiDecode` times its size, and a setup or a response it takes in pieces at `workerClone + streamedSetup` (`psiFrameHandlingBytes`). The frame itself is already held. This check weighs a request's decoding, not the masking that follows it: the check at the terms exchange weighs a single-pass request's masking, and [the partner's round](#the-partners-round) a cascade or count-only round's. Posting a copy peaks at twice what it copies, and a view posted copies its whole buffer. Over WebRTC a single-pass reply in one frame is posted as two views of the frame, its setup and then its response, and was measured at up to 3.82 times the frame beyond it ([The hand-off over file-sync](#the-hand-off-over-file-sync)). This check weighs those two at twice their own sizes, which is under that peak; the check at the terms exchange charges that reply at `copiedReply`. A frame moved to the worker rather than copied ([The hand-off over file-sync](#the-hand-off-over-file-sync)) is weighed without `workerClone`.
- **At the terms exchange of a single-pass run.** Before either party masks anything, the frame this party will read is bounded from the agreed counts: the reply cap where it receives, its response term the request cap, and the request cap, `35 * slots + 2` bytes, where it sends and reads the partner's request (`singlePassRequestByteCap`), each held to the connection's frame ceiling, the AEAD's limit on one frame under envelope version 1 and none under version 2 (`frameCeilingBytes`). That frame is weighed at the larger of its read, charged under the negotiated envelope version as the read gate charges it (`inboundFrameReadBytes`), and of the frame with its hand-off (`inboundPsiFramePeakBytes`), and at no less than the reply's index table. The hand-off is the request moved to the worker and masked there, at `handedOverRequest`, and the reply at `handedOverReply` (`fileSyncSinglePassHandOffBytes`). The two do not add: the exchange collects garbage between the read and the hand-off (`relieveTransientMemory`), under the `--expose-gc` the images run node with. Over WebRTC, where either single-pass message may travel in parts ([PROTOCOL.md, Single-pass messages in parts](PROTOCOL.md#single-pass-messages-in-parts)), no frame ceiling applies, and the read is charged as a message in parts: the message and the measured multiple of one part (`webRtcMessageReadBytes`, [TRANSPORT_BOUNDS.md, Memory a message in parts takes](TRANSPORT_BOUNDS.md#memory-a-message-in-parts-takes)). Its hand-off is charged for a request copied to the worker and masked there at `copiedRequest`, for a reply in one frame at `copiedReply`, and for a reply in parts as a frame copied to the worker (`psiFrameHandlingBytes`), each by `webRtcSinglePassHandOffBytes`. The message this party sends, the request where it receives and the reply cap where it sends, is weighed too, at the message and the measured multiple of one part (`webRtcMessageSendBytes`), and the need is the larger of the two. Where this party sends, it also holds its own setup, from before the request is read until the reply is sent, and the need is the larger of the setup's build peak and the need above plus what the setup adds to the masking, each a measured figure a value slot of its own on the PSI library the run loaded (`singlePassOwnSetupBytes`, [The sender's own setup](#the-senders-own-setup)).

A need over what is available is refused. Before a read or a hand-off it is a usage error (exit 64) and the file is left unread; past the terms exchange the partner is told by the abort marker on an authenticated run, or by the local-fault abort frame on a quick exchange. At the terms exchange it is a `RoundCapacityError`, and the partner is sent `PARTNER_SET_OVER_CAPACITY_ABORT_REASON`. `--allow-memory-shortfall` turns each into a warning, on stderr and on the event stream under `memoryShortfall`.

### The hand-off over file-sync

A file-sync message is read into a buffer of its own, which the connection keeps no reference to once it delivers the message.
A single-pass party therefore moves the partner's frame to the PSI worker rather than copying it (`PsiFrameHandOff`, `packages/core/src/psi/psiEngine.ts`):

- **The request.** The sender moves the request's buffer to the worker once the element scan has held the request to its bound.
- **The reply.** The receiver hands the setup to the engine in pieces of 16 MiB, each copied out of the reply and moved, once the element scan has held the setup to its bound. The engine checks each piece as it checks a setup received in parts, and frees the pieces it took on a refusal. The response then moves with the reply's buffer, once it is held to the request this party sent.
- **After authentication.** Either is handed over only once the connection has returned the frame: under envelope version 2 after every chunk's tag has verified, under version 1 after the frame's tag.
- **A small message.** Node refuses to move a buffer from its shared Buffer pool, which can hold a small message's bytes, so the command line copies such a buffer instead (`createWorkerThreadHandle`, `apps/cli/src/psiWorkerHost.ts`).

Over WebRTC, and in every cascade and count-only round, a frame is copied to the worker. A frame posted as a view copies the view's whole buffer, so a reply in one frame copies the frame once for its setup and again for its response.

Measured 2026-11-07 in the development container (aarch64 Linux, Node v26.13.0, the native library). A `WorkerPsiEngine` over a `worker_threads` worker running core's worker, driven through the participant's own calls, took a frame built in another process, written to a file and read whole, laid out as a decrypted version-2 envelope. The resident set was sampled every 10 ms from a baseline taken after a forced collection with the frame already held. Each figure is the peak beyond the frame, over the frame's size:

| Frame | Copied | Handed over |
| --- | --- | --- |
| Reply, 156,035,017 bytes (a 4,000,000-element setup) | 3.80 | 1.17 |
| Reply, 234,035,017 bytes (a 6,000,000-element setup) | 3.82 | 1.05 |
| Reply, 312,035,018 bytes (an 8,000,000-element setup) | 3.80 | 1.01 |
| Request, 140,000,002 bytes (4,000,000 elements), its masking included | 28.31 | 26.65 |

Each reply answered a request of 1,000 elements, so the frame is almost all setup. A copied reply is the calls a reply in one frame over WebRTC makes, `computeValueMatches` with no hand-off. The request's peak is mostly the engine masking it, which this table does not split from the hand-off: moving the request lowered that peak by 1.66 times the frame, more than the one frame, `workerClone`, its charge drops. The worker's copy alone, by the method `workerClone` was measured with: a 536,870,888-byte view posted to a worker held 1.00 times its size there and 1.98 at the post's peak; moved, it held nothing; and a view of half that buffer copied the whole buffer.

### The masking of a request

A single-pass sender answers the partner's request in one engine call, `processClientRequest`, which decodes the request, masks every element and builds the response. The terms-exchange check charges that call at `handedOverRequest` over file-sync and `copiedRequest` over WebRTC, each the largest figure below rounded up to a tenth.

Measured 2026-11-08 in the development container (aarch64 Linux, 10 CPUs, 23 GB shared with other work, Node v26.13.0), on the native library at four sizes and on the WebAssembly library at two, one run each:

- **The engine.** A `WorkerPsiEngine` over a `worker_threads` worker that serves core's engine as the command line's worker does (`servePsiWorker`, with the engine options for its library). The worker first created a setup of 1,000 values, as a sender does before it reads the request.
- **The frame.** A request a joiner's engine built in another process, written to a file and read whole into a buffer of its own, then handed over to the worker as over file-sync, or copied to it as over WebRTC.
- **The figure.** The process's high-water resident set once the call returned (`process.resourceUsage().maxRSS`), less a baseline taken after three forced collections with the frame held, over the frame's size. The high-water mark was above the resident set sampled every 10 ms in every run.

| Frame | Copied | Handed over |
| --- | --- | --- |
| Request, 35,000,002 bytes (1,000,000 elements), native library | 30.99 | 29.64 |
| Request, 70,000,002 bytes (2,000,000 elements), native library | 29.36 | 28.83 |
| Request, 105,000,002 bytes (3,000,000 elements), native library | 29.77 | 28.73 |
| Request, 140,000,002 bytes (4,000,000 elements), native library | 28.86 | 27.97 |
| Request, 35,000,002 bytes (1,000,000 elements), WebAssembly library | 30.76 | 30.03 |
| Request, 70,000,002 bytes (2,000,000 elements), WebAssembly library | 29.36 | 28.54 |

On each library the largest figure is at the smallest of these requests, 35,000,002 bytes, and no request past 140,000,002 bytes was measured. A smaller request can run above its multiple: one of 3,500,002 bytes (100,000 elements), handed over on the native library, peaked at 134,725,632 bytes beyond the frame, 38.49 times its size, about 29 MB more than `handedOverRequest` charges.

### The sender's own setup

A single-pass sender masks its own values into a setup (`createServerSetup`) before it reads the partner's request, and holds the setup until it sends its reply. The terms-exchange check charges the sender the larger of two figures, `slots` its own value slots, the most elements its setup can hold (`singlePassOwnSetupBytes`, `apps/cli/src/psiMemoryBudget.ts`):

- **The setup's creation.** `b * slots` bytes, `b` the build peak below: 884 on the native library and 865 on the WebAssembly library.
- **The masking beside it.** The request charge plus `m * slots` bytes, `m` the masking increment below: 401 on the native library and 210 on the WebAssembly library.

Each figure is the largest measured on its library, rounded up, with the native masking increment raised by what swap could hide in it (below), and the check takes the figures of the library the run loaded: the native addon, or the WebAssembly build the CLI falls back to where no native build loads (`loadCliPsiBackend`, `apps/cli/src/psiBackend.ts`). The PSI worker loads that same library and no other, and where it does not load there the worker fails to start and the exchange fails.

The WebAssembly masking increment is the 2^23 run's, because below that size the request's own working set, not the setup, determined the masking peak, and the request charge, about 249 MB above the lower masking run beside 1,000 values, covers those runs; a unit test holds the creation and masking peaks of each WebAssembly row of one run below, and of the batch run that sets the build peak, at or under the two charges.

Measured 2026-11-10 in the development container (aarch64 Linux, 10 CPUs, 23 GB shared with other work, Node v26.13.0), by the method of [The masking of a request](#the-masking-of-a-request), one process a run:

- **The setup.** The worker created a setup of 1,000 values, then one of `n` distinct values, which the process held.
- **The build peak.** The process's high-water resident set once the setup was created, less a baseline taken after three forced collections before it was created, with its values already held, over `n`.
- **What the setup holds.** The resident set after three forced collections, less that baseline, over `n`.
- **The masking increment.** The high-water mark was then reset to the resident set (`/proc/self/clear_refs`), and a 140,000,002-byte request of 4,000,000 elements was handed over to the worker and masked. The figure is that masking's high-water mark beyond the baseline, less the lower of two runs of the same masking beside a setup of 1,000 values, over `n`.

On the native library, one run at a time, the lower of the two masking runs beside 1,000 values peaked 4,022,882,304 bytes above its baseline:

| Setup | Runs | Build peak per element | Held per element | Masking increment per element | Swap use during the run |
| --- | --- | --- | --- | --- | --- |
| 1,048,576 elements | 1 | 883.50 | 293.61 | 165.70 | not read |
| 1,048,576 elements | 1 | 813.76 | 720.96 | 12.53 | did not rise |
| 2,097,152 elements | 1 | 752.06 | 695.66 | 63.75 | not read |
| 2,097,152 elements | 1 | 804.42 | 709.10 | 38.71 | did not rise |
| 4,194,304 elements | 1 | 798.40 | 691.71 | 38.89 | not read |
| 4,194,304 elements | 1 | 789.21 | 680.42 | 77.01 | did not rise |
| 8,388,608 elements | 2 | 761.60 to 769.97 | 618.99 to 644.20 | 165.14 to 183.79 | not read |
| 8,388,608 elements | 1 | 763.35 | 635.15 | 64.62 | did not rise |
| 16,777,216 elements | 1 | 688.05 | 630.21 | 267.11 | not read |
| 16,777,216 elements | 1 | 763.40 | 626.57 | 397.15 | rose by 53 MB |
| 16,777,216 elements | 1 | 781.02 | 623.48 | 394.12 | rose by 53,724 kB |

On the WebAssembly library, one run at a time, the lower of the two masking runs beside 1,000 values peaked 4,104,970,240 bytes above its baseline:

| Setup | Runs | Build peak per element | Held per element | Masking increment per element | Swap use during the run |
| --- | --- | --- | --- | --- | --- |
| 1,048,576 elements | 2 | 812.63 to 832.45 | 677.63 to 684.08 | 6.85 to 34.34 | did not rise |
| 1,048,576 elements | 1 | 834.02 | 694.50 | -15.68 | did not rise |
| 2,097,152 elements | 2 | 802.70 to 807.88 | 696.91 to 704.40 | 12.75 to 32.50 | did not rise |
| 2,097,152 elements | 1 | 781.69 | 684.90 | 27.80 | did not rise |
| 4,194,304 elements | 2 | 811.85 to 823.13 | 701.94 to 714.77 | 58.25 to 59.86 | did not rise |
| 4,194,304 elements | 1 | 764.23 | 694.35 | 54.60 | did not rise |
| 8,388,608 elements | 1 | 826.67 | 683.66 | 209.58 | did not rise |

The four rows of one run each were measured in sequence in one container, and the largest build peak and masking increment in the table are theirs.

The masking reuses the memory the setup holds. Beside the setups of 2^20 to 2^22 elements the masking raised the resident set above what the setup held; beside those of 2^23 elements on both libraries and 2^24 on the native library it did not, and its peak was at or below what the setup held. The increment therefore grows with the setup against a fixed request, and was measured beside one request size only. The WebAssembly library was measured at 2^20 to 2^23 elements only, not at 2^24, where the native increment rose to 397 bytes an element from at most 184 at 2^23. On 2026-11-09, 11 earlier native runs at 2^20 to 2^23 elements peaked at 792 to 881 bytes an element in creation.

A high-water mark of the resident set does not count pages swapped out, so a run measured alone that read the container's swap use before and after is held to one rule, because swap can only lower a reading: a run during which it rose by more than 16 MB is left out of a figure it would lower and never of one it would raise, and a figure that does count, read under such a rise, is raised by what that rise can hide, the rise over the run's element count:

- **The WebAssembly runs.** None of the runs in the WebAssembly table above raised swap use. An earlier batch of six runs, up to four at a time while swap use rose by 302 MB, read build peaks of 747.34 to 864.77 bytes an element at 2^20 to 2^22, and masking increments of up to 156.46, taken less the table's 4,104,970,240 bytes. A rise shared by runs side by side is no one run's, so the batch is not in the table, which holds runs measured alone. Swap can only lower a reading, so its build peak of 864.77 at 2^22, above every run measured alone, sets the WebAssembly build peak at 865; its masking increments are below the 2^23 run's.
- **The native runs at 2^20 to 2^23.** Swap use did not rise during the four that read it. The native build peak of 884 comes from a run at 2^20 that did not read it; swap can only lower a reading, so the charge keeps that run's 883.50 as the largest.
- **The native runs at 2^24.** Of the first two, the second, its build peak 763.40 and its masking increment 397.15 bytes an element, raised swap use by 53 MB, with free memory down to 0.3 GB and 6.2 GB still available to reclaim. Of the other two, the first rose by 65 MB, with pages it held swapped out (held 317.71 bytes an element, against about 625 in the other 2^24 runs), and is left out of the figures it would lower; its build peak 789.89 and masking increment 88.05, raised by the 4.1 bytes an element its rise can hide, stay below both charges, and its re-run, the last 2^24 row, rose again, by 53,724 kB. Both runs that rose by about 53 MB count, each raised by what its rise can hide, up to 3.3 bytes an element: 397.15 to 400.5 and 394.12 to 397.4. The native masking increment is the larger, rounded up to 401.

A smaller setup costs more an element: one of 100,000 elements peaked at 103,055,360 bytes in creation on the native library, 1,031 an element, about 15 MB more than the charge, and at 98,664,448 bytes on the WebAssembly library, 987 an element, about 12 MB more than its charge.

### The worker's heap, from the counts

At the terms exchange of a single-pass run, the PSI worker's heap is set to `298,000,000 + 709 * n` bytes, `n` the larger party's value slots (`psiWorkerHeapNeedBytes`): the measured worker V8 heap of a joiner's full round, the costlier role, in [The measured costs](#the-measured-costs). It is raised to that need, never below the limit the process already runs under. A run whose counts need more than 19,075 MiB gets it, and on a host where node runs at its default limit, a smaller run's worker keeps that limit, so running out of heap there ends the worker with an error the run reports rather than ending the process.

### The main thread's heap, from the values

Once a single-pass party has gathered its own distinct values, and before it masks any, a command-line party refuses a run whose main thread's `heap_size_limit` is under `120,000,000 + 135 * d` bytes, `d` the distinct values (`checkSinglePassOwnValuesHeap`, `apps/cli/src/psiMemoryBudget.ts`), on any channel. The refusal is a usage error (exit 64) naming the need, the limit, and the `NODE_OPTIONS=--max-old-space-size` line to set; the partner is told by the run's abort. `--allow-memory-shortfall` turns it into a warning.

The figure is the line through the first and last rows below, rounded up, which is above the rows between. Measured 2026-11-04 in the development container (aarch64 Linux, Node v26.13.0, native library): the smallest main-thread `--max-old-space-size` under which `linkViaSinglePassPSI` completed with the right match count, bisected to 32 MiB, with the engine in a worker and the input of 14 keys built in the same heap. The sender and the receiver passed at the same limit at every size. No run past the last row was measured; past it the figure is the line extended.

| Distinct values | Smallest passing `--max-old-space-size` | Its `heap_size_limit` |
| --- | --- | --- |
| 500,000 | 82 MiB | 178 MiB |
| 1,000,000 | 140 MiB | 236 MiB |
| 2,000,000 | 245 MiB | 341 MiB |
| 2,999,990 | 403 MiB | 499 MiB |

### Limits

- **Records, not elements, before contact.** The pre-contact need is taken from the records this party holds. A key whose transforms produce several candidates a record, or a `split_on` fan-out, sends more elements than records, which the check does not count.
- **Total, not free, memory.** The host figure is the host's total memory, so two parties on one host, or other workloads beside the run, share memory the check counts once.
- **The container figure is Node's.** The container limit the check counts is `process.constrainedMemory()`, which enters the least of the three figures when it is below the host's memory; the check reads no cgroup file itself.
- **Measured on cgroup v2 only.** On Docker Desktop 29.8.1 (linuxkit 7.0.14, cgroup v2), `process.constrainedMemory()` equals the `docker run --memory` value, and with no limit it returns 2^64, which the check treats as no container limit. cgroup v1 is not measured. Under a small container limit V8 shrinks its young generation, so the heap figure in the memory line is 20.03 GB at 768m and 20.10 GB at 4g or with no limit. Under 768m the check refuses with exit 64 and writes nothing to the drop directory; with `--allow-memory-shortfall` it warns and the run proceeds. The FIPS image behaves the same.
- **Frame multiples from separate measurements.** Each multiple in [Memory an inbound frame takes](#memory-an-inbound-frame-takes) was measured on its own step, not through a whole exchange, and the read multiple through `crypto.subtle` rather than the encryption layer's own path. The files read and not received are counted at their size, though each is decrypted when it is received.
- **At the terms exchange, an upper bound.** The single-pass check weighs the largest frame the counts allow, not the frame masking builds: a run whose values repeat sends a smaller one, so a host near the bound is refused unless `--allow-memory-shortfall` is passed, though the frame it would read could fit. It weighs the frame's read and hand-off, and the masking of a request this party answers, not the rest of the run's masking. Where this party sends, it charges its own setup at the larger of the setup's build peak and the request charge plus what the setup adds to the masking, each measured beside one request size only, and on the WebAssembly library at setups of up to 2^23 elements only ([The sender's own setup](#the-senders-own-setup)).
- **The read gate on file-sync only, the hand-off check only with the bundled worker.** Over WebRTC no part is weighed before it is read: a single-pass message is weighed whole at the terms exchange, and each partner set again before the worker takes it. The hand-off check runs only where the engine runs in the worker.
- **Parts weighed at a measured multiple.** Over WebRTC the multiple of one part was measured on the message's read or send alone between two werift peers, not through a whole exchange.

### Measured runs at 2^24

On 2026-09-30 two `alcove` zero-setup parties ran over a file-drop directory in the development container above, each with a 16,777,216-row input of four columns (an id, a synthetic SSN, a last name and a date of birth; 623 MB each), half of each input shared with the other:

- **Default main-thread heap, as Node starts it.** Both parties ran out of heap on the main thread while preparing the input, before the pre-contact check and before any network contact: exit 134 after 204 s, peak RSS 4.50 GB each.
- **With `NODE_OPTIONS=--max-old-space-size=19075`, the images' setting.** Both parties were still preparing their input on the main thread after 30 minutes, each on one core at 100%, at 6.78 GB and 6.11 GB RSS, and the attempt was stopped there, before the pre-contact check and before any network contact.

At the measured costs a symmetric round at this size needs about 20 GB for the joiner and 17 GB for the starter, more than this host holds for two parties.

On 2026-09-30 and 2026-10-01, on an Apple M1 Max with 32 GB of memory (Docker Desktop VM of 23.7 GB, 10 vCPUs, cgroup v2, the Node 26.10.0 Alpine image):

- **16,777,216 records a side, file-sync pair, no container memory limit.** The run did not complete. Both parties were stopped during the first-round value count after about 15,600 s of wall time, at a peak of about 7.4 and 7.6 GiB a party. No refusal and no memory line was reached: on the build measured, the zero-setup path counted before it logged the memory line.
- **15,339,166 records a side.** Not run: the pair needs about 37 GB and the host held 23.7 GB. A single party's preparation, up to the memory line, took 100 s and 108 s in two runs.

The completion run at the per-set maximum:

- **16,777,216 records a side, file-sync pair, to completion, one party per host.** On 2026-10-02 both parties exited 0 and each returned the expected result, 8,388,607 matched rows (below). Round 1 took about 25 minutes, rounds 2 and 3 about 11 each, and round 4 to the end of the run about 15.

| Party | Host | Transport | Wall time | Peak RSS |
| --- | --- | --- | --- | --- |
| Starter | Proxmox LXC container: Intel Core i3-14100, 3 cores / 6 logical CPUs, 29 GiB container memory limit, no swap, Linux, Node v26.8.2 | `file://` on a directory of its own host | 3,826,025 ms | 29,913,112,576 bytes |
| Joiner | Apple M1 Max, 10 CPUs, 32 GiB, macOS, Node v26.8.2 | `sftp://` to the starter's host over the LAN | 3,760,626 ms | 22,453,616,640 bytes, a floor |

What the figures mean for a host:

- **The starter's host had no margin.** The container's cgroup memory peak was 30,859,788,288 bytes, 145 MB under its `memory.high` throttling threshold, so at that limit the starter placement had no margin.
- **The joiner's figure is a floor.** macOS peak RSS does not count compressed pages, and the Mac had about 1 GB in swap before and after the run, so 22.45 GB is a lower bound on the joiner's true peak.
- **The expected result leaves out nulled SSNs.** One shared row of the synthetic population holds 111-11-1111, which the built-in standardization nulls, so it matches on no key and the result holds 8,388,607 of the 8,388,608 shared rows.

The modelled needs are each party's PSI round ([The measured costs](#the-measured-costs): 20.0 GB for the joiner, 16.6 GB for the starter) beside its main thread's peak of 11.78 GiB ([Preparing the input at 2^24](#preparing-the-input-at-224)): about 32.7 GB for the joiner and 29.3 GB for the starter. The starter's measured peak is 0.6 GB over its model. Two parties on one host need their sum, about 64 GB.

`apps/cli/test/stress/fileSyncCompletion.stress.test.ts` drives the run in the CLI's opt-in stress tier (`npm run test:stress -w apps/cli`, after `npm run build -w apps/cli`). Each party is the built `alcove` under the images' heap setting, with the four-column input above, half of it shared with the other. The test holds each result to that shared half, row for row, less any row whose SSN the built-in standardization nulls, which is what a run with no size limit returns, and logs the wall time and the party's peak RSS, its PSI worker included. It has two modes:

- **Both parties on one host**, over a local directory: the default, for sizes that fit one host.
- **One party on this host**, against a partner on another (`ALCOVE_STRESS_COMPLETION_PARTY` set to `starter` or `joiner`, `ALCOVE_STRESS_COMPLETION_URL` naming the shared directory as a `file://` or `sftp://` URL). The joiner is the party that arrives second, so on a `file://` directory the joiner waits for the starter's hello before it starts; either party stops as soon as it logs a role other than its own. It writes the party's figures and its host to a summary file.

Each skips where the memory is under what it needs: the free memory, or on macOS, whose free figure leaves out the cache it can reclaim, the available memory `memory_pressure` reports: free, inactive and speculative pages. `ALCOVE_STRESS_COMPLETION_ROWS` lowers the row count; the test file's header lists the other settings.

### Preparing the input at 2^24

Measured 2026-10-01 in the development container (dev container, 10 cores, 23 GB; aarch64 Linux, Node v26.10.0), with other workloads running beside it. One zero-setup party ran alone over a file-drop directory (`alcove --peer-timeout 30s file://<dir> <input>`) under `NODE_OPTIONS=--max-old-space-size=19075`, on the four-column input above, one distinct SSN a record. Times are from the process's start, read off its log lines; peak RSS is the process's `VmHWM` at the end of each stage.

16,777,216 records, load average 2.7 at the start:

| Stage | Time | Ends at | Peak RSS |
| --- | --- | --- | --- |
| Read and parse the CSV, infer the terms | 14.1 s | 14.1 s | 3.09 GiB |
| Constraint pass (standardizes every record's key fields, cached for the round) | 78.7 s | 92.8 s | 7.69 GiB |
| Memory check (`memory:` line) | under 0.1 s | 92.8 s | 7.69 GiB |
| First-round count, as the sender | 133.4 s (125,816 records/s) | 226.1 s | 11.78 GiB |
| First-round count, as the receiver | 136.1 s (123,314 records/s) | 362.2 s | 11.78 GiB |

On the build measured, the first round was held to one message file, 15,339,166 values; the count found at least 16,777,215, so the run was refused there with exit 64 and made no network contact. The stress probe below, run the same day over the same input on the core code as it stood before the lookups described under [The practical input bound](#the-practical-input-bound), with each value its own `Map` key, read it in 24.9 s and was still in the constraint pass 25.5 minutes later, when it was stopped.

15,339,166 records, the first 15,339,166 rows of the same input, load average 10.4 at the start: the read took 25.2 s and the constraint pass 176.4 s. The first-round count was skipped, since one value a record cannot exceed the bound, and the first entry appeared in the drop directory at 201.6 s, within 25 ms of the memory line, at a peak RSS of 6.48 GiB.

**The bound.** On this host a 2^24-record preparation, from reading the input to the first-round refusal, completes within **27 s per million records**, about 7.5 minutes, while the host's load stays within its core count. It is the slowest such run rounded up to a whole second per million: the stress probe below took 446.0 s (26.6 s per million) at a load average of about 12, and the profiled run above 362.2 s (21.6 s per million). An input within the message-file bound skips the count and reached first contact at 13.1 s per million. Past that load the bound does not hold: the stress test run beside a full repository check took 828.3 s (49.4 s per million), 627.6 s of it in the count: about 430 s in its first role and 180 s in its second.

`packages/core/test/stress/inputPreparation.stress.test.ts` reproduces the measurement in the opt-in stress tier (`npm run test:stress -w packages/core`): it writes the input, runs the same core stages in a process of its own under the images' heap limit, logs each stage's time and peak RSS, and holds the first-round check at 2^24: admitted at the per-set maximum, and refused, with the count walking every record at a steady pace, under a maximum one value short of the values the input's first round sends. That is one value a record, less the record holding SSN 111-11-1111, which the built-in standardization drops as a placeholder. About 13 minutes and 12 GB resident; `ALCOVE_STRESS_PREPARATION_ROWS` lowers the row count.

**Stages left as they are.** Each is linear in the records and is a limit of the bound above:

- **The constraint pass**: 78.7 s at 2^24, 176.4 s at 15,339,166 under load. It runs every record's field standardization.
- **The count walks every record twice** where this party drops its duplicates, the zero-setup default: once for each PSI role, since it refuses only when both are over the bound. 269.5 s of the 362.2 s at 2^24. A party that keeps its duplicates stops counting once over the bound.
- **Main-thread memory**: a peak of 11.78 GiB at 2^24, the dataset's cached values (7.69 GiB) and the count's index of every first-round value. The PSI round's own need ([The budget](#the-budget)) is in the worker, beside it.

### The practical input bound

On Node 26, V8 adds every string a `Map` or `Set` is asked about to its string table, and that table's lookups slow about fiftyfold once it holds about 2^24 strings of 9 decimal digits, which a cleaned SSN is. Measured 2026-10-01 in the development container, keeping each fresh string alive and looking it up once in a one-entry `Set`:

- 9-digit values in order took 20-70 ms per 250,000 lookups up to 17.0M strings, then over 5 s per 250,000;
- the same values in scattered order collapsed at the same count, so real SSNs, which are not sequential, are no different;
- 10-digit values above 2^32 and 16-digit values did not collapse up to 20M strings.

The host above measured the same collapse in the constraint pass at 2^24 records and in the first-round count from about 13.4M records, from roughly 95,000 to 2,000-3,000 records/s, in Docker and natively alike (2026-09-30 and 2026-10-01).

**The constraint pass, the first-round count and the round's deduplication look values up by hash.** The `null_if` and `exclude` lists, a record's candidate values as its key is assembled, the first-round count, the round's deduplication and the count-only round's single-occurrence filter look values up through `DistinctValues` (`packages/core/src/utils/distinctValues.ts`) rather than asking a `Map` or `Set` about the value, within the limit under Where values still reach the table below:

- It keys a `Map` by a 30-bit FNV-1a hash of the value's UTF-16 code units, a small integer in every V8 build, and confirms a hit by comparing the two strings with `===`, so two values share an entry exactly where the string comparison equates them.
- A value whose hash another value already holds goes to a string-keyed map of its own, about 131,000 values at 2^24.
- A collection that rarely holds more than one value, a record's candidates or a short `null_if` list, compares its first 16 values one by one before it builds the index.

The hash is the key because, of the keys measured at 2^24, it alone adds no per-record string to the table whatever the value's shape ([docs/notes/hash-keyed-value-lookup.md](../notes/hash-keyed-value-lookup.md)).

**Where values still reach the table.** The lookups above stop short of two collections. A record holding several candidates, from a `split_on` fan-out or a fuzzy expansion, reaches the round as a `Set` of its candidates, and a `split_on` step's output inside a field's standardization is a `Set`; both add those candidates to the string table. A fan-out over 2^24 records of digit values is not measured.
