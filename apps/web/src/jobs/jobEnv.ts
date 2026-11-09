import path from "node:path";

/** The environment variable naming the data root the job API creates workdirs
 * under. */
export const JOB_DATA_ROOT_ENV = "JOB_DATA_ROOT";

/**
 * The environment variable naming the operator-mounted directory the console
 * lists and reads input CSVs from. When unset or empty, falls back to
 * `JOB_DATA_ROOT` (so a single-folder console, one mount with only
 * `JOB_DATA_ROOT` set, still lists inputs). The feature is off only when both
 * are unset: the listing reports `configured: false` with an empty list and
 * the profile/coverage routes answer 404. The operator mounts their own data,
 * so this is trusted local input, not a shared-service surface.
 */
export const JOB_INPUT_DIR_ENV = "JOB_INPUT_DIR";

/**
 * Names the operator-mounted shared folder a filedrop exchange reads and
 * writes. Falls back to `JOB_DATA_ROOT` when unset or empty; filedrop is
 * unavailable only when both are unset. Server-side configuration, never a
 * browser-sent path.
 *
 * With {@link JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} also set, this names the INBOUND
 * (peer-written) leg of a split rendezvous, not a directory both parties write.
 */
export const JOB_RENDEZVOUS_DIR_ENV = "JOB_RENDEZVOUS_DIR";

/**
 * Names the OUTBOUND (self-written) shared folder of a split filedrop
 * exchange, the companion to {@link JOB_RENDEZVOUS_DIR_ENV}'s inbound leg. Set it
 * when the partner-shared mailbox is two folders; every filedrop exchange the
 * console runs then uses the CLI's `inbound_path`/`outbound_path` pair instead of
 * a single shared `path`.
 *
 * No {@link JOB_DATA_ROOT_ENV} fallback: this variable being set is the only signal
 * that a split is provisioned. An inbound leg that arrived through the data-root
 * fallback is refused rather than synced (`rendezvousSplitFaults` in
 * `./jobRendezvous`). Server-side configuration, never a browser-sent path.
 */
export const JOB_RENDEZVOUS_OUTBOUND_DIR_ENV = "JOB_RENDEZVOUS_OUTBOUND_DIR";

/**
 * The environment variable naming the operator-mounted secrets directory the
 * console browses when authoring an SFTP connection's file-reference credential
 * (a password file, an SSH private key, a key passphrase). Unlike
 * `JOB_INPUT_DIR` and `JOB_RENDEZVOUS_DIR`, it has NO `JOB_DATA_ROOT` fallback:
 * when it is unset the secrets mount is unavailable, so the data root, which
 * every job writes into, is never treated as a secrets directory. The
 * credential picker browses the data root through a listing of its own
 * instead, under the containment warning. The mount is server-side
 * configuration, never a browser-sent path.
 */
export const JOB_SECRETS_DIR_ENV = "JOB_SECRETS_DIR";

/**
 * A server-side override for the pasted-credential scratch directory,
 * defaulting to `SFTP_CREDENTIAL_SCRATCH_DIR` (`./sftpScratch`). The container
 * image ships that default directory owned by the unprivileged account it runs
 * as, so it uses the default; a deployment running under some other account --
 * a container started with `--user`, which is how the console launcher runs one
 * against a data root the operator owns -- or the integration harness, which
 * runs the built server as an ordinary user, points it at a writable,
 * non-partner-syncable location instead, since the fixed default sits under
 * root-owned `/run` and cannot be created at boot. It is server-side
 * configuration, never derived from a request, and the boot containment
 * assertion guards it exactly as it does the default -- a value inside the data
 * root or rendezvous mount refuses the boot.
 */
export const JOB_SFTP_CREDENTIAL_DIR_ENV = "JOB_SFTP_CREDENTIAL_DIR";

/** A directory the console reads from a `JOB_*` variable. */
export type JobDirectory =
  | "dataRoot"
  | "inputDir"
  | "rendezvousDir"
  | "rendezvousOutboundDir"
  | "secretsDir"
  | "sftpCredentialDir";

/** How a {@link JobDirectory} is read from the environment. */
interface JobDirectoryVariable {
  variable: string;
  /** Whether the value is made absolute with `path.resolve`, which also
   * normalizes it; otherwise it is used as configured. */
  resolve: boolean;
  /** The directory whose variable is read when this one is unset or blank. */
  fallback?: JobDirectory;
}

const JOB_DIRECTORY_VARIABLES: Readonly<
  Record<JobDirectory, JobDirectoryVariable>
> = {
  dataRoot: { variable: JOB_DATA_ROOT_ENV, resolve: false },
  inputDir: {
    variable: JOB_INPUT_DIR_ENV,
    resolve: true,
    fallback: "dataRoot",
  },
  rendezvousDir: {
    variable: JOB_RENDEZVOUS_DIR_ENV,
    resolve: true,
    fallback: "dataRoot",
  },
  rendezvousOutboundDir: {
    variable: JOB_RENDEZVOUS_OUTBOUND_DIR_ENV,
    resolve: true,
  },
  secretsDir: { variable: JOB_SECRETS_DIR_ENV, resolve: true },
  sftpCredentialDir: { variable: JOB_SFTP_CREDENTIAL_DIR_ENV, resolve: false },
};

/** `variable`'s value in `env`, trimmed, or undefined when unset or blank. */
function configuredValue(
  env: NodeJS.ProcessEnv,
  variable: string,
): string | undefined {
  const value = (env[variable] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The path `env` configures for `directory`, from its own variable or else its
 * fallback's, resolved as {@link JOB_DIRECTORY_VARIABLES} states, with whether
 * it came from its own variable. Undefined when neither is set.
 */
export function readJobDirectory(
  env: NodeJS.ProcessEnv,
  directory: JobDirectory,
): { path: string; fromOwnVariable: boolean } | undefined {
  const { variable, resolve, fallback } = JOB_DIRECTORY_VARIABLES[directory];
  const own = configuredValue(env, variable);
  const configured =
    own ??
    (fallback === undefined
      ? undefined
      : configuredValue(env, JOB_DIRECTORY_VARIABLES[fallback].variable));
  if (configured === undefined) return undefined;
  return {
    path: resolve ? path.resolve(configured) : configured,
    fromOwnVariable: own !== undefined,
  };
}

/** The path {@link readJobDirectory} reads for `directory`, or undefined. */
export function jobDirectory(
  env: NodeJS.ProcessEnv,
  directory: JobDirectory,
): string | undefined {
  return readJobDirectory(env, directory)?.path;
}
