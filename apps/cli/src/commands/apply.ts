import fs from "node:fs";
import path from "node:path";

import type { Argv, Arguments } from "yargs";

import {
  assertTermsRunnable,
  changedPartnerBoundTerms,
  compareTerms,
  decodeTermsUpdate,
  disclosedColumnNames,
  keepFirstPartyLinesWithOperatorText,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  ruleSetCitation,
  stripInvitationWhitespace,
  termsDeltaIsEmpty,
  TermsUpdateRefusedError,
  UsageError,
} from "@alcove/core";
import type {
  ExchangeSpec,
  LinkageRuleSetReference,
  LinkageTerms,
  PartnerBoundTerms,
  TermsDelta,
  TermsUpdate,
} from "@alcove/core";

import {
  deriveAcceptedInvitationTerms,
  termsUpdateWrite,
  type AcceptedInvitationTerms,
} from "../acceptedTermsRecords";
import { DEFAULT_CONFIG_PATH, persistTermsUpdate } from "../config";
import { expandTilde } from "../fileUtils";
import {
  consentSurfaceSink,
  displayInvitation,
  type ConsentSurfaceSink,
} from "../invitationDisplay";
import {
  addLoggingOptions,
  configFileFlag,
  keyFileFlag,
  UNCHANGED_KEY_FILE_DESCRIPTION,
} from "../optionDefinitions";
import { resolveTermsUpdateIdentity } from "../partyIdentity";
import {
  readPartnershipConfig,
  readPartnershipSecret,
} from "../termsUpdateFiles";
import {
  applyCommand,
  displayTermsDelta,
  termsProposalPath,
} from "../termsChange";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { runOrExit } from "../util/exit";
import { assertNoUnknownOptions, singleValue } from "../util/flags";
import {
  declarePositionals,
  positionalsBeforeDoubleDash,
  refuseSurplusPositionals,
} from "../util/positionals";
import { configureLogging, logLevelFlag } from "../util/logging";
import { promptConfirmOrClosed } from "../util/prompt";

const APPLY_USAGE = "[options] UPDATE";

/**
 * The refusal an apply gets when it would ask for consent to an update's
 * terms and standard input is not a terminal to ask at.
 */
export const APPLY_NEEDS_TERMINAL =
  "apply asks you to confirm the update's terms, and standard input is not " +
  "a terminal to ask at, so nothing was changed. Run it at a terminal (with " +
  "docker, add -it) to review the terms and answer, or pass " +
  "--consent-to-terms to consent to them in advance for an unattended run.";

export function builder(cmd: Argv): Argv {
  return addLoggingOptions(
    declarePositionals(
      cmd,
      { command: "apply", usage: APPLY_USAGE, optional: ["args"] },
      {
        // A terms update is base64url and may begin with `-`, so an unknown
        // `-`-leading token is taken as the positional, as accept takes an
        // invitation; a mistyped `--flag` is then refused by the handler.
        "unknown-options-as-args": true,
      },
    )
      .positional("args", {
        type: "string",
        array: true,
        describe: "UPDATE: the terms update, or an @path to a file holding it",
      })
      .usage(
        "Usage: $0 apply [options] UPDATE\n\n" +
          "Apply a terms update your partner made with 'alcove update' to\n" +
          "this party's configuration. The update is checked against the\n" +
          "shared secret in the key file, its terms are shown, and nothing is\n" +
          "written unless you confirm or pass --consent-to-terms. The key file\n" +
          "and the connection block are not changed.",
      )
      .option("config-file", {
        type: "string",
        describe: `this partnership's configuration, whose linkage terms the update replaces (default: ${DEFAULT_CONFIG_PATH})`,
      })
      .option("key-file", {
        type: "string",
        describe: UNCHANGED_KEY_FILE_DESCRIPTION,
      })
      // No short form, as on accept: skipping the confirmation takes an
      // explicit token, and `unknown-options-as-args` would make a
      // single-letter flag ambiguous with a `-`-leading update.
      .option("consent-to-terms", {
        type: "boolean",
        default: false,
        describe:
          "consent in advance to the update's terms, skipping the interactive " +
          "confirmation, so apply can run unattended or in a script. The " +
          "update's checks against the key file still run; review its terms " +
          "before using this.",
      }),
  );
}

