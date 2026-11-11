---
title: "One Expiry for Two Kinds of Shared Secret"
---

# One expiry for two kinds of shared secret

_Status: built.
Nothing here is normative: the enforcement sites, the advisory threshold and the case in which the decision would be revisited are specified in [SHARED_SECRET_ROTATION.md](../spec/SHARED_SECRET_ROTATION.md#expires-enforcement-and-the-expiring-soon-advisory).
See [docs/notes/README.md](README.md)._

## The decision

A key file's `expires` is written by either of two mechanisms: an invitation's setup lifetime or the `token_max_age_days` policy.
Both are stored as one bare `expires` field, and every check reads only that field, never which mechanism wrote it.

## Why no origin marker

The two sources share one recovery: an expired secret of either kind is replaced by a fresh invitation.
No expired state calls for a different step by kind, so the expired-side message is one message rather than one branched on origin.

A marker recording which mechanism wrote `expires` would add state to the key file without changing any decision taken from it.
It could also be present on one party's key file and absent on the other's, in a model whose recoverability depends on both parties reading their key files the same way.
A key file needs no conversion either: it holds a bare `expires`, which is what the uniform reading reads.

## The invitation token flagged 'expiring soon'

The advisory does not consult origin, so a freshly minted invitation token can be flagged in the narrow case the spec states.
The notice is correct and its guidance applies to either kind, so it is kept.
Suppressing it for invitation tokens alone would need a per-file origin marker, the cross-party state the single field avoids.
