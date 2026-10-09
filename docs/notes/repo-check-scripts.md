---
title: "Repository Check Scripts: Design Rationale"
---

# Repository check scripts: why each rule has the shape it has

_Status: decided and built.
Each check script's header states its contract: what it refuses, what it reads, its exit, and how to run it.
This note holds the reasoning behind those contracts: the failure each check exists for, the alternatives measured and declined, and the limits each accepts.
See [docs/notes/README.md](README.md)._

## URL-literal egress guard

[`scripts/check-egress-claims.mjs`](../../scripts/check-egress-claims.mjs)

### Why it is a check

[PRIVACY.md](../../PRIVACY.md) publishes negative claims to agency reviewers:
the container makes no network connection beyond the SFTP server or shared directory the operator configures;
the hosted web application loads no script, style, or font from a third-party host and requests no host beyond the supporting services it names;
and the project runs no license check, update ping, usage analytics, or telemetry.
Prose cannot hold those claims true.
A font CDN, an error-reporting SDK, an analytics snippet, or a version-check ping is one import away, and the document reviewers were handed goes quietly false.
So the claim is encoded as a check: a URL literal naming a host either sits on the allowlist with its reason, or it fails the build.

### How a literal and a host are read

Where a literal begins and ends is the language's own question.
The JavaScript and TypeScript family is read from the string, template, and JSX-text nodes of a TypeScript parse,
so a URL cannot run past the literal holding it, and whether a `${` interpolates is what the parser says.
Every other text format (CSS, HTML, SVG, Markdown, shell) is scanned raw,
and so is a file of the family whose parse reports a syntax error:
such a parse yields no literal nodes, and reporting a file clean because nothing could be extracted is the one direction the check cannot afford.
A raw scan reads comment text too, so those files over-report rather than under-report.

A URL inside a JavaScript or TypeScript comment is not reported.
That is a decision, not a limit of reach: a comment issues no request, and every documentation link would otherwise need an allowlist entry.

`new URL()` is the host oracle for the authorities it accepts.
An authority spelling out host-shaped text is reported even where `new URL()` rejects it
(`https://%zz/`, `https://[not-ipv6]/`, `https://a:b/`, `https://ex^ample/`),
and so is an authority of only a port outside a template (`https://:8443/x`).
A literal nothing could dereference can still fail the build; the author rewrites it or allowlists it with a reason.

### What is scanned, and why

The scanned roots are source that ships or runs, not all TypeScript.
They include `apps/web/server`, the console server the image runs, and the signaling broker's whole `src`, whose standalone entry runs as a service of its own.
The scanned files outside those trees are the shipped ones for both images:
the two entrypoints, which run inside the container the "no other network connection" claim is about;
the two `support/fips-probe/` files the FIPS image copies in and runs at every container start;
and the two Dockerfiles, which reach a different class (what the image build fetches),
scanned anyway because a `RUN curl` or `ADD https://...` pulling a third party into the image is what a reviewer of that claim wants shown.

Outside both, by design:
the build and test configuration at each workspace root, and the sibling `test/` trees.
Tests reach no user; build configuration does, through what it emits, which is why it is listed below as a gap rather than a safe exclusion.
A tree that starts shipping is added to the roots, so an exclusion stays a decision rather than an oversight.

Test files are not excluded by name.
The scanned roots are shipped-source trees by construction, so a `*.test.*` exclusion would only open a bypass.

Binary assets are skipped by extension rather than source admitted by extension,
so a new text format dropped into `apps/web/public` is scanned by default.
A new binary format that trips the check is fixed by adding its extension, a one-line edit a reviewer sees.
License and notice files are not scanned: the attribution URL in a vendored copyright line names an upstream project, not a host anything contacts.

### What it does not cover

These limits are published:
PRIVACY.md summarizes them and [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits) enumerates them, so narrowing one moves all three.
Most are past the reach of a literal scan; the guard is against egress added inadvertently, not against an author who wants to hide it.

- Egress assembled at runtime, from configuration, an operator-supplied value, or concatenation.
  The invitation endpoint and the operator's SFTP server are legitimately of this kind, so a literal scan is a safety check, not a proof of no egress.
- Egress originating inside a dependency, which is the dependency review's ground.
- Egress introduced by build configuration such as `apps/web/vite.config.ts`, which emits into the shipped page from outside the scanned roots.
- A file git ignores.
  Install and build output (`node_modules`, `dist`) lands under no scanned root,
  so the gap opens only for a file written under a scanned root and ignored there.
- A text file not in UTF-8: a UTF-16 file decodes with NULs between characters, matches nothing, and is still counted as scanned.
- A URL spelled to evade the matcher:
  split across concatenated fragments, written in a regular-expression literal,
  percent- or entity-encoded in the scheme or its colon (`%68ttps://`, `https&#58;//`),
  or glued to a letter, digit, or underscore before the scheme (`xhttps://host`).
  Any other preceding character still matches (`.https://host`).
  An escape the language removes is not an evasion: a literal is read as its cooked value, so `"https:\/\/host"` is reported.
- Schemes other than http, https, stun, stuns, turn, and turns (`wss://`, `ftp://`, `file://`), and a protocol-relative `//host`.
- An authority naming no host of its own:
  empty, which is what a protocol comparison (`location.protocol === "https:"`) is;
  wholly interpolated inside a template (`http://${host}:8443`), as the helpers over an inbound Host header write it;
  or all dots, which is how elided placeholder text writes a URL (`https://...#...`).
  An interpolation beside a literal host is reported (`https://${tenant}.evil.example`),
  and so is `https://${host}` in a string or JSX attribute, where nothing interpolates.

## Dependabot checklist-pin coverage

[`scripts/check-dependabot-pin-coverage.mjs`](../../scripts/check-dependabot-pin-coverage.mjs)

### Why it is a check

[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md) has an upgrade checklist for every dependency the repository reaches past the public API of.
A checklist fires only if someone reads it,
and a bump inside a batched Dependabot pull request beside a dozen routine ones is skimmed as routine, which is the point of batching.
`.github/dependabot.yml` holds those packages out of the batch, and the two files drift apart silently:
a checklist added reaches no config, and an exclude entry dropped reads exactly like one never needed.

Every checklist also assumes the package is pinned to the one version its assumptions were read off.
A caret slipping into a manifest installs a later version with no pull request to hold the checklist against.
So does a second manifest naming a different exact version: both pin and both look deliberate, but the checklist was worked through against only one of the two installed.

### Reading choices

- A group that names the package outright in its `patterns` is its deliberate reviewed treatment (`cryptographic`, `webrtc-stack`), so it needs no exclude entry.
  A group declaring no `patterns` matches every package (`non-critical`), so it always needs one.
- The cross-group rule is bounded by the update block, because groups compete for a bump only inside the block raising the pull request.
- A heading naming no package, or a token that is not an npm package name, fails rather than being passed over: a section no name can be read out of is a checklist nothing can be held against.
- Exact means a bare `major.minor.patch` with an optional prerelease or build suffix.
  A `file:` tarball, git commit, or `npm:` alias fails too: whether such a route pins is a judgment per dependency, and a checklist for one wants the rule widened by an explicit decision.
- The workspace set is expanded from the `workspaces` globs rather than asked of npm;
  the test holds that expansion to the set npm recorded in `package-lock.json`, so a glob read differently fails there instead of silently shrinking the sweep.

### What it does not cover

- Which group a package lands in.
  A package in no group still gets its own pull request, which satisfies the exclusion rule; only the silent direction, riding a batch, is checked.
- How Dependabot itself resolves the config.
  The lists are read as text, so what is asserted is the exclude entry the config writes by hand, not a prediction of which pull request a bump lands in.
- What is installed. No rule reads `package-lock.json` or `node_modules`; a lockfile disagreeing with an exact declaration is `npm ci`'s to catch.
- Whether the pinned version is the one the checklist was read off. A bump's own review establishes that.
- The docker and github-actions update blocks, whose lists hold different rationales;
  [`check-dependabot-ignore-shape.mjs`](../../scripts/check-dependabot-ignore-shape.mjs) owns the github-actions ignore list.
