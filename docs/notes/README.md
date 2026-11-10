# Design notes

Tracked, citeable design records: the model behind a mechanism, the options
weighed, and the decisions taken. Nothing here is normative -- a note binds no
implementation, and points at the spec for the normative rows rather than
restating them. A note opens with a status line stating where its subject
stands, from a direction still open to a decision taken and built.

## Index

The Status column is one word from a fixed set:

- **open** - a direction or question not yet decided, or decided only in part.
- **decided** - the decision is taken and not built.
- **built** - the decision is taken and built, in whole or for the part the
  note's status line names.
- **withdrawn** - weighed and set aside, or built and then removed.
- **measured** - a measurement record; any decision taken on it is recorded
  where it applies.

Each note states its full status at its own top; this table is a pointer, not
a restatement.

| Note | Subject | Status |
| ---- | ------- | ------ |
| [abort-marker-retryable-class.md](abort-marker-retryable-class.md) | A retryable class in the file-sync abort marker | open |
| [agent-hooks-and-scripts.md](agent-hooks-and-scripts.md) | Why the agent hooks and session scripts have their shape | built |
| [app-shell-service-worker.md](app-shell-service-worker.md) | The app-shell service worker's caching | built |
| [backup-import-per-exchange-guard.md](backup-import-per-exchange-guard.md) | A per-exchange guard on the backup import | built |
| [bound-transformed-value.md](bound-transformed-value.md) | A bound on the value a transform produces | built |
| [broker-runtime-closure.md](broker-runtime-closure.md) | The signaling broker's runtime closure | built |
| [browser-sftp-proxy.md](browser-sftp-proxy.md) | The browser SFTP path and its proxy | open |
| [cascade-fan-out.md](cascade-fan-out.md) | Fan-out under the cascade strategy | built |
| [chunked-aead-envelope.md](chunked-aead-envelope.md) | The chunked AEAD envelope's measurements | built |
| [claude-md-spawn-cost.md](claude-md-spawn-cost.md) | CLAUDE.md's per-spawn cost and its split | built |
| [cli-webrtc-attempt-cycle.md](cli-webrtc-attempt-cycle.md) | The CLI's WebRTC partner wait in bounded attempts | built |
| [cli-webrtc-stack.md](cli-webrtc-stack.md) | The CLI's WebRTC library | built |
| [cloudflare-turn-sizing.md](cloudflare-turn-sizing.md) | One relayed run through Cloudflare TURN | measured |
| [column-name-display.md](column-name-display.md) | Showing the operator's own column names | built |
| [comment-history-narration-check.md](comment-history-narration-check.md) | The comment history narration check | built |
| [connect-timeout-prior-art.md](connect-timeout-prior-art.md) | What a connect timeout bounds | built |
| [connection-error-kind-taxonomy.md](connection-error-kind-taxonomy.md) | The `ConnectionErrorKind` taxonomy | built |
| [connection-per-poll-sftp.md](connection-per-poll-sftp.md) | Connection-per-poll SFTP and reconnects | built |
| [console-announce-and-focus.md](console-announce-and-focus.md) | Announcing an outcome, and focus | built |
| [console-signing-identity-custody.md](console-signing-identity-custody.md) | The console's signing-identity custody | built |
| [core-dist-cache-buildinfo.md](core-dist-cache-buildinfo.md) | Why the core build is non-incremental | built |
| [cosign-keyless-signing.md](cosign-keyless-signing.md) | Keyless Cosign signing | built |
| [cross-workspace-test-material.md](cross-workspace-test-material.md) | Where cross-workspace test material lives | built |
| [deduplicate-matching-semantics.md](deduplicate-matching-semantics.md) | Deduplicating matching semantics | built |
| [default-linkage-rule-set.md](default-linkage-rule-set.md) | The built-in linkage rules and their provenance | built |
| [failure-cause-catalog.md](failure-cause-catalog.md) | A failure's cause sentence from core | built |
| [fan-out-matching-resolution.md](fan-out-matching-resolution.md) | Fan-out matching resolution | built |
| [file-sync-rendezvous-structure.md](file-sync-rendezvous-structure.md) | File-sync rendezvous and poll structure | built |
| [fips-provider-surface.md](fips-provider-surface.md) | A FIPS provider in the shipped image | measured |
| [fips-variant-image.md](fips-variant-image.md) | The FIPS variant container image | built |
| [folded-column-name-lookup.md](folded-column-name-lookup.md) | Folding column names before the key lookup | built |
| [hash-keyed-value-lookup.md](hash-keyed-value-lookup.md) | Keying per-record value lookups by hash | built |
| [hosted-environment-opentofu.md](hosted-environment-opentofu.md) | The hosted environment's inbound rules in OpenTofu | withdrawn |
| [hosted-static-build.md](hosted-static-build.md) | The hosted static build | built |
| [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) | Key establishment and the FIPS 140-3 boundary | built |
| [linkage-rule-catalog.md](linkage-rule-catalog.md) | The linkage rules and their precision bands | built |
| [linkage-rule-grounding.md](linkage-rule-grounding.md) | The rationale behind the linkage rules | built |
| [lockless-rendezvous-barrier.md](lockless-rendezvous-barrier.md) | An asymmetric rendezvous barrier | withdrawn |
| [managed-exchange-design.md](managed-exchange-design.md) | The recurring web exchange's design | built |
| [one-sided-disclosure.md](one-sided-disclosure.md) | One-sided linkage disclosure | built |
| [one-sided-fuzzy-expansion.md](one-sided-fuzzy-expansion.md) | Which party expands fuzzy variants | built |
| [operator-message-control-characters.md](operator-message-control-characters.md) | Control characters in an operator-facing message | built |
| [output-directory-removal-lock.md](output-directory-removal-lock.md) | The write lock on a failed write's removal | measured |
| [payload-as-agreed-terms.md](payload-as-agreed-terms.md) | The payload column set as agreed terms | built |
| [portable-configuration-readers.md](portable-configuration-readers.md) | The exchange-file readers under the portable-configuration rule | built |
| [prebuild-provenance.md](prebuild-provenance.md) | Provenance of the vendored prebuilds | built |
| [psi-c-count-only.md](psi-c-count-only.md) | Count-only linkage | built |
| [psi-run-to-run-determinism.md](psi-run-to-run-determinism.md) | A psi result changing between runs | built |
| [psi-step-liveness.md](psi-step-liveness.md) | Liveness through a partner's PSI step | built |
| [rebase-reattestation.md](rebase-reattestation.md) | Re-attesting a review across a rebase | built |
| [receipt-run-binding.md](receipt-run-binding.md) | Binding a signed receipt to one run | built |
| [receipt-signing-fips-boundary.md](receipt-signing-fips-boundary.md) | Receipt signing and the FIPS 140-3 boundary | decided |
| [record-durability-point.md](record-durability-point.md) | When a disclosure record is owed | built |
| [rename-to-alcove.md](rename-to-alcove.md) | The rename to Alcove | built |
| [repo-check-scripts.md](repo-check-scripts.md) | Why the repository check scripts have their shape | built |
| [reported-failure-cause.md](reported-failure-cause.md) | Showing a failed exchange's reported cause | built |
| [rotation-hardening.md](rotation-hardening.md) | Stale copies and one-sided rotations | built |
| [rule-set-citation-verdict.md](rule-set-citation-verdict.md) | A false rule-set citation in the acceptor's record | withdrawn |
| [sftp-adapter-state-machine.md](sftp-adapter-state-machine.md) | The SFTP adapter's state machines | built |
| [shared-consent-summary.md](shared-consent-summary.md) | One consent summary for two surfaces | built |
| [signing-identity-custody.md](signing-identity-custody.md) | Resolving the signing identity like a credential | built |
| [site-layout.md](site-layout.md) | A layout for the site's sources | open |
| [standing-relay-delivery.md](standing-relay-delivery.md) | How the standing relay is delivered | built |
| [terms-comparison.md](terms-comparison.md) | Comparing the two parties' linkage terms | built |
| [turn-provisioning-governance.md](turn-provisioning-governance.md) | TURN provisioning against partners' governance | open |
| [wasm-parallel-evaluation.md](wasm-parallel-evaluation.md) | Parallelizing the WebAssembly PSI backend | built |
| [web-server-runtime-role.md](web-server-runtime-role.md) | The web server's runtime role | built |
| [web-websocket-transport.md](web-websocket-transport.md) | The WebSocket relay and the browser SFTP path | built |
| [webrtc-frame-structure-envelope.md](webrtc-frame-structure-envelope.md) | The WebRTC inbound frame envelope | built |
| [webrtc-memory-measurements.md](webrtc-memory-measurements.md) | WebRTC party memory | measured |
| [webrtc-outbound-packer.md](webrtc-outbound-packer.md) | Encoding outbound WebRTC frames without recursion | built |
| [webrtc-relay-deployment.md](webrtc-relay-deployment.md) | The WebRTC relay and its deployment shape | measured |

The maturity ladder:

- `scratch/` (gitignored) - personal, throwaway thinking, no audience.
- `docs/notes/` (here) - tracked, citeable design records; non-normative.
- `docs/` proper - the formal, living documentation, in two tiers:
  - `docs/` (overview) - conceptual and operational documents for program
    officers, security reviewers, compliance officers, IT staff, and new
    contributors.
  - `docs/spec/` - the technical specification tier: wire formats, byte
    encodings, protocol internals, and implementation-level design, written for
    implementors and auditors. See [`docs/spec/README.md`](../spec/README.md)
    for the index and routing guide.

Naming: notes use lowercase-kebab filenames to distinguish them at a glance from
the SCREAMING_CASE formal specs in `docs/` and `docs/spec/`.
