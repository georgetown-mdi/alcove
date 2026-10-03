import path from "node:path";

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

declare global {
  var jobSecretsDirConfig: { resolvedDir?: string } | undefined;
}

/**
 * Resolve the secrets directory to an absolute path from
 * {@link JOB_SECRETS_DIR_ENV}, or undefined when it is unset -- with NO data-root
 * fallback. A plain resolve: the mount is the operator's own directory, and the
 * browse contract re-confines every path against its realpath rather than
 * trusting this resolution.
 */
function loadJobSecretsDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = (env[JOB_SECRETS_DIR_ENV] ?? "").trim();
  if (configured.length === 0) return undefined;
  return path.resolve(configured);
}

/**
 * Resolve the secrets directory once and memoize it on globalThis, so dev-mode
 * HMR does not re-read it. Undefined when the variable is unset.
 */
export function useJobSecretsDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobSecretsDirConfig ??= { resolvedDir: loadJobSecretsDir(env) };
  return globalThis.jobSecretsDirConfig.resolvedDir;
}
