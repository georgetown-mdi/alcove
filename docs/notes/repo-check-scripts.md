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
