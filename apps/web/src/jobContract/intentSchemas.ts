/**
 * The job intent: the body a client submits to create a job, its Zod schemas,
 * and the label and note rules the browser guards and the server validators
 * share. No Node import, so a browser guard can import it without bundling
 * {@link @jobs/intentConfig} or {@link @jobs/intentArgv}. Contract:
 * docs/spec/SERVER_JOB_API.md, "The job-create intent".
 */

import { z } from "zod";

import {
  FINGERPRINT_REGEX,
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_RECONNECT_ATTEMPTS,
  MAX_TEXT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_TRANSFORM_PATTERN_LENGTH,
  MetadataSchema,
  OwnColumnSelectionSchema,
  SHARED_SECRET_REGEX,
  StandardizationSchema,
  csvDelimiterRefusal,
  holdsPrivateKeyMaterial,
  isCsvDelimiterChoice,
  maxCodeUnits,
  normalizeCsvDelimiter,
  safeParseFileSyncOptions,
} from "@alcove/core";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { tokenMaxAgeDaysSchema } from "@psi/tokenMaxAge";

import { isAdmissibleInputName } from "./workInputName";

import type {
  FileSyncOptions,
  LinkageTerms,
  Metadata,
  OwnColumnSelection,
  SigningConfig,
  Standardization,
} from "@alcove/core";

/** Upper bound on a zero-setup `identity` label, the CLI's `--identity` value. */
export const MAX_IDENTITY_LENGTH = 1024;

/**
 * The control characters an `identity` label may not contain: C0, DEL and C1,
 * with no tab, LF or CR exception, since the label is one argv token bound
 * into a certificate the partner displays. Equal to core's
 * `TEXT_CONTROL_CHAR_PATTERN` (test/unit/jobs/identityLabelParity.test.ts).
 * Contract: docs/spec/SERVER_JOB_API.md, "The zero-setup intent".
 */
export const IDENTITY_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f]/;

/** The refusal for a control character in a label. It names the field and
 * the shape, never the submitted text. */
export const IDENTITY_CONTROL_CHAR_MESSAGE =
  "identity must not contain control characters";

/**
 * The bidirectional embedding, override and isolate characters (U+202A-U+202E,
 * U+2066-U+2069) an `identity` label may not contain; the implicit marks LRM,
 * RLM and ALM stay admitted. Equal to core's `BIDI_CONTROL_PATTERN`
 * (test/unit/jobs/identityLabelParity.test.ts). Contract:
 * docs/spec/SERVER_JOB_API.md, "The zero-setup intent".
 */
export const IDENTITY_DIRECTION_CHAR_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;

/** The refusal for a text-direction character in a label, separate from the
 * control-character refusal since the two refuse different characters. */
export const IDENTITY_DIRECTION_CHAR_MESSAGE =
  "identity must not contain text-direction characters";

/**
 * The refusal for a label holding private key material, core's third rule on a
 * terms `identity` (`PRIVATE_KEY_IDENTITY_MESSAGE`): a certificate bound to
 * such a label could not be named by any terms document. It never echoes the
 * submitted text.
 */
export const IDENTITY_PRIVATE_KEY_MESSAGE =
  "identity must not contain private key material";

/** Upper bound on a `peer_id`, the prefix of every file name this party writes
 * into the shared folder. */
export const MAX_PEER_ID_LENGTH = 64;

/**
 * A console-authored `peer_id`: one label of ASCII letters, digits, spaces, `-`
 * and `_`, starting and ending with a letter or digit. Stricter than core,
 * since the value becomes a file name component in a server-owned directory.
 * Contract: docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
export const PEER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/;

/** Whether `value` is an admissible `peer_id`. */
export function isAdmissiblePeerId(value: string): boolean {
  return value.length <= MAX_PEER_ID_LENGTH && PEER_ID_PATTERN.test(value);
}

/** The refusal both the console guard and the intent schema report for a
 * `peer_id` that fails {@link isAdmissiblePeerId}. */
export const PEER_ID_SHAPE_MESSAGE =
  "The party name must be a single label of ASCII letters (A-Z, a-z), digits, " +
  "spaces, '-', or '_', beginning and ending with a letter or digit. Write an " +
  "accented or non-Latin name in ASCII instead.";

/** The control characters a retention note may not contain: C0, DEL and C1,
 * except the tab, LF and CR a multi-line note may hold. Contract:
 * docs/spec/SERVER_JOB_API.md, "The exchange intent". */
export const NOTE_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * The tuning settings a client may set on a job: numeric, boolean, enum and
 * bounded-label {@link FileSyncOptions}, never a path, host, credential or
 * command. `connectionPerPoll` is sftp-only; `inactivityTimeoutMs` and
 * `unexpectedFiles` have no CLI flag, so the zero-setup arms refuse them.
 * Contract: docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
