// What a run whose terms this party settled for itself shows the operator
// before it puts anything on the wire -- terms written into a configuration
// file, or inferred from the input file a zero-setup run was pointed at. The
// outbound-payload confirmation covers the party that accepted an invitation;
// this covers the party whose terms no consent record and no acceptance
// display stands behind.

import { createHash } from "node:crypto";

import logLibrary from "loglevel";

import {
  CONSENT_FACTS,
  DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  disclosedColumnNames,
  heldBackColumnNames,
  inferredRecordIdentifierStatement,
  matchedFieldColumns,
  matchedFieldEntry,
  matchedFieldsWithColumns,
  precisionFloorSelectionStatement,
  redactAndSanitizeForDisplay,
  redactUrlCredentials,
  summarizeInvitation,
  withholdsPartnerAssociationTable,
} from "@alcove/core";

import {
  consentSurfaceSink,
  displayLessCertainNote,
  LESS_CERTAIN_REMEDY,
  logCountOnlyTier,
  marked,
  type ConsentSurfaceSink,
} from "./invitationDisplay";
import { linkageStrategyNote } from "./onlineBootstrap";
import { logFileLinePattern, readLogFileTail } from "./util/logging";

import type { ProtocolConnectionConfig } from "./protocol";
import type {
  InvitationSummary,
  LinkageTerms,
  Metadata,
  PreparedExchange,
  Standardization,
  getLogger,
} from "@alcove/core";

/**
 * The heading the display leads with. It states nothing about timing: the
 * display asks nothing and the run goes on without a pause, so a note that
 * nothing has been sent yet would suggest a chance to stop that the run does
 * not offer, and one promising that nothing has connected would go stale once
 * an unpinned SFTP configuration probes for first-use host-key trust.
 */
const DISCLOSURE_HEADING = "What this exchange sends and matches on:";

/**
 * The line the display ends with on a file-sync run writing without
 * renaming, so the mode is on the record of what the run was set to do.
 */
const WRITE_WITHOUT_RENAMING_LINE =
  "  exchange files written directly under their final names, without a " +
  "rename: yes (write_without_renaming)";

/** The label the outbound column list holds, spelled the way the acceptance
 * display and the outbound-payload confirmation both spell this same fact. */
const OUTBOUND_COLUMNS_LABEL = "columns you will send";

/**
 * What the display states for a count-only exchange whose input still marks a
 * column to send: `prepareForExchange` refuses that run a few lines later, so
 * the line states the outcome and the two ways out of it rather than a column
 * list the run will never transmit.
 */
const COUNT_ONLY_MARKED_COLUMNS_REFUSAL =
  "Your input marks one or more columns to send to your partner, which a " +
  "count-only exchange cannot do, so this run stops before it starts. Clear " +
  'the payload marking on those columns, or set the algorithm to "psi".';

/**
 * What the display states in place of an own-membership disclosure where this
 * party's own output block is the pair the terms exchange refuses:
 * `validateCompatibility` reads the partner's `expectsOutput` off this
 * document's `shareWithPartner`, so a document expecting no result and sharing
 * none is a run in which neither party expects output. That run stops at the
 * terms exchange, so what a partner would learn from it is nothing the
 * operator has to weigh. The remedy names the two configuration fields, since
 * either one settles it and each takes a matching value in the partner's own
 * file.
 */
const NO_PARTY_EXPECTS_OUTPUT_REFUSAL =
  "Neither you nor your partner expects a result from these terms, so this " +
  "run stops at the terms exchange, before any linkage data is sent. Set " +
  "expects_output to true if the result is yours to receive, or " +
  "share_with_partner to true if it is your partner's, and agree on the " +
  "matching value with your partner.";

/**
 * The columns this party transmits for matched records, from the metadata this
 * run resolved -- the set {@link disclosedColumnNames} gathers and the payload
 * step transmits, so the display cannot overstate or understate what leaves the
 * machine.
 *
 * Three shapes send nothing and say why rather than printing a bare "(none)":
 * a partner entitled to no result is sent no payload whatever the input file
 * holds, a count-only exchange sends none in either direction, and a resolved
 * set that is empty discloses only the fact of a match. A count-only run whose
 * metadata WOULD transmit a column is refused a few lines later, in
 * `prepareForExchange`, so it states that refusal beside the count-only fact
 * rather than listing a set no run of these terms transmits.
 *
 * Each name is redacted and escaped here, at the composition site, since these
 * are operator-file strings with no display boundary of their own.
 */
