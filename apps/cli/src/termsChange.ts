/**
 * What `alcove exchange` does when its partner's linkage terms differ from
 * its configuration's at the terms exchange: show how they differ, and either
 * take them on -- written into the configuration, the run continuing under
 * them -- or refuse, writing them beside the configuration as a terms update
 * `alcove apply` reads. Also the question an attended run asks before it takes
 * a partner's first declared payload columns into a configuration that lists
 * none it receives.
 */

import path from "node:path";

import {
  DISPLAY_TRUNCATION_MARKER,
  encodeTermsUpdate,
  keepFirstPartyLinesWithOperatorText,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  OperatorConfigError,
  operatorSuppliedText,
  payloadReceiveFilledNotice,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  sanitizeForDisplay,
  termsDeltaSections,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  markStatesItsOwnNextStep,
} from "@alcove/core";
import type {
  Displayable,
  getLogger,
  PayloadReceiveFillAnswer,
  TermsChange,
  TermsDelta,
} from "@alcove/core";

import { termsUpdateWrite } from "./acceptedTermsRecords";
import {
  DEFAULT_CONFIG_PATH,
  persistTermsUpdate,
  termsUpdateInvalidTerm,
  type TermsUpdateWrite,
} from "./config";
import type { EventStreamEmitter } from "./eventStream";
import { writeFileOwnerOnly } from "./fileUtils";
import {
  consentSurfaceSink,
  type ConsentSurfaceSink,
} from "./invitationDisplay";
import { DEFAULT_KEY_PATH } from "./keyFile";
import { recordTermsChangeNotTaken } from "./termsChangeNotTaken";
import { readPartnershipSecret } from "./termsUpdateFiles";
import { promptConfirm } from "./util/prompt";

/**
 * Where a run that does not take on its partner's changed terms writes them:
 * beside the configuration, named after it.
 */
export function termsProposalPath(configPath: string): string {
  const { dir, name } = path.parse(configPath);
  return path.join(dir, `${name}.proposed-terms`);
}

/** The `alcove apply` invocation that applies the proposal for `paths`. */
export function applyCommand(paths: {
  configPath: string;
  keyPath: string;
  proposalPath: string;
}): string {
  const flags = [
    ...(paths.configPath === DEFAULT_CONFIG_PATH
      ? []
      : [`--config-file ${paths.configPath}`]),
    ...(paths.keyPath === DEFAULT_KEY_PATH
      ? []
      : [`--key-file ${paths.keyPath}`]),
  ];
  return ["alcove apply", ...flags, `@${paths.proposalPath}`].join(" ");
}

/**
 * Show `heading`, then `delta` in the sections every front end shows
 * (`termsDeltaSections`). Every name and value in `delta` is the partner's and
 * is escaped here.
 */
export function displayTermsDelta(
  emit: ConsentSurfaceSink,
  heading: string,
  delta: TermsDelta,
): void {
  emit(heading);
  for (const section of termsDeltaSections(delta)) {
    switch (section.kind) {
      case "columns":
        emit(`  ${section.label}:`);
        for (const column of section.columns)
          emit(`    ${redactAndSanitizeForDisplay(column)}`);
        break;
      case "partnerDeduplicate":
        emit(
          `  ${section.label}: ${String(section.expected)} -> ${String(section.presented)}`,
        );
        break;
      case "otherTerms":
        emit(`  ${section.label}:`);
        for (const difference of section.differences)
          emit(
            `    ${redactAndSanitizeForDisplay(difference, {
              maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
            })}`,
          );
        break;
    }
  }
}

/**
 * Show how the partner's terms differ from the configuration's
 * ({@link displayTermsDelta}).
 */
export function displayTermsChange(
  emit: ConsentSurfaceSink,
  configPath: string,
  change: TermsChange,
): void {
  displayTermsDelta(
    emit,
    `Your partner's linkage terms differ from those in ${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}:`,
    change.delta,
  );
}

const UNATTENDED_REFUSAL =
  "this run is not attended (no terminal on stdin), so it did not take on " +
  "your partner's changed linkage terms and stopped before any linkage key " +
  "or data moved.";

const NOT_CONTINUABLE_REFUSAL =
  "your partner's linkage terms change the linkage fields, keys, algorithm, " +
  "strategy, output direction, or version, which this run was prepared " +
  "under, or your partner's deduplicate, which only alcove apply takes on, " +
  "so it stopped before any linkage key or data moved.";

