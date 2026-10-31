import YAML from "yaml";

import {
  annotateUnsetPayloadReceive,
  atLowestExchangeFileVersion,
  commentBlock,
  commentKey,
  CONNECTION_BLOCK_DOC_URL,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_PEER_INACTIVITY_TIMEOUT_MS,
  DEFAULT_PEER_TIMEOUT_MS,
  defaultPollingFrequencyMs,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  identifierTypedColumnNames,
  PLACEHOLDER_SFTP_HOST,
  PLACEHOLDER_SSH_USERNAME,
  POLL_INTERVAL_LINES,
  snakeizeKeys,
} from "@alcove/core";
import type {
  ExchangeSpec,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@alcove/core";

/**
 * The exchange-data portion of a template, as produced by `buildDataSpec`: the
 * linkage terms (always present -- default templates, or inferred from an input
 * file) plus the metadata and standardization that are inferred only when an
 * input file is given. Mirrors `ResolvedDataSpec` without coupling this module to
 * the bootstrap command layer.
 */
export interface TemplateDataSpec {
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  /** The field delimiter the run was given, written into the template so the
   * exchange it governs reads and writes by it without a flag. Absent when the
   * run chose none. */
  csvDelimiter?: string;
  /** The input columns the inferred metadata does not declare, in input
   * order, written as commented metadata entries so the operator can choose
   * to send one. Absent or empty when no input file was read, or when every
   * column was declared. */
  undeclaredColumns?: ReadonlyArray<string>;
}

/**
 * The placeholder written as an SFTP connection's `server.path` when nothing
 * names the directory.
 */
export const PLACEHOLDER_SFTP_PATH = "REPLACE_WITH_SHARED_DIRECTORY";

/**
 * The placeholder written as a filedrop connection's `path` when nothing names
 * the directory. Absolute so the template still parses: the filedrop schema
 * takes only an absolute path.
 */
export const PLACEHOLDER_FILEDROP_PATH = "/REPLACE_WITH_SHARED_DIRECTORY";

/**
 * The connection block a template is written with, without its tuning
 * options: an `sftp` server (`path` absent for the login directory) or a
 * `filedrop` directory. camelCase, like the rest of the spec the template
 * renders.
 */
export type TemplateConnection =
  | {
      channel: "sftp";
      server: {
        host: string;
        port: number;
        username: string;
        path?: string;
        password?: string;
      };
    }
  | { channel: "filedrop"; path: string };

/** The connection a template holds when nothing names one: an `sftp` block of
 * placeholders. */
export const DEFAULT_TEMPLATE_CONNECTION: TemplateConnection = {
  channel: "sftp",
  server: {
    host: PLACEHOLDER_SFTP_HOST,
    port: 22,
    username: PLACEHOLDER_SSH_USERNAME,
    path: PLACEHOLDER_SFTP_PATH,
  },
};

const HEADER_LINES = [
  "Alcove configuration template.",
  "",
  "Every option below is documented inline. Edit the placeholders (anything",
  "REPLACE_WITH_...; an exchange refuses a file still holding one), fill in",
  "your connection credentials, and review the linkage terms before running an",
  "exchange. The shared secret is NOT stored here -- it lives in the key file",
  "(.alcove.key), written by invite/accept.",
  "",
  "Field reference:",
  "  https://github.com/georgetown-mdi/alcove/blob/main/docs/EXCHANGE_REFERENCE.md",
  "CLI usage: https://github.com/georgetown-mdi/alcove/blob/main/docs/CLI.md",
  "snake_case keys; a value beginning with @ is read from the file at that path",
  "(use it for credentials so secrets stay out of this file).",
];

/**
 * Per-field documentation attached to the live document. Each entry is a path
 * into the (snake_case) document and the comment lines to render before that
 * key. The connection and linkage-terms scalar fields are documented here; the
 * inferred array sections (linkage_fields, linkage_keys, metadata,
 * standardization) are documented at the section level just below, since their
 * contents are example/inferred data rather than fixed options.
 *
 * @internal exported so a test asserts every entry's path still resolves in the
 * rendered document -- `commentKey` no-ops on a miss, so a renamed field would
 * otherwise drop its comment silently.
 */
export const FIELD_DOCS: Array<{ path: Array<string>; lines: Array<string> }> =
  [
    {
      path: ["format_version"],
      lines: [
        "The version of this file's format. An older Alcove refuses a file",
        "whose version is newer than it reads.",
      ],
    },
    {
      path: ["connection"],
      lines: [
        "How to reach your exchange partner. channel is one of sftp, filedrop (a",
        "shared mounted directory), or webrtc; a commented webrtc block is at the",
        "end of this file. The block each one takes is at",
        CONNECTION_BLOCK_DOC_URL,
      ],
    },
    {
      path: ["connection", "options"],
      lines: [
        "Connection tuning. Defaults shown; most exchanges leave these untouched.",
        "For a scheduled run, also set a stable peer_id naming this party, so a",
        "file a killed run left behind stops the next run with the file named:",
        "  peer_id: agency-a",
        "If the partner's file transfer refuses a file name it has passed",
        "before, add fields Alcove fills in for each run, such as the UTC",
        "date and time in agency-a_%Y%m%d-%H%M%S.",
      ],
    },
    {
      path: ["connection", "options", "server_connect_timeout_ms"],
      lines: ["Per-attempt timeout connecting to the server, in ms."],
    },
    {
      path: ["connection", "options", "peer_timeout_ms"],
      lines: ["How long to wait for the partner to arrive, in ms."],
    },
    {
      path: ["connection", "options", "inactivity_timeout_ms"],
      lines: [
        "How long the partner, once arrived, may send nothing before the",
        "exchange fails, in ms.",
      ],
    },
    {
      path: ["connection", "options", "poll_interval_ms"],
      lines: [
        "How often to check for the partner's file, in ms.",
        ...POLL_INTERVAL_LINES,
      ],
    },
    {
      path: ["connection", "options", "max_reconnect_attempts"],
      lines: ["Retries after a transient connection failure."],
    },
    {
      path: ["connection", "options", "timestamp_in_filename"],
      lines: [
        "Encode a timestamp + sequence in message filenames (sync-mediated drops).",
      ],
    },
    {
      path: ["connection", "options", "lockless_rendezvous"],
      lines: [
        "Use an ack-handshake barrier instead of a lock file; both parties must",
        "set this identically. Required for transports without atomic create.",
      ],
    },
    {
      path: ["connection", "options", "retain_files"],
      lines: [
        "Keep every message as a durable transcript instead of deleting it.",
        "Requires lockless_rendezvous and timestamp_in_filename both true; both",
        "parties must set it identically and start from a fresh directory.",
      ],
    },
    {
      path: ["linkage_terms"],
      lines: [
        "What will be matched and how. Both parties' terms must agree, or the",
        "exchange aborts. linkage_fields are the standardized PII elements;",
        "linkage_keys are the ordered keys built from them, tried in turn.",
      ],
    },
    {
      path: ["linkage_terms", "version"],
      lines: ["Linkage-terms schema version."],
    },
    {
      path: ["linkage_terms", "identity"],
      lines: [
        "Who holds these terms (name, organization, contact). Self-asserted.",
      ],
    },
    {
      path: ["linkage_terms", "date"],
      lines: ["Date these terms were last edited (YYYY-MM-DD)."],
    },
    {
      path: ["linkage_terms", "algorithm"],
      lines: [
        "psi reveals matched ids; psi-c reveals only the match count, counted",
        "across every key, and sends no payload columns. psi-c is for research.",
      ],
    },
    {
      path: ["linkage_terms", "linkage_strategy"],
      lines: [
        "cascade (one PSI round per key) or single-pass (all keys in one round,",
        "fewer round-trips, but discloses your full per-key value structure).",
        "psi-c runs the cascade's rounds under either and reveals the same.",
      ],
    },
    {
      path: ["linkage_terms", "deduplicate"],
      lines: [
        "Allow several of your records to match the same partner record.",
      ],
    },
    {
      path: ["linkage_terms", "output"],
      lines: [
        "expects_output: do you receive the result. share_with_partner: does the",
        "partner receive it.",
      ],
    },
    {
      path: ["linkage_terms", "linkage_fields"],
      lines: ["The standardized PII fields keys are built from."],
    },
    {
      path: ["linkage_terms", "linkage_keys"],
      lines: [
        "Ordered keys, tried in turn. The keys written list the highest-precision",
        "rules first, then the rules broader matching adds. A key with",
        "condition: missing_field: date_of_birth matches only where one side's",
        "record has no valid date of birth.",
        "The keys written are the rules broader matching selects. Three of them",
        "are less certain, matching on a name and a date of birth alone:",
        "LN + FN + DOB, swap(LN, FN) + DOB, and split(LN) + FN + DOB.",
        "Different people share a name and a date of birth more often the more",
        "people the two files cover, so delete those three keys when your files",
        "cover many people. A file of one age group, such as one school class,",
        "counts as covering many people, because its members share birth years.",
        "To run the highest-precision rules only, delete those three and SSN + FN,",
        "SSN4 + LN4 + YOB + MOB, LN + FN + DOB + ZIP3,",
        "ZIP5 + soundex(LN) + FN + DOB, ZIP5 + LN + FN + DOB +/-1 year,",
        "LN + FN + DOB + STATE, LN + FN + DOB + COUNTY,",
        "LN + FN + YOB + MOB + ZIP5, LN + FN + PHONE, PHONE + soundex(LN) + FN,",
        "FN + PHONE, FN + DOB + EMAIL, LN + FN + EMAIL, and",
        "EMAIL + soundex(LN) + FN.",
        "A key your input file cannot supply is not written.",
      ],
    },
    {
      path: ["metadata"],
      lines: [
        "Per-column description of your input CSV: semantic type and role",
        "(linkage / identifier / payload / ignored). Inferred from column names",
        "when omitted. Inference sends no column, your ID column included: set",
        "is_payload: true on a column to send it for matched records.",
      ],
    },
    {
      path: ["standardization"],
      lines: [
        "Per-field cleaning applied to a column before keys are built. output is a",
        "linkage field, input is the raw CSV column, steps run in order.",
      ],
    },
  ];

/**
 * Per-field documentation for an `sftp` connection block, in the form of
 * {@link FIELD_DOCS}.
 *
 * @internal exported so a test asserts every entry resolves in an sftp render.
 */
export const SFTP_FIELD_DOCS: Array<{
  path: Array<string>;
  lines: Array<string>;
}> = [
  {
    path: ["connection", "server"],
    lines: [
      "SFTP server both parties drop files on. When the block has no path, the",
      "login directory is used. Supply a credential by adding one",
      "of (preferably as an @path, never a literal secret -- quote the value, as",
      "a leading @ is reserved in YAML):",
      '  password: "@./sftp-password.txt"',
      '  private_key: "@~/.ssh/id_alcove"',
      "An encrypted private key also takes its passphrase:",
      '  private_key_passphrase: "@./sftp-key-passphrase.txt"',
      "If the server accepts keyboard-interactive but not the direct password",
      "method, answer its prompts with the password (requires password):",
      "  keyboard_interactive: true",
      "Optionally pin the host key to verify the server on connect:",
      "  host_key_fingerprint: SHA256:....",
    ],
  },
  {
    path: ["connection", "server", "host"],
    lines: ["SFTP host name or IP."],
  },
  {
    path: ["connection", "server", "port"],
    lines: ["SSH port (default 22)."],
  },
  {
    path: ["connection", "server", "username"],
    lines: ["SSH username for the server."],
  },
  {
    path: ["connection", "server", "path"],
    lines: [
      "Directory on the server that both parties use for this exchange's",
      "files; both must name the same one. Delete the field to use the login",
      "directory.",
    ],
  },
];

/**
 * Per-field documentation for a `filedrop` connection block, in the form of
 * {@link FIELD_DOCS}.
 *
 * @internal exported so a test asserts every entry resolves in a filedrop
 * render.
 */
export const FILEDROP_FIELD_DOCS: Array<{
  path: Array<string>;
  lines: Array<string>;
}> = [
  {
    path: ["connection", "path"],
    lines: [
      "Absolute path of the shared folder both parties mount, for example a",
      "network share. Each party writes its own mount point here.",
    ],
  },
];

// Optional sections appended as commented-out examples: opt-in features with no
// default value to pre-fill, so they are documented here for the operator to
// uncomment and edit rather than written active. Kept in sync with the optional
// top-level sections of ExchangeSpec (see init.test.ts, which asserts every
// schema section appears in the template).
//
// @internal exported so a test un-comments each example and validates it against
// the schema -- an operator who enables a section must get a loadable config.
export const OPTIONAL_SECTIONS = `# --- Optional sections (uncomment and edit to enable) ------------------------

# A webrtc connection, in place of the connection block above: a direct
# channel between the two parties, set up through a peer-coordination server.
# role is inviter on the party that issued the invitation and acceptor on the
# other; 'alcove accept' writes this block for you. key is the coordination
# server's API key (default peerjs). port defaults to 443, or to 80 with
# secure: false, which opens the signaling socket without TLS. stun replaces
# the built-in STUN server list. turn names relay servers for networks where a
# direct connection fails (write the credential as an @path, or leave out
# username and credential to have each run mint one from the shared secret;
# credential_type is hmac-sha1 for a time-limited credential your relay's
# deployment minted, password otherwise). allowed_relays names the relay
# hosts, each with a port when given, that your side may connect through,
# enroll at, and name in its invitations, among your own and an invitation's;
# unset, it may use them all. Your relay_registrar, where set, still receives
# each rotated relay key.
# connection:
#   channel: webrtc
#   server:
#     host: REPLACE_WITH_COORDINATION_SERVER_HOST
#     port: 443
#     key: peerjs
#     secure: true
#   role: inviter
#   stun:
#     - "stun:stun.example.org:3478"
#   turn:
#     - url: "turns:relay.example.org:443?transport=tcp"
#       username: REPLACE_WITH_TURN_USERNAME
#       credential: "@./turn-credential.txt"
#       credential_type: password
#   allowed_relays:
#     - relay.example.org

# unexpected_files (sftp and filedrop): what to do when a file that is not part
# of the exchange appears in the shared directory during it. error stops the
# exchange, warn logs the file and continues, ignore skips it. Unset, it is
# error, or warn when retain_files or lockless_rendezvous is set. Your own
# setting: your partner may use another. Add it under connection.options above:
# connection:
#   options:
#     unexpected_files: warn

# legal_agreement: the data sharing agreement authorizing this exchange, the
# purpose of this disclosure under it, and the agreement's expiration date,
# recorded in both parties' exchange records. Both parties must write identical
# values or the exchange is cancelled, and it fails once expiration_date has
# passed. Add it under linkage_terms above:
# linkage_terms:
#   legal_agreement:
#     reference: "MOU-2025-0042"
#     purpose: "Audit and evaluation of the State tutoring program"
#     expiration_date: "2027-12-31"

# authentication: partner shared-secret policy. The secret itself lives in the
# key file, never here; only policy belongs in the config.
# authentication:
#   # The shared secret expires after this many days of inactivity (no
#   # successful run); omit it and the shared secret does not expire.
#   token_max_age_days: 365

# signing: receipt signing and partner-certificate trust. mode is none or
# certificate (third-party verifiable); the session-derived mode is not yet
# implemented and an exchange configured with it is refused. Under certificate
# mode identity_file is required: the signing identity is a long-lived
# credential, so you choose where it lives and Alcove never does -- a mount of
# its own is the usual home, read-only for every run except the one that creates
# the file. Create it with
# 'alcove fingerprint --identity-file <the path below>'. A signed run writes its
# receipt into the output folder beside the result and record.
# signing:
#   mode: none
#   # identity_file: /run/signing/alcove-signing-identity.json
#   # partner_fingerprint: <43-char base64url>  # pin the partner's certificate

# retention_disposition: a local note (recorded in your own exchange record
# only, never shared) describing where you file the result and under what
# retention schedule.
# retention_disposition: "Filed in the secure share; purged after 90 days."

# about: notes about this file that Alcove keeps but never acts on, such as a
# label or a comment.
# about:
#   label: "Quarterly enrollment match"
#   comment: "Set up with the county records office."

# include_own_columns: which of your own input columns your result file holds
# beside the values your partner sends, so you do not have to join the result
# back to your input by hand. disclosed writes the columns you send to the
# partner; all writes every column your metadata block declares, or, with no
# metadata block, every column of your input file. Your identifier column, if
# you have one, is left out either way -- the result's first column holds it.
# Purely local: nothing extra is sent, and your partner's result is unchanged.
# Omit the field to write your partner's values alone.
# include_own_columns: disclosed

# include_matching_key: true adds a last column, matched_on_key, to your result
# file, naming the linkage key each pair matched on. Requires the psi algorithm
# and the cascade linkage strategy, and terms that give you a result. Purely
# local: nothing extra is sent, and your partner's result is unchanged.
# --include-matching-key or --no-include-matching-key overrides it for one run.
# include_matching_key: true

# expected_partner_deduplicate: the linkage_terms.deduplicate your partner
# declared for its own side in the invitation you accepted. 'alcove accept'
# fills this in; you rarely set it by hand. An exchange refuses a partner that
# presents a different value than the invitation declared, before any key or
# payload moves. Omit the field for an exchange you and your partner each
# authored from your own configuration, where neither side declared anything to
# the other.
# expected_partner_deduplicate: false
`;

// The commented csv_delimiter example, shown only when the run named no
// delimiter (a run that named one gets the key written active). Its presence --
// active or commented -- is what keeps every ExchangeSpec section represented.
//
// @internal exported so the section-coverage test reads it from one place.
export const CSV_DELIMITER_HINT = `# csv_delimiter: the field delimiter of the CSV you link and of the result
# Alcove writes -- one character, 'tab', or 'detect' to take it from the input
# file. Local to you: your partner reads and writes its own files however it
# likes, and nothing about this is sent. Omit the field to read and write
# commas.
# csv_delimiter: "|"
`;

// The commented metadata + standardization block shown only when no input file
// was given (with an input file these sections are inferred and written active).
// Their presence -- active or commented -- is what keeps every ExchangeSpec
// section represented in the template.
//
// @internal exported so a test un-comments the example and validates it against
// the schema -- an operator who follows it by hand must get a loadable config.
export const INFERRED_SECTIONS_HINT = `# metadata and standardization are inferred from an input CSV: run
# 'alcove init data.csv' to fill them in, or author them by hand.
#
# metadata:
#   - name: ssn
#     type: ssn
#     role: linkage
#     is_payload: false
#     description: Social Security number
# standardization:
#   - output: ssn
#     input: ssn
#     # Drop an SSN more than this many people in the file hold.
#     max_people_per_value: 1
#     steps:
#       - function: trim_whitespace
#       - function: pad_left
#         params:
#           length: 9
#           char: "0"
`;

/**
 * The comment written after an inferred metadata block naming the input
 * columns it does not declare, each as a commented entry that sends the
 * column once uncommented. `identifier` is the name of the block's
 * `role: identifier` column, if it declares one: without one the comment names
 * how to declare one, and with one it names how to use an identifier-typed
 * undeclared column instead.
 */
function undeclaredColumnsComment(
  undeclaredColumns: ReadonlyArray<string>,
  identifier: string | undefined,
): string {
  const entries = undeclaredColumns.flatMap((name) =>
    YAML.stringify([{ name, type: "other", role: "payload", is_payload: true }])
      .trimEnd()
      .split("\n"),
  );
  const otherIdentifiers =
    identifier === undefined
      ? []
      : identifierTypedColumnNames(undeclaredColumns);
  return commentBlock([
    "Input columns not declared above, and so not sent to your partner.",
    "Uncomment an entry to send that column for matched records, or set its",
    "role to ignored to leave it out without a notice at each run.",
    ...(identifier === undefined
      ? [
          "No column above is your record identifier. To use one of the",
          "columns listed below as your record identifier, uncomment its entry",
          "and set its role to identifier; set is_payload to false as well to",
          "keep it from your partner.",
        ]
      : otherIdentifiers.length === 0
        ? []
        : [
            `${identifier} above is your record identifier. To use ` +
              (otherIdentifiers.length > 1
                ? `one of ${otherIdentifiers.join(", ")}`
                : otherIdentifiers[0]!) +
              " instead,",
            "uncomment its entry, set its role to identifier (and is_payload to",
            "false to keep it from your partner), and set the role of",
            `${identifier} above to ignored.`,
          ]),
    ...entries,
  ]);
}

/**
 * Render the commented `alcove.yaml` template `alcove init` writes: the
 * connection block (`sftp` placeholders unless `connection` names
 * another) with its tuning options, the linkage terms (default or
 * inferred), the inferred metadata/standardization when an input file was
 * given, and the optional sections documented as commented examples.
 *
 * The active sections are built into one YAML document so per-field comments
 * land in the right place and the result round-trips through the schema (the
 * test parses it); the opt-in sections, which have no default to pre-fill, are
 * appended as commented text.
 */
export function renderConfigTemplate(
  data: TemplateDataSpec,
  connection: TemplateConnection = DEFAULT_TEMPLATE_CONNECTION,
): string {
  const spec: Record<string, unknown> = {
    connection: {
      ...connection,
      options: {
        serverConnectTimeoutMs: DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
        peerTimeoutMs: DEFAULT_PEER_TIMEOUT_MS,
        inactivityTimeoutMs: DEFAULT_PEER_INACTIVITY_TIMEOUT_MS,
        pollIntervalMs: defaultPollingFrequencyMs(connection.channel),
        maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
        timestampInFilename: false,
        locklessRendezvous: false,
        retainFiles: false,
      },
    },
    linkageTerms: data.linkageTerms,
  };
  if (data.metadata !== undefined) spec.metadata = data.metadata;
  if (data.standardization !== undefined)
    spec.standardization = data.standardization;
  if (data.csvDelimiter !== undefined) spec.csvDelimiter = data.csvDelimiter;

  const doc = new YAML.Document(
    snakeizeKeys(atLowestExchangeFileVersion(spec as ExchangeSpec)),
  );
  doc.commentBefore = commentBlock(HEADER_LINES);
  const channelDocs =
    connection.channel === "sftp" ? SFTP_FIELD_DOCS : FILEDROP_FIELD_DOCS;
  for (const { path, lines } of [...FIELD_DOCS, ...channelDocs])
    commentKey(doc, path, lines);
  annotateUnsetPayloadReceive(doc, data.linkageTerms);
  const metadataNode = doc.get("metadata", true);
  if (
    data.undeclaredColumns !== undefined &&
    data.undeclaredColumns.length > 0 &&
    YAML.isSeq(metadataNode)
  )
    metadataNode.comment = undeclaredColumnsComment(
      data.undeclaredColumns,
      data.metadata?.find((column) => column.role === "identifier")?.name,
    );

  const sections = [doc.toString().trimEnd()];
  // When no input file seeded metadata/standardization, document them (commented)
  // so every ExchangeSpec section is still represented in the template.
  if (data.metadata === undefined) sections.push(INFERRED_SECTIONS_HINT);
  if (data.csvDelimiter === undefined) sections.push(CSV_DELIMITER_HINT);
  sections.push(OPTIONAL_SECTIONS);
  return sections.join("\n") + "\n";
}
