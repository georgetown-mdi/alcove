import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  providerTurnEntryToMint,
  redactAndSanitizeForDisplay,
  relayHostStatement,
  relayHostStatementLines,
} from "@alcove/core";
import type { WebRTCConnectionConfig } from "@alcove/core";

import {
  mintProviderTurn,
  providerTurnMintStatement,
} from "../connection/webrtc/providerTurn";
import type { ProviderTurnRun } from "../connection/webrtc/providerTurn";
import {
  gatherRelayCandidate,
  relayCredentialForRun,
} from "../connection/webrtc/weriftPeer";
import { webSocketRelayDialsFor } from "../connection/webrtc/websocketRelayDial";
import { RELAY_CHECK_DOC_URL, SHARED_FOLDER_CHECK_DOC_URL } from "../docLinks";
import { runMountChecks } from "../doctor/mount";
import { runProbe } from "../doctor/probe";
import type { RelayCandidateGathering } from "../doctor/relay";
import {
  enrollBeforeRelayCheck,
  relayCheckConnection,
  relayCheckPlan,
  runRelayCheck,
} from "../doctor/relay";
import { readSmbMountInput, readSmbProbeInput } from "../doctor/smbEnvironment";
import type { WebSocketRelayAsking } from "../doctor/websocketRelay";
import type { DoctorMode, DoctorReport } from "../doctor/verdict";
import {
  DOCTOR_EXIT_CODE,
  overallOf,
  verdictJson,
  verdictLines,
} from "../doctor/verdict";
import {
  addLoggingOptions,
  configFileFlag,
  EXCHANGE_CONFIG_FILE_DESCRIPTION,
  keyFileFlag,
  SHARED_KEY_FILE_DESCRIPTION,
} from "../optionDefinitions";
import { runOrExit } from "../util/exit";
import { declarePositionals } from "../util/positionals";
import { parseOrExit, singleValue } from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";
import { loadConfig } from "../config/exchangeConfig";

// `alcove doctor` answers "why did the file drop not work" before an exchange
// is attempted: `doctor probe` checks over the network as smbclient sees it,
// `doctor mount` through the kernel as a mounted folder. Connection inputs come
// from the SMB_* environment, never flags, so a password never becomes an argv
// value. `doctor relay` asks the relays a webrtc run uses, and only when the
// operator names it. Full behavior and the `--json` verdict
// contract: docs/CLI.md, "Checking a network shared folder", and
// docs/spec/CLI_DOCTOR.md.

function commonOptions(cmd: Argv): Argv {
  return addLoggingOptions(
    cmd.option("json", {
      type: "boolean",
      default: false,
      describe:
        "print the machine-readable verdict on stdout instead of the " +
        "human-readable check lines",
    }),
  );
}

/** Handler for `alcove doctor probe`. */
export function probeHandler(argv: Arguments): Promise<void> {
  return runDoctor(argv, "probe");
}

/** Handler for `alcove doctor mount DIRECTORY`. */
export function mountHandler(argv: Arguments): Promise<void> {
  return runDoctor(argv, "mount");
}

/** Handler for `alcove doctor relay`. */
export function relayHandler(argv: Arguments): Promise<void> {
  return runDoctor(argv, "relay");
}

/** What {@link checkRelay} is handed. */
export interface RelayCheckOptions {
  configFile: string;
  keyFile: string;
  /**
   * Writes one line of the host statement, before any request is made. The
   * caller writes it at every log level, `silent` included.
   */
  writeStatementLine: (line: string) => void;
  gather?: RelayCandidateGathering;
  /** Asks each WebSocket relay whether it admits the run's proof. */
  askWebSocket?: WebSocketRelayAsking;
  /**
   * The fetch the enrollment at the invitation relay's registrar, and the
   * mint of a provider turn entry's servers, send with.
   */
  fetch?: typeof globalThis.fetch;
  now?: Date;
  boundMs?: number;
}

