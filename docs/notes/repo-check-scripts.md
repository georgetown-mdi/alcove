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
the build and test configuration at each workspace root, the sibling `test/` trees,
and `apps/web/deploy`, whose nginx and platform-hook files configure the Elastic Beanstalk host and address the instance itself (127.0.0.1, the EC2 metadata service).
Tests and deploy files reach no user; build configuration does, through what it emits, which is why it is listed below as a gap rather than a safe exclusion.
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

- Rule 2 refuses a regular-expression metacharacter in the path segment, so a pattern loosened by unescaping a `.` fails rather than being treated as a rename.
- Rule 4 exists because a second image's push between the first one's push and its signing leaves the first published under `latest` and unsigned for as long as that build runs,
  and permanently if the build fails.
- Rule 5 exists because rule 1 reads the whole workflow file at once and rule 4 credits a step by the digest it names,
  so one step's copy of the certificate arguments would satisfy rule 1 for every other step.
  A verify step stripped of the pair, or pointed at another identity, would pass both while running a command no partner runs.
- Rule 6 requires at least one `--signer-workflow`, since without it the attestation command's `--repo` is satisfied by an attestation any workflow in this repository produced.

### What it does not cover

- Whether the identity is the one a run produces.
  The check compares the published pattern against this repository's workflow path and tag filter, so the two being wrong together passes.
  What Fulcio writes into the certificate was driven rather than inferred, in [cosign-keyless-signing.md](cosign-keyless-signing.md).
- The `<owner>/<repo>` segment of either command, which nothing in the tree derives.
  A fork publishing the document unchanged passes, and the two commands' copies of that segment are not compared with each other.
- GitHub's filter-pattern semantics.
  Rule 3 compares text under a stated correspondence rather than modelling them:
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
  The pinned files cover the PSI engine's bytes, the resolved association mapping, the terms-exchange envelope, single-pass message 2's frame layout,
  and the parts a PSI set and a matched-record list are sent in.
  The cascade's mapped-element list bodies, its per-round association-table frames, the count-only reply ([PROTOCOL.md](../spec/PROTOCOL.md)),
  and the save-bootstrap secret frame ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md)) are pinned by no file, so a delta confined to one of them moves no digest.
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

[`scripts/single-pass-bench.mjs`](../../scripts/single-pass-bench.mjs) is a bench rather than a check;
the figures it produced, and the ceiling derived from them, are in [PROTOCOL.md](../spec/PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).

### What it measures

The single-pass dataset ceiling is bound by two costs, not by the wire size:

- ECDH masking compute: one elliptic-curve scalar multiplication per distinct linkage-key value, single-threaded through `@openmined/psi.js`.
  Across the exchange the curve work is `c_enc*(D_send + D_recv)` for each party's first encryption plus `c_re*(2*D_recv)` for the sender's re-encryption and the receiver's match,
  where `D` is the count of distinct values a party pools across all keys.
- The receiver's peak resident memory.
  It keeps the reply, decodes it, builds its own and the sender's distinct-value index tables, and runs the cascade replay, all resident at once,
  so the receiver is the heavier side.

### Three memory quantities

They differ by more than an order of magnitude:

- the lifetime peak RSS, which includes transient allocation churn and is the practical ceiling;
- the live V8 heap after a forced GC, the retained JS;
- the WebAssembly linear heap.

The WASM heap is the emmalloc linear memory the OpenMined module exports, grow-only and never returned to the OS.
`process.memoryUsage().arrayBuffers` does not include it, since it counts only the V8 wire-buffer copies,
so the harness wraps `WebAssembly.instantiate` before the module instantiates and reads the exported memory's byte length.

### Mode choices

- `rates` establishes that masking is linear in the distinct-value count, so the spec's table can extrapolate from its slopes.
- `sweep` runs each side in its own forked process so `process.resourceUsage().maxRSS` is isolated per side,
  with the receiver's decode, index-table build and cascade replay exercised as in a live exchange.
  `maxRSS` is a whole-process lifetime high-water mark, so it includes churn across all phases, and most of the per-value slope is collectable garbage.
  Under `--gc` the children run `@alcove/core`'s `relieveTransientMemory` at the single-pass phase boundaries, so the receiver RSS reported is the shipped relief rather than a bench-only collection.
- `both-sided` is the quadratic case.
  At the default group size the resolved table reaches `N * N` pairs, exactly the pair-count bound the sender applies to the returned table (own rows times the partner's declared record count).
  The later keys keep near-unique values, so `D` stays `keys * rows` and the masking workload matches the sweep's;
  the receiver's post-replay time is where the closure check over the table's blocks lands.
- The masking ops need one PSI client key shared between the receiver's request and its match step,
  so the two sides cannot run as independent processes each generating its own key, and the sweep relays a live exchange instead of building a reply offline.

### Datasets

Every cell is a distinct value within a party, so `D = keys * rows`, the worst case the ceiling must cover.
The first `overlap * rows` rows are shared across parties so the match path runs and the result can be checked.
Both parties are sized equally, the symmetric case the role rule targets:
the sender's row count drives the index table, and the larger distinct-value counts drive everything else.
