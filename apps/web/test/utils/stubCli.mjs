// A stub Alcove CLI the job-driver tests point the driver at via the
// JOB_CLI_BINARY override. It emulates the parts of the real CLI the driver
// depends on: it can emit chosen fd-3 NDJSON events, write an output file, exit
// with a chosen code, and honor or ignore an interrupt signal -- all configured
// through environment variables so a test can drive one binary through many
// scenarios without a separate script per case.
//
// It also emulates the `probe-host-key`, `fingerprint`, and `apply`
// subcommands the console spawns (self-contained branches that never touch the
// exchange emulation).
//
// Environment variables (all optional):
//   STUB_FD3_EVENTS   JSON array of event objects to write to fd 3, in order.
//                     Every occurrence of the CONFIG_FILE_PLACEHOLDER token in a
//                     string field is replaced with the --config-file value as
//                     the real CLI spells it (see displayedConfigFile), so a test
//                     can stage a message naming the configuration file the real
//                     CLI would name without knowing the workdir the driver
//                     created.
//   STUB_FD3_RAW      A raw string written verbatim to fd 3 (for malformed-line
//                     tests); written BEFORE STUB_FD3_EVENTS so a malformed
//                     preamble is observed before any terminal event.
//   STUB_EXIT_CODE    Integer exit code (default 0).
//   STUB_STDERR       Text written to stderr before exit. The
//                     CONFIG_FILE_PLACEHOLDER token is replaced as it is in
//                     STUB_FD3_EVENTS, so a test can stage a refusal the real
//                     CLI prints before its event stream is open. The real CLI
//                     escapes this route too, so the same spelling is used.
//   STUB_STDOUT       Text written to stdout before exit.
//   STUB_OUTPUT_FILE  When set, the result is written with this content (so the
//                     result route has a file): as alcove-results-<time>.csv
//                     inside the output positional (last argv) where that names
//                     a folder, as the real CLI does, or to that path itself
//                     otherwise. A `result` event in STUB_FD3_EVENTS that states
//                     no resultPath is given the absolute path written, as the
//                     real CLI's is.
//   STUB_RUN_CREATED_AT  The ISO-8601 instant this run's stamp is made from.
//                     Defaults to the createdAt STUB_RECORD_JSON states, then
//                     to the current time.
//   STUB_PARTNER_PIN  When set, signing.partner_fingerprint is written into the
//                     document named by --config-file before the fd-3 events,
//                     as the real first-contact adoption does (it persists the
//                     pin and only then emits its warning).
//   STUB_TERMS_PROPOSAL  When set, this content is written beside the document
//                     --config-file names, as `<name>.proposed-terms`, before
//                     the fd-3 events, as the real CLI writes a partner's
//                     changed terms before its refusal.
//   STUB_APPLY_STDIN_FILE  When the `apply` subcommand is invoked, whatever it
//                     read from stdin is written to this path.
//   STUB_APPLY_EXIT_CODE  When set, the `apply` subcommand exits with this code
//                     and writes nothing.
//   STUB_RECORD_JSON  When set, the record is written with this content, and its
//                     paired .keys.json alongside it (so the record/keys routes
//                     have files) as alcove-record-<time>.json in the working
//                     directory, the real CLI's default. The keys path
//                     is the record path with .json replaced by .keys.json,
//                     matching the CLI's keysPathFor.
//   STUB_RECEIPT_JSON When set, the receipt is written with this content: at the
//                     configuration's signing.receipt_output when it names one,
//                     and otherwise as alcove-receipt-<time>.json in the
//                     working directory, the real CLI's default.
//   STUB_DELAY_MS     Milliseconds to wait before exiting (default 0). During
//                     the wait the process is interruptible.
//   STUB_IGNORE_SIGINT  When "1", SIGINT is ignored (to test SIGTERM escalation).
//   STUB_IGNORE_SIGTERM When "1", SIGTERM is ignored (to test SIGKILL).
//   STUB_SIGTERM_CLEANUP_MS  Milliseconds a handled SIGTERM waits before the
//                     exit 143, standing in for the real CLI's cleanup on that
//                     signal (default 0). The pending exit is written to
//                     STUB_SIGTERM_CLEANUP_FILE, when set, just before it.
//   STUB_READY_FILE   When set, this path is written once the signal handlers
//                     above are installed, so a signalling test can wait for the
//                     child to be ready rather than sleeping.
//   STUB_ARGV_FILE    When set, the process argv (JSON array) is written to this
//                     path, so a test can assert exactly how the driver invoked
//                     the CLI (subcommand, flags, and positional order).
//   STUB_PROBE_STDOUT When the `probe-host-key` subcommand is invoked, this raw
//                     string is written to stdout (so a test can feed a valid
//                     JSON line, a malformed line, or an oversized flood). When
//                     unset, a default valid line is emitted, so a driver spawned
//                     under the sanitized child env (which drops STUB_* vars) still
//                     gets a well-formed probe result. The probe branch honors
//                     STUB_EXIT_CODE, STUB_DELAY_MS, and STUB_IGNORE_SIGTERM, and
//                     never runs the exchange emulation.
//   STUB_FINGERPRINT_STDOUT
//                     When the `fingerprint` subcommand is invoked, this raw
//                     string is written to stdout. When unset a default canonical
//                     fingerprint line is emitted. The branch also CREATES the
//                     file named by --identity-file (and the one named by
//                     --export-certificate, when present) so the driver's
//                     created-vs-loaded read of the identity path is exercised
//                     against a file that really appears. The identity create is
//                     exclusive, as the real command's is, so a name already
//                     taken -- a dangling symlink included -- is the CLI's usage
//                     exit rather than a write through it. It honors
//                     STUB_EXIT_CODE, STUB_DELAY_MS, and STUB_IGNORE_SIGTERM.
//   STUB_CWD_FILE     When set, the child's own process.cwd() is written to this
//                     path by the `fingerprint` branch, so a test can assert the
//                     directory the driver spawned the child in -- which is what
//                     decides whose ./alcove.yaml the real CLI would resolve.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { sanitizeForDisplay } from "@alcove/core/untrusted-text";