/**
 * Run `doctor relay` against the exchange a configuration and key file
 * describe: refuse a configuration the check does not apply to, state the
 * hosts it contacts and those it does not, then contact what a run of the
 * configuration contacts -- the invitation's registrar where the run enrolls
 * there, the first TURN url the run lists and every WebSocket relay it
 * dials, each presented what the run presents -- and nothing else.
 *
 * @internal exported for testing
 */
export async function checkRelay(
  options: RelayCheckOptions,
): Promise<DoctorReport> {
  const { connection: loaded, authentication } = loadConfig({
    configFile: options.configFile,
    keyFile: options.keyFile,
  });
  // Every refusal the configuration alone decides comes before the mint, the
  // first request; a minted url never takes the run's derived credential and
  // the mint leaves the WebSocket relays as they are.
  const configured = relayCheckConnection(loaded);
  const role = configured.role;
  const websocketDials =
    role === undefined
      ? []
      : await webSocketRelayDialsFor(
          configured,
          authentication.sharedSecret,
          role,
        );
  const runRelayCredential = await relayCredentialForRun(
    configured,
    authentication.sharedSecret,
    options.now ?? new Date(),
  );
  const minted = await mintProviderTurnStated(configured, options);
  const connection =
    minted === undefined
      ? configured
      : relayCheckConnection(minted.connection, minted.provider);
  const plan = relayCheckPlan(connection, runRelayCredential, websocketDials);
  for (const line of relayHostStatementLines(
    relayHostStatement(plan, connection),
  ))
    options.writeStatementLine(line);
  const enrollment =
    plan.registrar?.contacted === true
      ? await enrollBeforeRelayCheck(
          plan.registrar.url,
          authentication.sharedSecret,
          options.fetch,
        )
      : undefined;
  return runRelayCheck(
    plan,
    options.gather ?? gatherRelayCandidate,
    options.boundMs,
    enrollment,
    options.askWebSocket,
  );
}

/**
 * Mint the provider `turn` entry a run of `connection` mints, as the run
 * mints it, after a statement line naming the provider the mint contacts.
 * `undefined`, with nothing written or contacted, where the run mints none.
 */
async function mintProviderTurnStated(
  connection: WebRTCConnectionConfig,
  options: Pick<RelayCheckOptions, "writeStatementLine" | "fetch">,
): Promise<ProviderTurnRun | undefined> {
  const entry = providerTurnEntryToMint(connection);
  if (entry === undefined) return undefined;
  options.writeStatementLine(providerTurnMintStatement(entry.provider));
  return mintProviderTurn(
    connection,
    options.fetch === undefined ? {} : { fetch: options.fetch },
  );
}

