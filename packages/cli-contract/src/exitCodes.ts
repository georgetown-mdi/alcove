// The CLI's named process exit codes, rungs of the sysexits table docs/CLI.md
// (Exit codes) lists; 64 and 69 stay literals at the CLI's exit boundaries
// (`exitCodeForError`, apps/cli/src/util/exit.ts). Each is an exported
// numeric literal, the shape scripts/mirrored-exit-codes.test.mjs reads.

/**
 * The process exit code for a failure in this implementation rather than in
 * anything the operator, the partner, or the transport supplied: `EX_SOFTWARE`
 * (70), the sysexits code for an internal software error. Held by core's
 * `InternalConsistencyError`, which core and the CLI raise where a
 * check on their own state fails.
 *
 * Distinct from both neighbours: 64 would name the operator's input as what to
 * fix when the run already found their declared sizes within budget, and 69
 * would present a deterministic internal fault as a transport blip worth
 * retrying, when a retry re-runs the whole exchange to the same refusal. The
 * documented response to a 70 is to report it (see docs/CLI.md, Exit codes).
 */
export const INTERNAL_FAULT_EXIT_CODE = 70;

/**
 * The process exit code for a run the partner or the agreed terms refused:
 * `EX_PROTOCOL` (76). Held by a `protocol`-kind `ConnectionError` (the
 * partner sent a frame or payload outside the message contract or what was
 * consented), a `PeerAbortError`, a `ReceiptVerificationError`
 * (the partner's certificate or receipt signature refused), and core's
 * `ProtocolRefusalError` (terms incompatible, a protocol version
 * mismatch, a partner abort at the terms exchange, a malformed partner frame,
 * or a completed exchange whose partner payload did not fit the result).
 *
 * Not 69: a retry meets the same partner and the same terms and reaches the
 * same refusal, and after a completed exchange it conducts another one. The
 * documented response is to contact the partner (see docs/CLI.md, Exit
 * codes).
 */
export const PARTNER_REFUSED_EXIT_CODE = 76;

/**
 * The process exit code for an authentication failure: `EX_NOPERM` (77). Held
 * by core's `AuthenticationError` -- the key exchange rejecting the
 * shared secret or the peer, or an SFTP host key other than the pinned one --
 * and set on the refusal for a rotated shared secret this party could not
 * save, after which every later key exchange fails the same way.
 *
 * Not 69: a retry against the same secret or the same server reaches the same
 * refusal, and on a schedule so does every later run. The documented response
 * is to re-invite, or to verify the server's key (see docs/CLI.md, Exit
 * codes).
 */
export const AUTHENTICATION_FAILED_EXIT_CODE = 77;

/**
 * The process exit code `alcove verify-receipt` reports for a definite
 * verification failure: `EX_DATAERR` (65), the sysexits code for input data
 * that was incorrect in some way. Read by both of the command's report
 * renderers -- the unsigned record and the dual-signed record -- and combined
 * across them by `worseReceiptVerdictExitCode`, so a failure on either
 * half reports this code.
 *
 * Distinct from the top-level catch-all (`process.exit(1)` in `index.ts`),
 * which stays 1: an unattended supervisor that sees this code knows the run
 * itself completed and rendered a definite bad-data verdict, rather than
 * hitting an error no command handler caught. See docs/CLI.md, Exit codes.
 */
export const RECEIPT_VERIFICATION_FAILED_EXIT_CODE = 65;

/**
 * The process exit code `alcove verify-receipt` reports for an incomplete
 * verdict: `EX_NOINPUT` (66). Nothing contradicted the record, but a check
 * could not run because an input it needs -- data, terms, a pinned
 * fingerprint, a signing identity, the exchange record -- was not supplied or
 * could not be read. Nonzero so a script gating on exit 0 accepts only a
 * receipt that was fully checked, and distinct from
 * {@link RECEIPT_VERIFICATION_FAILED_EXIT_CODE} because the remedy is to
 * supply the missing inputs, not to distrust the record.
 */
export const RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE = 66;

/**
 * The process exit code for an input file the run reads that is not there:
 * `EX_NOINPUT` (66). Held by `InputNotFoundError`.
 *
 * Not 64, because the command and its configuration are correct and the same
 * run succeeds once the file lands, as a scheduled run whose upstream extract
 * is late does; and not 69, because nothing about the transport is at fault
 * and a retry before the file lands reaches the same refusal. The documented
 * response is to retry once the file is in place, then alert (see
 * docs/CLI.md, Exit codes).
 */
export const INPUT_NOT_FOUND_EXIT_CODE = 66;

/**
 * The exit code a run reports when the exchange itself completed and a local
 * write did not: the result file, an audit artifact, the configuration and
 * consent records an online `invite`/`accept` writes, or the configuration and
 * key a zero-setup `--save` writes. `EX_CANTCREAT` (73) in the BSD `sysexits`
 * convention, not `EX_UNAVAILABLE` (69): the two exit codes demand opposite
 * operator responses (retry vs. do not retry), and a bare supervisor sees only
 * the code. See docs/CLI.md (Exit 73) and docs/spec/CLI_EVENTS.md.
 */
export const PERSISTENCE_LOSS_EXIT_CODE = 73;
