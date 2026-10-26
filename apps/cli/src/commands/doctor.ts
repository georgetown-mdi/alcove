import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  redactAndSanitizeForDisplay,
  relayHostStatement,
  relayHostStatementLines,
} from "@alcove/core";

import {
  gatherRelayCandidate,
  relayCredentialForRun,
} from "../connection/webrtc/weriftPeer";
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
import { exitCodeForError, exitWithError } from "../util/exit";
import { declarePositionals } from "../util/positionals";
import { parseOrExit, singleValue } from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";
import { loadConfig } from "./exchange";

// `alcove doctor` answers "why did the file drop not work" before an exchange
// is attempted: `doctor probe` checks over the network as smbclient sees it,
// `doctor mount` through the kernel as a mounted folder. Connection inputs come
// from the SMB_* environment, never flags, so a password never becomes an argv
// value. `doctor relay` asks the TURN relay a webrtc run allocates on, and only
// when the operator names it. Full behavior and the `--json` verdict
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
  /** The fetch the enrollment at the invitation relay's registrar sends with. */
  fetch?: typeof globalThis.fetch;
  now?: Date;
  boundMs?: number;
}

/**
 * Run `doctor relay` against the exchange a configuration and key file
 * describe: refuse a configuration the check does not apply to, state the
 * hosts it contacts and those it does not, then contact what a run of the
 * configuration contacts -- the invitation's registrar where the run enrolls
 * there, and the first TURN url the run lists, presented what the run
 * presents -- and nothing else.
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
  const connection = relayCheckConnection(loaded);
  const plan = relayCheckPlan(
    connection,
    await relayCredentialForRun(
      connection,
      authentication.sharedSecret,
      options.now ?? new Date(),
    ),
  );
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
              "are optional. See docs/CLI.md, Checking a network shared folder.",
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
              "skipped. See docs/CLI.md, Checking a network shared folder.",
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
              "configuration lists, for a relay address, after naming the " +
              "hosts it contacts and those it does not. Where a run " +
              "enrolls at the registrar the invitation names, first " +
              "enrolls the exchange's relay key there, as a run does. It " +
              "contacts no other relay host. " +
              "See docs/CLI.md, Checking the relay of a WebRTC exchange.",
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
  try {
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
  } catch (err) {
    // Reached by the operator-input faults readSmbProbeInput and
    // readSmbMountInput raise (doctor/smbEnvironment), by a configuration
    // checkRelay cannot load or refuses (doctor/relay), and by anything the
    // checks did not turn into a verdict -- a failing tool becomes a verdict
    // rather than a throw. exitCodeForError classifies whichever arrives.
    exitWithError(log, err, exitCodeForError(err));
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