/**
 * The refusal of a change this run did not take on, naming the operator's own
 * paths, marked as theirs, with the command that applies the proposal on a
 * line of its own.
 */
function proposalRefusal(
  change: TermsChange,
  paths: { configPath: string; keyPath: string; proposalPath: string },
): OperatorConfigError {
  const refused = messageWithOperatorText`${change.continuable ? UNATTENDED_REFUSAL : NOT_CONTINUABLE_REFUSAL} Your partner's terms were written to ${operatorSuppliedText(
    paths.proposalPath,
  )}.`;
  const toFix = messageWithOperatorText`To fix, review and apply them, then run the exchange again:`;
  const command = messageWithOperatorText`  ${operatorSuppliedText(
    applyCommand(paths),
  )}`;
  return notTaken(
    keepFirstPartyLinesWithOperatorText(
      new OperatorConfigError(
        `${refused.text}\n${toFix.text}\n${command.text}`,
      ),
      [refused, toFix, command],
    ),
    change.delta,
    true,
  );
}

/**
 * `refusal`, recorded as ending its run on `delta`, and tagged as stating its
 * own next step: a terms change is settled by the operator or the partner, so
 * the retry the generic post-rotation advisory prescribes cannot succeed.
 */
function notTaken<E extends Error>(
  refusal: E,
  delta: TermsDelta,
  proposalWritten = false,
): E {
  const tagged = markStatesItsOwnNextStep(refusal);
  recordTermsChangeNotTaken(tagged, { delta, proposalWritten });
  return tagged;
}

/**
 * The `onTermsChange` an `alcove exchange` run passes to core. Shows the
 * change, then:
 *
 * - `interactive` and the change can continue this run: refuses without
 *   asking where `configPath` would not load with the partner's terms
 *   written into it; otherwise asks, and on yes writes them through the
 *   write `alcove apply` makes (`termsUpdateWrite`) and resolves, so the run
 *   continues under them. A no refuses, and nothing is written.
 * - otherwise: writes the partner's terms as a terms update beside the
 *   configuration ({@link termsProposalPath}), authenticated under the
 *   shared secret in `keyPath`, and refuses naming the `alcove apply`
 *   command that applies it.
 *
 * Each refusal is an {@link OperatorConfigError} composed of this party's own
 * paths, a configuration key, and fixed text: exit 64, event category
 * `config`.
 */
export function termsChangeHandler(params: {
  configPath: string;
  keyPath: string;
  interactive: boolean;
  log: ReturnType<typeof getLogger>;
  logFile: string | undefined;
}): (change: TermsChange) => Promise<void> {
  const { configPath, keyPath, interactive, log, logFile } = params;
  return async (change) => {
    const emit = consentSurfaceSink({
      log,
      logFile,
      toPromptStream: interactive,
      level: interactive ? "info" : "warn",
    });
    displayTermsChange(emit, configPath, change);
    const shownConfig = redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    );

    if (interactive && change.continuable) {
      // The partner's deduplicate stays under the record the operator last
      // applied.
      const write: TermsUpdateWrite = {
        ...termsUpdateWrite({
          linkageTerms: change.adoptedTerms,
          expectedPartnerDeduplicate: change.partnerTerms.deduplicate,
          invitationRelay: undefined,
        }),
        expectedPartnerDeduplicate: "unchanged",
      };
      const invalidTerm = termsUpdateInvalidTerm(configPath, write);
      if (invalidTerm !== undefined) {
        const message = messageWithOperatorText`your partner's linkage terms would leave ${operatorSuppliedText(
          configPath,
        )} unable to load (its ${invalidTerm} term would be invalid), so the exchange stopped before any linkage key or data moved and the file was not changed. Ask your partner about the change.`;
        throw notTaken(
          keepOperatorSuppliedText(
            new OperatorConfigError(message.text),
            message,
          ),
          change.delta,
        );
      }
      const accepted = await promptConfirm(
        `Accept your partner's terms, write them to ${shownConfig}, and continue this exchange?`,
      );
      if (!accepted) {
        const message = messageWithOperatorText`you did not accept your partner's changed linkage terms, so the exchange stopped before any linkage key or data moved and ${operatorSuppliedText(
          configPath,
        )} was not changed. Run the exchange again to be asked again, or ask your partner about the change.`;
        throw notTaken(
          keepOperatorSuppliedText(
            new OperatorConfigError(message.text),
            message,
          ),
          change.delta,
        );
      }
      persistTermsUpdate(configPath, write);
      log.info(
        `wrote your partner's linkage terms to ${shownConfig}; the exchange continues under them.`,
      );
      return;
    }

    const proposalPath = termsProposalPath(configPath);
    const proposal = await encodeTermsUpdate(
      { linkageTerms: change.partnerTerms },
      readPartnershipSecret(keyPath),
    );
    writeFileOwnerOnly(proposalPath, `${proposal}\n`);
    throw proposalRefusal(change, {
      configPath,
      keyPath,
      proposalPath,
    });
  };
}