- Whether a package that ought to have a checklist has one. The read runs from the document outward, never back.
- A `patterns` entry with a `*` inside an otherwise literal name, such as a scoped-org wildcard.
  What it would swallow depends on resolution, so the check throws rather than guessing.
- Which of two groups should review a package named in both. The check holds only that every other group excludes it.

## Vectors against their generators

[`scripts/check-vectors-generators.mjs`](../../scripts/check-vectors-generators.mjs)

### Why it is a check

Every known-answer vectors file under `packages/core/test/vectors/` has a generator beside it,
and the suites assert the code reproduces the checked-in JSON.
Nothing asserted the other direction, that the JSON is what the generator produces,
so a failing conformance assertion could be silenced by editing the vectors file instead of fixing the code.

Every entry in the directory is classified, and an unclassified entry fails, so coverage cannot rot behind a file nobody added a rule for.
A verifier script is not run here: running it proves nothing about the file's provenance,
and `verify-native-wire-vectors.mjs` needs the vendored native addon selected for the runtime.
A vectors file with no generator is listed with its reason and named on every run, so the hole stays visible.
An in-place generator preserves the hand-authored fields of the committed file,
so the comparison covers the derived half, which is the half a silenced assertion would have to move.

### Restoring the tree

A check that left a regenerated vectors file behind would be indistinguishable from the edit it exists to catch.
So the bytes and timestamps of every touched file are restored on return or throw,
and signal handlers restore in the gaps between per-file runs.
Each generator runs synchronously, so a signal arriving during one is not handled until that child exits;
a process-group kill mid-run leaves that file's probe mtime and any in-place write for git to restore.

### The probes

- The write probe sets each target's mtime to a fixed past instant before its generator runs,
  so whether the generator wrote the file is observed rather than assumed, and must agree with its declared shape.
- The excused-value probe requires each mask to fire the same non-zero number of times on both sides, counted per key,
  so a mask that has stopped matching fails instead of excusing the whole file.
- The built-core probe fails when `packages/core/dist` is older than its sources, since a stale dist makes the comparison meaningless.

### The masked values

The signed-receipt and signing-certificate generators sign by shelling out to `openssl`, and two values do not reproduce:

- `signature`: ECDSA draws a fresh nonce per signature, so it moves on every run.
- `signatureProducer`: each generator records `openssl version`, which reproduces only on a host with the same build.

Regenerating both files against an openssl reporting a different version and diffing the whole file showed those were the only bytes that move;
every fingerprint, binder, coordinate, and canonical layout reproduced exactly.
So they are masked by name rather than the files being dropped from the check.
What the signature mask gives up is covered elsewhere, also measured:
flipping one character of every masked signature fails `signedReceipt.test.ts`, `signedReceiptVerification.test.ts`, and `signingIdentity.test.ts`,
and the browser suite loads them in real Chromium.
The producer value records which openssl signed the checked-in bytes, history a regeneration does not need to reproduce.

### What it does not cover

- Whether a vectors file is correct. A generator and a file wrong together pass.
- A hand-edited input in an in-place generator's file, preserved by design so a deliberate re-pin is reviewable as a diff.
- What another dependency version would produce: the comparison is against the locally installed packages and the locally built core, the same limit `npm run check:routetree` has.
- Formatting drift from a prettier upgrade.
  The generator's output is formatted through the repository's prettier before comparing, so a reflow moves both sides and shows up as a formatcheck failure instead.
- Another process writing the same files concurrently, which can leave either copy in place.

## Installed packages against the lockfile

[`scripts/check-node-modules-drift.mjs`](../../scripts/check-node-modules-drift.mjs)

### Why it is a check

`worktree-init.sh` does not install: it shares the primary clone's installed packages by absolute symlink.
A worktree therefore inherits whatever the primary holds, including an install that has fallen behind its own lockfile,
and nothing in the provisioning path consulted a lockfile.
That inheritance is silent and it bites:
a worktree provisioned from a primary holding prettier 3.8.4 against a lockfile pinning 3.9.6 reformatted dozens of untouched files on `npm run format`.

### Why npm decides

Predicting which lockfile entries npm would install on this platform, or where it would dedupe them, would reimplement the tool's resolution,
which [CLAUDE.md](../../CLAUDE.md) names a review finding.
So the comparison is `npm install --dry-run --json`, which builds the ideal tree from package-lock.json and diffs it against what is on disk.

Measured 2026-08-02 against npm 11.17.0 and node 26.4.0, in the repository's own drifted worktree and in synthetic trees the colocated test rebuilds on every run:

- `--offline` against a complete lockfile needs neither network nor a warm cache.
  Pointed at an empty `--cache`, the dry run still produced the full diff, naming the lockfile's versions, so cache state cannot change the verdict.
- `--dry-run` writes nothing, neither node_modules nor the lockfile.
- npm prints its human-readable `change <name> <from> => <to>` lines to stdout ahead of the `--json` summary even at `--loglevel=error`,
  so the summary is parsed from the first line that is a bare `{`.
- npm masks uuid-shaped path segments in everything it prints, reporting them as `***`.
  Probing such a path as-is under a directory named for a session id reads every entry as absent and calls a provisioned worktree empty,
  so each reported path is mapped back to the longest package-lock.json key it ends with before anything is opened.

### Reading the diff over a symlink mirror

npm compares an ideal tree of real directories against a mirror of links, so most of its diff is mirror shape rather than drift.
The classes are told apart by version:

- `change` with differing versions: the wrong version is installed. This is the class that bites, and it fails.
- `change` with equal versions: npm plans to replace a link with a real directory holding the same version.
  It is shape, not drift, and is ignored; in the drifted worktree, 549 of 603 change entries were this.
- `add`: npm does not walk into a linked package's own node_modules, so a dependency nested under a shared package reads as absent.
  It is ignored when the install path already holds the version npm names (all 71 add entries in the drifted worktree did),
  failed as missing when the path holds nothing, and failed as a wrong version when it holds another.
- `remove`: a package on disk the lockfile does not list. It is reported, never failed:
  a primary shared across branches legitimately holds packages this branch's lockfile never mentions,
  and an extra package cannot change what the lockfile does describe.

### The `file:` tarball gap

A `file:` tarball dependency keeps its version string across a re-vendor,
so a mirror whose installed bytes lag the lockfile would pass on version identity while running stale code.
Every other class asserts nothing below a version number; this one gap is closed by an integrity comparison.

Measured 2026-08-24 against npm 11.19.0 and node 26.7.0 in throwaway trees:
`npm install --package-lock-only` on a `file:` dependency whose tarball changed bytes but not version left the lockfile's integrity untouched,
since npm treated the existing entry as up to date and never re-hashed.
A real `npm install` against the new tarball updates package-lock.json's integrity and leaves node_modules/.package-lock.json, npm's record of what it extracted, holding the same value;
an install not re-run since keeps the old value there.
So installed staleness is read by comparing the two files' integrity for each `file:` path, rather than by asking npm to refresh the lockfile.

### An unreadable install record

The same session measured the two ways node_modules/.package-lock.json can be unreadable:

- No node_modules at all: the dry run reports every package as an `add`, which already fails as missing.
  Nothing is installed to be stale, so the integrity comparison stays out of that verdict.
- node_modules populated, its record gone: the dry run goes quiet.
  Against a real install it reported no entry, and against a mirror only the same-version `change` entries the mirror's shape produces,
  both while the installed bytes were the pre-re-vendor ones.
  The record's absence blinds the one class that could fail here, so the tree is reported unverified and exits 2,
  after the other classes have reported.

## Exchange-record version obligations

[`scripts/check-exchange-record-version.mjs`](../../scripts/check-exchange-record-version.mjs)

### Why it is a check

Both obligations fall due long after the sentence stating them was written, and nothing fails when they are forgotten.
They are one check so that one literal edit gets one verdict rather than two failures to be read together.
The literal is read out of the source because this runs before any build, and a check that skipped on a missing `dist/` would be inert exactly when it is needed.

