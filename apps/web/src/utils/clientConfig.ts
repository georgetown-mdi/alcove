import { z } from "zod";

import type { LogLevel } from "loglevel";
import type { ZodType } from "zod";

/**
 * The deployment this build targets. `hosted` is the public browser-only
 * deployment: the server never receives a file and only coordinates peers.
 * `console` is the single-party console build, whose same-origin job API runs
 * a filedrop exchange server-side. The value is fixed at build time from
 * `VITE_DEPLOYMENT_PROFILE`; it decides the file-assurance copy, the transport
 * chooser's filedrop copy, and whether a filedrop channel routes to the
 * server-job driver.
 */
export type DeploymentProfile = "hosted" | "console";

const DEPLOYMENT_PROFILES = [
  "hosted",
  "console",
] as const satisfies ReadonlyArray<DeploymentProfile>;

/**
 * The client's build-time configuration. Each field is read from the
 * `VITE_`-prefixed variable of the same name, which Vite bakes in at build
 * time. The client resolves it without the server's env loader, which pulls
 * Node-only modules into the bundle.
 */
export interface ClientConfig {
  /**
   * Errors only (1), not warnings (2): PeerJS's warning-level logs
   * interpolate remote peer ids into the browser console, and those ids are
   * rendezvous addresses derived from the invitation secret -- the app keeps
   * them out of its own default logs (see psi/transport/rendezvous.ts), so
   * the PeerJS logger must not reintroduce them. Raise via
   * `VITE_PEERJS_DEBUG_LEVEL` at build time when diagnosing connection
   * issues.
   */
  PEERJS_DEBUG_LEVEL: number;
  LOG_LEVEL: keyof LogLevel;
  /**
   * `hosted` (the default) is the public browser-only deployment: the server
   * never receives a file, so the browser-only file-assurance copy holds and
   * every filedrop/sftp transport saves an exchange file. A deployment whose
   * server legitimately runs exchanges (the console) opts in via
   * `VITE_DEPLOYMENT_PROFILE=console`, which drops that assurance copy and
   * routes a filedrop channel to the server-job driver.
   */
  DEPLOYMENT_PROFILE: DeploymentProfile;
  /**
   * The release version of the image this build ships in, baked in from the
   * canonical `apps/cli/package.json` version by the image build (see the
   * Dockerfile and docs/RELEASES.md). Empty in the continuously deployed
   * hosted build and in any web build outside the image build, which pass no
   * value. A docker build of the repo bakes whatever version the manifest
   * holds -- on a non-release tree, the last published release -- so a value
   * here names the release the manifest held at build time, not a promise
   * that this build is that release.
   */
  ALCOVE_VERSION: string;
}

// Vite hands every env value over as a string, so a number arrives as its
// decimal text; a blank one is refused rather than read as zero.
const numberFromEnv = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number());

const clientConfigSchema: ZodType<ClientConfig> = z.object({
  PEERJS_DEBUG_LEVEL: numberFromEnv.default(1),
  LOG_LEVEL: z
    .string()
    .default("INFO")
    .transform((level) => level as keyof LogLevel),
  DEPLOYMENT_PROFILE: z.enum(DEPLOYMENT_PROFILES).default("hosted"),
  ALCOVE_VERSION: z.string().default(""),
});

/**
 * Resolves a {@link ClientConfig} from `data`, keyed by the unprefixed names.
 * An absent value takes its default; a value of the wrong shape is refused
 * with an error naming every offending variable, so a misconfigured build
 * fails at load rather than running under a substituted default.
 */
export function parseClientConfig(
  data: Readonly<Record<string, unknown>>,
): ClientConfig {
  const result = clientConfigSchema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `VITE_${issue.path.map(String).join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid build configuration: ${problems.join("; ")}.`);
}

/** The `VITE_`-prefixed build-time values, keyed by their unprefixed names. */
function viteEnvData(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(import.meta.env)
      .filter(([key]) => key.startsWith("VITE_"))
      .map(([key, value]) => [key.substring(5), value]),
  );
}

const config = parseClientConfig(viteEnvData());

/** This build's {@link DeploymentProfile}, resolved once from the config. */
export function deploymentProfile(): DeploymentProfile {
  return config.DEPLOYMENT_PROFILE;
}

/** Whether this build targets the console ({@link DeploymentProfile}
 * `console`), whose server runs a filedrop exchange rather than the browser. */
export function isConsoleBuild(): boolean {
  return deploymentProfile() === "console";
}

/** The release version of the image this build ships in, or undefined when it
 * has none. A released console image is the one build that has one; it
 * is what the partner accept kit names its `docker run` image by, so the
 * partner runs the version that minted their invitation. */
export function alcoveVersion(): string | undefined {
  return config.ALCOVE_VERSION === "" ? undefined : config.ALCOVE_VERSION;
}

/** The default level for the app's own loggers. */
export function logLevel(): keyof LogLevel {
  return config.LOG_LEVEL;
}

/** The PeerJS client's log level before diagnostic mode raises it. */
export function peerjsDebugLevel(): number {
  return config.PEERJS_DEBUG_LEVEL;
}