/**
 * The `onPayloadReceiveFill` an attended run passes to core, or `undefined`
 * for an unattended one, which takes the partner's declared columns without
 * asking. Shows the columns against the empty receive set the configuration
 * lists, the way {@link displayTermsChange} shows a change, and asks whether
 * to take them. A yes accepts, and a run with a `configPath` records them
 * there as `payload.receive` through its fill -- a zero-setup `--save` run
 * (`configSavedAfterExchange`) in the configuration it saves when the exchange
 * completes; a zero-setup run without `--save` has none and records nothing. A
 * no declines with an {@link OperatorConfigError} (exit 64, event category
 * `config`) and records no receive columns.
 */
export function payloadReceiveFillConfirmation(params: {
  configPath: string | undefined;
  configSavedAfterExchange?: boolean;
  interactive: boolean;
  log: ReturnType<typeof getLogger>;
  logFile: string | undefined;
}): ((columns: string[]) => Promise<PayloadReceiveFillAnswer>) | undefined {
  const { configPath, interactive, log, logFile } = params;
  const savedAfterExchange = params.configSavedAfterExchange === true;
  if (!interactive) return undefined;
  return async (columns) => {
    const emit = consentSurfaceSink({ log, logFile, toPromptStream: true });
    const delta: TermsDelta = {
      received: { added: columns, removed: [] },
      sent: undefined,
      partnerDeduplicate: undefined,
      otherTerms: [],
    };
    const shownConfig =
      configPath === undefined
        ? undefined
        : redactAndRenderOperatorSuppliedText(operatorSuppliedText(configPath));
    displayTermsDelta(
      emit,
      shownConfig === undefined || savedAfterExchange
        ? "Your partner's linkage terms declare payload columns it sends you:"
        : `Your partner's linkage terms declare payload columns it sends you, and ${shownConfig} lists none you receive (linkage_terms.payload.receive):`,
      delta,
    );
    const accepted = await promptConfirm(
      shownConfig === undefined
        ? "Receive these columns and continue this exchange?"
        : savedAfterExchange
          ? `Receive these columns, record them as linkage_terms.payload.receive in the configuration this run saves to ${shownConfig} when the exchange completes, and continue this exchange?`
          : `Receive these columns, write them to ${shownConfig} as linkage_terms.payload.receive, and continue this exchange?`,
    );
    if (accepted) return { accepted: true };
    if (configPath === undefined)
      return {
        accepted: false,
        refusal: notTaken(
          new OperatorConfigError(
            "you did not accept the payload columns your partner declares it " +
              "sends you, so the exchange stopped before sending any of your " +
              "linkage keys or data. Run the exchange again to be asked " +
              "again, or ask your partner about the columns.",
          ),
          delta,
        ),
      };
    const message = messageWithOperatorText`you did not accept the payload columns your partner declares it sends you, so the exchange stopped before sending any of your linkage keys or data, and no columns you receive were recorded in ${operatorSuppliedText(
      configPath,
    )}. Run the exchange again to be asked again, or ask your partner about the columns.`;
    return {
      accepted: false,
      refusal: notTaken(
        keepOperatorSuppliedText(
          new OperatorConfigError(message.text),
          message,
        ),
        delta,
      ),
    };
  };
}

const PAYLOAD_RECEIVE_TAKEN_HEADING =
  "this unattended run took the payload columns your partner declares it sends you, without asking: ";

/** One copy of the notice, and how many columns its list names. */
interface PayloadReceiveTakenList {
  text: Displayable;
  shownColumns: number;
}

