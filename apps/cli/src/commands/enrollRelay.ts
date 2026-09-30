import type { Argv, Arguments } from "yargs";

import { ConnectionError, UsageError } from "@alcove/core";
import type { RelayRegistrar } from "@alcove/core";

import { DEFAULT_CONFIG_PATH } from "../config";
import { expandTilde } from "../fileUtils";
import { clearRelayRegistrationPending, DEFAULT_KEY_PATH } from "../keyFile";
import { addLoggingOptions, keyFileFlag } from "../optionDefinitions";
import {
  enrollRelayKey,
  relayRegistrarForRun,
  relayRegistrarLabel,
  relayRegistrationNotice,
  type RelayRegistrarTransport,
  type RelayRegistrationOutcome,
} from "../relayRegistrar";
import {
  AUTHENTICATION_FAILED_EXIT_CODE,
  exitCodeForError,
  exitWithError,
} from "../util/exit";
import { parseOrExit, singleValue } from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";
import { promptHiddenText } from "../util/prompt";
import { loadConfig } from "./exchange";

export function builder(cmd: Argv): Argv {
  const beforeLogging = cmd
    .usage("Usage: $0 enroll-relay [options]")
    .option("config-file", {
      type: "string",
      describe: `exchange configuration file (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("key-file", {
      type: "string",
      describe: `key file holding the shared secret (default: ${DEFAULT_KEY_PATH})`,
    })
    .option("replace-relay-key", {
      type: "boolean",
      default: false,
      describe:
        "register this exchange's current relay key in place of whatever key " +
        "the relay registrar holds for its exchange id; for an exchange whose " +
        "key the registrar holds but no run has any more",
    });
  return addLoggingOptions(beforeLogging);
}

const MAX_OWNER_TOKEN_LENGTH = 1024;

// Visible ASCII only: the token travels in an HTTP header.
const OWNER_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Hold a typed relay-owner token to the shape a header can carry, trimmed.
 * No message repeats the token.
 */
function checkedOwnerToken(typed: string): string {
  const token = typed.trim();
  if (token.length === 0)
    throw new UsageError(
      "no relay-owner token was entered, so nothing was sent; run the " +
        "command again and enter the token when asked",
    );
  if (token.length > MAX_OWNER_TOKEN_LENGTH || !OWNER_TOKEN_PATTERN.test(token))
    throw new UsageError(
      "the relay-owner token entered is not one the registrar takes: it must " +
        `be at most ${MAX_OWNER_TOKEN_LENGTH} visible ASCII characters with no ` +
        "spaces. Nothing was sent; run the command again",
    );
  return token;
}

/** The failure an enrollment outcome other than `registered` becomes. */
function enrollmentError(
  registrar: RelayRegistrar,
  outcome: Exclude<RelayRegistrationOutcome, { kind: "registered" }>,
  replace: boolean,
): Error {
  const label = relayRegistrarLabel(registrar);
  const reason = outcome.reason === undefined ? "" : `: ${outcome.reason}`;
  if (outcome.kind === "unavailable")
    return new ConnectionError(
      `${label} could not be reached to enroll the exchange${reason}. Run ` +
        "the command again once it answers.",
      "transport",
    );
  if (outcome.kind === "refused" && outcome.status === 401)
    return Object.assign(
      new Error(
        `${label} refused the relay-owner token (HTTP 401${reason}). Check ` +
          "the token with the relay's operator and run the command again.",
      ),
      { exitCode: AUTHENTICATION_FAILED_EXIT_CODE },
    );
  if (outcome.kind === "refused" && !replace)
    return new UsageError(
      `${label} did not enroll the exchange (HTTP ${outcome.status}${reason}). ` +
        "If the registrar holds another key for this exchange id and the id " +
        "is this exchange's, run the command again with --replace-relay-key; " +
        "if the id belongs to another exchange, choose a different " +
        "connection.relay_registrar.exchange_id.",
    );
  return new UsageError(
    `${label} refused the request (HTTP ${outcome.status}${reason}); check ` +
      "connection.relay_registrar in the configuration and run the command " +
      "again.",
  );
}

/** What {@link enrollRelay} is handed. */
export interface EnrollRelayOptions {
  configFile: string;
  keyFile: string;
  /** `--replace-relay-key`: the token on `PUT` in place of `POST`. */
  replace: boolean;
  /** Ask the operator for the relay-owner token. */
  readOwnerToken: (question: string) => Promise<string>;
  transport?: RelayRegistrarTransport;
}

/**
 * Enroll the exchange a configuration and key file describe at the registrar
 * its connection names: register the relay key derived from the key file's
 * current shared secret, with the configuration's `token_max_age_days` as the
 * row's lapse, under the relay-owner token `readOwnerToken` supplies. The
 * token is read after every local check, sent once, and written nowhere; a
 * confirmed enrollment drops any registration the key file records as
 * pending, since the registrar then holds the current key.
 *
 * @internal exported for testing
 */
export async function enrollRelay(
  options: EnrollRelayOptions,
): Promise<string> {
  const { connection, authentication } = loadConfig({
    configFile: options.configFile,
    keyFile: options.keyFile,
  });
  const registrar = relayRegistrarForRun(connection);
  if (registrar === undefined)
    throw new UsageError(
      "the configuration names no relay registrar this party registers at: " +
        "enrollment needs a webrtc connection with connection.relay_registrar " +
        "and a connection.turn entry that sets no username or credential, " +
        "and no connection.invitation_relay naming a turn url, since a run " +
        "relaying through the partner's relay registers nothing",
    );
  const ownerToken = checkedOwnerToken(
    await options.readOwnerToken(
      `Relay-owner token for ${relayRegistrarLabel(registrar)} (not shown as you type):`,
    ),
  );
  const outcome = await enrollRelayKey(
    {
      registrar,
      sharedSecret: authentication.sharedSecret,
      maxAgeDays: authentication.tokenMaxAgeDays ?? null,
      ownerToken,
      replace: options.replace,
    },
    options.transport,
  );
  if (outcome.kind !== "registered")
    throw enrollmentError(registrar, outcome, options.replace);
  clearRelayRegistrationPending(
    authentication.keyFilePath,
    authentication.sharedSecret,
  );
  return relayRegistrationNotice(registrar, outcome);
}

const MAX_PIPED_TOKEN_BYTES = 4096;

/**
 * The first line of `input`, for a token piped rather than typed. Returns as
 * soon as a newline arrives, so a caller that keeps the pipe open is not
 * waited on; an input with no newline in its first
 * {@link MAX_PIPED_TOKEN_BYTES} bytes is refused.
 *
 * @internal exported for testing
 */
export async function readFirstLine(
  input: AsyncIterable<unknown>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    length += buffer.length;
    if (buffer.includes(0x0a) || length > MAX_PIPED_TOKEN_BYTES) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const newline = text.indexOf("\n");
  if (newline === -1 && length > MAX_PIPED_TOKEN_BYTES)
    throw new UsageError(
      "standard input holds no relay-owner token on its first line; pipe " +
        "the token alone, or run the command at a terminal to be asked for it",
    );
  return newline === -1 ? text : text.slice(0, newline);
}

export async function handler(argv: Arguments): Promise<void> {
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "enroll-relay",
    }),
  );
  try {
    const configFile = expandTilde(
      (singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH,
    );
    const keyFile = expandTilde(keyFileFlag(argv));
    const notice = await enrollRelay({
      configFile,
      keyFile,
      replace: argv["replace-relay-key"] === true,
      readOwnerToken: (question) =>
        process.stdin.isTTY === true
          ? promptHiddenText(question)
          : readFirstLine(process.stdin),
    });
    log.info(notice);
  } catch (err) {
    exitWithError(log, err, exitCodeForError(err));
  } finally {
    closeLogging();
  }
}
