import { z } from "zod";

import { authorityMovingSignalingField } from "@alcove/core";

import {
  SIGNALING_SCHEME_MISMATCH,
  signalingSchemeMatchesPage,
} from "./signalingScheme";
import {
  defaultRelayConfigProblems,
  defaultRelayModeOf,
  defaultRelayRegistrarOrigin,
} from "./defaultRelayConfig";

import type {
  DefaultRelayMode,
  DefaultRelaySetting,
} from "./defaultRelayConfig";
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
   * never receives a file, so the hosted file-assurance copy holds and
   * every filedrop/sftp transport saves an exchange file. A deployment whose
   * server legitimately runs exchanges (the console) opts in via
   * `VITE_DEPLOYMENT_PROFILE=console`, which drops that assurance copy and
   * routes a filedrop channel to the server-job driver.
   */
  DEPLOYMENT_PROFILE: DeploymentProfile;
  /**
   * The product version this build belongs to (docs/RELEASES.md). The image
   * build bakes in the `apps/cli/package.json` version (see the Dockerfile);
   * the hosted build bakes in the version of the release tag it was built
   * from, and is empty when built from anything else
   * (hosted/buildIdentity.ts). Empty in any other web build, which passes no
   * value. A docker build of the repo bakes whatever version the manifest
   * holds -- on a non-release tree, the last published release -- so a value
   * here names the release the manifest held at build time, not a promise
   * that this build is that release.
   */
  ALCOVE_VERSION: string;
  /**
   * The short commit hash a hosted build was built from
   * (hosted/buildIdentity.ts), shown where the build names no release
   * version. Empty in any other build.
   */
  BUILD_COMMIT: string;
  /**
   * The signaling server this deployment's browser parties register with, and
   * the one an invitation it mints names: a `ws:` or `wss:` URL whose path is
   * the server's mount (`wss://signaling.example.org/api/`). Unset or blank,
   * the parties use this app's own server at its origin's `/api/`. Fixed by
   * the deployment, never read from an invitation.
   */
  SIGNALING_SERVER_URL: SignalingServerSetting | undefined;
  /**
   * The default relay this build offers its browser exchanges, as
   * {@link ClientConfig.DEFAULT_RELAY_MODE} says: a `turn:` or `turns:` url,
   * its credential minted from the exchange's shared secret. Empty, the build
   * has none. Set with {@link ClientConfig.DEFAULT_RELAY_REGISTRAR_URL} or not
   * at all.
   */
  DEFAULT_RELAY_TURN_URL: string;
  /**
   * The `https://` address of the default relay's registrar, as its origin,
   * where each run enrolls its relay key without a token. Empty, the build
   * has none.
   */
  DEFAULT_RELAY_REGISTRAR_URL: string;
  /**
   * The `wss://` url of the default relay's WebSocket relay, which an
   * invitation this build creates names. Set only beside the two above;
   * empty, the build names none.
   */
  DEFAULT_RELAY_WEBSOCKET_URL: string;
  /**
   * How the build offers its default relay: `opt-in`, the default, until
   * this browser's user turns it on; `on`, in every browser exchange. Read
   * only beside a default relay.
   */
  DEFAULT_RELAY_MODE: DefaultRelayMode;
}

export type { DefaultRelayMode, DefaultRelaySetting };

/**
 * How a build offers its default relay to the browser exchanges it runs.
 * `opt-in` lists it only once this browser's user turns it on, or, url by
 * url, where an invitation a run accepts names it; `on` lists it in every one.
 */
export type DefaultRelayBuild =
  { kind: "none" } | { kind: DefaultRelayMode; relay: DefaultRelaySetting };

// Vite hands every env value over as a string, so a number arrives as its
// decimal text; a blank one is refused rather than read as zero.
const numberFromEnv = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number());

const SIGNALING_SERVER_URL_SHAPE =
  "must be a ws: or wss: URL naming a host and an optional port and path, " +
  "with no user name, password, query, or fragment";

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

const BUILD_COMMIT_SHAPE = /^(?:[0-9a-f]{7,64})?$/;

