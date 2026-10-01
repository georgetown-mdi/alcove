---
title: "Keying Per-Record Value Lookups by Hash"
---

# Keying per-record value lookups by hash

_Status: decided and built. The lookup, the string-table collapse it avoids, and the limits it leaves are specified in [FILE_SYNC.md, The practical input bound](../spec/FILE_SYNC.md#the-practical-input-bound); this note records why a per-record value is looked up by a hash of it rather than by the string itself. See [docs/notes/README.md](README.md)._

On Node 26, V8 adds every string a `Map` or `Set` is asked about to its string table, and lookups in that table slow about fiftyfold once it holds about 2^24 strings of 9 decimal digits. Preparing a 2^24-record input asks about every record's values, so the key a lookup gives the `Map` decides whether preparation at that size finishes.

## The keys weighed

Three keys were measured on 2026-10-01 in the development container, one process each, with other workloads beside them:

| Key the `Map` is given | 2^24 distinct 9-digit values | 2^24 distinct composite keys | 2^24 preparation: constraint pass, count, peak RSS |
| --- | --- | --- | --- |
| The string | 32.4 s | 37.6 s | constraint pass unfinished after 25.5 min |
| A digit string of up to 15 digits as the number `1` followed by its digits, any other string as itself | 9.9 s | 33.1 s | 123.4 s, 264.6 s, 12.00 GiB |
| The 30-bit hash, confirmed by comparison | 5.4 s | 22.2 s | 157.2 s, 272.8 s, 11.27 GiB |

## The choice

The hash was adopted.

- The two keys that avoid the collapse ran the whole preparation within the run-to-run spread of the shared host, so preparation time did not separate them.
- The hash is faster on both value shapes in isolation.
- The hash adds no per-record string to the table whatever the value's shape. The numeric key still adds every composite first-round value, so a linkage key built from several fields would reach the collapse again.
