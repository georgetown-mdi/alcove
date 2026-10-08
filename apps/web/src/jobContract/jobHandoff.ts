import type { HandoffBindPath } from "./handoffBindPaths";

/**
 * The recurring-run hand-off: the portable, secret-free material an operator
 * needs to graduate a prototyped console exchange to a scheduled `alcove`
 * command-line run. The console composes every path it runs the CLI over as
 * a CONTAINER-internal path, and the shared secret lives only in the on-disk
 * `.alcove.key`, which never crosses the browser. The hand-off is a
 * PORTABLE TEMPLATE, not a turnkey export: the machine-independent parts
 * (SFTP host/port/username, the host-key fingerprint pin, the linkage terms
 * exactly as they ran) are filled in, while machine-specific paths are shown
 * as labelled placeholders the operator sets for their own machine.
 *
 * The exchange mode's template is written through core's
 * `serializeExchangeDocument`, the writer Alcove's own `saveConfig`
 * uses, and over a document the schema has validated -- so an authored
 * exchange and one opened from the mount are written by one writer, in the
 * file Alcove would write for those settings (docs/spec/EXCHANGE_FILE.md,
 * "Writing a configuration back").
 *
 * Two invariants, enforced by the compose helpers in `@jobs/handoff` and
 * driven in jobHandoff.unit.test.ts and jobHandoffParity.unit.test.ts:
 * - No shared secret, key-file body, or inline credential value is ever
 *   present: the exchange config holds the credential only as an `@path`
 *   reference, and the zero-setup command holds no secret at all.
 * - No container-internal path is ever present: the credential `@path`,
 *   every filedrop rendezvous mount, and the signing identity file are
 *   replaced with fixed placeholder tokens before the template is composed.
 *   A configuration opened from the mount and not converted states its own
 *   shared-folder, sftp credential, and signing paths instead, as it read them
 *   (`withPathsAsRead` in `@jobs/handoff`): paths of the operator's machine,
 *   never the console's.
 */
export interface JobHandoff {
  /** The mode the run used: `exchange` (invitation, config-and-key driven) or
   * `zeroSetup` (Direct, the positional `$0` command form). */
  mode: "exchange" | "zeroSetup";
  /** The channel the run used. */
  channel: "sftp" | "filedrop";
  /**
   * Whether the run wrote a `.alcove.key` the operator must copy to their
   * recurring folder. True for the exchange mode (which holds a shared secret
   * in the key file), false for the zero-setup mode (which holds none).
   */
  usedKeyFile: boolean;
  /**
   * Whether the run used the `.alcove.key` beside the configuration opened in
   * the working folder, rather than one written into the run's own folder.
   * The panel then points at that file, which the run's handshake rotated in
   * place. Always false for a zero-setup run, which uses no key file.
   */
  keyFileBesideConfiguration: boolean;
  /**
   * Whether the authored SFTP credential arrived as a PASTED value
   * (materialized to a server-owned file) rather than a file the operator
   * owns. The panel shows the save-it-to-a-file caveat when true. Always
   * false on the filedrop channel, which has no credential.
   */
  credentialPasted: boolean;
  /**
   * Whether the run signed receipts under a long-lived signing identity.
   * True for a `certificate`-mode exchange, false otherwise (every
   * zero-setup run signs nothing).
   *
   * The panel shows the reuse-the-identity caveat when true: the recurring
   * run must load the SAME signing key file, since a fresh `alcove
   * fingerprint` on the scheduling machine mints a different key the
   * partner's pin would reject.
   */
  usedSigningIdentity: boolean;
  /**
   * The settings the template's `certificate`-mode signing block needs and
   * does not have, as the file spells them, which the panel names for the
   * operator to set before scheduling. Absent when there are none. They are
   * the two the CLI refuses such a block without, before any exchange: a
   * party name in `linkage_terms.identity` and a `signing.identity_file`.
   * An unconverted opened configuration's block, handed off as read for a
   * run that signed nothing, can lack either.
   */
  signingSettingsToSet?: Array<HandoffSigningSetting>;
  /**
   * Which machine-specific paths the template states as the opened
   * configuration read them rather than as placeholders. The panel names a
   * path stated as read as the operator's own, to confirm on the scheduling
   * machine, and a placeholder as one to set.
   */
  pathsAsRead: HandoffPathsAsRead;
  /**
   * The absolute paths outside the exchange folder the template names -- a
   * credential file, a shared folder, the signing identity -- which a run of
   * the published image reads only where each is mounted at the same path
   * inside the container. A relative path resolves under the exchange folder
   * and is not listed.
   */
  bindPaths: Array<HandoffBindPath>;
  /** The portable template itself: the exchange config document and the command
   * that runs it (exchange mode), or the zero-setup command tokens (zeroSetup
   * mode). */
  template: JobHandoffTemplate;
}

/**
 * Per path kind, whether the template states the opened configuration's own
 * value and no placeholder. All false for a zero-setup run, a converted
 * configuration, and an exchange authored on the console.
 */
export interface HandoffPathsAsRead {
  /** Every sftp credential `@path` the template states is the file's own.
   * False on filedrop, and false when any credential field is a placeholder. */
  credential: boolean;
  /** The filedrop shared folder, or both folders of a split pair, is the
   * file's own. False on sftp. */
  sharedDirectory: boolean;
  /** The template's `signing` block states a signing identity of the file's
   * own. */
  signing: boolean;
}

/** A setting a `certificate`-mode signing block requires, as the file spells
 * it. */
export type HandoffSigningSetting =
  "linkage_terms.identity" | "signing.identity_file";

/**
 * The portable template, discriminated on which artifact the mode produces: the
 * `alcove.yaml` config text an exchange-mode recurring run loads, beside the
 * argv tokens of the `alcove exchange` command that loads it, or the argv
 * tokens of the zero-setup command a Direct-mode recurring run invokes.
 */
export type JobHandoffTemplate =
  | { kind: "config"; yaml: string; argv: Array<string> }
  | { kind: "command"; argv: Array<string> };