export interface JobExchangeOptions {
  pollIntervalMs?: number;
  peerTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  serverConnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  timestampInFilename?: boolean;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  unexpectedFiles?: "error" | "warn" | "ignore";
  connectionPerPoll?: boolean;
}

/**
 * Re-raise core's file-sync option issues on this parse, so core's
 * cross-field rules apply here in core's wording: `peer_id` needs
 * `timestamp_in_filename` and may not be `temp`, and `retain_files` needs
 * `timestamp_in_filename` and `lockless_rendezvous`.
 */
function checkAgainstCoreFileSyncOptions(
  options: JobExchangeOptions,
  ctx: z.RefinementCtx,
): void {
  const validation = safeParseFileSyncOptions(options);
  if (validation.success) return;
  for (const issue of validation.error.issues)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path,
    });
}

// No poll-interval floor beyond core's positive integer, matching the CLI: a
// sub-second interval is warned about, not refused.
const jobExchangeOptionsFields = {
  pollIntervalMs: z.number().int().positive().optional(),
  peerTimeoutMs: z.number().int().positive().optional(),
  serverConnectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECONNECT_ATTEMPTS)
    .optional(),
  timestampInFilename: z.boolean().optional(),
  locklessRendezvous: z.boolean().optional(),
  peerId: z
    .string()
    .refine(isAdmissiblePeerId, { message: PEER_ID_SHAPE_MESSAGE })
    .optional(),
  retainFiles: z.boolean().optional(),
};

// Neither has a CLI flag, so only a configured run admits them.
const configuredOnlyOptionsFields = {
  inactivityTimeoutMs: z.number().int().positive().optional(),
  unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
};

const jobExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobExchangeOptionsFields,
    ...configuredOnlyOptionsFields,
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

// `connectionPerPoll` dials a real SFTP session, so only the sftp arms admit it.
const jobSftpExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobExchangeOptionsFields,
    ...configuredOnlyOptionsFields,
    connectionPerPoll: z.boolean().optional(),
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

// A webrtc run polls no folder and holds no file-sync session, so only the
// timeouts and reconnect bound every channel shares apply.
const jobWebrtcExchangeOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    peerTimeoutMs: jobExchangeOptionsFields.peerTimeoutMs,
    inactivityTimeoutMs: configuredOnlyOptionsFields.inactivityTimeoutMs,
    serverConnectTimeoutMs: jobExchangeOptionsFields.serverConnectTimeoutMs,
    maxReconnectAttempts: jobExchangeOptionsFields.maxReconnectAttempts,
  })
  .strict();

/**
 * A zero-setup duration passed as a CLI duration flag: a whole number of
 * seconds at most {@link MAX_TIMEOUT_SECONDS}, refused rather than rounded,
 * since the CLI exits 64 on a value its flag refuses. Contract:
 * docs/spec/SERVER_JOB_API.md, "The zero-setup intent".
 */
function wholeSecondFlagMs(field: string) {
  return z
    .number()
    .int()
    .positive()
    .max(
      MAX_TIMEOUT_SECONDS * 1000,
      `${field} must not exceed ${MAX_TIMEOUT_SECONDS / 86_400} days on a ` +
        "quick exchange: the duration flag that passes it to the run " +
        "refuses a longer value",
    )
    .refine((ms) => ms % 1000 === 0, {
      message:
        `${field} must be a whole number of seconds on a quick ` +
        "exchange: it is passed to the run as a duration flag, whose value " +
        "takes a second-or-coarser unit",
    })
    .optional();
}

// Only what `zeroSetupOptionsArgv` (@jobs/intentArgv) can pass: a zero-setup
// run composes no document, so the strict parse refuses a field with no flag.
const jobZeroSetupOptionsFields = {
  ...jobExchangeOptionsFields,
  peerTimeoutMs: wholeSecondFlagMs("peerTimeoutMs"),
  serverConnectTimeoutMs: wholeSecondFlagMs("serverConnectTimeoutMs"),
};

const jobZeroSetupOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object(jobZeroSetupOptionsFields)
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

const jobZeroSetupSftpOptionsSchema: z.ZodType<JobExchangeOptions> = z
  .object({
    ...jobZeroSetupOptionsFields,
    connectionPerPoll: z.boolean().optional(),
  })
  .strict()
  .superRefine(checkAgainstCoreFileSyncOptions);

/**
 * A file in the operator-mounted work-input directory, the alternative to
 * inline `inputCsv`: `name` is one path segment ({@link isAdmissibleInputName}),
 * and the CLI reads the file in place.
 */
export interface JobInputFileReference {
  name: string;
}

/**
 * The signing modes an exchange implements, as core's
 * `assertSigningModeImplemented` allows: `session-derived`, and any mode core
 * adds later, is refused here rather than failing the run with exit 64.
 */
