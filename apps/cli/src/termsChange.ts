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
  termsDeltaSections,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type { ExchangeSpec, getLogger, TermsChange } from "@alcove/core";

import { termsUpdateWrite } from "./acceptedTermsRecords";
import {
  DEFAULT_CONFIG_PATH,
  persistTermsUpdate,
  termsUpdateInvalidTerm,
  type TermsUpdateWrite,
} from "./config";
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

/**
 * Show how the partner's terms differ from the configuration's, in the
 * sections every front end shows (`termsDeltaSections`). Every name and value
 * is the partner's and is escaped here.
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
  for (const section of termsDeltaSections(change.delta)) {
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
 * paths, marked as theirs.
 */
function proposalRefusal(
  change: TermsChange,
  paths: { configPath: string; keyPath: string; proposalPath: string },
): OperatorConfigError {
  const message = messageWithOperatorText`${change.continuable ? UNATTENDED_REFUSAL : NOT_CONTINUABLE_REFUSAL} Your partner's terms were written to ${operatorSuppliedText(
    paths.proposalPath,
  )}. Review and apply them, then run the exchange again:\n  ${operatorSuppliedText(
    applyCommand(paths),
  )}`;
  const refusal = keepOperatorSuppliedText(
    new OperatorConfigError(message.text),
    message,
  );
  recordTermsChangeNotTaken(refusal, {
    delta: change.delta,
    proposalWritten: true,
  });
  return refusal;
}

/** `refusal`, recorded as ending its run on `change` with no proposal written. */
function notTaken<E extends Error>(refusal: E, change: TermsChange): E {
  recordTermsChangeNotTaken(refusal, {
    delta: change.delta,
    proposalWritten: false,
  });
  return refusal;
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
      const partnerSend = change.partnerTerms.payload?.send;
      // The change is to what the partner sends and the agreed terms; what
      // this party sends stays under the consent record it already holds, and
      // the partner's deduplicate under the record the operator last applied.
      const write: TermsUpdateWrite = {
        ...termsUpdateWrite(
          {
            linkageTerms: change.adoptedTerms,
            expectedPayloadColumns: partnerSend?.map(({ name }) => name),
            expectedPartnerDeduplicate: change.partnerTerms.deduplicate,
            invitationRelay: undefined,
          },
          existing,
        ),
        expectedPartnerDeduplicate: "unchanged",
        outboundPayloadConsent: existing.outboundPayloadConsent,
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
          change,
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
          change,
        );
      }
      persistTermsUpdate(configPath, write);
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
    throw proposalRefusal(change, {
      configPath,
      keyPath,
      proposalPath,
    });
  };
}
