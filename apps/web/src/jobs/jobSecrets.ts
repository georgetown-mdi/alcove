import { jobDirectory } from "./jobEnv";

declare global {
  var jobSecretsDirConfig: { resolvedDir?: string } | undefined;
}

/**
 * Resolve the secrets directory once and memoize it on globalThis, so dev-mode
 * HMR does not re-read it. Undefined when `JOB_SECRETS_DIR` is unset -- with NO
 * data-root fallback (`JOB_SECRETS_DIR_ENV` in `./jobEnv`). A plain resolve: the mount
 * is the operator's own directory, and the browse contract re-confines every
 * path against its realpath rather than trusting this resolution.
 */
export function useJobSecretsDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobSecretsDirConfig ??= {
    resolvedDir: jobDirectory(env, "secretsDir"),
  };
  return globalThis.jobSecretsDirConfig.resolvedDir;
}
