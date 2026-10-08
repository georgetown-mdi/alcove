import type { HandoffBindPath } from "./handoffBindPaths";

/**
 * The recurring-run hand-off: a portable, secret-free template for running a
 * console exchange as a scheduled `alcove` command. Machine-independent
 * settings are filled in; machine-specific paths are placeholders, or an
 * unconverted opened configuration's own paths. It never contains a secret or
 * a container-internal path (`@jobs/handoff`). Contract:
 * docs/spec/SERVER_JOB_API.md, "The recurring-run hand-off".
 */
export interface JobHandoff {
  /** `exchange` (config and key file) or `zeroSetup` (the positional command). */
  mode: "exchange" | "zeroSetup";
  /** The channel the run used. */
  channel: "sftp" | "filedrop";
  /** Whether the run wrote a `.alcove.key` the operator must copy; false for zero-setup. */
  usedKeyFile: boolean;
  /**
   * Whether the run used the `.alcove.key` beside the opened configuration,
   * which the handshake rotated in place. False for zero-setup.
   */
  keyFileBesideConfiguration: boolean;
  /** Whether the SFTP credential was pasted rather than a file the operator owns. */
  credentialPasted: boolean;
  /**
   * Whether the run signed under a long-lived identity (`certificate` mode).
   * The scheduled run must load the same key file: a fresh `alcove
   * fingerprint` creates a key the partner's pin rejects.
   */
  usedSigningIdentity: boolean;
  /**
   * The settings a `certificate`-mode signing block lacks and the CLI refuses
   * to run without, as the file spells them. Absent when there are none.
   */
  signingSettingsToSet?: Array<HandoffSigningSetting>;
  /** Which paths the template states as the opened configuration read them. */
  pathsAsRead: HandoffPathsAsRead;
  /**
   * The absolute paths outside the exchange folder the template names, which
   * the published image reads only when each is mounted at the same path.
   */
  bindPaths: Array<HandoffBindPath>;
  /** The template itself. */
  template: JobHandoffTemplate;
}

/**
 * Per path kind, whether the template states the opened configuration's own
 * value rather than a placeholder.
 */
export interface HandoffPathsAsRead {
  /** False on filedrop, and when any credential field is a placeholder. */
  credential: boolean;
  /** The shared folder, or both folders of a split pair. False on sftp. */
  sharedDirectory: boolean;
  /** The `signing` block's identity file. */
  signing: boolean;
}

/** A setting a `certificate`-mode signing block requires, as the file spells it. */
export type HandoffSigningSetting =
  "linkage_terms.identity" | "signing.identity_file";

/**
 * The exchange mode's `alcove.yaml` with the `alcove exchange` argv that
 * loads it, or the zero-setup command's argv.
 */
export type JobHandoffTemplate =
  | { kind: "config"; yaml: string; argv: Array<string> }
  | { kind: "command"; argv: Array<string> };