### The bump

A managed web exchange keeps an accounting of disclosures:
one stored value per exchange, holding its runs' exchange records verbatim,
and the source an operator draws a HIPAA 164.528 accounting or a FERPA 99.32 disclosure record from
([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md), "The accounting of disclosures").
The reader rejects an unrecognized version rather than migrating it,
so moving `EXCHANGE_RECORD_VERSION` invalidates, on every device holding one, an accounting nothing else holds a copy of.
The read refuses the whole value, and so does the append, which re-reads the accounting inside its own transaction:
a still-scheduled exchange goes on disclosing and files nothing, unattended.

The recovery is built: the stored-form export and the accounting-scoped reset, offered in that order from the unreadable state.
It rests on an assumption only the current format has been driven against:
that a move invalidates the entries and leaves the accounting envelope readable, so the entries come back whole.
An assumption about a format that does not exist yet cannot be tested ahead of the bump, so the literal is pinned.
The recovery entry points must also be declared, since a tree that lost that path would pass the pin while deferring to nothing.
They are named functions rather than a surface description: a declaration is a fact the check can read.

### The reset

The counter has cycled freely, from the format's first `v1` under the earlier product name on up,
because no published artifact contains any of its literals: `exchangeRecord.ts` does not exist at v0.1.0, the only tagged release.
The reset is taken at first publication rather than earlier.
Re-using a previously cycled value mid-development would let an artifact written under the old `v1` parse as the current version and fail on its field set,
instead of taking the clean version refusal the reader is built to give.

The release marker is `apps/cli/package.json`'s version, the same marker and publication floor `check-protocol-version-bump.mjs` arms on,
so "first publication" has one definition.
It is read from the tree rather than a git tag because the gate's checkout has no tags:
`static_checks.yaml` pins neither `fetch-depth` nor `fetch-tags`, and a marker absent from the checkout would leave the check inert forever.

Both rules record their discharge in the check itself (`RECORD_VERSION_PIN`, `RESET_TAKEN_AT_RELEASE`) rather than in a ledger beside it,
so recording one is the diff a reviewer sees, at the moment the decision is taken.

### What it does not cover