function displayOutboundColumns(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
  columns: ReadonlyArray<string>,
): void {
  const label = `  ${marked(OUTBOUND_COLUMNS_LABEL, "outboundSendSelfAuthored")}`;
  // The count-only case comes first, ahead of the output direction: it holds
  // both directions at once, and it is the shape a marked column is refused
  // over.
  if (linkageTerms.algorithm === "psi-c") {
    emit(`${label}: (none)`);
    emit(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
    if (columns.length > 0) emit(`    ${COUNT_ONLY_MARKED_COLUMNS_REFUSAL}`);
    return;
  }
  if (!linkageTerms.output.shareWithPartner) {
    emit(
      `${label}: (none) -- your partner receives no result, so no payload is sent`,
    );
    return;
  }
  if (columns.length === 0) {
    emit(`${label}: (none) -- only matched records`);
    return;
  }
  emit(`${label}:`);
  for (const column of columns)
    emit(`    - ${redactAndSanitizeForDisplay(column)}`);
}

/**
 * @internal exported for testing
 *
 * Print what this run discloses and what it matches on, through `emit`.
 *
 * The matching facts are derived through {@link summarizeInvitation}, which
 * reads `linkageTerms` alone: the fields the keys match on, each key's
 * one-liner, and whether the strategy applies the grouping and candidate-set
 * terms the document declares. Deriving them here instead would be a second
 * reading of the same terms, free to disagree with the one the acceptance
 * surfaces render. The COPY is this seat's own -- the terms are the operator's
 * own file rather than a partner's proposal, so no line names an inviting or
 * accepting party.
 *
 * `standardization` is the run's authored one, `undefined` where it has none:
 * it decides which column each linkage field reads, so which declared columns
 * the run holds back ({@link heldBackColumnNames}). `inputColumns` is the
 * header the run read, in input order, which the held back line lists from.
 *
 * `run` names the command the display is for. A quick exchange's display
 * states which column inference took as the record identifier, and which
 * built-in rules the run selected for its keys, on lines above them, since no
 * file declares either; the remedy under a key marked less certain
 * is that command's own ({@link LESS_CERTAIN_REMEDY}).
 */
export function renderExchangeDisclosure(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
  metadata: Metadata,
  inputColumns: ReadonlyArray<string>,
  standardization: Standardization | undefined,
  run: "quickExchange" | "configuredExchange",
): void {
  const summary = summarizeInvitation({ linkageTerms });
  emit(DISCLOSURE_HEADING);
  displayOutboundColumns(emit, linkageTerms, disclosedColumnNames(metadata));

  const receivesResult = linkageTerms.output.expectsOutput;
  emit(
    `  ${marked(
      "you will receive the result",
      receivesResult ? "viewerReceivesResult" : "viewerReceivesNoResult",
    )}: ${receivesResult ? "yes" : "no"}`,
  );
  if (!receivesResult) emit(`    ${CONSENT_FACTS.viewerReceivesNoResult.note}`);
  // The partner's receipt takes its own basis, which the value decides: a
  // partner that receives is one the run delivers to, while a partner that does
  // not rests on the agreed terms being honored.
  const partnerFact = linkageTerms.output.shareWithPartner
    ? "partnerReceivesResult"
    : "partnerReceivesNoResult";
  emit(
    `  ${marked("your partner will receive the result", partnerFact)}: ` +
      (linkageTerms.output.shareWithPartner ? "yes" : "no"),
  );
  emit(`    ${CONSENT_FACTS[partnerFact].note}`);
  // What a partner entitled to no result still learns, which its receipt line
  // does not state: under `psi` an identifier-revealing match tells it which of
  // its own records are in this party's data, unless the run withholds its half
  // of the matched-pair table. No such line under `psi-c`, whose non-receiving
  // party is the sender -- it computes nothing from the round and is sent no
  // count report -- so the algorithm's disclosures stand there instead.
  //
  // The withheld variant here reads the two documents the parties wrote for
  // themselves -- `withholdsPartnerAssociationTable` holds this party's
  // declared `payload.receive` against the partner's declared `payload.send`
  // -- so it takes the fact worded for a seat that accepted no invitation
  // rather than the one the invitation seats read off their own token.
  //
  // Ahead of both sentences: `validateCompatibility` holds the partner's
  // `expectsOutput` equal to this document's `shareWithPartner`, so a document
  // with neither is the "neither party expects output" pair it refuses
  // (linkageTermsNegotiation.ts) -- a run that stops at the terms exchange,
  // whose membership sentence would describe an exchange that does not happen.
  const neitherPartyExpectsOutput =
    !linkageTerms.output.expectsOutput && !linkageTerms.output.shareWithPartner;
  if (neitherPartyExpectsOutput) emit(`  ${NO_PARTY_EXPECTS_OUTPUT_REFUSAL}`);
  else if (
    !linkageTerms.output.shareWithPartner &&
    linkageTerms.algorithm === "psi"
  ) {
    const membershipFact = withholdsPartnerAssociationTable(linkageTerms)
      ? "partnerOwnMembershipWithheldSelfAuthored"
      : "partnerLearnsOwnMembership";
    emit(
      `  ${marked(
        "what your partner learns about its own records",
        membershipFact,
      )}:`,
    );
    emit(`    ${CONSENT_FACTS[membershipFact].note}`);
  }

  logAlgorithmAndStrategy(emit, linkageTerms);

  emit(
    `  ${marked("duplicate matches", "duplicateMatches")}: ` +
      (linkageTerms.deduplicate
        ? "several of your records may match a single one of your partner's"
        : "no more than one of your records matches a single one of your partner's"),
  );
  // What the grouping this party declared discloses, and which party pays it,
  // in the wording written for a seat where each party declares its own value
  // against its own file. Withheld where the strategy applies no grouping: the
  // run is refused rather than matched loosely, so the statement would describe
  // an exchange that does not happen.
  if (linkageTerms.deduplicate && summary.deduplicateApplied) {
    emit(`    ${DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT}`);
    emit(`    ${DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE}`);
  }
  // Value-level matching multiplicity, beside the record-level line above.
  // Printed only where the exchange matches on the candidates: terms declaring
  // a split under a count-only exchange are refused before it runs.
  if (summary.fansOut && summary.fanOutApplied) {
    emit(`  ${marked("several values per record", "fanOutCandidates")}:`);
    emit(`    ${CONSENT_FACTS.fanOutCandidates.note}`);
  }
  // What those several values group once the partner declares a duplicate
  // matching of its own beside this party's. Read from core's verdict over
  // every producer of a candidate set, so a key declaring `swap` and a fuzzy
  // comparison state it where the line above is silent, and stated
  // conditionally: this run holds its own side of the pair and reads the
  // partner's only when the exchange runs.
  if (summary.candidateSetChainsGrouping) {
    emit(
      `  ${marked(
        "records grouped with no value in common",
        "candidateSetChainsGrouping",
      )}:`,
    );
    emit(`    ${CONSENT_FACTS.candidateSetChainsGrouping.note}`);
  }

  // The summary's own labels, each followed by the input column it reads where
  // that column's name differs, so the line names the column matched as the
  // held back line names the columns left out.
  const matched = matchedFieldsWithColumns(
    linkageTerms,
    matchedFieldColumns(metadata, linkageTerms, standardization),
  );
  if (matched.length > 0)
    emit(
      `  ${marked("matched on", "matchedFields")}: ` +
        matched
          .map((entry) =>
            matchedFieldEntry(
              entry,
              entry.columns
                .filter(
                  (column) => spokenForm(column) !== spokenForm(entry.label),
                )
                .map((column) => redactAndSanitizeForDisplay(column)),
            ),
          )
          .join(", "),
    );
  const heldBack = heldBackColumnNames(
    metadata,
    inputColumns,
    linkageTerms,
    standardization,
  );
  if (heldBack.length > 0)
    emit(
      `  ${marked("held back", "heldBackColumnsSelfAuthored")}: ` +
        heldBack.map((name) => redactAndSanitizeForDisplay(name)).join(", "),
    );
  if (run === "quickExchange") {
    emit(`  record identifier: ${inferredRecordIdentifierStatement(metadata)}`);
    emit(
      "  rules selected: " +
        precisionFloorSelectionStatement(DEFAULT_PRECISION_FLOOR_SELECTION),
    );
  }
  logLinkageKeyLines(emit, summary, { lessCertainMarker: true });
  if (summary.linkageKeys.some((key) => key.lessCertain))
    displayLessCertainNote(emit, LESS_CERTAIN_REMEDY[run]);
}

/**
 * The algorithm line with the count-only tier beneath it, and the linkage
 * strategy line with its note, in the lines and order the accept display
 * prints them.
 */
function logAlgorithmAndStrategy(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
): void {
  emit(`  ${marked("PSI algorithm", "algorithm")}: ${linkageTerms.algorithm}`);
  if (linkageTerms.algorithm === "psi-c")
    logCountOnlyTier(
      emit,
      linkageTerms.output.expectsOutput && linkageTerms.output.shareWithPartner,
    );
  emit(
    `  ${marked("linkage strategy", "linkageStrategy")}: ` +
      linkageTerms.linkageStrategy,
  );
  const strategyNote = linkageStrategyNote(linkageTerms);
  if (strategyNote !== undefined) emit(`    ${strategyNote}`);
}

/**
 * One line per key: its name and the fields it combines, both already escaped
 * by the summary, and beneath it a key condition's line, the same one the
 * acceptance display states. The full element and transform detail stays in
 * the acceptance display, where a party is reading terms it did not write.
 * `lessCertainMarker` false leaves the mark off for a display that does not
 * explain it.
 */
function logLinkageKeyLines(
  emit: ConsentSurfaceSink,
  summary: InvitationSummary,
  { lessCertainMarker }: { lessCertainMarker: boolean },
): void {
  emit(`  ${marked("linkage keys", "linkageKeys")}:`);
  for (const key of summary.linkageKeys) {
    emit(
      `    - ${key.name}: ${key.headerFields.join(" - ")}` +
        (key.hasSwap ? " (matched in either order)" : "") +
        (lessCertainMarker && key.lessCertainHeaderMarker !== undefined
          ? ` ${key.lessCertainHeaderMarker}`
          : ""),
    );
    if (key.condition !== undefined) emit(`      ${key.condition}`);
  }
}

/** The heading of {@link renderInvitationTermsDisclosure}. */
const INVITATION_TERMS_DISCLOSURE_HEADING =
  "What these terms disclose, as your partner is shown them before accepting:";

/**
 * Print what an invitation minted from a configuration file's terms discloses,
 * through `emit`: the algorithm with the count-only tier and the linkage
 * strategy with its note, in the accept display's own lines, and each key with
 * the missing-field condition line the accept display states under it.
 */
export function renderInvitationTermsDisclosure(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
): void {
  emit(INVITATION_TERMS_DISCLOSURE_HEADING);
  logAlgorithmAndStrategy(emit, linkageTerms);
  logLinkageKeyLines(emit, summarizeInvitation({ linkageTerms }), {
    lessCertainMarker: false,
  });
}

/**
 * The routing the display renders through, on every path that shows it.
 *
 * It asks nothing and refuses nothing: a run that is valid without it stays
 * valid. Rendered through {@link consentSurfaceSink} on the prompt stream,
 * like the outbound-payload confirmation beside it: this is the only account
 * this party gets of what its run discloses, so a raised `--log-level` must
 * not drop it. The `--log-file` copy takes `warn` for the same reason -- at
 * `info` a run quieted to `warn` would print the surface and keep no record
 * of it -- leaving `error` and `silent` the levels that record none of it, as
 * they record no other line either.
 *
 * One case writes the log copy alone: an unattended run whose `--log-file`
 * records the display, where the last display recorded there is this one
 * ({@link lastRecordedDisclosureDigest}). A scheduler mails whatever reaches
 * stderr, so an unchanged display would reach its owner on every run.
 *
 * The digest also covers the party identity and the connection destination,
 * which the display does not render, so a run whose partner-facing identity or
 * destination changed is not silenced.
 */
function showDisclosure(params: {
  render: (emit: ConsentSurfaceSink) => void;
  linkageTerms: LinkageTerms;
  connection: ProtocolConnectionConfig;
  logFile: string | undefined;
  log: ReturnType<typeof getLogger>;
  unattended: boolean;
}): void {
  const { render, linkageTerms, connection, logFile, log, unattended } = params;
  const lines: string[] = [];
  render((line) => lines.push(line));
  if (
    (connection.channel === "sftp" || connection.channel === "filedrop") &&
    connection.options?.writeWithoutRenaming === true
  )
    lines.push(WRITE_WITHOUT_RENAMING_LINE);
  const digest = disclosureDigest(lines, linkageTerms, connection);
  const logRecordsDisplay =
    logFile !== undefined && log.getLevel() <= logLibrary.levels.WARN;
  const logCopyOnly =
    logRecordsDisplay &&
    unattended &&
    lastRecordedDisclosureDigest(logFile) === digest;
  const emit: ConsentSurfaceSink = logCopyOnly
    ? (line) => log.warn(line)
    : consentSurfaceSink({
        log,
        toPromptStream: true,
        level: "warn",
      });
  for (const line of lines) emit(line);
  if (logRecordsDisplay) log.warn(`${DISCLOSURE_DIGEST_LABEL}${digest}`);
}

/**
 * The text ahead of the display's digest on the log line recording it, which
 * {@link lastRecordedDisclosureDigest} matches on.
 */
const DISCLOSURE_DIGEST_LABEL = "Disclosure digest: sha256:";

/**
 * How far back from the end of a `--log-file` the last recorded digest is
 * looked for. A digest beyond it counts as absent, which prints the display.
 */
const DISCLOSURE_DIGEST_SEARCH_BYTES = 8 * 1024 * 1024;

/**
 * Where the connection points, with every credential removed: an sftp server's
 * scheme, host, port and path, a filedrop's path, a webrtc signaling endpoint.
 * Hashed but never displayed.
 *
 * @internal exported for testing
 */
export function disclosureDestination(
  connection: ProtocolConnectionConfig,
): string {
  const locate = (
    scheme: string,
    host: string,
    port: number | undefined,
    paths: readonly (string | undefined)[],
  ): string => {
    const authority = port === undefined ? host : `${host}:${port}`;
    const [first, ...rest] = paths.filter((p) => p !== undefined);
    const raw = `${scheme}://${authority}/${(first ?? "").replace(/^\//, "")}`;
    let located: string;
    try {
      located = redactUrlCredentials(new URL(raw));
    } catch {
      located = raw;
    }
    return [located, ...rest].join(" ");
  };
  switch (connection.channel) {
    case "sftp": {
      const { host, port, path, inboundPath, outboundPath } = connection.server;
      return locate("sftp", host, port, [path, inboundPath, outboundPath]);
    }
    case "filedrop": {
      const { path, inboundPath, outboundPath } = connection;
      return ["filedrop", path, inboundPath, outboundPath]
        .filter((p) => p !== undefined)
        .join(" ");
    }
    case "webrtc": {
      const { host, port, path, secure } = connection.server;
      return locate(secure === false ? "ws" : "wss", host, port, [path]);
    }
  }
}

/**
 * The digest of the display's lines plus two fixed-label lines the display
 * does not render: the party identity and the connection destination.
 *
 * @internal exported for testing
 */
export function disclosureDigest(
  lines: readonly string[],
  linkageTerms: LinkageTerms,
  connection: ProtocolConnectionConfig,
): string {
  const hashed = [
    ...lines,
    `party identity: ${linkageTerms.identity}`,
    `connection destination: ${disclosureDestination(connection)}`,
  ];
  return createHash("sha256").update(hashed.join("\n"), "utf8").digest("hex");
}

/**
 * The digest on the last line of `logFile` that records one, within its last
 * {@link DISCLOSURE_DIGEST_SEARCH_BYTES}; `undefined` when there is none or
 * the file cannot be read.
 *
 * @internal exported for testing
 */
export function lastRecordedDisclosureDigest(
  logFile: string,
): string | undefined {
  const tail = readLogFileTail(logFile, DISCLOSURE_DIGEST_SEARCH_BYTES);
  if (tail === undefined) return undefined;
  const pattern = logFileLinePattern(
    "warn",
    DISCLOSURE_DIGEST_LABEL,
    /([0-9a-f]{64})/,
  );
  let last: string | undefined;
  for (const match of tail.matchAll(pattern)) last = match[1];
  return last;
}

/**
 * A name as it reads aloud, for deciding whether a column name says what its
 * field label already does: `first_name` and `First Name` both read as
 * `first name`. Used only to choose whether the matched on line names a
 * column, never to match or bind one.
 */
function spokenForm(name: string): string {
  return name.replace(/[_-]+/g, " ").trim().toLowerCase();
}

/**
 * Show what this run will disclose and match on, before any credential, terms,
 * or data are sent.
 */
export function displayExchangeDisclosure(params: {
  /** The metadata this run resolved -- the source of what it would transmit. */
  metadata: Metadata;
  /** The input header this run read, in input order. */
  inputColumns: ReadonlyArray<string>;
  /** The terms this run resolved, which decide what it matches on. */
  linkageTerms: LinkageTerms;
  /** The configuration's standardization, which binds fields to columns. */
  standardization: Standardization | undefined;
  /** The connection this run uses; only its destination is hashed. */
  connection: ProtocolConnectionConfig;
  /** The operator's `--log-file`, so the log keeps a copy of the surface. */
  logFile: string | undefined;
  log: ReturnType<typeof getLogger>;
  /** No terminal can answer a question on this run. */
  unattended: boolean;
}): void {
  const {
    metadata,
    inputColumns,
    linkageTerms,
    standardization,
    connection,
    logFile,
    log,
    unattended,
  } = params;
  showDisclosure({
    render: (emit) =>
      renderExchangeDisclosure(
        emit,
        linkageTerms,
        metadata,
        inputColumns,
        standardization,
        "configuredExchange",
      ),
    linkageTerms,
    connection,
    logFile,
    log,
    unattended,
  });
}

/**
 * Show the same display for a zero-setup run, whose terms and metadata are
 * inferred from the input file it was pointed at rather than read from a
 * configuration. The lines are the ones above: an operator who settled these
 * terms on a command line is owed the same account of what leaves the machine
 * as one who wrote them into a file.
 *
 * Takes the prepared exchange itself, the pair handed to the run, so the
 * display cannot state terms or columns other than the ones transmitted.
 *
 * There is no consent record to stand it down. A zero-setup run accepts no
 * invitation and loads no configuration, so nothing before it showed the
 * operator these facts.
 */
export function displayZeroSetupDisclosure(params: {
  /** The exchange this run prepared -- the source of what it transmits and
   * what it matches on. */
  prepared: PreparedExchange;
  /** The connection this run uses; only its destination is hashed. */
  connection: ProtocolConnectionConfig;
  /** The operator's `--log-file`, so the log keeps a copy of the surface. */
  logFile: string | undefined;
  log: ReturnType<typeof getLogger>;
  /** No terminal can answer a question on this run. */
  unattended: boolean;
}): void {
  const { prepared, connection, logFile, log, unattended } = params;
  // A zero-setup run authors no standardization: each field reads the column
  // its type infers, as the prepare step bound it. Its direct-mode metadata
  // declares every column of the header it read, in header order.
  showDisclosure({
    render: (emit) =>
      renderExchangeDisclosure(
        emit,
        prepared.linkageTerms,
        prepared.metadata,
        prepared.metadata.map((column) => column.name),
        undefined,
        "quickExchange",
      ),
    linkageTerms: prepared.linkageTerms,
    connection,
    logFile,
    log,
    unattended,
  });
}