// PeerJS's LogLevel runs from Disabled (0) to All (3).
const PEERJS_MAX_DEBUG_LEVEL = 3;

const clientConfigSchema: ZodType<ClientConfig> = z
  .object({
    PEERJS_DEBUG_LEVEL: numberFromEnv
      .pipe(z.number().int().min(0).max(PEERJS_MAX_DEBUG_LEVEL))
      .default(1),
    LOG_LEVEL: z.preprocess(
      (value) => (typeof value === "string" ? value.toUpperCase() : value),
      z.enum(LOG_LEVELS).default("INFO"),
    ),
    DEPLOYMENT_PROFILE: z.enum(DEPLOYMENT_PROFILES).default("hosted"),
    ALCOVE_VERSION: z.string().default(""),
    BUILD_COMMIT: z
      .string()
      .regex(
        BUILD_COMMIT_SHAPE,
        "must be empty or 7 to 64 lowercase hex digits",
      )
      .default(""),
    SIGNALING_SERVER_URL: z
      .string()
      .default("")
      .transform(parseSignalingServerUrl),
    DEFAULT_RELAY_TURN_URL: z.string().trim().default(""),
    DEFAULT_RELAY_REGISTRAR_URL: z.string().trim().default(""),
    DEFAULT_RELAY_WEBSOCKET_URL: z.string().trim().default(""),
    DEFAULT_RELAY_MODE: z.string().trim().default(""),
  })
  .superRefine((value, context) => {
    for (const problem of defaultRelayConfigProblems(
      value.DEFAULT_RELAY_TURN_URL,
      value.DEFAULT_RELAY_REGISTRAR_URL,
      value.DEFAULT_RELAY_WEBSOCKET_URL,
      value.DEFAULT_RELAY_MODE,
    ))
      context.addIssue({
        code: "custom",
        path: [problem.variable],
        message: problem.message,
      });
  })
  .transform((value) => ({
    ...value,
    DEFAULT_RELAY_REGISTRAR_URL: defaultRelayRegistrarOrigin(
      value.DEFAULT_RELAY_REGISTRAR_URL,
    ),
    DEFAULT_RELAY_MODE:
      defaultRelayModeOf(value.DEFAULT_RELAY_MODE) ?? "opt-in",
  }));

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

/** The product version this build belongs to, or undefined when it has none.
 * A console image and a hosted build from a release tag have one; it is what
 * the partner accept kit names its `docker run` image by, so the partner runs
 * the version that minted their invitation. */
export function alcoveVersion(): string | undefined {
  return config.ALCOVE_VERSION === "" ? undefined : config.ALCOVE_VERSION;
}

/** The short commit hash this hosted build was built from, or undefined when
 * the build names none. */
export function buildCommit(): string | undefined {
  return config.BUILD_COMMIT === "" ? undefined : config.BUILD_COMMIT;
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

/**
 * The {@link DefaultRelayBuild} `resolved` names.
 *
 * @internal exported for testing
 */
export function defaultRelayBuildOf(resolved: ClientConfig): DefaultRelayBuild {
  if (resolved.DEFAULT_RELAY_TURN_URL === "") return { kind: "none" };
  return {
    kind: resolved.DEFAULT_RELAY_MODE,
    relay: {
      turnUrl: resolved.DEFAULT_RELAY_TURN_URL,
      registrarUrl: resolved.DEFAULT_RELAY_REGISTRAR_URL,
      ...(resolved.DEFAULT_RELAY_WEBSOCKET_URL !== "" && {
        websocketUrl: resolved.DEFAULT_RELAY_WEBSOCKET_URL,
      }),
    },
  };
}

/**
 * The default relay this build names and how it offers it. Which relay a run
 * or an invitation uses is `defaultRelayInUse` or `defaultRelayForRun`, in
 * psi/transport/defaultRelay.ts, which read this browser's switch too.
 */
export function defaultRelayBuild(): DefaultRelayBuild {
  return defaultRelayBuildOf(config);
}

/** The PeerJS client's log level before diagnostic mode raises it. */
export function peerjsDebugLevel(): number {
  return config.PEERJS_DEBUG_LEVEL;
}