- Whether the recovery still works. It reads declarations, not behaviour.
  The behaviour is tested by `apps/web/test/unit/psi/disclosureAccounting.test.ts` (the envelope-parses, entries-reject split against the real parsers),
  `apps/web/test/browser/managedExchangeStore.test.ts` (the read's classification and the reset against real IndexedDB),
  and `apps/web/test/browser/managedExchangeDetail.test.ts` (both recovery arms reachable from the unreadable state, in order).
- The artifact side of the reset.
  A development artifact at rest, a browser-stored accounting or a record file on an operator's disk, is outside the tree.
  A leftover entry numbered above the reset value is worse than unreadable: the accounting orders entry literals ordinally, so it classifies as a stale page,
  whose remedy is a reload that cannot help and which withholds the export-then-reset arms
  ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#what-an-exchange-record-version-bump-does-to-a-stored-accounting)).
  The Release Checklist step the failures name lists that confirm-or-wipe obligation.
- Whether the record vectors were regenerated. `npm run check:vectors` fails on its own once the literal moves.
- Whether a recorded discharge was recorded after the decision was taken or instead of taking it.
  Moving a constant is a one-line edit the check cannot tell from a correct one, the same limit the pull-request checklist's security-review sha has, so it is a reviewer's call.
- The CLI's record files.
  The CLI writes a standalone record file per run and keeps no accounting store,
  so a version its build does not recognize is refused when the file is read, with the file still in the operator's hands.
  The recovery obligation the bump rule defers is the web accounting's alone.

## Failure display sinks

[`scripts/check-run-failure-sink.mjs`](../../scripts/check-run-failure-sink.mjs)

### Why it is a check

A failed run holds two pieces of operator-facing text a relayed cause chain can reach.
The `message` is composed as a chain whose links are separated by the error renderer's own newline (`sanitizedFailureMessage` in `apps/web/src/exchange/useInviterExchange.ts`).
The `reportedCause` is the chain itself, where the category states copy of its own in front of it.
Two treatments lay either out:
a `pre-line` white-space style for the renderer's newlines,
and a break in front of each escaped line-break marker a value's own text holds (`layOutValueLineBreaks`).
A render that omits them collapses the chain onto one line, readable enough to pass a green suite and useless to an operator trying to tell which link failed.
So each piece renders through one component in `apps/web/src/exchange/RunSurface.tsx`.

### The types it checks

`FAILURE_TYPES` names the exchange roles' `RunFailure`, the recurring exchange's `ManagedRunFailureAlert`,
and the `FailureText` shape both satisfy, which a component taking a failure as operator-facing text alone annotates its prop with.
Each holds the two pieces and renders them through the same sinks.
A type absent from that list binds nothing.

### The scanned set

Every source under `apps/web/src` is walked whole rather than listed, so a new file is covered the moment it exists and no list drifts out of coverage.
The bindings narrow the scan, not the file set: a file that never annotates a name as a tracked type contributes none.

### How a binding is found

There is no type checker.
Every reference to a tracked type is walked up to the declaration it annotates, and the local name that declaration binds is a failure-valued binding for the rest of the file:

- A parameter or variable annotated whole: `(failure: RunFailure)`, `const failure: RunFailure = ...`,
  and `useState<RunFailure>()`, where the type is the initializer's type argument and the binding is the array pattern's first element.
- A member of the type literal annotating one, `{ failure: RunFailure }` on a destructured parameter,
  read through the destructuring to the name the binding element introduces:
  the renamed local in `{ failure: renamedFailure }`, and through a nested pattern the same way.
  A parameter bound whole (`props: { failure: RunFailure }`) keeps the key, the name the member is read by there.
- A member of a named props interface, by the key alone.
  The interface and the component destructuring it are two declarations a single-file scan does not link,
  so a component renaming the member (`{ failure: renamed }: Props`) binds nothing.

Matching by name within one file replaces type resolution.
A file binding an unrelated value under a name it also annotates as a tracked type has that value's `.message` render reported,
a false report whose fix is to read the two names apart.

### What a render matches

- Matched: a `.message` or `.reportedCause` read off a tracked binding anywhere inside a JSX expression container,
  the `{failure.message}` child of a hand-styled span and the `message={failure.message}` attribute alike, optional chaining included.
  The same-named attribute of that piece's own sink is the one allowed position; the right prop on the wrong component fails.
- Not matched: a read taken as a condition.
  Those are the guards in front of an optional piece, compared (`{failure.reportedCause !== undefined && <Sink ... />}`) or bare (`{failure.reportedCause && <Sink ... />}`),
  and none puts the read's text in front of the operator: a `&&` yields its left side only where it is falsy, and the rest yield a boolean.
  A guard whose branch inlines the piece fails on that branch.
  A `??` or `||` is matched, since each yields the left side's value to render.
- Not matched, a stated limit: a read reaching JSX through a local (`const text = failure.message`, `const { message } = failure`),
  a helper called with the failure, or a container assembled outside JSX.
  Following those needs taint analysis a syntactic scan cannot run.
- Not matched, by construction of an AST walk: the name inside a comment or a string literal.

### Vacuity guards

Every half of the claim is named by identifier, so a rename would leave the check scanning for something that no longer exists.
Each tracked type's and each sink's declaration must still be where the check says,
and each sink must have at least one render going through it.

## Release signing coupling

[`scripts/check-release-signing.mjs`](../../scripts/check-release-signing.mjs)

### Why it is a check

Keyless signing leaves no public key to fetch,
so what the `cosign verify` command in [RELEASES.md](../RELEASES.md) pins is the release workflow's Sigstore identity:
this repository's path to the workflow file, plus the ref the run came from.
Both halves are properties of the workflow, its filename and its `on.push.tags` filter,
and neither a rename nor a widened trigger touches the document.
The drift costs in both directions.
A published pattern that no longer describes the signer refuses the signature a real release produced,
so a partner's verification fails over a good image and the project hears about it from the partner.
A pattern loosened until it passes again accepts signatures a release did not produce.

The workflow's own self-verify step catches the first direction, but only at release time, with the tag pushed and the image published.
This check is the pull-request half.

The build-provenance attestation is coupled the same way:
`gh attestation verify --signer-workflow` names the workflow file whose run produced the attestation,
so a rename leaves that command reporting no matching attestation for an image every release attests.
Nothing measures that at release time, since GitHub keeps the attestation and no step reads it back,
so this check is the only half there is.
The decision to sign keylessly, and the probe runs behind the issuer and identity, are in [cosign-keyless-signing.md](cosign-keyless-signing.md).

### Why each rule

- The identity's workflow-path segment may hold no regular-expression metacharacter, so a pattern loosened by unescaping a `.` fails rather than being treated as a rename.
- Every image push is followed by its own sign, verify and attest steps before the next image build, because a second image's push between the first one's push and its signing leaves the first published under `latest` and unsigned for as long as that build runs,
  and permanently if the build fails.
- Each verify step carries both certificate arguments in its own run text, because the one-identity comparison reads the whole workflow file at once and the step-order rule credits a step by the digest it names,
  so one step's copy of the certificate arguments would satisfy the comparison for every other step.
  A verify step stripped of the pair, or pointed at another identity, would pass both while running a command no partner runs.
- The document publishes at least one `--signer-workflow`, since without it the attestation command's `--repo` is satisfied by an attestation any workflow in this repository produced.

### What it does not cover

- Whether the identity is the one a run produces.
  The check compares the published pattern against this repository's workflow path and tag filter, so the two being wrong together passes.
  What Fulcio writes into the certificate was driven rather than inferred, in [cosign-keyless-signing.md](cosign-keyless-signing.md).
- The `<owner>/<repo>` segment of either command, which nothing in the tree derives.
  A fork publishing the document unchanged passes, and the two commands' copies of that segment are not compared with each other.
- GitHub's filter-pattern semantics.
  The tag-pattern comparison compares text under a stated correspondence rather than modelling them:
  over the accepted character class a filter and a regular expression agree character for character, except that `.` is literal in a filter.
  Any other character, `*` and `?` above all, fails rather than being translated on a guess.
- Whether any of it verifies.
  Only a release run signs anything; the self-verify step measures that, and this check keeps that step's two arguments the published ones.

## Post-publication protocol version bump

[`scripts/check-protocol-version-bump.mjs`](../../scripts/check-protocol-version-bump.mjs)

### Why it is a check

[PROTOCOL.md](../spec/PROTOCOL.md) states that a wire-format delta ships within `PROTOCOL_VERSION` 1 while Alcove is pre-publication,
and takes a bump from the first published deployment onward.
The release that obligation binds arrives long after the sentence was written, nothing fails when it is forgotten,
and the change that should have taken the version decision ships past it.

### Reading choices

- The release marker is `apps/cli/package.json`'s version, which [RELEASES.md](../RELEASES.md) step 2 calls the release version and `check-release-version.mjs` compares the pushed tag against.
  It is read from the tree rather than a git tag because the gate's checkout has no tags:
  `static_checks.yaml` pins neither `fetch-depth` nor `fetch-tags`, and a marker absent from the checkout would leave the check inert forever.
- The vectors digests are the proxy for "the wire format changed".
  A vectors file classified in neither list fails, so coverage cannot lapse behind a file nobody classified.
- The ledger is empty while the rule is inert,
  because a pin recorded pre-publication would go stale against months of permitted deltas and then fail at publication for an unrelated reason.
- Once the rule binds, the ledger is append-only, and that shape is what a reviewer reads:
  a bump adds an entry, so a legitimate bump and an in-place rewrite of a published version's pin are different diffs.
  The check cannot tell a legitimate re-pin from a rewrite that dodges the bump,
  the same limit the pull-request checklist's security-review sha has.

### What it does not cover

- A wire-format delta no vectors file pins.
  Several frames [Matching Algorithms](../spec/PROTOCOL.md#matching-algorithms) defines are pinned by no file, so a delta confined to one of them moves no digest.
- A frame shape the pinned scenarios do not drive.
  The terms-envelope vectors capture what `exchangeTerms` and `sendAbort` emit on the scenarios they run.
  The vectors suite closes that gap on its side: it reads the field set each slot's schema admits from the source and fails until the pinned frames cover it,
  so an added field takes a scenario, and a scenario moves the digest.
- A cosmetic change against a wire-format one.
  The digest is over parsed JSON, so reformatting does not move it, but reordering keys or renaming a hand-authored vector does,
  which fails toward taking the version decision.
- Whether the version decision taken was right: it fails a moved pin with no bump, and cannot judge a bump that was not needed.
- A `PROTOCOL_VERSION` that is not an integer literal, which fails rather than being guessed, since the check reads source instead of importing the built package.

## WebRTC `provider_options` unread

[`scripts/check-webrtc-provider-options-unread.mjs`](../../scripts/check-webrtc-provider-options-unread.mjs)

### Why it is a check

That no WebRTC transport reads `connection.provider_options` is a claim about runtime,
and prose asserting one goes stale silently the day a WebRTC consumer of the map is added.
It also makes the SFTP-only default-deny allowlist in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionprovider_options) a safe place to stop:
the day a WebRTC transport reads the map, this check fails before that transport ships without an allowlist of its own.

### The scanned set is the claim

A WebRTC source the lists do not name is unexamined, as with [`scripts/lib/sftpAdapterSites.mjs`](../../scripts/lib/sftpAdapterSites.mjs).
Each list is checked against the tree, so an added or removed file fails rather than changing what the list means.
The web neighbours are resolved with the TypeScript compiler's own resolver under `apps/web/tsconfig.json`'s merged options rather than a re-parse of its `paths` map.
A dynamic `import()` and a second hop are outside the set.

`WEB_FILES` stays a list rather than a directory scan of `apps/web/src`, the shape `CLI_FILES` uses,
because `apps/web` also hosts the console's job API, whose SFTP-authoring code may legitimately read `provider_options`.

### What a read matches

Both spellings are watched: the camelCase name the parsed exchange spec uses at runtime, and the snake_case name in the document and an unnormalized parse.
A destructured key is matched plain or renamed, in a declaration or a parameter.
A dynamic key (`x[computedKeyVar]`, or a computed destructuring key) and a re-export under another name are not seen,
since neither writes the name in a shape the scan reads.

## Single-pass measurement harness

[`scripts/single-pass-bench.mjs`](../../scripts/single-pass-bench.mjs) is a bench rather than a check:
it measures the receiver memory and masking compute that bound a single-pass exchange,
and its figures, with the ceiling derived from them, are in [PROTOCOL.md](../spec/PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).

Across both parties the curve work is `c_enc*(D_send + D_recv) + c_re*(2*D_recv)`,
each party's first encryption plus the sender's re-encryption and the receiver's match, where `D` is the count of distinct values a party pools across all keys.
The masking steps share one PSI client key between the receiver's request and its match,
so the sweep relays a live exchange rather than building a reply offline in an independent process.

## Web config loadability

[`scripts/check-web-config-native-load.mjs`](../../scripts/check-web-config-native-load.mjs) and [`scripts/check-web-config-image-load.mjs`](../../scripts/check-web-config-image-load.mjs), sharing the child-process harness in [`scripts/lib/configLoadHarness.mjs`](../../scripts/lib/configLoadHarness.mjs)

### Why each is a check

Two paths evaluate `apps/web/vite.config.ts` with no transform in front: Vite's `configLoader: "native"` and a plain `node` import.
Both hand it to Node's strip-only type stripping, which erases annotations and nothing else,
so a construct that needs code generated for it is refused with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
Driven against Node 26.7, that is a constructor parameter property, an `enum` (`const` or not), a non-`declare` `namespace`, and an `import x = require(...)` alias;
modifiers that erase, such as `private`, `readonly`, `abstract` and `declare`, load.
That list is for a reader; what the check enforces is the measurement.
The refusal is a parse error in the module holding the construct, so it fires anywhere in the config's import graph,
and the graph reaches app source (`src/utils/serverConfig.ts` to `src/utils/configManager.ts`) that nothing else holds to erasable syntax.
Typecheck, lint and a bundling `vite build` all run a real TypeScript transform and do not see it.

The Dockerfile builder stage copies apps/web's config, `src/`, `server/` and `public/` and no test tree,
and `npm run build:console -w apps/web` there is the first thing that evaluates `vite.console.config.ts`, and the `vite.config.ts` it imports, against that subset.
Vite's config loader bundles the config rather than importing it, so it resolves every literal specifier the file holds, inside a dynamic import too, whether or not the branch is taken.
One import of a test-tree module fails the image build while every local command stays green, because each runs from a tree that has the test files.

### Measured, not modelled

Neither check parses TypeScript, resolves a specifier, or predicts what a loader would do; both spawn the real loaders and read the outcome,
under [CLAUDE.md](../../CLAUDE.md)'s rule on settling an external tool's behavior by driving it.
The image check reads its copy list out of the Dockerfile, so the two cannot drift.

### Why a control fixture

A check that only loaded the real config would pass forever, detecting nothing, if the measurement stopped being one:
a future Vite making "native" a transforming loader, Node growing a transform of its own, the replicated tree quietly carrying the test tree in, or the loader no longer resolving relative imports.
So each check first loads a control the measurement must refuse, and a control that loads fails the check rather than licensing the result below it.
The native check asserts the control's rejection rather than assuming it because a TypeScript loader installed by a means it does not scrub, a `node --import` in a wrapper or a hook in another inherited variable, would still transform the config.

### Why both native loaders

Vite's native loader imports the config through Node, so today the plain-import leg is the narrower of the two.
It is driven anyway, since that overlap is a property of the current Vite:
if a later "native" grows a transform, the plain leg still measures Node's own behavior, and it is what `node apps/web/vite.config.ts` gets.

### What they do not cover

- Another version of Vite or Node than the installed ones.
- A construct reached only from a branch a command other than `serve` takes.
- Whether a config that loads is correct for the dev server or the build.
- The build past the config: a module under `apps/web/src` importing the test tree does not fail the image check.
  A full `vite build` is the minutes `check:deploy-trigger-graph` pays for and the merge path does not have.
- The image's own `npm ci`: the replicated tree borrows this checkout's installed dependencies through a symlink,
  so it measures the repository file subset, not the installed tree the image resolves bare specifiers from.
- `.dockerignore`, which keeps build outputs and node_modules out of the build context.
  The check copies from the working tree, where a stray build output under a copied source directory is reachable to the load and would not be in the image.

## Route tree freshness

[`scripts/check-routetree-fresh.mjs`](../../scripts/check-routetree-fresh.mjs)

### Why it is a check

`apps/web/src/routeTree.gen.ts` is written by the TanStack Router codegen and checked in by design:
typecheck, lint, build and the web test suites all read it, so a fresh clone must have it before any generation step runs.
The price is that every web-tooling invocation rewrites it,
so a copy that has drifted behind the pinned generator shows up as an unrelated modification in a branch that touched no route,
noise in a diff and a dirty tree where a clean one is required.
The check turns that drift into a failure, so a refresh lands as its own commit instead of going in with someone else's.

### Non-mutating

A check that left a regenerated file behind would recreate the hazard it exists to remove,
so the working-tree bytes are restored whatever the outcome.
The signal handlers restore too, since an ordinary teardown does not run on a signal, and a backup outside the repository covers the restore itself failing.

The probe is appended rather than the file being moved aside, so the path never stops existing:
a repo-wide reader running at the same time, such as the egress scan over `git ls-files`, an editor or a typecheck, sees a valid file with one extra trailing comment instead of an ENOENT.

### Why a probe line

`vitest list` is the cheapest invocation that loads the web config and so runs the codegen, about seven seconds.
A check that only diffed the file afterwards would pass forever, detecting nothing, if a future TanStack or vitest release stopped generating on config load.
The generator was measured to overwrite a probe-marked file whole, so a probe left behind means the codegen did not run.

### What it does not cover

- Another version of `@tanstack/router-generator`.
  It compares against the locally installed generator, so it is only as good as the lockfile pin, and a node_modules out of step with the lockfile makes it disagree with CI.
  A stale copy and a generator that changed its output format both read as "differs" and are answered the same way, by committing the regenerated bytes.
- Route correctness: that the tree is what the app needs, that no route file is missing or misnamed, that the routes resolve.
- Another entry point reaching the codegen with a different plugin configuration.
- A stale route tree against a broken web config: an invocation failing for another reason, such as an uncollectable test file or a missing `@alcove/core` build,
  is reported as a codegen failure with the command's own output.

## Built-in rule set version bump

[`scripts/check-built-in-set-versions.mjs`](../../scripts/check-built-in-set-versions.mjs)

### Why it is a check

[What the versions mean](default-linkage-rule-set.md#what-the-versions-mean) states the rule in prose:
an edit to the built-in field set bumps its version, and an edit to the key set bumps the key set's,
a reorder included, because the order is cascade order and moving a key changes which one claims a record more than one would match.
The recorded validation attaches to a name and a version together,
so an edited set holding the old version leaves that note describing rules nobody ran.
A future obligation written as prose fails silently when it is forgotten; the check is that obligation.

### Reading choices

- Every set the registry declares is read, not the default alone, so a set added to it is pinned from its first commit.
- The digest is over the evaluated declarations rather than the file text, so a cosmetic edit leaves a version alone, the case the note names.
- Unlike the protocol-version pin, this rule binds from the outset rather than from a first publication, so the ledger ships populated.
- The ledger is keyed by set name and then version, and is append-only: a bump adds an entry, so a legitimate bump and an in-place rewrite of a recorded pin are different diffs.
  The check cannot tell a legitimate re-pin from a rewrite that dodges the bump, the same limit the pull-request checklist's security-review sha has, so an edit to a recorded entry is a reviewer's call.
- One name and version identify one content, which the ledger's keying takes for granted.
  A shared set is one declaration read twice, but two different contents under one name and version fail rather than being pinned to whichever entry comes first.

### What it does not cover

- Whether the version decision was right: it fails moved content with no bump and a bump with no pin, but cannot judge which semver component a change deserved, or a bump that was not needed.
- A content change against a cosmetic one below the property level.
  Renaming a key or reordering a constraint's `exclude` list moves the digest, which fails toward taking the version decision.
  A key's name is not cosmetic between the parties: the terms cross-check encodes the key list whole, so two builds spelling a key differently cancel the exchange.
- A declaration that is not a plain literal, which fails rather than being guessed at, since the sets are read by evaluating their source initializers.

## Zero-setup key fields

[`scripts/check-zero-setup-keys.mjs`](../../scripts/check-zero-setup-keys.mjs)

### Why it is a check

The property and its failure modes are in [What zero-setup rests on](default-linkage-rule-set.md#what-zero-setup-rests-on).
Held by review, it is the shape that goes stale, because the edit that breaks it is one nobody would recognize as touching zero-setup at all.
Holding only the default set would leave a later set covered by nothing until someone remembered.

### Why a field's name must equal its type

The satisfiability filter compares an element's `field` against the semantic types the input file supplies,
so a built-in field whose name is not its type names a type no file can offer,
and every key referencing it is dropped from a zero-setup party's terms whatever columns that party brings.

### What it does not cover

- Whether a declared field is one a party really always holds.
  Widening the field set is not silent, since its content is pinned by [the version bump check](#built-in-rule-set-version-bump) and a widening takes a bump there,
  but whether the wider set is still guaranteed is a judgment no check makes.
- The terms builder itself: that the filter binds an element by semantic type, which is what makes the name-equals-type rule matter, is covered by the core suite.
- A file that supplies a column of the right type but no usable value: the property is that the keys stay inside the guaranteed fields, not that a given file matches on them.

## Mutation score floors

[`scripts/stryker-security.mjs`](../../scripts/stryker-security.mjs)

### Why a per-file floor

Stryker's own `thresholds.break` is whole-run, so a file whose tests were gutted can be offset by the others,
and the score this leg exists to defend is each file's own.
The score follows the mutation-testing report definition; mutants Stryker could not run, compile errors, runtime errors and ignored ones, are outside both sides of the ratio.

### Why an on-demand install

Stryker drags in a second copy of vitest and its own typescript,
so a devDependency would put both in every contributor's and every CI job's install for a leg that runs nightly.
The private prefix is reused across runs when it already holds the pinned versions.
Stryker's vitest runner resolves vitest through the working directory's package.json, so Stryker runs with the repository root as its working directory and picks up the pinned vitest there.
The typescript version is read from the installed copy so the prefix gets the one the repository resolves; Stryker's configuration step needs it at runtime, with no checker plugin involved.

### What it does not cover

- A mutant is killed only by a test that reaches the mutated source.
  Each leg's files are exercised through its own workspace's unit tier alone, the vitest configuration its Stryker configuration names,
  so coverage in another workspace's suites or an integration tier does not count, and a file whose only tests are there scores as uncovered.
- The score answers whether a test distinguishes the mutated behavior, not whether the behavior is correct.
  A survivor whose only observable effect is message text is a real survivor, though not necessarily worth a test.
- A file that stops being mutated, renamed, deleted or dropped from the configuration, fails rather than passing vacuously, because floors are compared per file.
- A runner change that stops tests executing per mutant leaves survivors that may keep the score above its floor,
  so a surviving mutant with zero tests completed fails naming its file, whatever the score.

## Nested root packages

[`scripts/check-nested-root-package.mjs`](../../scripts/check-nested-root-package.mjs)

### Why it is a check

A workspace manifest bump can leave a second copy of a package the root already has:
npm 11.17 does not hoist a later range bump incrementally while a root `overrides` block stands, so the stale hoisted copy is kept and the raised version is nested under the workspace that asked for it.
Nothing at install time reports the split.
A build plugin can resolve the root copy while the dev server runs the nested one, and a suite that fails on it does not name the split as the cause.
`@dependabot rebase` and `@dependabot recreate` each reproduce it.
The measurements and the remedy are in [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md), "What a root overrides block changes about later installs".

### Why every package

The mechanism is the overrides block's presence, not any one dependency, so a named list would only ever cover the recurrences that already happened.
`NESTED_BY_DESIGN` records a split meant to stand, which keeps the check from failing on one.
An entry there that is no longer a split fails too, so a fixed split cannot leave its excuse behind.

### What it does not cover

- It reports the split the committed lockfile records, not one npm would resolve; a lockfile edit it passes is still confirmed by reinstalling from it.
- A copy nested deeper, under another package's node_modules, is ordinary conflict resolution, which the committed tree holds dozens of;
  the class above was measured nesting directly under the workspace that raised its range.
- A workspace-nested package the root does not have: with no root copy there is nothing to be split against.
- A stale hoist against a split some declared range requires.
  The lockfile records neither the override nor which edge each copy serves, so which one a split is stays a reading of the bump, recorded with its reason in `NESTED_BY_DESIGN`.
- A copy is matched by the directory it installs under, which is what a bare specifier resolves through, and its identity is read from the entry's `name`.
  Where the two disagree, an npm alias, the check refuses by name rather than reporting a duplicate of a package only one of them is; an alias anywhere else is out of scope.
- The manifest's `workspaces` globs are not re-expanded: the lockfile's keys are npm's record of the directories it resolved.

## Workflow agent model pins

[`scripts/check-workflow-agent-models.mjs`](../../scripts/check-workflow-agent-models.mjs)

### Why it is a check

A Workflow script's `agent(prompt, {...})` call that omits `model` does not fall back to the agent definition's pinned tier;
it inherits the session model silently, wherever the script runs from.
The tiering rule in [CLAUDE.md](../../CLAUDE.md) is only as good as the pins written into the scripts, and prose cannot assert that every call has one.
The PreToolUse hooks that gate the Agent tool see none of this, since the model lives inside a script string rather than a top-level tool input.
A `.claude/scripts/*-workflow.mjs` file is a script body, not a module, so it is not linted and cannot be imported; the check reads it whole as one block.
Fable requires the owner's per-spawn approval and is never inherited, so it may not be pinned in a committed script at all.

The same holds for `effort`: a call that omits it runs at the session's reasoning effort, whatever the session was started with.
Effort decides how deep a reviewer reads: the same lens round replayed on ten branches raised 6 of 22 known majors at major with the effort raised, against 1 at the effort it inherited.
So every call pins a literal `effort` beside its `model`, from the values the Workflow runtime accepts (`low`, `medium`, `high`, `xhigh`, `max`).
A call missing both pins is reported once, naming both.

### Why the options object is spelled out

A spread into the options object can carry a `model` or `effort` of its own and decide it at run time, so a spread fails whether or not a literal sits beside it.
A hoisted options constant is treated as no pin, by design: the convention is an inline literal in the call.

### Why a lexer

The scan reads strings, template literals, regex literals and comments as tokens,
so a `model: 'opus'` in a prompt template or a comment is not a pin, and a parenthesis inside a string cannot run one call's extent into the next.
A pin counts only at the top level of the call's own options object, so a nested call's pin cannot stand in for its caller's.

### What it does not cover

- `agent` reached under another name.
  A non-call use of the identifier is reported, but a binding taken off a property (`const spawn = deps.agent`) is a member access the check leaves alone,
  and a call through that binding, or straight through the member access (`deps.agent(...)`), is invisible.
- A js fence nested inside another fence: the outer fence's info string decides the block, so js inside a markdown example is not scanned.
- A script of neither shape: an ad-hoc inline Workflow script, or a file passed by `scriptPath` from elsewhere.
  `require-workflow-fable-approval.mjs` covers the inline form for Fable.

## OS-layer attribution lists

[`scripts/generate-os-package-attribution.mjs`](../../scripts/generate-os-package-attribution.mjs)

### Why generated from a built image

NOTICE covers the npm tree by construction and `npm sbom` reaches no OS package, so these lists are where a reviewer reads an image's OS layer.
They come from a built image rather than a Dockerfile: the base image's own packages ship as surely as the ones an install instruction names, and no instruction names them.
The query runs against the tag because neither Dockerfile names its final stage,
and a `--target` query would measure a stage that predates the runtime stage's own installs, which on the default image is where `samba-client` arrives.
The queries were run against both images at both architectures.
The rpm query runs unchanged under the FIPS variant's fips-only OpenSSL configuration: rpm reads its database in C, and the configuration reaches only what dnf's Python hashes with.

### Why a moved version only reports

The runtime stage's package install resolves versions against a live index that moves under a digest-pinned base,
so failing on a version would fail builds nobody changed; a package set or license string that moved still fails.

### Why each refusal

- rpm exits 0 when its format string names a tag that does not exist, printing nothing, so a run that parses no row fails rather than reporting an empty package set.
- [COMPLIANCE.md](../COMPLIANCE.md)'s Section 889 paragraph and [CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md) state that neither the release SBOM nor these lists cover the Node.js runtime,
  which each image installs outside its package manager, so a row naming it would falsify both.
- A license disjunction is a licensing call, not a measurement, and the two distributions mix legacy Fedora shorthand with SPDX expressions, so no string is rewritten.
- A package recording no license fails rather than landing with an empty cell; rpm's literal "(none)" is the same absence in another shape.

## Pull-request checklist

[`scripts/check-pr-checklist.mjs`](../../scripts/check-pr-checklist.mjs)

### Why it reads the fetched pull request

A push and a body edit landing seconds apart leave the push-triggered run holding a body that no longer exists, and a re-run is handed the same stale payload.
So the workflow fetches the pull request from the API and the check reads that copy.
On the runner an unreadable head sha, title or number exits 2 rather than passing, since each would otherwise skip or weaken a rule silently.

### What it does not cover

The rules are a mechanical check for the tells that a checklist was left unresolved, or resolved with a clause that answers nothing,
the same approach as [`check-contributing-scope.mjs`](../../scripts/check-contributing-scope.mjs).

- Whether a stated reason is true is a review call.
- An author who edits the sha without re-reading the diff passes the Security review rule, which reads a string, not a review.
- A line in a second `## Checklist` section is not read.
- A single-commit pull request may skip a hand-written squash message, since GitHub takes that commit's own message as the subject,
  so the title checked is not necessarily the subject that lands.
  The check enforces the title anyway, as the one field the workflow can see, and the maintainer can align the two at merge; it does not branch on commit count to guess GitHub's squash behavior.
- `titleBudget()`'s fallback for an unnumbered pull request serves a direct call; the CLI requires `PR_NUMBER` on the runner.

## Dependabot ignore shape

[`scripts/check-dependabot-ignore-shape.mjs`](../../scripts/check-dependabot-ignore-shape.mjs)

### Why it is a check

The `github-actions` block in `.github/dependabot.yml` ignores within-major updates for several organizations.
That suppression is sound only over pins that float within their major:
an exact pin such as `actions/checkout@v7.0.1`, a commit sha, or a branch name under a covered organization sits under an ignore that suppresses every update it could receive,
so it freezes with no pull request to expose a fix.
The entries are read from the config, so editing the ignore list changes what is enforced with no second edit.

### A property of the config, not a prediction

Whether those ignores in fact suppress a v7.0.1 to v7.0.2 bump has not been driven against Dependabot, and the rule does not rest on it.
A pin the config's own stated rationale assumes to be floating is worth holding to that shape either way.

### Why `*` matches across `/`

Under that reading `github/*` covers the subpath action `github/codeql-action/init`.
Whether that is Dependabot's reading is unsettled; see the open assumption in [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md).
The inclusive reading is the fail-closed one: it requires more pins to be bare majors, so the rule stays correct if the narrower reading is Dependabot's.

### What it does not cover

- A bare-major pin from an organization no ignore entry names: whether the ignore list is complete is unchecked, only the direction that fails silently is.
- A reference naming no ref at all, which rule C of [`check-action-pin-drift.mjs`](../../scripts/check-action-pin-drift.mjs) owns; a test holds that delegation.
- The npm and docker Dependabot blocks, whose ignore and exclude-patterns lists rest on different rationales.
- What `@v7` resolves to: the ref is read as text, so a tag named like a bare major that points at a frozen commit is out of scope.

## Built-in STUN default claims

[`scripts/check-stun-default-claims.mjs`](../../scripts/check-stun-default-claims.mjs)

### Why it is a check

A run that configures no STUN or TURN server gathers ICE against the WebRTC library's built-in default, disclosing the host's public address to whoever operates it.
Three surfaces name that endpoint to an operator, one right before they hand a recurring exchange's secret to a scheduler:
the CLI's warning, the web app's command-line export panel, and the docs.
An app may not import from another app and a document imports nothing, so the rest are hand-written copies of a value the library decides.
A copy left behind by a bump is a confidentiality statement gone false, which prose cannot hold true.

### Where the value is measured

The CLI owns the werift dependency, and its WebRTC integration suite (`apps/cli/test/integration/webrtc/transport.test.ts`) drives a real peer with no configured list,
resolves the hostname to loopback, and watches the STUN binding request arrive on that port.
It is re-run on every werift bump per [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md).
This check holds the copies to the constant and says nothing about whether the constant is right.
Reading the library's source to predict its default would be a second implementation of it, which this repository does not accept.

### What it does not cover

- The web app's own ICE list (`apps/web/src/psi/transport/rendezvous.ts`, described in [PRIVACY.md](../../PRIVACY.md)).
  It is a different list for exchanges a browser runs itself, which happens to include the same Google server;
  tying it here would fuse two independent decisions, so those files are not listed, by design.
- A copy in a file no list names: a new surface is covered only once it is added to `CODE_COPIES` or `CLAIM_TEXTS`.
- Prose describing the default without writing the endpoint: nothing there can drift, though each `stated` file must still hold one claim that writes it.
- A claim split across two sentences: a claim is read from "built-in" to the end of its sentence, so the endpoint must sit in that sentence.

## Merge gate identities

[`scripts/check-merge-gate-identities.mjs`](../../scripts/check-merge-gate-identities.mjs)

### Why it is a check

A branch ruleset names each required status check by a bare context string, which GitHub matches against the check runs a pull request produces.
Three ordinary edits break that match with nothing red to show for it,
leaving the requirement pending and every pull request unmergeable until branch protection is edited, and a fourth drops a check the merge gate relies on after a merge:

- Renaming a job whose `name:` is a required context: the check run the ruleset waits for is never created under that name again.
- Adding a `paths:` or `paths-ignore:` filter to a gating workflow: a pull request touching nothing the filter matches skips the workflow, so its check runs are never created.
- Requiring a context whose job a workflow outside `GATING_WORKFLOWS` declares: the path-filter rule reads only the listed files, so the previous hazard goes unwatched on that workflow.
- Dropping a gating workflow's push trigger on staging.
  A pull request merges without being brought up to date with staging, so the push run is what tests two independently green pull requests together.

The declaring-workflow rule holds `GATING_WORKFLOWS` to the merge gate's own contexts rather than leaving it a hand-kept list nothing measures.
Reading per protected branch rather than per ruleset name means renaming a ruleset does not drop coverage, and the branch endpoint reports what every active ruleset contributes.

### What it does not cover

- A templated job name: resolving a `${{ }}` expression means reimplementing the expansion GitHub performs, so a context only such a job satisfies fails rather than passing on a guess.
- Whether a job with the right name runs on a pull request to the protected branch, or succeeds: the context rule matches names, not runs.
  The trigger rule covers that for the listed workflows, and the declaring-workflow rule holds the list to every workflow declaring a required job.
- A job calling a reusable workflow produces composed check-run names (`caller / callee`); only the caller's own name is collected.
- Which of two identically named jobs satisfies a context.
  Nothing constrains a job name to one file, and which check run GitHub matches is its call to make, so a context is held to all of its declarers,
  and one unlisted file fails the rule even when another declarer is listed.

## Verification-config integrity

[`scripts/check-config-integrity.mjs`](../../scripts/check-config-integrity.mjs)

### Why it is a check

Typecheck and test are only evidence while the configs under them still say what they are believed to say.
A tsconfig that loses its strictness options type-checks the same tree and reports nothing;
a vitest config that loses its `projects` list runs a fraction of the suites, or none, and exits 0.
Both failures are silent: the gates stay green, and every later gate on that tree stays green with them.
The check states the invariants those gates rest on so a truncated, emptied or half-written config fails loudly.
The file-list rule exists so a config that keeps `strict` but loses its `include` does not pass by checking nothing.
A project with no files is absent from the vitest listing entirely, which is the shape a lost `include` takes.

### Why it drives the tools

`tsc --showConfig` resolves `extends`, so a strictness option is checked where the compiler sees it, wherever it is written;
`vitest list --filesOnly` resolves the project graph the way a run does, without importing a test file.
Reading the JSON and the config source would be a second implementation of two resolvers, and a check that models a tool can disagree with it.

### What it does not cover

- Whether an option or a project should be there.
  The tables are the decision; review makes it, and moving a line there is an edit a reviewer sees.
  Not every option a config sets is listed: what is listed is what a silent loss would cost.
- The count of test files a project collects, beyond one: pinning a count churns on every test file added.
- Any other config a run reads (eslint, rollup, vite's build half).
  They fail loudly on their own: a lost rollup or vite config breaks the build rather than passing a smaller one.

## Deploy trigger

[`scripts/check-deploy-trigger-graph.mjs`](../../scripts/check-deploy-trigger-graph.mjs)

### Why it is a check

`pages_deploy.yaml` redeploys the hosted site on a push whose changed paths match a hand-written filter, narrower than the trees it names:
`packages/peerjs-broker/src/contrib/**`, for one, omits the sibling `src/standalone.ts` on the assumption that the broker's own entry is in no deployed import graph.
An assumption like that is invisible when it breaks.
Let an unfiltered source into the deployed site and edits to it stop triggering a deploy: production serves the previous build and no run goes red.
So every source the deployed build reads has to match the filter that redeploys it.

The deploy holds a Cloudflare token able to replace the public site, and a job holding it that also ran repository code would hand that token to whatever a pull request merged into that code.
So the upload job checks nothing out and only uploads the artifact the gate built, and no other job, in any workflow, holds the token or runs in the GitHub environments the token is set on.
A second deploy path, or a build step moved into the upload job, would hold the same token without that separation, and nothing but review would notice; the check turns either into a failure.

### Why the graph is read from a real build

Nothing in the check resolves an import, expands an alias or models what rolldown or the router plugin would do with a specifier: the build runs and reports what it read.
A prediction from the sources can disagree with the bundler; the record cannot.
`REQUIRED_GRAPH_ROOTS` exists because a recorder that stops producing in one bundle leaves a shrunken graph that trivially satisfies the filter, so each entry names the bundle whose silence it catches.
Build products are declared rather than inferred: a push carries sources, never an untracked build product, so the filter has to name the sources a product is built from.

### What it does not cover

- Filter syntax past three shapes.
  GitHub's path filters are a glob language, and modelling it would be predicting a tool's parser rather than driving it.
  A pattern of another shape throws, so it fails the check rather than being matched wrongly; adding one means teaching the check the shape.
- The reverse direction.
  A filter entry matching nothing in the graph is not a finding: the filter covers files no module graph reads (package.json, tsconfig.json, public assets).
- Anything a build does not resolve as a module.
  A file read at runtime by path, or copied into the artifact by a plugin (`public/`, the per-route documents' template), is not in the record.
- Whether a triggered deploy succeeds.
- Credentials outside the workflow files.
  A secret set at repository level rather than on the two environments is readable by any job naming it, and the check sees only the names a workflow writes.

## Action pin drift

[`scripts/check-action-pin-drift.mjs`](../../scripts/check-action-pin-drift.mjs)

### Why it is a check

The `github-actions` Dependabot block is configured against `.github/workflows`.
The shared CI prologue composite, `.github/actions/setup/action.yml`, pins actions of its own on a path this repository does not rely on being scanned.
Coverage reaches it transitively instead: every pin a composite has is identical to a pin a workflow has,
so a release or advisory showing on the workflow occurrence covers the composite one, and the bump answering it cannot land on the workflow and leave the composite behind.

### Why each rule

- Rule A: a bump applied to some occurrences and not others, the shape a single-file dependency pull request has, fails rather than leaving a stale composite.
- Rule B: a composite-only action has no occurrence on the configured path for a release or advisory to show on, so the check fails closed on it rather than passing a gap.
- Rule C: a reference naming no ref fixes no version, so nothing determines which code the step runs and no release or advisory has an occurrence to show on;
  neither tree may hold one, and rule A's mirror cannot be satisfied by one.
  Whether GitHub itself rejects the shape is unverified and the rule does not rest on it: if GitHub does, the rule never fires.

### What it does not cover

- What a ref resolves to: `@v7` agrees with `@v7` whatever the tag points at,
  so a floating major moving under both occurrences, one spelling denoting different commits in different places, and whether a ref is a tag, a branch or a sha are outside it.
- Which paths Dependabot in fact scans: it enforces the mirror invariant and confirms no tool's coverage.
- An action reached other than by `uses:`: a `run:` line that fetches a release, or an image named in `container:` or `services:`.
- Two workflows pinning an action no composite uses at differing refs: rule A binds only actions appearing in both trees.

## Image dependencies of the support scripts

[`scripts/derive-image-dependencies.mjs`](../../scripts/derive-image-dependencies.mjs)

### Why derived rather than listed

The shipped file-drop support scripts delegate every check they make to a capability of the image:
they hand a container an Alcove subcommand, or pipe a helper script into a shell inside it and depend on the tools that shell can resolve.
Nothing else in the repository connects the two, so a script can ask for a capability the image does not have and the mismatch shows only on an operator's PC.
The derivation lives apart from the probe so a new call site is noticed on every pull request without a Docker daemon.

### Why each anchor

- The subcommand names come from the image's own two dispatchers,
  so a command that ships without being registered, or a call site invoking one never seen, changes the derived set rather than going unnoticed.
- Running a helper script is what resolves the tools it needs, so no list of tool names is kept:
  a helper that gains a dependency on another in-image binary is covered by the run it already has.

### What it does not cover

- The subcommand-less invocation (`<image> file:///sync input.csv out.csv`), which names no registered command.
  `image_smoke.yaml` runs a full exchange over a bind mount, which is that shape.
- A call site that splits an argument vector across logical lines, or builds one from values the derivation cannot see.
  Both fail closed only insofar as the capability then goes underived, which is why the tripwires assert that each derivation found something.

## Workflow args resolution

[`scripts/check-workflow-args-resolve.mjs`](../../scripts/check-workflow-args-resolve.mjs)

### Why it is a check

The Workflow harness injects a script's arguments as `args`, either as the object the caller passed or as JSON text of it.
Every other delivery, an array, a bare scalar, null or nothing at all, has no named field,
and a script that reads one off it gets `undefined` rather than an error: the round runs, the agents are spawned, and the caller's arguments are missing from the prompts.
So a committed script resolves `args` once, through `resolveWorkflowArgs(args)`, which fails closed on a shape it cannot use.
The reads that break that convention, `args.role`, `const {role} = args`, `{...args}`, `args[k]`, all look ordinary, so prose cannot hold it.

### Why a lexer

The word `args` appears inside strings, templates, comments and prose outside every fence in these files, and none of those is a read of the binding.
Reading each block through the shared lexer is what makes the rule exact.

### What it does not cover

- What `resolveWorkflowArgs` itself does: the check holds every read of `args` to that call and nothing more.
  The two script tests compile and run the real script files; a new Workflow script that defined a lax resolver under that name would pass with no test behind it.
- `args` reached under another name.
  Taking the alias is itself a read and is reported (`const a = args`), but a binding taken off a property (`const a = deps.args`) is a member access the check leaves alone, and reads through it are invisible.
- A js fence nested inside another fence: the outer fence's info string decides the block, so js inside a markdown block is not scanned.
- A script of neither shape: an ad-hoc inline Workflow script, or a file passed by `scriptPath` from outside `.claude/scripts/*-workflow.mjs`.

## Check runner

[`scripts/run-checks.mjs`](../../scripts/run-checks.mjs)

### Why one job and one list

`static_checks.yaml`'s `repo-guards` job is where a repository-wide obligation is gated:
it has no path filter, and the merge-gating workflows beside it are each scoped to one concern (code scanning, dependency review, the Alpine native build).
So the set only grows.
The job is a single step invoking the runner, which is also the command a contributor runs before pushing rather than meeting a check when CI fails.

### Why serial and past a failure

Two checks regenerate a file in the working tree and restore it:
`check:routetree` rewrites `apps/web/src/routeTree.gen.ts`, and `check:vectors` the known-answer vectors,
so nothing else may read those paths while they run.
It runs past a failure so one red check does not hide the state of the rest.

### Why the typecheck, lint and format trio is not listed

It has its own required status check (`Typecheck, Lint, Format`), kept separate so the context on the merge gate's critical path is the one a contributor iterates on;
CONTRIBUTING.md names it beside this command.

### Why some checks stay off the list

A check needing the network, a token, a release trigger or CI's own install cannot run from a plain checkout,
and one whose cost is measured in minutes does not belong on the unfiltered merge path.

### Why the build is cleared

A `usesBuild` check's run clears the hosted build output first, so no check reads a build from before the run started.
The test classifying every `check:*` script means a new check cannot be added without being classified.