// The token STUB_FD3_EVENTS spells the --config-file value with, paired with
// STUB_CONFIG_FILE_TOKEN in ./jobFixtures.ts (this file is spawned as a
// process, so the two cannot share one declaration).
const CONFIG_FILE_PLACEHOLDER = "__CONFIG_FILE__";

// The default probe line emitted when STUB_PROBE_STDOUT is unset (an all-A
// canonical fingerprint), so the probe route's round-trip is deterministic even
// when the driver's sanitized child env cannot include STUB_PROBE_STDOUT.
const DEFAULT_PROBE_LINE =
  JSON.stringify({
    fingerprint: "SHA256:" + "A".repeat(43),
    key_type: "ssh-ed25519",
  }) + "\n";

// The default fingerprint line emitted when STUB_FINGERPRINT_STDOUT is unset: a
// canonical 43-character unpadded base64url digest (the final character drawn
// from the aligned set the config schema requires).
const DEFAULT_FINGERPRINT_LINE = "B".repeat(42) + "A\n";

// The CLI's usage-error exit code, which is what the real command answers when
// it cannot create the identity at the path it was given.
const FINGERPRINT_USAGE_EXIT_CODE = 64;

/**
 * Create the identity file, refusing (false) rather than writing through
 * anything already at the name. The real command creates via a temp file plus
 * linkSync, so an existing name is EEXIST -- a dangling symlink included, which
 * a plain write would follow, creating the key in whatever directory the link
 * points at.
 */
function createIdentityExclusively(filePath) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ stub: "identity" }), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

/** The value of a single `--flag=value` argv token, or undefined when absent. */
function flagValue(argv, flag) {
  const prefix = `${flag}=`;
  const token = argv.find((candidate) => candidate.startsWith(prefix));
  return token === undefined ? undefined : token.slice(prefix.length);
}

if (process.env.STUB_ARGV_FILE !== undefined)
  fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(process.argv));

// Writes to stdout and stderr still queued at exit. A pipe write is
// asynchronous on macOS, so a process.exit taken while one is queued cuts the
// stream short of what the stub was told to write.
const pendingStdioWrites = [];