type JobSigningMode = "none" | "certificate";

/**
 * Where this party's signing identity file is: a secrets mount id and path
 * segments the server resolves against `JOB_SECRETS_DIR`, never a path. Absent
 * means the default ({@link SIGNING_IDENTITY_FILE_NAME}), created on demand; a
 * named location is read, never created. Contract:
 * docs/spec/SERVER_JOB_API.md, "Where the identity is: the console's option".
 */
export interface JobSigningIdentityLocation {
  mount: "secrets";
  subPath: Array<string>;
}

/** The secrets mount only. Resolving the location re-checks each segment's
 * shape and confines it by realpath. */
export const jobSigningIdentityLocationSchema: z.ZodType<JobSigningIdentityLocation> =
  z.strictObject({
    mount: z.literal("secrets"),
    subPath: z.array(z.string().min(1)).min(1),
  });

/**
 * The receipt-signing choice: the mode, plus a partner fingerprint pin and an
 * identity location, both admitted only under `certificate`. An absent pin is
 * a first authenticated contact. `identity_file` is not representable; the
 * server supplies it ({@link JobSigningPaths}). Contract:
 * docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
export interface JobSigningChoice {
  mode: JobSigningMode;
  partnerFingerprint?: string;
  identityLocation?: JobSigningIdentityLocation;
}

const partnerFingerprintSchema = z
  .string()
  .regex(
    FINGERPRINT_REGEX,
    "partnerFingerprint must be an unpadded base64url SHA-256 digest (43 " +
      "characters), as 'alcove fingerprint' prints it",
  );

const jobSigningChoiceSchema: z.ZodType<JobSigningChoice> = z
  .object({
    mode: z.enum(["none", "certificate"]),
    partnerFingerprint: partnerFingerprintSchema.optional(),
    identityLocation: jobSigningIdentityLocationSchema.optional(),
  })
  .strict()
  // A run that signs nothing loads no identity, so a location is refused.
  .refine(
    (signing) =>
      signing.mode === "certificate" || signing.identityLocation === undefined,
    {
      message:
        "identityLocation is only admissible with signing mode 'certificate'",
      path: ["identityLocation"],
    },
  )
  // No certificate is verified under `none`, so a pin is refused.
  .refine(
    (signing) =>
      signing.mode === "certificate" ||
      signing.partnerFingerprint === undefined,
    {
      message:
        "partnerFingerprint is only admissible with signing mode 'certificate'",
      path: ["partnerFingerprint"],
    },
  );

/**
 * The identity path a composed `signing` block names, supplied by the caller:
 * the console's own path for a live run, or a placeholder for the hand-off
 * template (`handoff.ts`).
 */
export interface JobSigningPaths {
  /** Absolute path of the signing identity file the run loads its private key
   * and certificate from (`signing.identity_file`). */
  identityFile: string;
}

/**
 * The `signing` block a validated intent composes: only `certificate` composes
 * one, and an absent pin composes no `partnerFingerprint` key. Throws when a
 * certificate intent has no resolved identity path. Contract:
 * docs/spec/SERVER_JOB_API.md, "Composed CLI configuration".
 */
export function composedSigning(
  intent: JobExchangeIntent,
  paths: JobSigningPaths | undefined,
): SigningConfig | undefined {
  if (intent.signing?.mode !== "certificate") return undefined;
  if (paths === undefined)
    throw new Error(
      "certificate-mode signing reached config composition with no identity " +
        "path resolved",
    );
  return {
    mode: "certificate",
    identityFile: paths.identityFile,
    ...(intent.signing.partnerFingerprint !== undefined
      ? { partnerFingerprint: intent.signing.partnerFingerprint }
      : {}),
  };
}

/** Which side of the partnership the submitting party runs. */
export type JobExchangeSide = "inviter" | "acceptor";

/**
 * The fields shared by every {@link JobExchangeIntent} arm. No field becomes a
 * path, host, credential reference or argv string: `sharedSecret` and
 * `inputCsv` are written to fixed-name files, and the rest are bounded data,
 * enums or booleans. Field contracts: docs/spec/SERVER_JOB_API.md, "The
 * exchange intent".
 */
