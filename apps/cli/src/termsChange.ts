/**
 * What `alcove exchange` does when its partner's linkage terms differ from
 * its configuration's at the terms exchange: show how they differ, and either
 * take them on -- written into the configuration, the run continuing under
 * them -- or refuse, writing them beside the configuration as a terms update
 * `alcove apply` reads.
 */

import path from "node:path";

import {
  encodeTermsUpdate,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  OperatorConfigError,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type {
  ExchangeSpec,
  getLogger,
  PayloadColumnsChange,
  TermsChange,
} from "@alcove/core";

import { termsUpdateWrite } from "./acceptedTermsRecords";
import { DEFAULT_CONFIG_PATH, persistTermsUpdate } from "./config";
import { writeFileOwnerOnly } from "./fileUtils";
import {
  consentSurfaceSink,
  type ConsentSurfaceSink,
} from "./invitationDisplay";
import { DEFAULT_KEY_PATH } from "./keyFile";
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
function applyCommand(paths: {
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

function columnLines(
  emit: ConsentSurfaceSink,
  label: string,
  columns: ReadonlyArray<string>,
): void {
  if (columns.length === 0) return;
  emit(`  ${label}:`);
  for (const column of columns)
    emit(`    ${redactAndSanitizeForDisplay(column)}`);
}

function directionLines(
  emit: ConsentSurfaceSink,
  change: PayloadColumnsChange | undefined,
  labels: { added: string; removed: string },
): void {
  if (change === undefined) return;
  columnLines(emit, labels.added, change.added);
  columnLines(emit, labels.removed, change.removed);
}

/**
 * Show how the partner's terms differ from the configuration's: the columns
 * the partner sends, the columns this party sends, and each other term. Every
 * name and value is the partner's and is escaped here.
 */
export function displayTermsChange(
  emit: ConsentSurfaceSink,
  configPath: string,
  change: TermsChange,
): void {
  emit(
    `Your partner's linkage terms differ from those in ${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}:`,
  );
  directionLines(emit, change.delta.received, {
    added: "columns your partner now sends you",
    removed: "columns your partner no longer sends you",
  });
  directionLines(emit, change.delta.sent, {
    added: "columns you now send your partner (your partner accepts these)",
    removed:
      "columns you no longer send your partner (your partner accepts this)",
  });
  if (change.delta.otherTerms.length > 0) {
    emit("  other terms that differ:");
    for (const difference of change.delta.otherTerms)
      emit(
        `    ${redactAndSanitizeForDisplay(difference, {
          maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
        })}`,
      );
  }
}

const UNATTENDED_REFUSAL =
  "this run is not attended (no terminal on stdin), so it did not take on " +
  "your partner's changed linkage terms and stopped before any linkage key " +
  "or data moved.";

const NOT_CONTINUABLE_REFUSAL =
  "your partner's linkage terms change the linkage fields, keys, algorithm, " +
  "strategy, output direction, or version, which this run was prepared " +
  "under, so it stopped before any linkage key or data moved.";

/**
 * The refusal of a change this run did not take on, naming the operator's own
 * paths, marked as theirs.
 */
function proposalRefusal(
  continuable: boolean,
  paths: { configPath: string; keyPath: string; proposalPath: string },
): OperatorConfigError {
  const message = messageWithOperatorText`${continuable ? UNATTENDED_REFUSAL : NOT_CONTINUABLE_REFUSAL} Your partner's terms were written to ${operatorSuppliedText(
    paths.proposalPath,
  )}. Review and apply them, then run the exchange again:\n  ${operatorSuppliedText(
    applyCommand(paths),
  )}`;
  return keepOperatorSuppliedText(
    new OperatorConfigError(message.text),
    message,
  );
}

/**
 * The `onTermsChange` an `alcove exchange` run passes to core. Shows the
 * change, then:
 *
 * - `interactive` and the change can continue this run: asks, and on yes
 *   writes the partner's terms into `configPath` through the write
 *   `alcove apply` makes (`termsUpdateWrite`) and resolves, so the run
 *   continues under them. A no refuses, and nothing is written.
 * - otherwise: writes the partner's terms as a terms update beside the
 *   configuration ({@link termsProposalPath}), authenticated under the
 *   shared secret in `keyPath`, and refuses naming the `alcove apply`
 *   command that applies it.
 *
 * Each refusal is an {@link OperatorConfigError} composed of this party's own
 * paths and fixed text: exit 64, event category `config`.
 */
export function termsChangeHandler(params: {
  configPath: string;
  keyPath: string;
  existing: Pick<
    ExchangeSpec,
    "metadata" | "disclosedPayloadColumns" | "outboundPayloadConsent"
  >;
  interactive: boolean;
  log: ReturnType<typeof getLogger>;
  logFile: string | undefined;
}): (change: TermsChange) => Promise<void> {
  const { configPath, keyPath, existing, interactive, log, logFile } = params;
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
      const accepted = await promptConfirm(
        `Accept your partner's terms, write them to ${shownConfig}, and continue this exchange?`,
      );
      if (!accepted) {
        const message = messageWithOperatorText`you did not accept your partner's changed linkage terms, so the exchange stopped before any linkage key or data moved and ${operatorSuppliedText(
          configPath,
        )} was not changed. Run the exchange again to be asked again, or ask your partner about the change.`;
        throw keepOperatorSuppliedText(
          new OperatorConfigError(message.text),
          message,
        );
      }
      const partnerSend = change.partnerTerms.payload?.send;
      // The change is to what the partner sends and the agreed terms; what
      // this party sends stays under the consent record it already holds.
      persistTermsUpdate(configPath, {
        ...termsUpdateWrite(
          {
            linkageTerms: change.adoptedTerms,
            expectedPayloadColumns: partnerSend?.map(({ name }) => name),
            expectedPartnerDeduplicate: change.partnerTerms.deduplicate,
            invitationRelay: undefined,
          },
          existing,
        ),
        outboundPayloadConsent: existing.outboundPayloadConsent,
      });
      log.info(
        `wrote your partner's linkage terms to ${shownConfig}; the exchange continues under them.`,
      );
      return;
    }

    const proposalPath = termsProposalPath(configPath);
    const partnerSend = change.partnerTerms.payload?.send;
    const proposal = await encodeTermsUpdate(
      {
        linkageTerms: change.partnerTerms,
        ...(partnerSend !== undefined
          ? { disclosedPayloadColumns: partnerSend.map(({ name }) => name) }
          : {}),
      },
      readPartnershipSecret(keyPath),
    );
    writeFileOwnerOnly(proposalPath, `${proposal}\n`);
    throw proposalRefusal(change.continuable, {
      configPath,
      keyPath,
      proposalPath,
    });
  };
}