/** The sentence after the column list, naming `shownConfig` or none. */
function payloadReceiveTakenTail(shownConfig: Displayable | undefined): string {
  return shownConfig === undefined
    ? ". They were not written to any configuration."
    : `. They were written to ${shownConfig} as linkage_terms.payload.receive, and later exchanges refuse a partner that sends a different list.`;
}

/**
 * The notice with `columns` cut at a name boundary to the budget `tail`
 * leaves under `WARNING_MESSAGE_MAX_DISPLAY_LENGTH`.
 */
function composePayloadReceiveTaken(
  columns: readonly string[],
  tail: string,
): PayloadReceiveTakenList {
  const budget =
    WARNING_MESSAGE_MAX_DISPLAY_LENGTH -
    PAYLOAD_RECEIVE_TAKEN_HEADING.length -
    tail.length -
    DISPLAY_TRUNCATION_MARKER.length;
  let taken = "";
  let shownColumns = 0;
  for (const name of columns) {
    const quoted = `"${redactAndSanitizeForDisplay(name).replaceAll('"', '\\"')}"`;
    const next = taken === "" ? quoted : `${taken}, ${quoted}`;
    if (next.length > budget) {
      taken += DISPLAY_TRUNCATION_MARKER;
      break;
    }
    taken = next;
    shownColumns += 1;
  }
  // Every part is fixed copy or a value already rendered for display, and
  // quoting a name adds only printable ASCII to it.
  return {
    text: `${PAYLOAD_RECEIVE_TAKEN_HEADING}${taken}${tail}` as Displayable,
    shownColumns,
  };
}

/**
 * The line an unattended run writes when it takes the payload columns its
 * partner declares, in place of {@link payloadReceiveFillConfirmation}'s
 * question: each column taken, and the configuration `recordedIn` it was
 * written to as `payload.receive`, or that it was written to none. The
 * column names are the partner's: each is redacted and escaped on its own, so
 * a dangling private-key marker in one name cannot consume the names after
 * it, and a double quote inside a name is shown as `\"` so it cannot fake the
 * end of the quoted name. The list is cut at a name boundary, never inside an
 * escape, so the whole line stays within `WARNING_MESSAGE_MAX_DISPLAY_LENGTH`;
 * the path is the operator's.
 */
export function payloadReceiveTakenNotice(
  columns: readonly string[],
  recordedIn: string | undefined,
): Displayable {
  return composePayloadReceiveTaken(
    columns,
    payloadReceiveTakenTail(
      recordedIn === undefined
        ? undefined
        : redactAndRenderOperatorSuppliedText(operatorSuppliedText(recordedIn)),
    ),
  ).text;
}

/**
 * Report that this run filled `payload.receive` with `columns`, recorded in
 * the configuration `recordedIn` or in none. An unattended run that took at
 * least one column writes {@link payloadReceiveTakenNotice} through
 * `unattendedWriter`, the command's unfiltered writer
 * (`ConfiguredLogging.writePlainLine`), so the line shows at every
 * `--log-level`, and emits the notice on `eventStream` as a
 * `payloadReceiveTaken` warning whose message escapes the path, as every
 * event field is, and whose list is cut to the budget that escaped path
 * leaves, so it may name fewer columns than the line; any other fill
 * recorded in a configuration is logged at info.
 */
export function reportPayloadReceiveFill(params: {
  columns: readonly string[];
  recordedIn: string | undefined;
  unattendedWriter: ((line: string) => void) | undefined;
  eventStream: EventStreamEmitter | undefined;
  log: { info: (message: string) => void };
}): void {
  const { columns, recordedIn, unattendedWriter, eventStream, log } = params;
  if (unattendedWriter !== undefined && columns.length > 0) {
    unattendedWriter(payloadReceiveTakenNotice(columns, recordedIn));
    if (eventStream !== undefined) {
      const event = composePayloadReceiveTaken(
        columns,
        payloadReceiveTakenTail(
          recordedIn === undefined
            ? undefined
            : redactAndSanitizeForDisplay(recordedIn),
        ),
      );
      eventStream.payloadReceiveTaken(
        event.text,
        columns.slice(0, event.shownColumns),
        columns.length,
      );
    }
    return;
  }
  if (recordedIn !== undefined)
    log.info(
      sanitizeForDisplay(payloadReceiveFilledNotice(columns), {
        maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
      }),
    );
}