/** The update argument, read from an `@path` where it names one. */
function readUpdateArgument(raw: string): string {
  let resolved: unknown;
  try {
    resolved = resolveAtSignRefs(raw);
  } catch (err) {
    throw new UsageError(
      `could not read the terms update from ${raw}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof resolved !== "string")
    throw new UsageError("the terms update must be a string");
  return stripInvitationWhitespace(resolved);
}

/** Whether `updateArgument` is an `@path` naming the file at `filePath`. */
function namesFile(updateArgument: string, filePath: string): boolean {
  return (
    updateArgument.startsWith("@") &&
    path.resolve(expandTilde(updateArgument.slice(1))) ===
      path.resolve(filePath)
  );
}

/**
 * The refusal an update the decode refused is reported as. A partnership
 * refusal names the terms proposal beside the configuration where there is
 * one: the exchange that wrote it rotated the shared secret, so an update
 * made before it no longer verifies.
 */
function refusalOf(
  err: TermsUpdateRefusedError,
  paths: { configPath: string; keyPath: string; updateArgument: string },
): UsageError {
  const unchanged = " Nothing was changed.";
  switch (err.check) {
    case "format":
      return new UsageError(
        `the terms update could not be read: ${err.message}.${unchanged} ` +
          "Ask your partner to run 'alcove update' again and send you its " +
          "whole output.",
      );
    case "partnership": {
      const refused = messageWithOperatorText`the terms update was refused by the partnership check: it was made under a shared secret other than the one in ${operatorSuppliedText(
        paths.keyPath,
      )}, so it is for a different partnership, or an exchange between you has replaced the secret since it was made.${unchanged}`;
      const askAgain =
        "your partner to run 'alcove update' again from the configuration " +
        "and key file they use with you.";
      const proposalPath = termsProposalPath(paths.configPath);
      if (
        !namesFile(paths.updateArgument, proposalPath) &&
        fs.existsSync(proposalPath)
      ) {
        const lines = [
          refused,
          messageWithOperatorText`To fix, apply the terms your last exchange with your partner wrote to ${operatorSuppliedText(
            proposalPath,
          )}:`,
          messageWithOperatorText`  ${operatorSuppliedText(
            applyCommand({ ...paths, proposalPath }),
          )}`,
          messageWithOperatorText`If those are not the terms you expect, ask ${askAgain}`,
        ];
        return keepFirstPartyLinesWithOperatorText(
          new UsageError(lines.map((line) => line.text).join("\n")),
          lines,
        );
      }
      const message = messageWithOperatorText`${refused} Ask ${askAgain}`;
      return keepOperatorSuppliedText(new UsageError(message.text), message);
    }
    case "authentication":
      return new UsageError(
        "the terms update was refused by the MAC check: it names this " +
          "partnership, but its content was changed after your partner " +
          `made it.${unchanged} Ask your partner to send it again.`,
      );
  }
}

/** A column list as the change summary shows it, one escaped name a line. */
function columnLines(
  label: string,
  columns: ReadonlyArray<string> | undefined,
  notStated: string,
): string[] {
  if (columns === undefined)
    return [`    ${label}: not stated -- ${notStated}`];
  if (columns.length === 0) return [`    ${label}: (none)`];
  return [
    `    ${label}:`,
    ...columns.map((column) => `      ${redactAndSanitizeForDisplay(column)}`),
  ];
}

function sameColumns(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

const RECEIVE_NOT_STATED =
  "the next exchange takes whatever columns your partner sends";
const SEND_NOT_STATED =
  "the next exchange sends the columns your metadata marks as payload";

/** The citation as the change summary shows it, each value escaped. */
function ruleSetLine(
  label: string,
  ruleSet: LinkageRuleSetReference | undefined,
): string {
  if (ruleSet === undefined) return `    ${label}: not stated`;
  const cite = ({ name, version }: { name: string; version: string }) =>
    ruleSetCitation(
      redactAndSanitizeForDisplay(name),
      redactAndSanitizeForDisplay(version),
    );
  return `    ${label}: ${cite(ruleSet.keySet)} over ${cite(ruleSet.fieldSet)}`;
}

function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** What applying an update changes in the configuration. */
interface UpdateChanges {
  delta: TermsDelta;
  before: LinkageTerms;
  after: LinkageTerms;
  /**
   * The partner-bound terms the write changes, a payload column's
   * description aside, including the ones the comparison skips.
   */
  changedTerms: Array<keyof PartnerBoundTerms>;
  /**
   * The partner's `deduplicate` the update records where the configuration
   * records none, which the comparison does not hold the partner to.
   */
  firstPartnerDeduplicate: boolean | undefined;
  /** Whether nothing the operator consents to changes. */
  none: boolean;
}

/**
 * The update's changes to the configuration: the terms as core compares
 * them against the partner's, the partner-bound terms the write changes, and
 * the partner's `deduplicate` this party records. A payload column's
 * description changes none of them.
 */
function updateChanges(
  existing: ExchangeSpec,
  update: TermsUpdate,
  accepted: AcceptedInvitationTerms,
): UpdateChanges {
  const { delta } = compareTerms(existing.linkageTerms, update.linkageTerms, {
    partnerDeduplicate: existing.expectedPartnerDeduplicate,
  });
  const changedTerms = changedPartnerBoundTerms(
    existing.linkageTerms,
    accepted.linkageTerms,
  );
  const firstPartnerDeduplicate =
    existing.expectedPartnerDeduplicate === undefined
      ? accepted.expectedPartnerDeduplicate
      : undefined;
  return {
    delta,
    before: existing.linkageTerms,
    after: accepted.linkageTerms,
    changedTerms,
    firstPartnerDeduplicate,
    none:
      termsDeltaIsEmpty(delta) &&
      changedTerms.length === 0 &&
      firstPartnerDeduplicate === undefined,
  };
}

const columnNames = (
  columns: ReadonlyArray<{ name: string }> | undefined,
): string[] | undefined => columns?.map(({ name }) => name);

/**
 * State what the update changes in the configuration, ahead of the terms it
 * adopts, in the sections every front end shows a terms change in. A change
 * the comparison does not show -- a rule-set citation only one side states,
 * the columns this party sends where the partner states none it receives,
 * the columns it receives where the configuration lists none -- is stated on
 * its own lines, and any other changed term by name. A received-column list
 * the update leaves unstated is shown as before and after lines, not as
 * columns removed, since the next exchange then takes whatever is sent.
 */
function displayChanges(
  emit: ConsentSurfaceSink,
  configPath: string,
  changes: UpdateChanges,
): void {
  const { before, after, changedTerms, firstPartnerDeduplicate } = changes;
  const sendBefore = columnNames(before.payload?.send);
  const sendAfter = columnNames(after.payload?.send);
  const receiveBefore = columnNames(before.payload?.receive);
  const receiveAfter = columnNames(after.payload?.receive);
  const receiveBecomesUnstated =
    receiveBefore !== undefined && receiveAfter === undefined;
  const delta: TermsDelta = receiveBecomesUnstated
    ? { ...changes.delta, received: undefined }
    : changes.delta;
  const showRuleSet =
    changedTerms.includes("linkageRuleSet") &&
    (before.linkageRuleSet === undefined || after.linkageRuleSet === undefined);
  const showSend =
    delta.sent === undefined && !sameColumns(sendBefore, sendAfter);
  const showReceive =
    delta.received === undefined && !sameColumns(receiveBefore, receiveAfter);
  const shown = new Set<string>([
    ...(showRuleSet ? ["linkageRuleSet"] : []),
    ...(showSend || showReceive ? ["payload"] : []),
  ]);
  const unnamed = termsDeltaIsEmpty(delta)
    ? changedTerms.filter((field) => !shown.has(field))
    : [];

  displayTermsDelta(
    emit,
    `Changes this update makes to ${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}:`,
    delta,
  );
  if (
    termsDeltaIsEmpty(delta) &&
    !showRuleSet &&
    !showSend &&
    unnamed.length === 0
  )
    emit("  linkage terms: no change");
  if (unnamed.length > 0)
    emit(`  other terms that change: ${unnamed.map(snakeCase).join(", ")}`);
  if (showRuleSet) {
    emit("  linkage rule set: change");
    emit(ruleSetLine("before", before.linkageRuleSet));
    emit(ruleSetLine("after", after.linkageRuleSet));
  }
  if (firstPartnerDeduplicate !== undefined)
    emit(
      `  your partner's deduplicate: recorded as ${String(firstPartnerDeduplicate)}`,
    );
  if (showSend) {
    emit("  columns you send: change");
    for (const line of columnLines("before", sendBefore, SEND_NOT_STATED))
      emit(line);
    for (const line of columnLines("after", sendAfter, SEND_NOT_STATED))
      emit(line);
  }
  if (showReceive) {
    emit("  columns you will receive: change");
    for (const line of columnLines("before", receiveBefore, RECEIVE_NOT_STATED))
      emit(line);
    for (const line of columnLines("after", receiveAfter, RECEIVE_NOT_STATED))
      emit(line);
  }
}

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("apply", async () => {
      const logFile = singleValue(argv, "log-file") as string | undefined;
      const { log, close } = configureLogging({
        logLevel: logLevelFlag(argv),
        logFile,
        name: "apply",
      });
      closeLogging = close;
      const positionals = (
        (argv["args"] as Array<unknown> | undefined) ?? []
      ).map(String);
      assertNoUnknownOptions(positionalsBeforeDoubleDash(argv, positionals));
      if (positionals.length === 0)
        throw new UsageError(
          `a terms update is required; usage: alcove apply ${APPLY_USAGE}`,
        );
      refuseSurplusPositionals(positionals.length, 1, "apply", APPLY_USAGE);
      const configPath = configFileFlag(argv);
      const keyPath = keyFileFlag(argv);
      const consentToTerms = argv["consent-to-terms"] === true;

      const existing = readPartnershipConfig(configPath);
      const identity = resolveTermsUpdateIdentity(
        existing.linkageTerms.identity,
        configPath,
      );
      const sharedSecret = readPartnershipSecret(keyPath);
      const encoded = readUpdateArgument(positionals[0] as string);

      // Verified before anything the update holds is shown or acted on.
      let update: TermsUpdate;
      try {
        update = await decodeTermsUpdate(encoded, sharedSecret);
      } catch (err) {
        if (err instanceof TermsUpdateRefusedError)
          throw refusalOf(err, {
            configPath,
            keyPath,
            updateArgument: positionals[0] as string,
          });
        throw err;
      }
      if (update.linkageTerms.identity === identity)
        throw new UsageError(
          "this terms update names your own identity as the party that " +
            `made it ("${identity}"), so it was made from your own ` +
            "configuration and applying it would swap your side of the " +
            "terms for your partner's. Nothing was changed. Send it to " +
            "your partner to apply instead.",
        );

      // This party's own side of the cardinality is kept: the update states
      // the sending party's side, recorded as expected_partner_deduplicate.
      const accepted = deriveAcceptedInvitationTerms(
        update,
        identity,
        existing.linkageTerms.deduplicate,
      );
      assertTermsRunnable(accepted.linkageTerms, existing);
      const write = termsUpdateWrite(accepted);

      const changes = updateChanges(existing, update, accepted);
      if (changes.none) {
        persistTermsUpdate(configPath, write);
        log.info(
          "the terms update changes no linkage term other than the date or " +
            "a payload column description, and states the deduplicate " +
            "already recorded for your partner, so it was applied to " +
            `${redactAndRenderOperatorSuppliedText(
              operatorSuppliedText(configPath),
            )} without asking. Your next 'alcove exchange' with this ` +
            "partner runs on the same terms.",
        );
        return;
      }

      // Refused, not read as a decline, so an unattended apply fails visibly.
      if (!consentToTerms && process.stdin.isTTY !== true)
        throw new UsageError(APPLY_NEEDS_TERMINAL);

      const consentSurface = consentSurfaceSink({
        log,
        logFile,
        toPromptStream: !consentToTerms,
      });
      displayChanges(consentSurface, configPath, changes);
      displayInvitation({
        token: update,
        ownOutboundSend:
          existing.metadata !== undefined
            ? disclosedColumnNames(existing.metadata)
            : undefined,
        emit: consentSurface,
        promptFollows: !consentToTerms,
        surface: "update",
      });
      if (consentToTerms) {
        log.info(
          "--consent-to-terms given: applying the update on advance consent " +
            "without the confirmation prompt.",
        );
      } else {
        const answer = await promptConfirmOrClosed(
          `Apply this update to ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(configPath),
          )}?`,
        );
        if (answer === "closed")
          throw new UsageError(
            "standard input closed before you answered, so the update was " +
              "not applied and the configuration was not changed. Run it " +
              "again at a terminal (with docker, add -it) and answer, or " +
              "pass --consent-to-terms to consent to the terms in advance.",
          );
        if (answer === "no") {
          consentSurface("update declined; the configuration was not changed");
          return;
        }
      }

      persistTermsUpdate(configPath, write);
      log.info(
        `applied the terms update to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configPath),
        )}: its linkage terms and the records that follow from them were ` +
          "rewritten, and its connection block and the key file were not " +
          "changed. Your next 'alcove exchange' with this partner runs on " +
          "the new terms.",
      );
    });
  } finally {
    closeLogging?.();
  }
}