function writeStdio(stream, text) {
  pendingStdioWrites.push(
    new Promise((resolve) => stream.write(text, () => resolve())),
  );
}

function exitAfterDelay(code) {
  const delayMs = Number.parseInt(process.env.STUB_DELAY_MS ?? "0", 10);
  const exitOnceFlushed = () =>
    void Promise.all(pendingStdioWrites).then(() => process.exit(code));
  if (delayMs > 0) setTimeout(exitOnceFlushed, delayMs);
  else exitOnceFlushed();
}

// The probe-host-key subcommand the console's host-key probe driver spawns is
// self-contained: emit a chosen stdout line and exit, never touching the
// exchange emulation below. Honors STUB_IGNORE_SIGTERM so the watchdog SIGKILL
// escalation can be exercised.
if (process.argv[2] === "probe-host-key") {
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });
  writeStdio(
    process.stdout,
    process.env.STUB_PROBE_STDOUT ?? DEFAULT_PROBE_LINE,
  );
  exitAfterDelay(Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10));
} else if (process.argv[2] === "fingerprint") {
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });
  if (process.env.STUB_CWD_FILE !== undefined)
    fs.writeFileSync(process.env.STUB_CWD_FILE, process.cwd());
  const exitCode = Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10);
  let outcome = exitCode;
  if (exitCode === 0) {
    // The real command creates the identity file (and the export) before it
    // prints, so the stub does too: the driver reads the identity path's presence
    // BEFORE spawning, and a second invocation must therefore see the file this
    // one left. Create-or-REUSE, as the real command is: an identity already
    // there is loaded, never rewritten, so a read of one in a read-only mount
    // writes nothing.
    const identityFile = flagValue(process.argv, "--identity-file");
    if (
      identityFile !== undefined &&
      !fs.existsSync(identityFile) &&
      !createIdentityExclusively(identityFile)
    )
      outcome = FINGERPRINT_USAGE_EXIT_CODE;
    if (outcome === 0) {
      const exportFile = flagValue(process.argv, "--export-certificate");
      if (exportFile !== undefined)
        fs.writeFileSync(exportFile, JSON.stringify({ stub: "certificate" }));
      writeStdio(
        process.stdout,
        process.env.STUB_FINGERPRINT_STDOUT ?? DEFAULT_FINGERPRINT_LINE,
      );
    }
  }
  exitAfterDelay(outcome);
} else if (process.argv[2] === "apply") {
  runApplyStub();
} else {
  runExchangeStub();
}

// The `apply` subcommand the console's terms-proposal apply spawns: with
// --consent-to-terms, append a line to the file --config-file names, standing
// in for the rewrite. An `@path` update naming no file is the real command's usage exit.
// STUB_APPLY_EXIT_CODE, when set, replaces the whole run with that exit -- its
// own variable, since one child environment serves the exchange a test stages
// alongside it.
function runApplyStub() {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const answer = Buffer.concat(chunks).toString("utf8");
    if (process.env.STUB_APPLY_STDIN_FILE !== undefined)
      fs.writeFileSync(process.env.STUB_APPLY_STDIN_FILE, answer);
    if (process.env.STUB_APPLY_EXIT_CODE !== undefined) {
      exitAfterDelay(Number.parseInt(process.env.STUB_APPLY_EXIT_CODE, 10));
      return;
    }
    const update = process.argv.find((token) => token.startsWith("@"));
    if (update === undefined || !fs.existsSync(update.slice(1))) {
      exitAfterDelay(64);
      return;
    }
    const configFile = flagValue(process.argv, "--config-file");
    if (process.argv.includes("--consent-to-terms") && configFile !== undefined)
      fs.appendFileSync(configFile, "# applied by the stub\n");
    exitAfterDelay(0);
  });
}