export interface JobExchangeIntentBase {
  /** Optional on the wire: a body with no `mode` is an exchange intent
   * ({@link jobCreateIntentSchema}). */
  mode?: "exchange";
  linkageTerms: LinkageTerms;
  /** Absent exactly when `mountedConfigurationOpened` is true: that run uses
   * the key file beside the opened configuration, which the browser never
   * receives. */
  sharedSecret?: string;
  inputCsv?: string;
  inputFile?: JobInputFileReference;
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * The `deduplicate` the accepted invitation declared for the inviting party,
   * held against the inviter's presented value before any key or payload
   * moves. Absent binds nothing; `false` is a declaration and is forwarded.
   */
  expectedPartnerDeduplicate?: boolean;
  /** Which of this party's own columns its result file includes (core's
   * `include_own_columns`). Local: nothing of it reaches the partner. */
  includeOwnColumns?: OwnColumnSelection;
  /** The delimiter this party's own input is read and result written with
   * (core's `csv_delimiter`), graded by {@link jobCsvDelimiterSchema}. Absent
   * means commas. */
  csvDelimiter?: string;
  /** Optional on the wire; the server-job driver's config requires it. */
  side?: JobExchangeSide;
  /**
   * Whether this run was composed from the configuration opened off the mount:
   * the run then reads the `.alcove.key` beside it, and the hand-off merges
   * that document into its template (`buildJobHandoff` in `@jobs/handoff`).
   */
  mountedConfigurationOpened?: boolean;
  /**
   * Whether the operator converted the opened configuration to the console's
   * own resources; read only beside `mountedConfigurationOpened`. Unconverted,
   * the hand-off states the document's own paths, and a certificate run of a
   * document naming a signing path is refused (`createJob` in `@jobs/jobManager`).
   */
  mountedConfigurationConverted?: boolean;
  options?: JobExchangeOptions;
  eventStream?: boolean;
  diagnosticRun?: boolean;
  sweepExchangeFiles?: boolean;
  signing?: JobSigningChoice;
  retentionDisposition?: string;
  /** Days the rotated secret stays usable (core's
   * `authentication.token_max_age_days`). Absent means no expiry. */
  tokenMaxAgeDays?: number;
}

/** A filedrop exchange intent: no host or credential, and the server chooses
 * the shared folder. */
export interface JobFiledropExchangeIntent extends JobExchangeIntentBase {
  channel: "filedrop";
}

/** An sftp exchange intent: all connection material comes from the
 * operator-authored connection on the server. */
export interface JobSftpExchangeIntent extends JobExchangeIntentBase {
  channel: "sftp";
}

/**
 * A webrtc exchange intent: the coordination server is the one the operator
 * authored on the server, and `side` is required, since it is the run's
 * `role`. A run of an opened configuration is not representable: an opened
 * webrtc configuration is edited and saved back, not run.
 */
export interface JobWebrtcExchangeIntent extends JobExchangeIntentBase {
  channel: "webrtc";
  side: JobExchangeSide;
  mountedConfigurationOpened?: false;
}

/**
 * The intent a client submits to create an exchange job, discriminated on
 * `channel`: the only route from the client into a CLI invocation, and closed
 * to injection by construction. Contract: docs/spec/SERVER_JOB_API.md, "The
 * job-create intent".
 */
export type JobExchangeIntent =
  JobFiledropExchangeIntent | JobSftpExchangeIntent | JobWebrtcExchangeIntent;

/**
 * The CLI's `--linkage-strategy` value: `cascade` (the default, one PSI round
 * per key) or `single-pass` (every key in one exchange, disclosing the
 * per-key value structure to the receiver).
 */
export type JobZeroSetupLinkageStrategy = "cascade" | "single-pass";

/**
 * The fields shared by every {@link JobZeroSetupIntent} arm: no shared secret,
 * linkage terms, metadata or standardization, since the CLI infers the terms
 * from each party's input. `deduplicate` is this party's own side, unlike the
 * exchange mode's `expectedPartnerDeduplicate`. Contract:
 * docs/spec/SERVER_JOB_API.md, "The zero-setup intent".
 */
interface JobZeroSetupIntentBase {
  mode: "zeroSetup";
  inputCsv?: string;
  inputFile?: JobInputFileReference;
  options?: JobExchangeOptions;
  eventStream?: boolean;
  diagnosticRun?: boolean;
  sweepExchangeFiles?: boolean;
  linkageStrategy?: JobZeroSetupLinkageStrategy;
  deduplicate?: boolean;
  identity?: string;
  csvDelimiter?: string;
}

/** A filedrop zero-setup intent: the server builds the `file://` locator from
 * the configured shared folder. */
export interface JobZeroSetupFiledropIntent extends JobZeroSetupIntentBase {
  channel: "filedrop";
}

/** An sftp zero-setup intent: the connection comes from the authored entry on
 * the server (`zeroSetupSftpArgv` in `@jobs/intentArgv`). */
export interface JobZeroSetupSftpIntent extends JobZeroSetupIntentBase {
  channel: "sftp";
}

/** The intent a client submits to create a zero-setup job, discriminated on
 * `channel` and closed to injection as the exchange intent is. */
export type JobZeroSetupIntent =
  JobZeroSetupFiledropIntent | JobZeroSetupSftpIntent;

