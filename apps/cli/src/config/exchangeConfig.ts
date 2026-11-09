import {
  classifyFailure,
  describeYamlSyntaxPosition,
  getLogger,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  OperatorConfigError,
  operatorSuppliedText,
  parseExchangeSpec,
  PLACEHOLDER_SSH_USERNAME,
  redactAndRenderOperatorSuppliedText,
  UsageError,
} from "@alcove/core";
import type { ExchangeDataSpec, FileSyncOptions } from "@alcove/core";

import { applyConnectionOverrides, assertNoConfigPlaceholder } from "../config";
import {
  checkKeyFileExpiry,
  loadKeyFile,
  rotationInFlightNotice,
  type KeyFile,
} from "../keyFile";
import {
  connectionOverridesFrom,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnUnsupportedFileSyncFlags,
  warnUnsupportedWebRTCServerFlags,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import type { AuthPersist, ProtocolConnectionConfig } from "../protocol";
import { resolveExchangeSpecRefs } from "../util/atSignRefs";

import {
  describeConfigSchemaError,
  errnoClause,
  readConfigDocument,
  type ConfigDocumentFailure,
} from "./loaders";

// The recurring-exchange configuration loader: `alcove exchange` reads its
// configuration and key file through here, and so do `doctor` and
// `enroll-relay`, which load the same pair. It sits outside `config.ts`'s
// re-exports because it reads the flag warnings in optionDefinitions.ts, which
// imports `config.ts`.

/**
 * The options {@link loadConfig} reads: the config and key file paths and the
 * connection override flags, without the run-only ones.
 */
export type ExchangeConfigOptions = Omit<
  CommonBootstrapOptions,
  | "logLevel"
  | "logFile"
  | "verbosity"
  | "eventStream"
  | "allowMemoryShortfall"
  | "record"
>;

// The runtime-injected authentication fields: their values come only from
// `.alcove.key`, so an operator who sets them in the top-level `authentication`
// block of alcove.yaml is warned and the value is stripped. Each entry lists
// the user-input spellings (snake_case and camelCase) a field can appear as
// before `camelizeKeys` runs, plus the hint shown when it is stripped.
const INJECTED_AUTH_FIELDS: Record<string, { forms: string[]; hint: string }> =
  {
    sharedSecret: {
      forms: ["shared_secret", "sharedSecret"],
      hint:
        "the shared secret is always loaded from the key file (any @-file " +
        "reference in this field was also not resolved)",
    },
    expires: {
      forms: ["expires"],
      hint:
        "expiration is always loaded from the key file (any @-file reference " +
        "in this field was also not resolved)",
    },
  };

/**
 * Warn about and strip the runtime-injected authentication fields
 * (`shared_secret`/`expires`) from a raw top-level `authentication` block, in
 * place. Their values come only from `.alcove.key`, so a value set in YAML is
 * ignored; warning rather than silently dropping lets the operator see why their
 * setting did nothing. Operator-policy fields (e.g. `token_max_age_days`) are NOT
 * touched -- they pass through to schema validation, which is the authority on
 * which policy fields are valid (and, being strict, rejects an unrecognized one).
 * Runs on the raw config before `parseExchangeSpec` (which applies `camelizeKeys`
 * then Zod), so it matches both the snake_case and camelCase spelling of each
 * injected field.
 *
 * @internal exported for testing
 */
export function warnAndStripInjectedAuthFields(
  rawAuth: Record<string, unknown>,
  configFile: string,
  log: ReturnType<typeof getLogger>,
): void {
  // Map every accepted spelling straight to its hint, so matching a key both
  // identifies it as injected and yields the message in one lookup (no second
  // indexed access that could interpolate `undefined` if the tables drifted).
  const formToHint = new Map<string, string>();
  for (const { forms, hint } of Object.values(INJECTED_AUTH_FIELDS))
    for (const form of forms) formToHint.set(form, hint);

  for (const key of Object.keys(rawAuth)) {
    const hint = formToHint.get(key);
    // An operator-policy field (or an unrecognized one): leave it for the schema
    // to accept or strip, the same treatment any other config key gets.
    if (hint === undefined) continue;
    log.warn(
      `${redactAndRenderOperatorSuppliedText(
        operatorSuppliedText(configFile),
      )}: authentication.${key} is set and will be ignored; ` + hint,
    );
    delete rawAuth[key];
  }
}

/** What {@link loadConfig} states behind a key-file path with no file at it. */
const MISSING_KEY_FILE_REMEDY =
  " does not exist. Create one with 'alcove invite' (generate an " +
  "invitation) or 'alcove accept' (accept a partner's invitation); both " +
  "write a .alcove.key.";

/** What {@link loadConfig} states behind an expired secret's key-file path. */
const EXPIRED_SECRET_REMEDY =
  " and cannot be used; no exchange was attempted. Both parties must " +
  "re-invite to establish a new shared secret: remove the expired key file " +
  "on both sides, then one party runs 'alcove invite' (the offline form, " +
  "with no URL) and the other runs 'alcove accept INVITATION " +
  "[INPUT_FILE]'. Each side's configuration is reused; only the key file is " +
  "recreated.";

/** The refusal for a configuration that fails exchange-spec validation. */
function invalidExchangeSpecError(
  configFile: string,
  err: unknown,
): OperatorConfigError {
  const message = messageWithOperatorText`config file ${operatorSuppliedText(
    configFile,
  )} is not a valid exchange spec: ${describeConfigSchemaError(err)}`;
  return keepOperatorSuppliedText(
    new OperatorConfigError(message.text),
    message,
  );
}

/**
 * The refusal for a configuration {@link readConfigDocument} could not read or
 * parse: an {@link OperatorConfigError} (exit 64), since the file is the
 * operator's own and nothing has touched a transport. A missing file names the
 * command that writes one and keeps `code: "ENOENT"`.
 */
function configReadRefusal(
  configFile: string,
  failure: ConfigDocumentFailure,
): OperatorConfigError {
  switch (failure.reason) {
    case "missing": {
      const message = messageWithOperatorText`config file ${operatorSuppliedText(
        configFile,
      )} does not exist; to create one, run 'alcove invite --identity IDENTITY URL INPUT_FILE' first`;
      return Object.assign(
        keepOperatorSuppliedText(
          new OperatorConfigError(message.text),
          message,
        ),
        { code: "ENOENT" },
      );
    }
    case "unreadable": {
      const message = messageWithOperatorText`config file ${operatorSuppliedText(
        configFile,
      )} could not be read${errnoClause(failure.code)}`;
      return keepOperatorSuppliedText(
        new OperatorConfigError(message.text),
        message,
      );
    }
    case "unparseable": {
      const { position } = failure.error;
      const at =
        position === undefined
          ? ""
          : `: ${describeYamlSyntaxPosition(position)}`;
      const message = messageWithOperatorText`config file ${operatorSuppliedText(
        configFile,
      )} could not be parsed as YAML${at}`;
      return keepOperatorSuppliedText(
        new OperatorConfigError(message.text),
        message,
      );
    }
  }
}

/** The configuration and key file {@link loadConfig} reads, resolved. */
type LoadedExchangeConfig = {
  connection: ProtocolConnectionConfig;
  authentication: AuthPersist;
} & ExchangeDataSpec;

/**
 * Read and validate the configuration and key file `options` name. With
 * `invitedKeyFile`, the key decoded from `--invitation` and not yet written,
 * that key stands in for the key file and nothing is read from its path.
 *
 * @throws {UsageError} for any failure to load them (exit 64), since nothing
 *   here touches a transport: a failure raised as some other class is wrapped
 *   in one, keeping it as the `cause`. An `InternalConsistencyError` passes
 *   through unwrapped (exit 70).
 */
export function loadConfig(
  options: ExchangeConfigOptions,
  invitedKeyFile?: KeyFile,
): LoadedExchangeConfig {
  try {
    return readExchangeConfig(options, invitedKeyFile);
  } catch (err) {
    const failureClass = classifyFailure(err);
    if (failureClass === "usage-error" || failureClass === "internal-fault")
      throw err;
    const message = messageWithOperatorText`config file ${operatorSuppliedText(
      options.configFile,
    )} could not be loaded`;
    throw keepOperatorSuppliedText(
      new UsageError(message.text, { cause: err }),
      message,
    );
  }
}

function readExchangeConfig(
  options: ExchangeConfigOptions,
  invitedKeyFile: KeyFile | undefined,
): LoadedExchangeConfig {
  const log = getLogger("exchange");

  const rawConfig = readConfigDocument(options.configFile, {
    whenMissing: "refuse",
    refusal: (failure) => configReadRefusal(options.configFile, failure),
  });

  // Warn about and strip the runtime-injected fields from the top-level
  // `authentication` block (their values come only from the key file). Operator-
  // policy fields under the same block are left for schema validation. Runs on
  // the raw config before parseExchangeSpec applies camelizeKeys + Zod.
  const rawAuth = (rawConfig as Record<string, unknown>)?.["authentication"];
  if (typeof rawAuth === "object" && rawAuth !== null)
    warnAndStripInjectedAuthFields(
      rawAuth as Record<string, unknown>,
      options.configFile,
      log,
    );

  let parsedSpec: ReturnType<typeof parseExchangeSpec>;
  try {
    parsedSpec = parseExchangeSpec(rawConfig);
  } catch (err) {
    // Well-formed YAML that fails schema validation is still invalid caller
    // configuration (exit 64), not a transport failure.
    throw invalidExchangeSpecError(options.configFile, err);
  }

  // Resolve @-file references in the supported credential/opaque fields after
  // schema validation: a missing or unreadable referenced file is a UsageError
  // naming the reference (exit 64), propagated unwrapped rather than relabeled as
  // an invalid exchange spec. The literal @path strings validate cleanly as plain
  // string values, so resolving after the parse loses no validation. Scoped to
  // the documented @-file fields under `connection`; a free-text field such as
  // linkageTerms.identity keeps a literal `@`.
  const resolvedSpec = resolveExchangeSpecRefs(parsedSpec);
  const {
    connection: baseConn,
    authentication: specAuth,
    ...exchangeDataSpec
  } = resolvedSpec;
  log.info(
    "loaded exchange spec from",
    redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(options.configFile),
    ),
  );

  const connection = applyConnectionOverrides(
    baseConn,
    connectionOverridesFrom(options),
  );

  // The channel here comes from the loaded config (post-override); warn on the
  // file-sync-only flags before the channel allowlist below.
  //
  // connectionPerPoll is read from both the raw CLI flag and the merged config:
  // a persisted connection_per_poll: true in a filedrop config must draw the
  // ignored-warning too, which only the merged connection.options holds.
  // applyConnectionOverrides applies the CLI override only on sftp, so a CLI
  // --connection-per-poll against a filedrop config never reaches
  // connection.options -- only the raw flag states that intent. Either source
  // being on means the operator asked for a mode this channel ignores. The
  // other flags stay raw-CLI-only: they warn solely on a non-file-sync channel
  // (webrtc), whose SharedOptions cannot express them.
  warnUnsupportedFileSyncFlags(
    connection.channel,
    {
      locklessRendezvous: options.locklessRendezvous,
      retainFiles: options.retainFiles,
      pollingFrequencyMs: options.pollingFrequencyMs,
      // This call runs before the channel is narrowed to sftp/filedrop below, so
      // connection.options is typed SharedOptions | FileSyncOptions; read
      // connectionPerPoll through a FileSyncOptions cast (as the core webrtc
      // refines do), which yields undefined on a SharedOptions block that cannot
      // hold it.
      connectionPerPoll:
        options.connectionPerPoll === true ||
        (connection.options as FileSyncOptions | undefined)
          ?.connectionPerPoll === true,
      peerId: options.peerId,
      timestampInFilename: options.timestampInFilename,
      writeWithoutRenaming: options.writeWithoutRenaming,
      ignoreFilesOlderThan: options.ignoreFilesOlderThan,
    },
    log,
  );
  // The server-block half of the same report: applyConnectionOverrides merges
  // that sub-group on sftp alone, so every --server-* flag typed at a webrtc
  // config is dropped, credentials included -- and a credential typed at a
  // channel that discards it looks, from the terminal, exactly like one that was
  // used.
  warnUnsupportedWebRTCServerFlags(
    connection.channel,
    {
      serverPort: options.serverPort,
      serverUsername: options.serverUsername,
      serverPassword: options.serverPassword,
      serverPrivateKey: options.serverPrivateKey,
      serverPrivateKeyPassphrase: options.serverPrivateKeyPassphrase,
      serverKeyboardInteractive: options.serverKeyboardInteractive,
      serverHostKeyFingerprint: options.serverHostKeyFingerprint,
    },
    log,
    // The connection is the loaded configuration's own, so the remedies point at
    // its `connection.server` block rather than at a URL this command took none
    // of.
    "configuration",
  );
  warnLowPollingFrequency(connection.channel, options.pollingFrequencyMs, log);

  if (
    connection.channel !== "sftp" &&
    connection.channel !== "filedrop" &&
    connection.channel !== "webrtc"
  ) {
    // An unsupported channel in the config is invalid caller configuration
    // (exit 64), not a transport failure. It is an allowlist, so a channel added
    // to the config union is refused here until runProtocol learns to run it
    // (CONTRIBUTING.md, Transport branching). The `never` binding is what makes
    // that a check rather than a hope: it compiles only while the list above
    // covers every channel the union contains, so adding one to core without
    // adding it here fails the build rather than reaching an operator.
    const unsupported: never = connection;
    throw new UsageError(
      `the ${(unsupported as { channel: string }).channel} channel is not ` +
        `supported in the CLI`,
    );
  }

  // Checked after the overrides, so a flag that sets a field for this run
  // (--server-username) stands in for the placeholder the file still holds.
  assertNoConfigPlaceholder({
    value: connection,
    path: ["connection"],
    configFile: options.configFile,
    messageFor: (field) =>
      field === "connection.server.username"
        ? `The SFTP username is still ${PLACEHOLDER_SSH_USERNAME}. ` +
          "Replace it with your account on the SFTP server."
        : undefined,
  });

  // Warn when connection-per-poll is paired with a short poll interval, so a
  // wasteful setting persisted in alcove.yaml is flagged, not only a CLI
  // --connection-per-poll. Read through a FileSyncOptions cast for the same
  // reason as the call above: the merged options are typed for every channel,
  // and a webrtc block cannot hold either field. A no-op off sftp (the mode is
  // SFTP-only).
  warnConnectionPerPollShortInterval(
    connection.channel,
    (connection.options as FileSyncOptions | undefined)?.connectionPerPoll,
    (connection.options as FileSyncOptions | undefined)?.pollIntervalMs,
    log,
  );

  let keyData: KeyFile | undefined;
  try {
    keyData = invitedKeyFile ?? loadKeyFile(options.keyFile);
  } catch (err) {
    // A malformed existing key file is bad input the operator must fix or
    // re-provision (exit 64), the same classification saveKeyFile gives a
    // malformed token on write -- not a transport failure (69). loadKeyFile
    // already raises a complete, leak-safe UsageError for an invalid-JSON key
    // file; pass it through rather than re-wrapping (which would echo it twice).
    // A schema failure (a raw ZodError, naming the field not its value) or an
    // errno is reclassified here.
    if (err instanceof UsageError) throw err;
    const message = messageWithOperatorText`key file at ${operatorSuppliedText(
      options.keyFile,
    )} is malformed: ${err instanceof Error ? err.message : String(err)}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  // A missing key file is a configuration problem (exit 64), consistent with
  // the missing-config case above.
  if (keyData === undefined) {
    const message = messageWithOperatorText`key file ${operatorSuppliedText(
      options.keyFile,
    )}${MISSING_KEY_FILE_REMEDY}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  // Hard stop on an already-expired token before any dataset prep, connection, or
  // PAKE handshake. The `expires` in the key file is authoritative regardless of
  // token_max_age_days -- it may be an invitation token's short lifetime or a
  // max-age stamp from a prior rotation. authenticateConnection enforces the same
  // condition pre-handshake, but reporting it here exits earlier and with a
  // re-invite-specific message. UsageError -> exit 64, like the malformed/missing
  // key-file cases above. (The threshold-dependent "expiring soon" advisory is
  // emitted later, in the handler, because it is conditional on the rotation
  // outcome.)
  if (checkKeyFileExpiry(keyData, Date.now()) === "expired") {
    // keyData.expires is necessarily set when the status is "expired", but
    // TypeScript does not narrow it across the call; the fallback keeps the
    // message a definite string rather than risk rendering "undefined".
    const expiredAt = keyData.expires ?? "(unknown)";
    const message = messageWithOperatorText`the shared secret in ${operatorSuppliedText(
      options.keyFile,
    )} expired at ${expiredAt}${EXPIRED_SECRET_REMEDY}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  if (keyData.rotationInFlightSince !== undefined)
    log.warn(
      rotationInFlightNotice(options.keyFile, keyData.rotationInFlightSince),
    );
  const authPersist: AuthPersist = {
    // Operator-policy fields parsed from the YAML `authentication` block (today,
    // token_max_age_days), passed through end to end -- protocol.ts reads
    // tokenMaxAgeDays here to stamp the rotated token's expiry. The injected
    // fields below come only from the key file and override any YAML value.
    ...specAuth,
    sharedSecret: keyData.sharedSecret,
    expires: keyData.expires,
    keyFilePath: options.keyFile,
    ...(invitedKeyFile !== undefined && { keyFileWrittenThisRun: true }),
    ...(keyData.previousSharedSecret !== undefined && {
      previousSharedSecret: keyData.previousSharedSecret,
    }),
    ...(keyData.previousExpires !== undefined && {
      previousExpires: keyData.previousExpires,
    }),
    ...(keyData.rotationHistory !== undefined && {
      rotationHistory: keyData.rotationHistory,
    }),
    ...(keyData.rotationInFlightSince !== undefined && {
      rotationInFlightSince: keyData.rotationInFlightSince,
    }),
  };
  // The channel guard above throws on any channel runProtocol cannot run, so
  // the discriminated union narrows `connection` to ProtocolConnectionConfig
  // here.
  return {
    connection,
    authentication: authPersist,
    ...exchangeDataSpec,
  };
}