function runExchangeStub() {
  // Write the result artifacts BEFORE the fd-3 events, so a terminal `result`
  // event implies the output/record/keys files are already on disk. This mirrors
  // the real CLI (whose result event means the result has been written) and lets a
  // test that waits for the terminal event read the files without racing the
  // child's write.
  const stamp = runStamp();
  let writtenResultPath;
  if (process.env.STUB_OUTPUT_FILE !== undefined) {
    writtenResultPath = resultFilePath(
      process.argv[process.argv.length - 1],
      stamp,
    );
    fs.writeFileSync(writtenResultPath, process.env.STUB_OUTPUT_FILE);
  }

  // The real CLI persists an adopted pin into its configuration file and only
  // then emits the warning naming it, so the stub writes before its fd-3 events
  // too: a relay that reads the value back must find it already on file.
  if (process.env.STUB_PARTNER_PIN !== undefined) {
    const configPath = separatedFlagValue(process.argv, "--config-file");
    if (configPath !== undefined) {
      const document = YAML.parseDocument(fs.readFileSync(configPath, "utf8"));
      document.setIn(
        ["signing", "partner_fingerprint"],
        process.env.STUB_PARTNER_PIN,
      );
      fs.writeFileSync(configPath, document.toString());
    }
  }

  // The real CLI writes a partner's changed terms beside its configuration
  // before it emits the refusal naming them, so the stub does too.
  if (process.env.STUB_TERMS_PROPOSAL !== undefined) {
    const configPath = separatedFlagValue(process.argv, "--config-file");
    if (configPath !== undefined)
      fs.writeFileSync(
        configPath.replace(/\.yaml$/, ".proposed-terms"),
        process.env.STUB_TERMS_PROPOSAL,
      );
  }

  if (process.env.STUB_RECORD_JSON !== undefined) {
    const recordPath = `./alcove-record-${stamp}.json`;
    const keysPath = recordPath.endsWith(".json")
      ? recordPath.slice(0, -".json".length) + ".keys.json"
      : recordPath + ".keys.json";
    fs.writeFileSync(recordPath, process.env.STUB_RECORD_JSON);
    fs.writeFileSync(keysPath, JSON.stringify({ salts: {} }));
  }

  if (process.env.STUB_RECEIPT_JSON !== undefined)
    fs.writeFileSync(
      configuredReceiptOutput() ?? `./alcove-receipt-${stamp}.json`,
      process.env.STUB_RECEIPT_JSON,
    );

  if (process.env.STUB_FD3_RAW !== undefined)
    writeFd3(process.env.STUB_FD3_RAW);
  // Substituted after the parse, per string field, rather than into the JSON
  // text: the replacement holds a backslash for every character the display
  // escape rewrites, which is no valid escape inside a JSON string.
  const events = JSON.parse(process.env.STUB_FD3_EVENTS ?? "[]").map((event) =>
    withResultPath(
      Object.fromEntries(
        Object.entries(event).map(([key, value]) => [
          key,
          typeof value === "string" ? withConfigFile(value) : value,
        ]),
      ),
      writtenResultPath,
    ),
  );
  for (const event of events) writeFd3(JSON.stringify(event) + "\n");

  if (process.env.STUB_STDERR !== undefined)
    writeStdio(process.stderr, withConfigFile(process.env.STUB_STDERR));
  if (process.env.STUB_STDOUT !== undefined)
    writeStdio(process.stdout, process.env.STUB_STDOUT);

  const exitCode = Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10);

  if (process.env.STUB_IGNORE_SIGINT === "1")
    process.on("SIGINT", () => {
      /* swallow: force escalation to SIGTERM */
    });
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });

  // A default SIGINT/SIGTERM (not ignored above) exits with the conventional
  // signal code so the driver's cancellation classification can be exercised.
  if (process.env.STUB_IGNORE_SIGINT !== "1")
    process.on("SIGINT", () => process.exit(130));
  if (process.env.STUB_IGNORE_SIGTERM !== "1")
    process.on("SIGTERM", () => {
      const cleanupMs = Number.parseInt(
        process.env.STUB_SIGTERM_CLEANUP_MS ?? "0",
        10,
      );
      const exitCleanedUp = () => {
        if (process.env.STUB_SIGTERM_CLEANUP_FILE !== undefined)
          fs.writeFileSync(process.env.STUB_SIGTERM_CLEANUP_FILE, "cleaned up");
        process.exit(143);
      };
      if (cleanupMs > 0) setTimeout(exitCleanedUp, cleanupMs);
      else exitCleanedUp();
    });

  // Written only once every handler above is installed, so a signalling test can
  // wait for the state it is exercising to actually be in place. Sleeping
  // instead races the child's startup: a signal delivered before registration
  // takes the DEFAULT action, so an ignore-and-escalate case silently becomes a
  // first-signal kill and the terminal holds the wrong code.
  if (process.env.STUB_READY_FILE !== undefined)
    fs.writeFileSync(process.env.STUB_READY_FILE, "ready");

  exitAfterDelay(exitCode);
}