/** The union the create route accepts, discriminated on `mode`, then `channel`. */
export type JobCreateIntent = JobExchangeIntent | JobZeroSetupIntent;

/**
 * The channels an opened configuration runs over. A webrtc job is created
 * only from the console's own authoring, so an opened webrtc configuration
 * is edited and saved back instead.
 */
export type JobChannel = Extract<
  JobCreateIntent["channel"],
  "sftp" | "filedrop"
>;

/** The {@link JobChannel} values, as the configuration file spells them. */
const JOB_CHANNELS: ReadonlySet<string> = new Set<JobChannel>([
  "sftp",
  "filedrop",
]);

/** Whether the console runs an opened configuration over `channel`; an
 * allowlist, so a channel the schema adds later is not run until named here. */
export function isJobChannel(channel: string): channel is JobChannel {
  return JOB_CHANNELS.has(channel);
}

/**
 * Upper bound in UTF-16 code units on `inputCsv`, equal to the browser intake's
 * byte limit ({@link MAX_CSV_FILE_BYTES}) so a CSV that passed the intake is
 * never refused here. The body byte cap is the memory bound. Contract:
 * docs/spec/SERVER_JOB_API.md, "Size caps".
 */
export const MAX_INPUT_CSV_LENGTH = MAX_CSV_FILE_BYTES;

/** Upper bound on the number of `metadata` columns. */
export const MAX_METADATA_COLUMNS = 4096;

/** Upper bound on the length of a `metadata` column `description`. */
export const MAX_METADATA_DESCRIPTION_LENGTH = 4096;

/** Upper bound on the number of `standardization` transformations. */
export const MAX_STANDARDIZATION_TRANSFORMATIONS = 4096;

/** Upper bound on the number of `steps` in one `standardization` transformation. */
export const MAX_STANDARDIZATION_STEPS = 256;

/** Upper bound in code units on a `csvDelimiter`, applied before core resolves
 * it: room for `detect`, the longest word it accepts, and the whitespace the
 * resolution trims. */
export const MAX_CSV_DELIMITER_LENGTH = 32;

// A standardization step's `params` is left uncapped; the body byte cap
// (MAX_JOB_BODY_BYTES) bounds it.
const boundedMetadataSchema = MetadataSchema.refine(
  (columns) => columns.length <= MAX_METADATA_COLUMNS,
  { message: "metadata must not exceed the column cap" },
).refine(
  (columns) =>
    columns.every(
      (column) =>
        (column.description?.length ?? 0) <= MAX_METADATA_DESCRIPTION_LENGTH,
    ),
  { message: "a metadata column description exceeds the length cap" },
);

/**
 * The standardization functions whose named param core compiles to a regex
 * (`compileLinearRegex`): the only params the pattern cap applies to. A
 * plain-string param is never compiled, and `parse_date`'s format is bounded
 * by `isStepValid` in the coverage accumulator before any compile.
 */
const REGEX_SOURCE_PARAM_BY_FUNCTION: Record<string, string> = {
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
};

/**
 * Whether every compiled regex source in `transformation` is within
 * {@link MAX_TRANSFORM_PATTERN_LENGTH}, which bounds the RE2JS compile cost on
 * the console's event loop. The editor reads it to tell whether an unavailable
 * coverage sweep is the input header's doing.
 */
export function stepPatternsWithinCap(
  transformation: Standardization[number],
): boolean {
  for (const step of transformation.steps ?? []) {
    if (!Object.hasOwn(REGEX_SOURCE_PARAM_BY_FUNCTION, step.function)) continue;
    const value = step.params?.[REGEX_SOURCE_PARAM_BY_FUNCTION[step.function]];
    if (
      typeof value === "string" &&
      value.length > MAX_TRANSFORM_PATTERN_LENGTH
    )
      return false;
  }
  return true;
}

const boundedStandardizationSchema = StandardizationSchema.refine(
  (transformations) =>
    transformations.length <= MAX_STANDARDIZATION_TRANSFORMATIONS,
  { message: "standardization must not exceed the transformation cap" },
)
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          (transformation.steps?.length ?? 0) <= MAX_STANDARDIZATION_STEPS,
      ),
    { message: "a standardization transformation exceeds the step cap" },
  )
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          transformation.output.length <= MAX_NAME_LENGTH &&
          transformation.input.length <= MAX_NAME_LENGTH,
      ),
    { message: "a standardization output or input exceeds the length cap" },
  );

// The job manager refuses a name that resolves to no regular file at create time.
const jobInputFileReferenceSchema: z.ZodType<JobInputFileReference> = z
  .object({
    name: z.string().refine(isAdmissibleInputName, {
      message: "inputFile.name must be a single admissible path segment",
    }),
  })
  .strict();

