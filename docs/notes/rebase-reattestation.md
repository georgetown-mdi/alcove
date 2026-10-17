# Re-attesting a review across a rebase

_Status: decided on the maintainer's ruling and built, as a mechanical
re-attestation path beside the others in `.claude/commands/assess-review.md`
(Step 4), with a later ruling admitting a shared file by hunk identity. A
base-sync merge takes a full round. See [docs/notes/README.md](README.md)._

## The problem

A review round attests the commit it read, and the pull-request checklist line
names that sha. A branch that then falls behind a code-moving `staging` commit
has to move: it is rebased, its head changes, and the attestation goes stale.
Under the paths that preceded it that head takes a full standing-contract role
round -- 150-250k tokens each -- even where the rebase changed nothing the
branch itself authored and the conflicts it resolved were markdown and comment
wording.

The question is not whether that round is thorough. It is whether it reads
anything the earlier round did not: where the branch's own change is identical
before and after the move, the round re-reads the same program and reaches the
same answer.

## What the path verifies

The branch's own change -- its diff against its own base -- must be unchanged
by the rebase:

- the same paths, and
- at each path, either the same program at both ends of the move, or, for a
  TypeScript/JavaScript path the staging range also changed, the same hunks,
- once comments are removed and markdown and the spec wording-change lists
  (the `.txt` files under `docs/spec/wording-changes/` and the legacy
  `docs/spec/wording-changes.txt`) are excluded.

`.claude/scripts/verify-rebase-invariance.mjs` decides it by running the
non-executable-delta comparison twice over exactly the paths the branch's diff
touches: once between the pre- and post-rebase bases, once between the two
heads. Both comparisons are needed and each catches a different way a rebase
moves the branch's diff.

| What the rebase did | Where it shows | Verdict |
| --- | --- | --- |
| The conflict resolution invented an executable line | Between the two heads | Violates |
| The staging range changed a file the branch also changed, away from the branch's hunks | Between the two bases; the hunk comparison finds the branch's hunks unchanged | Holds, unless a review claim names the file |
| The staging range changed a file the branch also changed, inside a branch hunk or its context | Between the two bases; the hunk comparison finds the hunks differ | Violates |
| The staging range changed a file the branch did not touch | Neither -- that path is not compared | Holds |

The comparison itself is the sibling verifier's, not a second implementation of
it: markdown decided by its path, source by parsing each side and printing it
back with comments suppressed, YAML by materializing each side, and every other
path unverifiable, which fails the run.

### The hunk comparison for a shared file

A path the staging range changed shows a delta between the two bases whatever
the branch did, so for a TypeScript/JavaScript path the verifier compares the
branch's own hunks instead:

- each of the four sides is parsed and printed back with comments suppressed,
  the sibling's canonical form, and a side that does not parse fails the run;
- the branch's change at each end is the diff from that end's base to its head,
  in that form, with three lines of context;
- the two ends agree when `git patch-id --verbatim` gives both diffs the same
  identity.

Each choice is measured in the verifier's test file against real git:

- **The comparison runs on the comment-free form.** A raw-text patch identity
  counts a staging comment beside a branch hunk as a change to that hunk.
- **Patch identity ignores where a hunk sits and its `@@` line**, so staging
  lines added above a hunk do not move it.
- **It hashes the context lines.** "Overlap" therefore means a staging change
  inside a branch hunk or within three lines of one, and both send the head to
  a round.
- **`--verbatim` keeps whitespace.** The default strips it even inside a string
  literal, so a resolution that changed `"a b"` to `"ab"` would compare equal.

A YAML path the staging range changed keeps the two-ended comparison and sends
the head to a round. A path the branch touches only at one end has a hunk only
there, so the comparison fails it; a commit added during the rebase is
therefore never admitted through this path.

### Why unchanged hunks are enough

The maintainer's ruling that admitted the rebase path rested on two halves:

- CI on the merge commit tests the composition;
- the comparison proves the branch's own executable content unchanged.