/** Text with the placeholder token spelled as the --config-file value, so a
 * staged message names the file the real CLI would name. A function replacement
 * rather than a string one, so a `$` in the path is a character and not a
 * replacement pattern. */
function withConfigFile(text) {
  return text.replaceAll(CONFIG_FILE_PLACEHOLDER, () => displayedConfigFile());
}

/**
 * The --config-file value as the real CLI spells it in a message it emits:
 * display-escaped, because the CLI escapes every message it puts on fd 3 or on
 * stderr (`buildErrorEvent` and `buildWarningEvent` in
 * `apps/cli/src/eventStream.ts`, and the top-level stderr render in
 * `apps/cli/src/index.ts`). A path of printable ASCII with no backslash comes
 * back unchanged; one holding anything else does not, and staging it raw leaves
 * a relay searching a message for the escaped spelling untested against the
 * spelling that actually arrives.
 */
function displayedConfigFile() {
  return sanitizeForDisplay(
    separatedFlagValue(process.argv, "--config-file") ?? "",
    { maxLength: Infinity },
  );
}

function writeFd3(line) {
  try {
    fs.writeSync(3, line);
  } catch {
    // fd 3 not wired; ignore (mirrors the real CLI's fail-safe writer).
  }
}

/** The stamp this run's artifact names share, made from its createdAt as the
 * CLI's recordFileStamp makes it. */
function runStamp() {
  return runCreatedAt().replace(/[:.]/g, "-");
}

function runCreatedAt() {
  if (process.env.STUB_RUN_CREATED_AT !== undefined)
    return process.env.STUB_RUN_CREATED_AT;
  if (process.env.STUB_RECORD_JSON !== undefined) {
    try {
      const createdAt = JSON.parse(process.env.STUB_RECORD_JSON).createdAt;
      if (typeof createdAt === "string") return createdAt;
    } catch {
      // A record body a test made unparseable on purpose names no stamp.
    }
  }
  return new Date().toISOString();
}

/** Where the result goes, by the CLI's own rule: a path ending in a separator
 * or naming an existing directory is a folder, and gets a stamped name. */
function resultFilePath(output, stamp) {
  let folder = output.endsWith("/") || output.endsWith(path.sep);
  if (!folder)
    try {
      folder = fs.statSync(output).isDirectory();
    } catch {
      folder = false;
    }
  return folder ? path.join(output, `alcove-results-${stamp}.csv`) : output;
}

/** A `result` event as the real CLI emits it: holding the absolute path of the
 * result file it wrote, unless the test staged one of its own. */
function withResultPath(event, writtenResultPath) {
  if (
    event.type !== "result" ||
    event.resultWritten === false ||
    writtenResultPath === undefined ||
    event.resultPath !== undefined
  )
    return event;
  return { ...event, resultPath: path.resolve(writtenResultPath) };
}

/** The configuration's signing.receipt_output, or undefined where it names
 * none or no configuration was passed. */
function configuredReceiptOutput() {
  const configPath = separatedFlagValue(process.argv, "--config-file");
  if (configPath === undefined) return undefined;
  try {
    const value = YAML.parse(fs.readFileSync(configPath, "utf8"))?.signing
      ?.receipt_output;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The value of a flag the exchange argv passes as two tokens, tolerating the
 * `--flag=value` spelling as well. The exchange driver uses the separated form
 * for every flag it passes; `flagValue` above answers the fingerprint and probe
 * subcommands, which use the joined one. */
function separatedFlagValue(argv, flag) {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length)
    return argv[flagIndex + 1];
  return flagValue(argv, flag);
}
