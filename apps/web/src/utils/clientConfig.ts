import { z } from "zod";

import { authorityMovingSignalingField } from "@alcove/core";

import {
  SIGNALING_SCHEME_MISMATCH,
  signalingSchemeMatchesPage,
} from "./signalingScheme";

import type { LogLevelDesc } from "loglevel";
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
 * A signaling server this deployment names in place of its own origin: the
 * parsed `VITE_SIGNALING_SERVER_URL`. `path` is the mount the PeerJS client
 * dials, ending in `/`; `port` is absent when the URL names its scheme's
 * default.
 */
export interface SignalingServerSetting {
  secure: boolean;
  host: string;
  port?: number;
  path: string;
}

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
  LOG_LEVEL: (typeof LOG_LEVELS)[number];
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
  /**
   * The signaling server this deployment's browser parties register with, and
   * the one an invitation it mints names: a `ws:` or `wss:` URL whose path is
   * the server's mount (`wss://signaling.example.org/api/`). Unset or blank,
   * the parties use this app's own server at its origin's `/api/`. Fixed by
   * the deployment, never read from an invitation.
   */
  SIGNALING_SERVER_URL: SignalingServerSetting | undefined;
}

// Vite hands every env value over as a string, so a number arrives as its
// decimal text; a blank one is refused rather than read as zero.
const numberFromEnv = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number());

const SIGNALING_SERVER_URL_SHAPE =
  "must be a ws: or wss: URL naming a host and an optional port and path, " +
  "with no user name, password, query or fragment";

function parseSignalingServerUrl(
  value: string,
  context: z.RefinementCtx,
): SignalingServerSetting | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    // Checked on the raw text: URL reports an empty query or fragment
    // ("...?", "...#") as an empty string.
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    context.addIssue({ code: "custom", message: SIGNALING_SERVER_URL_SHAPE });
    return z.NEVER;
  }
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (
    authorityMovingSignalingField({ host: url.hostname, path }) !== undefined
  ) {
    context.addIssue({ code: "custom", message: SIGNALING_SERVER_URL_SHAPE });
    return z.NEVER;
  }
  if (url.port !== "" && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    context.addIssue({
      code: "custom",
      message: "the port must be 1 to 65535",
    });
    return z.NEVER;
  }
  const setting: SignalingServerSetting = {
    secure: url.protocol === "wss:",
    host: url.hostname,
    path,
  };
  if (url.port !== "") setting.port = Number(url.port);
  return setting;
}

// The names loglevel's setDefaultLevel accepts, in any case.
const LOG_LEVELS = [
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "SILENT",
] as const;

// PeerJS's LogLevel runs from Disabled (0) to All (3).
const PEERJS_MAX_DEBUG_LEVEL = 3;

const clientConfigSchema: ZodType<ClientConfig> = z.object({
  PEERJS_DEBUG_LEVEL: numberFromEnv
    .pipe(z.number().int().min(0).max(PEERJS_MAX_DEBUG_LEVEL))
    .default(1),
  LOG_LEVEL: z.preprocess(
    (value) => (typeof value === "string" ? value.toUpperCase() : value),
    z.enum(LOG_LEVELS).default("INFO"),
  ),
  DEPLOYMENT_PROFILE: z.enum(DEPLOYMENT_PROFILES).default("hosted"),
  ALCOVE_VERSION: z.string().default(""),
  SIGNALING_SERVER_URL: z
    .string()
    .default("")
    .transform(parseSignalingServerUrl),
});

/**
 * Resolves a {@link ClientConfig} from `data`, keyed by the unprefixed names.
 * An absent value takes its default; a value of the wrong shape is refused
 * with an error naming every offending variable, so a misconfigured build
 * fails at load rather than running under a substituted default. Given the
 * page's `pageProtocol`, a signaling server whose scheme differs from the
 * page's is refused the same way ({@link SIGNALING_SCHEME_MISMATCH}).
 */
export function parseClientConfig(
  data: Readonly<Record<string, unknown>>,
  pageProtocol?: string,
): ClientConfig {
  const result = clientConfigSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `VITE_${issue.path.map(String).join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid build configuration: ${problems.join("; ")}.`);
  }
  const signaling = result.data.SIGNALING_SERVER_URL;
  if (
    signaling !== undefined &&
    pageProtocol !== undefined &&
    !signalingSchemeMatchesPage(signaling, pageProtocol)
  )
    throw new Error(
      `Invalid build configuration: VITE_SIGNALING_SERVER_URL: ${SIGNALING_SCHEME_MISMATCH}.`,
    );
  return result.data;
}

/** The `VITE_`-prefixed build-time values, keyed by their unprefixed names. */
function viteEnvData(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(import.meta.env)
      .filter(([key]) => key.startsWith("VITE_"))
      .map(([key, value]) => [key.substring(5), value]),
  );
}

const config = parseClientConfig(
  viteEnvData(),
  typeof window === "undefined" ? undefined : window.location.protocol,
);

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
export function logLevel(): LogLevelDesc {
  return config.LOG_LEVEL;
}

/** The signaling server this deployment names, or undefined when its
 * browser parties use this app's own origin. */
export function signalingServerSetting(): SignalingServerSetting | undefined {
  return config.SIGNALING_SERVER_URL;
}

/** The PeerJS client's log level before diagnostic mode raises it. */
export function peerjsDebugLevel(): number {
  return config.PEERJS_DEBUG_LEVEL;
}