The hunk comparison keeps the second half. What a round read was the branch's
change -- its hunks and the lines around them. Where those are identical at
both ends, the round read the same change, and a staging change elsewhere in
the file is the composition the first half already covers: it is in the merge
commit CI tests, and it is not branch-authored. A conflict resolution that
edits a branch hunk changes that hunk's identity, so it still sends the head to
a round.

### Paths a review claim names

The maintainer ruled that this admission stops at the paths the branch's
security claims name. Adjacent code can change what a branch hunk means while
compiling and passing every test, and on a path a security claim rests on that
is the risk a round exists for.

So the verifier takes the branch's rounds ledger (`--ledger`) and reads the
`file` field of every claim in its rows. Only role rounds write claims, and
every role's claims count, not only the security role's. A shared path with
unchanged hunks that a claim names VIOLATES, and the head takes the
standing-contract round. A
claim's `file` is free text, so any claim whose file contains the path counts:
matching too much costs a round, and matching too little admits a path a claim
covers. A ledger line that does not parse stops the run rather than reading as
a ledger naming no path.

## Why a rebase is admitted where a base sync is not

A rebase composes the branch with staging content no round has read, exactly as
a base-sync merge does. That argument is what keeps a base sync outside every
mechanical path, and the exception has to answer it rather than route around it.

The difference is that the branch's own effective diff survives a rebase as a
comparable object, and a merge's does not:

- After a rebase the branch's commits are re-authored onto the new base, so the
  branch's diff against its base exists at both ends and can be compared.
- After a base sync the attested-to-head diff holds the whole merged staging
  range, so the verifier answers for what that range touched rather than for
  the branch's change. There is nothing to compare it against.

What a round attested was the branch's change. Where that change is identical
at both ends, the round's reading of it stands, and re-reading it buys the same
answer at a round's price.

## What the path does not attest

- **The content the branch now sits on.** Paths outside the branch's own diff
  are not compared, and no verdict here is about them. This is the ground the
  exception concedes.
- **The rest of a shared file.** In a TypeScript/JavaScript file the branch and
  the staging range both changed, only the branch's hunks and their three lines
  of context are compared. A staging change further away -- one that renames a
  binding a hunk uses, or wraps the hunk in a new scope -- is not read here,
  except on a path a review claim names.
- **The composition, as a matter of review.** What covers it instead is
  mechanical: every gate re-runs at the new head, and a pull-request gate runs
  against the head merged with the base tip, so a composition that fails to
  build, typecheck, lint, or pass a test is caught there. Running that merge is
  `actions/checkout`'s default on a `pull_request` event, and
  `npm run check:checkout-ref-override` holds every pull-request-triggered
  workflow to it. What is left over is an interaction that compiles and passes
  every test while being wrong -- the residual risk this path accepts, and the
  reason a single executable line inside the branch's own hunks sends the head
  to a full round.
- **Markdown.** Excluded, with the spec wording-change lists, as both are under
  the non-executable-delta path, where a markdown-only delta already holds. So a conflict resolved inside a governing
  document -- a `docs/spec/` file -- is not read by this path. That is a stated
  limit rather than a verified property; excluding markdown in one path and not
  the other would have been the inconsistency, and the alternative was to make
  the cheapest possible re-attestation depend on a file class the existing path
  already waives.

## The shape check

Step 4 routes a rebase and a base sync differently, so the verifier checks
which one it has rather than trusting the caller:

- each base must be an ancestor of its own head;
- the post-rebase base must descend from the pre-rebase one;
- the attested head must NOT be an ancestor of the new head.

The last is the discriminator. A base sync leaves a merge commit whose first
parent is the attested head, so the attested head is an ancestor of it; a
rebase re-authors the branch's commits and leaves it none. A head the verifier
refuses on shape takes the rules Step 4 already states.

## Why it is a script rather than a reading

Nothing in CI can catch a false claim here. `npm run check:pr-checklist`
compares the sha on the checklist line against the pull request's head and has
no view of whether the claimed property holds, so an eyeballed "the rebase
changed nothing" lands an unreviewed head as reviewed. The property is verified
mechanically or not at all -- the same rule the non-executable-delta path
states, for the same reason.
