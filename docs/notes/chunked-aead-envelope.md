---
title: "The chunked AEAD envelope: measurements behind its shape"
---

# The chunked AEAD envelope: measurements behind its shape

_Status: decided and built.
The envelope, its chunk size and the read gate's charge for it are specified in [CHANNEL_SECURITY.md, The chunked envelope, version 2](../spec/CHANNEL_SECURITY.md#the-chunked-envelope-version-2) and [TRANSPORT_BOUNDS.md, Inbound frame-size bound](../spec/TRANSPORT_BOUNDS.md#inbound-frame-size-bound);
this note records the measurements behind the chunk size and the single shape, and the run of a large frame under it.
See [docs/notes/README.md](README.md)._

## The chunk size

Measured on 2026-11-04 in the development container (10-core arm64 Linux, Node 26.13): a frame of random bytes encrypted and then decrypted through `crypto.subtle` in chunks of each size, the median of five runs, in milliseconds:

| Chunk | 512 MiB frame, encrypt / decrypt | 1 GiB frame, encrypt / decrypt |
| --- | --- | --- |
| 64 KiB | 1,839 / 2,267 | 2,979 / 2,860 |
| 256 KiB | 1,162 / 744 | 1,762 / 1,487 |
| 1 MiB | 524 / 529 | 1,121 / 1,110 |
| 4 MiB | 563 / 548 | 1,104 / 954 |
| 16 MiB | 464 / 375 | 1,040 / 876 |
| 64 MiB | 503 / 457 | 1,546 / 1,218 |
| The whole frame, one call | 505 / 554 | 2,842 / 4,524 |

A smaller chunk pays the cost of each call, and a larger one the allocation of each call's output.
What a chunk adds to memory while it is encrypted or decrypted is a small multiple of `C`, against the frames of hundreds of megabytes and more that need the chunks.

## Every frame is chunked

The measurement shows no cost to chunking against one call, at 512 MiB or at 1 GiB,
so version 2 has one shape rather than one call below the AEAD's limit and chunks above it.

## A frame of 2 GiB under version 2

On 2026-11-04, in a 10-core arm64 Linux container with 23 GB of memory, under a load average near 15 from other work,
a frame of 2,147,487,744 bytes crossed a local synced folder whole under envelope version 2,
encrypted and written in 41.7 s and read and decrypted in 20.7 s,
at a peak resident set of 4.32 GiB with both parties in one process (`apps/cli/test/stress/fileSyncKeyedLargeFrame.stress.test.ts`).
The run of a frame that size with no key exchange, on the same day and host, and the memory opening one takes are in [TRANSPORT_BOUNDS.md, Inbound frame-size bound](../spec/TRANSPORT_BOUNDS.md#inbound-frame-size-bound).