/**
 * A party's own CSV delimiter: bounded at {@link MAX_CSV_DELIMITER_LENGTH},
 * resolved by {@link normalizeCsvDelimiter}, then graded by
 * {@link isCsvDelimiterChoice}, so this boundary and the command line accept
 * the same values. The parsed value is the resolved character. The refusal
 * names the field and never echoes the value. Contract:
 * docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
export const jobCsvDelimiterSchema: z.ZodType<string> = z
  .string()
  .check(maxCodeUnits(MAX_CSV_DELIMITER_LENGTH))
  .transform(normalizeCsvDelimiter)
  .superRefine((value, ctx) => {
    if (isCsvDelimiterChoice(value)) return;
    ctx.addIssue({
      code: "custom",
      message: `csvDelimiter must state a delimiter Alcove accepts: ${csvDelimiterRefusal(value)}`,
    });
  });

/**
 * The per-run controls on every arm of both modes: booleans that each select a
 * fixed CLI flag. `--force-retain-sweep` is not representable. Contract:
 * docs/spec/SERVER_JOB_API.md, "The per-run controls".
 */
const jobRunControlFields = {
  diagnosticRun: z.boolean().optional(),
  sweepExchangeFiles: z.boolean().optional(),
};

const jobExchangeIntentCommonFields = {
  ...jobRunControlFields,
  linkageTerms: LinkageTermsSchema,
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "sharedSecret must be a base64url-encoded 32-byte value (43 base64url characters)",
    )
    .optional(),
  inputCsv: z
    .string()
    .min(1)
    .check(maxCodeUnits(MAX_INPUT_CSV_LENGTH))
    .optional(),
  inputFile: jobInputFileReferenceSchema.optional(),
  metadata: boundedMetadataSchema.optional(),
  standardization: boundedStandardizationSchema.optional(),
  expectedPartnerDeduplicate: z.boolean().optional(),
  includeOwnColumns: OwnColumnSelectionSchema.optional(),
  csvDelimiter: jobCsvDelimiterSchema.optional(),
  side: z.enum(["inviter", "acceptor"]).optional(),
  mountedConfigurationOpened: z.boolean().optional(),
  mountedConfigurationConverted: z.boolean().optional(),
  eventStream: z.boolean().optional(),
  signing: jobSigningChoiceSchema.optional(),
  retentionDisposition: z
    .string()
    .min(1)
    .check(maxCodeUnits(MAX_TEXT_LENGTH))
    .refine((note) => !NOTE_CONTROL_CHAR_PATTERN.test(note), {
      message: "retentionDisposition must not contain control characters",
    })
    .optional(),
  tokenMaxAgeDays: tokenMaxAgeDaysSchema.optional(),
};

// Not annotated z.ZodType: z.discriminatedUnion requires concrete ZodObject
// members, so the type is checked on the unions below. The `mode` literal lets each arm
// join the create route's mode-discriminated union.
const jobFiledropExchangeIntentSchema = z
  .object({
    mode: z.literal("exchange"),
    channel: z.literal("filedrop"),
    ...jobExchangeIntentCommonFields,
    options: jobExchangeOptionsSchema.optional(),
  })
  .strict();

const jobSftpExchangeIntentSchema = z
  .object({
    mode: z.literal("exchange"),
    channel: z.literal("sftp"),
    ...jobExchangeIntentCommonFields,
    options: jobSftpExchangeOptionsSchema.optional(),
  })
  .strict();

const jobWebrtcExchangeIntentSchema = z
  .object({
    mode: z.literal("exchange"),
    channel: z.literal("webrtc"),
    ...jobExchangeIntentCommonFields,
    side: z.enum(["inviter", "acceptor"]),
    mountedConfigurationOpened: z.literal(false).optional(),
    options: jobWebrtcExchangeOptionsSchema.optional(),
  })
  .strict();

const jobExchangeChannelUnion = z.discriminatedUnion("channel", [
  jobFiledropExchangeIntentSchema,
  jobSftpExchangeIntentSchema,
  jobWebrtcExchangeIntentSchema,
]);

/** Whether exactly one of `inputCsv` and `inputFile` is present. */
function hasExactlyOneInputSource(intent: {
  inputCsv?: unknown;
  inputFile?: unknown;
}): boolean {
  return (intent.inputCsv !== undefined) !== (intent.inputFile !== undefined);
}

/** Whether exactly one of `sharedSecret` and `mountedConfigurationOpened: true`
 * is present; the latter run reads the key file beside the opened
 * configuration. */
function hasExactlyOneSecretSource(intent: {
  sharedSecret?: unknown;
  mountedConfigurationOpened?: unknown;
}): boolean {
  return (
    (intent.sharedSecret !== undefined) !==
    (intent.mountedConfigurationOpened === true)
  );
}

