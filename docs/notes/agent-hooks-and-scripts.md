---
title: "Agent Hooks and Session Scripts: Design Rationale"
---

# Agent hooks and session scripts: why each has the shape it has

_Status: decided and built.
Each hook's or session script's header states its contract: what it refuses or decides, what it reads, its exit, and what to do when refused.
This note holds the reasoning behind those contracts: the incident or failure each exists for, the alternatives measured and declined, and the limits each accepts.
See [docs/notes/README.md](README.md)._

## Non-executable-delta verifier

[`.claude/scripts/verify-nonexecutable-delta.mjs`](../../.claude/scripts/verify-nonexecutable-delta.mjs)

### Why it is mechanical

[`assess-review.md`](../../.claude/commands/assess-review.md), Step 4, lets a head be re-attested without a fresh review round when its diff against the reviewed sha changes no executable line.
Nothing in CI can catch a false claim of that property:
`npm run check:pr-checklist` compares the attested sha against the head and has no view of whether the property holds,
so an eyeballed "comment-only" lands an unreviewed head as reviewed.

### Primitives measured wrong

The comparison parses each side to a TypeScript `SourceFile` and prints it back with comments suppressed.
Two cheaper primitives were measured wrong, and the colocated test pins both failure modes against the installed TypeScript:

- the compiler's emit erases type positions along with comments, so a type-only edit compares identical;
- a raw scanner has no parser context, so a backtick inside a comment puts it in template state and a comment-only edit reads as a change.

For YAML, a comparison key built by stringifying the value was measured wrong the same way.
`JSON.stringify` writes NaN, Infinity, -Infinity and null all as `null`,
and an own-keys walk writes every Date and every Set as the same empty object,
so a real value change in any of them would pass as comment-only.
The deep comparison treats mapping key order as insignificant, as YAML does, and keeps sequence order.
`uniqueKeys` and `strict` are passed although both default on, so a future default change cannot loosen the check.

### Why the refusals fail closed

A verifier backing an attestation must not report HOLDS over a file it did not examine,
so every path that is not markdown, source, or YAML is unverifiable rather than accepted as "not a JS/TS extension".
The YAML refusals each have a soundness probe:
a multi-document stream, because documents are not aligned across two streams;
a document with a parse diagnostic, a duplicate key among them, which lands in `doc.errors` rather than resolving last-wins;
and a document that parses clean but cannot be materialized,
since an unresolved alias throws out of `toJS()`, an alias bomb trips the package's resource cap,
and a self-referencing anchor comes back circular with no diagnostic.
Each refusal is a reason on its own path's verdict, so one unreadable file leaves every other path with a verdict.

A chmod leaves the blob identical, so modes come off the diff record.
A mode change between two existing sides is unverifiable whatever the extension: the comparison reads programs and cannot say whether making one runnable is harmless.
Rename detection is off, so a moved module counts as a changed program on both paths.

### Which tree the verdict is about

Every ref short of a full sha is per-worktree.
The primary checkout's copy is routinely called by absolute path while the branch under review sits in a linked worktree,
so binding git to the script's own location would resolve HEAD, HEAD~n and ORIG_HEAD against a tree nobody named.
A full sha hides the mistake, because linked worktrees share one object database.
Commands run at the worktree's top level, which was measured to matter both ways:
under `diff.relative` a run from a subdirectory drops every changed path outside it and reports a vacuous HOLDS,
and the `--raw` paths are root-relative only from the top level, which is what `git show <ref>:<path>` reads.

### Limits

Markdown content is exempt wholesale, including a fenced code block an operator would copy out.
The printer's normalizations (whitespace, blank lines, indentation, quote style, ASI semicolons, trailing commas, numeric literal form) compare equal, each pinned by the test.
The soundness probes run before every comparison, so an attestation proves soundness on the TypeScript and `yaml` actually installed rather than trusting that CI ran the suite.