export function builder(cmd: Argv): Argv {
  return cmd
    .usage(
      "Usage: $0 doctor <probe | mount DIRECTORY | relay> [options]\n\n" +
        "Check a network shared folder before an exchange: doctor probe over\n" +
        "the network, doctor mount through the mount. Run both. Check that\n" +
        "this host reaches a WebRTC exchange's relay: doctor relay.",
    )
    .command(
      "probe",
      "Check the shared folder over the network, without mounting it",
      (probe) =>
        commonOptions(
          declarePositionals(probe, { command: "doctor probe", usage: "" }),
        )
          .usage("Usage: $0 doctor probe [options]")
          .epilog(
            "Reads the connection from the environment, not from flags: " +
              "SMB_SERVER, SMB_SHARE, and SMB_USER are required; SMB_PASS, " +
              "SMB_PATH, SMB_DOMAIN, SMB_DIALECT, SMB_MARKER, and SMB_TOKEN " +
              `are optional. See ${SHARED_FOLDER_CHECK_DOC_URL}`,
          ),
      probeHandler,
    )
    .command(
      "mount [directory]",
      "Check an already-mounted shared folder",
      (mount) =>
        commonOptions(
          declarePositionals(mount, {
            command: "doctor mount",
            usage: "DIRECTORY [options]",
            required: ["directory"],
          }),
        )
          .usage("Usage: $0 doctor mount DIRECTORY [options]")
          .epilog(
            "Reads SMB_MARKER and SMB_TOKEN from the environment to find the " +
              "marker a doctor probe left; without them the cross-check is " +
              `skipped. See ${SHARED_FOLDER_CHECK_DOC_URL}`,
          )
          .positional("directory", {
            type: "string",
            describe: "the mounted shared folder to check",
            demandOption: true,
          }),
      mountHandler,
    )
    .command(
      "relay",
      "Check that this host reaches a WebRTC exchange's relay",
      (relay) =>
        commonOptions(
          declarePositionals(relay, { command: "doctor relay", usage: "" })
            .option("config-file", {
              type: "string",
              describe: EXCHANGE_CONFIG_FILE_DESCRIPTION,
            })
            .option("key-file", {
              type: "string",
              describe: SHARED_KEY_FILE_DESCRIPTION,
            }),
        )
          .usage("Usage: $0 doctor relay [options]")
          .epilog(
            "Asks the TURN relay a run allocates on, the first the " +
              "configuration lists, for a relay address, and each " +
              "WebSocket relay a run dials whether it admits the run's " +
              "proof, after naming the hosts it contacts and those it does " +
              "not. Where a run " +
              "enrolls at the registrar the invitation names, first " +
              "enrolls the exchange's relay key there, as a run does. It " +
              "contacts no other relay host. " +
              `See ${RELAY_CHECK_DOC_URL}`,
          ),
      relayHandler,
    )
    .demandCommand(
      1,
      "specify which checks to run: `doctor probe`, `doctor mount DIRECTORY`, " +
        "or `doctor relay`",
    );
}

async function runDoctor(argv: Arguments, mode: DoctorMode): Promise<void> {
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  const {
    log,
    writePlainLine,
    close: closeLogging,
  } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: `doctor-${mode}`,
    }),
  );

  const writeLine = (line: string): void => {
    if (log.getLevel() <= logLibrary.levels.INFO)
      writePlainLine(redactAndSanitizeForDisplay(line));
  };
  const writeStatementLine = (line: string): void =>
    writePlainLine(redactAndSanitizeForDisplay(line));
  // Reached by the operator-input faults readSmbProbeInput and
  // readSmbMountInput raise (doctor/smbEnvironment), by a configuration
  // checkRelay cannot load or refuses (doctor/relay), and by anything the
  // checks did not turn into a verdict -- a failing tool becomes a verdict
  // rather than a throw. exitCodeForError classifies whichever arrives.
  try {
    await runOrExit(log, async () => {
      const report =
        mode === "probe"
          ? await runProbe(readSmbProbeInput(process.env))
          : mode === "mount"
            ? runMountChecks(
                // Backslashes are folded on ingestion, the convention every
                // operator-supplied local path in the CLI follows.
                (singleValue(argv, "directory") as string).replace(/\\/g, "/"),
                readSmbMountInput(process.env),
              )
            : await checkRelay({
                configFile: configFileFlag(argv),
                keyFile: keyFileFlag(argv),
                writeStatementLine,
              });
      emit(report, argv["json"] === true, writeLine);
      // Not process.exit: the verdict may still be draining to a pipe, and the
      // exit code is the caller's whole machine-readable answer when --json is
      // not in use.
      process.exitCode = DOCTOR_EXIT_CODE[overallOf(report)];
    });
  } finally {
    closeLogging();
  }
}

/**
 * Write the verdict: the `--json` document goes to stdout alone (one line,
 * `console.log`); the human check lines go through `writeLine`, which writes
 * to the logger's destination unprefixed, gated the same as any `info` log
 * line, and escaped there since the lines contain server-controlled bytes (an
 * NT_STATUS token, smbclient's own output) and configuration text (a TURN
 * url). Full contract for both forms, including the JSON line's own ASCII
 * encoder: docs/spec/CLI_DOCTOR.md.
 */
function emit(
  report: DoctorReport,
  json: boolean,
  writeLine: (line: string) => void,
): void {
  if (json) {
    console.log(verdictJson(report));
    return;
  }
  for (const line of verdictLines(report)) writeLine(line);
}
