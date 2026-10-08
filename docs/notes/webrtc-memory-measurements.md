---
title: "WebRTC party memory: measurement history"
---

# WebRTC party memory: measurement history

_Status: measurement record, built. The current measurement, the fit and the figure the stress test uses are in [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#a-partys-memory); this note records which commits moved the peak and the before and after figures behind that. See [docs/notes/README.md](README.md)._

## Commit 80452d2c3 moved the peak from the second key to the first

Commit 80452d2c3 holds a round's matched records in typed arrays. On 2026-10-03, before it, the 1,000,000-record peaks were 2,541,735,936 bytes (sender) and 2,747,879,424 (receiver), in the second key with the main heap at 1.73 and 1.81 GB.

On the 2026-10-08 measurement host on 2026-10-05, one run at each commit, the main heap at the peak fell from 1.73 to 0.68 GB (sender) and 1.77 to 0.65 GB (receiver) across it, and the sender's peak from 2,554,142,720 to 2,245,230,592 bytes. The receiver's did not fall (2,700,550,144 and 2,740,928,512).

## Commit 72fb8155b did not move the peak

Commit 72fb8155b writes the exchange record's and receipt's encoding in chunks. Three 1,000,000-record runs on its parent, 1a0504a44, on the same host the same day (2026-10-05), had mean peaks of 2,223,104,000 bytes (sender) and 2,701,021,184 (receiver), against 2,226,461,355 and 2,718,849,707 on aa35fa977: 0.15% and 0.66% apart, inside the spread of either set. No peak fell after the last key, where the steps it changed run.

## The two-host point

The round between two hosts at 7,700,000 records was measured on 2026-10-03 on commit 85704c19c, before 80452d2c3 moved the peak, and has not been measured since. It stays among the fitted points. Fitted to the twelve 2026-10-08 runs alone, the figures at 7,700,000 records fall 2.4% (sender) and 3.8% (receiver) under its peaks, and the receiver's peak at 1,000,000 records did not fall with that commit.