/** The {@link hasExactlyOneSecretSource} refusal, shared by both union levels. */
const SECRET_SOURCE_ISSUE = {
  message:
    "exactly one of sharedSecret or mountedConfigurationOpened: true must be " +
    "set: a run of the opened configuration uses the key file beside it",
  path: ["sharedSecret"],
};

/** Default a plain object's missing `mode` to `"exchange"`: the exchange client
 * (`serverJobExchangeDriver`) sends none, and a zero-setup body names itself. */
function withDefaultExchangeMode(raw: unknown): unknown {
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !("mode" in raw)
  )
    return { ...(raw as Record<string, unknown>), mode: "exchange" };
  return raw;
}

/**
 * Whether a certificate-mode intent's terms name this party; a blank identity
 * counts as absent. Applied at both union levels: a refine cannot sit on a
 * discriminated-union arm, and the signing block alone does not include the
 * terms. Contract: docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
function certificateModeNamesThisParty(intent: {
  signing?: { mode: string };
  linkageTerms: LinkageTerms;
}): boolean {
  if (intent.signing?.mode !== "certificate") return true;
  return (intent.linkageTerms.identity ?? "").trim() !== "";
}

/** The {@link certificateModeNamesThisParty} refusal, shared by both union levels. */
const UNNAMED_CERTIFICATE_PARTY_ISSUE = {
  message:
    "linkageTerms.identity is required with signing mode 'certificate': a " +
    "certificate is trusted by the identity its holder used in the agreed " +
    "terms, so an exchange that names no party cannot sign a receipt, and is " +
    "refused before it runs",
  path: ["linkageTerms", "identity"],
};

/**
 * Zod schema for a {@link JobExchangeIntent}. Both arms are strict, so an
 * unmodeled field fails the parse, and union-level refines require one input
 * source, one secret source, and a named party under certificate signing.
 * Contract: docs/spec/SERVER_JOB_API.md, "The exchange intent".
 */
export const jobExchangeIntentSchema: z.ZodType<JobExchangeIntent> = z
  .preprocess(withDefaultExchangeMode, jobExchangeChannelUnion)
  .refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  })
  .refine(hasExactlyOneSecretSource, SECRET_SOURCE_ISSUE)
  // Matches core's pre-exchange `assertCertificateModeNamesLocalParty`, so the
  // job is refused before this party's payload crosses.
  .refine(certificateModeNamesThisParty, UNNAMED_CERTIFICATE_PARTY_ISSUE);

const jobZeroSetupIntentCommonFields = {
  ...jobRunControlFields,
  inputCsv: z
    .string()
    .min(1)
    .check(maxCodeUnits(MAX_INPUT_CSV_LENGTH))
    .optional(),
  inputFile: jobInputFileReferenceSchema.optional(),
  eventStream: z.boolean().optional(),
  linkageStrategy: z.enum(["cascade", "single-pass"]).optional(),
  deduplicate: z.boolean().optional(),
  // Free text, so it takes the label rules above: no leading `-`, control or
  // text-direction character, or private key material.
  identity: z
    .string()
    .min(1)
    .check(maxCodeUnits(MAX_IDENTITY_LENGTH))
    .regex(/^[^-]/, "identity must not begin with '-'")
    .refine((label) => !IDENTITY_CONTROL_CHAR_PATTERN.test(label), {
      message: IDENTITY_CONTROL_CHAR_MESSAGE,
    })
    .refine((label) => !IDENTITY_DIRECTION_CHAR_PATTERN.test(label), {
      message: IDENTITY_DIRECTION_CHAR_MESSAGE,
    })
    .refine((label) => !holdsPrivateKeyMaterial(label), {
      message: IDENTITY_PRIVATE_KEY_MESSAGE,
    })
    .optional(),
  csvDelimiter: jobCsvDelimiterSchema.optional(),
};

// Not annotated z.ZodType, as the exchange arms are not.
const jobZeroSetupFiledropIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("filedrop"),
    ...jobZeroSetupIntentCommonFields,
    options: jobZeroSetupOptionsSchema.optional(),
  })
  .strict();

const jobZeroSetupSftpIntentSchema = z
  .object({
    mode: z.literal("zeroSetup"),
    channel: z.literal("sftp"),
    ...jobZeroSetupIntentCommonFields,
    options: jobZeroSetupSftpOptionsSchema.optional(),
  })
  .strict();

const jobZeroSetupChannelUnion = z.discriminatedUnion("channel", [
  jobZeroSetupFiledropIntentSchema,
  jobZeroSetupSftpIntentSchema,
]);

/** Zod schema for a {@link JobZeroSetupIntent}: `mode: "zeroSetup"` is
 * required, both arms are strict, and exactly one input source is set. */
