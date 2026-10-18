import { DEFAULT_KEY_TABLE_PATH, KEY_TABLE_PATH_ENV } from "./keyTable.ts";

// The standalone runner's settings, kept apart from standalone.ts, which
// listens at import time, so a test can resolve them without a process.

/** Bind address when `--host` names none: loopback, so a relay started for a
 * test or a trial is reachable only from its own machine. */
export const DEFAULT_RELAY_HOST = "127.0.0.1";

/** Port when `--port` names none: an ephemeral one, which the ready line
 * reports. */
export const DEFAULT_RELAY_PORT = 0;

const MAX_PORT = 65_535;

const FLAG_NAMES = ["host", "port", "key-table"] as const;

type FlagName = (typeof FLAG_NAMES)[number];

/**
 * A setting the runner cannot act on. The message composes the offending
 * value raw; the runner escapes it where it writes it.
 */
export class RelayOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayOptionError";
  }
}

/** Where the runner listens and where it reads the key table. */
export interface RelayOptions {
  /** Address passed to `listen`. */
  host: string;
  /** Port passed to `listen`; `0` yields an ephemeral one. */
  port: number;
  /** The SQLite file holding the per-exchange keys. */
  keyTablePath: string;
}

function isFlagName(name: string): name is FlagName {
  return (FLAG_NAMES as ReadonlyArray<string>).includes(name);
}

function nonEmpty(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new RelayOptionError(`${source} must not be empty`);
  return trimmed;
}

/**
 * Resolve the runner's settings from an argument vector
 * (`process.argv.slice(2)`) and an environment map: `--host`, `--port` and
 * `--key-table`, each taking the token after it, the key table falling back
 * to `ALCOVE_RELAY_TURNDB` and then to the relay host's path.
 *
 * @throws {RelayOptionError} on an unknown, repeated, valueless or empty
 *   flag, or a port that is not a whole number from 0 to 65535.
 */
export function resolveRelayOptions(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): RelayOptions {
  const flags = new Map<FlagName, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.startsWith("--") ? token.slice(2) : "";
    if (!isFlagName(name)) {
      throw new RelayOptionError(`Unknown argument: ${token}`);
    }
    if (flags.has(name)) {
      throw new RelayOptionError(`--${name} may be given only once`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RelayOptionError(`--${name} requires a value`);
    }
    flags.set(name, nonEmpty(value, `--${name}`));
    index += 1;
  }

  const rawPort = flags.get("port");
  let port = DEFAULT_RELAY_PORT;
  if (rawPort !== undefined) {
    port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (Number.isNaN(port) || port > MAX_PORT) {
      throw new RelayOptionError(
        `--port must be a whole number from 0 to ${MAX_PORT}; got ${JSON.stringify(rawPort)}`,
      );
    }
  }

  const envPath = env[KEY_TABLE_PATH_ENV];
  return {
    host: flags.get("host") ?? DEFAULT_RELAY_HOST,
    port,
    keyTablePath:
      flags.get("key-table") ??
      (envPath !== undefined && envPath.trim() !== ""
        ? envPath
        : DEFAULT_KEY_TABLE_PATH),
  };
}