export const jobZeroSetupIntentSchema: z.ZodType<JobZeroSetupIntent> =
  jobZeroSetupChannelUnion.refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  });

/**
 * The schema `POST /api/jobs` parses, discriminated on `mode` (absent means
 * `exchange`), then `channel`. The per-mode refines do not run on this union,
 * so its own refines repeat the cross-field rules. Contract:
 * docs/spec/SERVER_JOB_API.md, "The job-create intent".
 */
export const jobCreateIntentSchema: z.ZodType<JobCreateIntent> = z
  .preprocess(
    withDefaultExchangeMode,
    z.discriminatedUnion("mode", [
      jobExchangeChannelUnion,
      jobZeroSetupChannelUnion,
    ]),
  )
  .refine(hasExactlyOneInputSource, {
    message: "exactly one of inputCsv or inputFile must be set",
  })
  .refine(
    (intent) => intent.mode !== "exchange" || hasExactlyOneSecretSource(intent),
    SECRET_SOURCE_ISSUE,
  )
  .refine(
    (intent) =>
      intent.mode !== "exchange" || certificateModeNamesThisParty(intent),
    UNNAMED_CERTIFICATE_PARTY_ISSUE,
  );

/** The signing choice a hand-back states: any mode the file may hold
 * (`session-derived` included) and the pin under `certificate`. The file keeps
 * its own identity path. */
export interface JobHandBackSigning {
  mode: SigningConfig["mode"];
  partnerFingerprint?: string;
}

/**
 * The settings the console's steps edit, handed back into an opened
 * configuration on a channel the console does not conduct (`PUT
 * /api/jobs/config`). Every other setting comes from the mounted file.
 * Contract: docs/spec/SERVER_JOB_API.md, "Saving an opened configuration back".
 */
export interface JobConfigurationHandBack {
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  includeOwnColumns?: OwnColumnSelection;
  csvDelimiter?: string;
  signing: JobHandBackSigning;
  retentionDisposition?: string;
}

const jobHandBackSigningSchema: z.ZodType<JobHandBackSigning> = z
  .strictObject({
    mode: z.enum(["none", "session-derived", "certificate"]),
    partnerFingerprint: partnerFingerprintSchema.optional(),
  })
  .refine(
    (signing) =>
      signing.mode === "certificate" ||
      signing.partnerFingerprint === undefined,
    {
      message:
        "partnerFingerprint is only admissible with signing mode 'certificate'",
      path: ["partnerFingerprint"],
    },
  );

/** Zod schema for a {@link JobConfigurationHandBack}: strict, and each field
 * bounded as on the job intent. */
export const jobConfigurationHandBackSchema: z.ZodType<JobConfigurationHandBack> =
  z
    .strictObject({
      linkageTerms: jobExchangeIntentCommonFields.linkageTerms,
      metadata: jobExchangeIntentCommonFields.metadata,
      standardization: jobExchangeIntentCommonFields.standardization,
      includeOwnColumns: jobExchangeIntentCommonFields.includeOwnColumns,
      csvDelimiter: jobExchangeIntentCommonFields.csvDelimiter,
      signing: jobHandBackSigningSchema,
      retentionDisposition: jobExchangeIntentCommonFields.retentionDisposition,
    })
    .refine(certificateModeNamesThisParty, UNNAMED_CERTIFICATE_PARTY_ISSUE);

/** The signing identity file's name in the mounted data root. The leading dot
 * keeps it out of the input picker ({@link isAdmissibleInputName}). */
export const SIGNING_IDENTITY_FILE_NAME = ".alcove-signing-identity.json";

/** The proposal a run refused on a partner terms change writes beside the
 * job's `alcove.yaml` (`termsProposalPath` in `apps/cli/src/termsChange.ts`). */
export const TERMS_PROPOSAL_FILE_NAME = "alcove.proposed-terms";

/** The copy of the mounted `alcove.yaml` as it was before the last save of an
 * opened configuration (`PUT /api/jobs/config`). */
export const PREVIOUS_CONFIGURATION_FILE_NAME = "alcove.yaml.previous";

/**
 * The fixed, server-chosen file names in a job workdir, so a client string
 * never becomes a file path. The CLI names a run's own artifacts by the run's
 * stamp ({@link ./runArtifactNames}). Contract: docs/spec/SERVER_JOB_API.md,
 * "Workdir layout".
 */
export const JOB_FILE_NAMES = {
  /** The composed CLI config document. */
  config: "alcove.yaml",
  /** The CLI key file holding the shared secret. */
  key: ".alcove.key",
  /** The client's input CSV content. */
  input: "input.csv",
  /** The CLI's diagnostic log (`--log-file`), written only on a diagnostic
   * run. It can contain partner identity and linkage keys, so it is served only
   * through the job's log endpoint. */
  log: "run.log",
} as const;
