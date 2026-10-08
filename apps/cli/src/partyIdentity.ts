import {
  PLACEHOLDER_IDENTITY,
  UsageError,
  unnamedPartyIdentity,
} from "@alcove/core";

import { promptFreeText, writePromptLine } from "./util/prompt";

/** How every refusal here tells the operator to supply the label. */
const IDENTITY_FLAG_HELP = '--identity "name, org, contact"';

/** Why an identity is never invented, stated once for both refusals. */
const PARTNER_READS_IT =
  "The identity is the name your partner reads in the agreed linkage terms";

export { PLACEHOLDER_IDENTITY };

/**
 * A typed label as it enters linkage terms: NFC-normalized, the form parties
 * compare free text in, then trimmed, so one typed name is one string in the
 * agreed terms and in the identity a signing certificate is authorized against.
 */
function normalizeSuppliedIdentity(identity: string | undefined): string {
  return identity?.normalize("NFC").trim() ?? "";
}

/**
 * The refusal every `--identity` path raises when the flag holds the template
 * placeholder rather than a name.
 */
export const IDENTITY_STILL_PLACEHOLDER =
  `"${PLACEHOLDER_IDENTITY}" is the placeholder alcove init writes where a ` +
  "name belongs, so it is refused exactly as no identity at all. " +
  `Pass ${IDENTITY_FLAG_HELP} naming this party. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The clause ending every refusal that reads the label from a configuration
 * file: that file supplies the terms of every later run, so a flag given once
 * would name the party differently here than everywhere after.
 */
const FLAG_CANNOT_STAND_IN =
  `${IDENTITY_FLAG_HELP} cannot stand in, because the configuration persists ` +
  "unchanged and is what every exchange under this partnership sends.";

/**
 * The refusal a command raises when no identity was supplied for a run that
 * authors its own linkage terms.
 */
export const IDENTITY_REQUIRED =
  `no identity for this party: pass ${IDENTITY_FLAG_HELP}. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The refusal {@link resolveInvitationIdentity} raises. The path is composed
 * raw and escaped once at the display sink: CONTRIBUTING.md, Operator-facing
 * escaping.
 */
export function configuredIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    `linkage_terms.identity, and it is the source of this invitation's terms. ` +
    `${PARTNER_READS_IT}, so set it there -- ${FLAG_CANNOT_STAND_IN}`
  );
}

/**
 * The refusal {@link resolveKeptConfigurationIdentity} raises. The path is
 * composed raw, as in {@link configuredIdentityRequired}.
 */
export function keptConfigurationIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    "linkage_terms.identity, and this acceptance keeps that configuration " +
    `rather than writing one. ${PARTNER_READS_IT}, so set it there -- ` +
    FLAG_CANNOT_STAND_IN
  );
}

/**
 * The refusal every configured-label resolver raises when the configuration
 * still holds the template placeholder. The path is composed raw, as in
 * {@link configuredIdentityRequired}.
 */
export function configuredIdentityStillPlaceholder(configPath: string): string {
  return (
    `linkage_terms.identity in ${configPath} is still ` +
    `"${PLACEHOLDER_IDENTITY}", the placeholder alcove init writes where a ` +
    "name belongs, so it is refused exactly as an absent one. " +
    `${PARTNER_READS_IT}, so replace it there with this party's name, ` +
    `organization, and contact -- ${FLAG_CANNOT_STAND_IN}`
  );
}

/**
 * This party's identity label for a command that authors its own linkage
 * terms: the normalized `--identity` value, with no fallback to system state
 * such as the account name. Blank and {@link PLACEHOLDER_IDENTITY} are
 * refused: docs/EXCHANGE_REFERENCE.md#linkage_termsidentity.
 */
export function resolveIdentity(identity: string | undefined): string {
  const chosen = normalizeSuppliedIdentity(identity);
  if (chosen.length === 0) throw new UsageError(IDENTITY_REQUIRED);
  if (unnamedPartyIdentity(chosen) === "placeholder")
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * This party's identity label for a run that may go unnamed: the normalized
 * `--identity` value, or `undefined` when blank. {@link PLACEHOLDER_IDENTITY}
 * is refused rather than dropped, since the operator typed it as a name.
 */
export function optionalIdentity(
  identity: string | undefined,
): string | undefined {
  const chosen = normalizeSuppliedIdentity(identity);
  if (chosen.length === 0) return undefined;
  if (unnamedPartyIdentity(chosen) === "placeholder")
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * The line shown above either identity question; the same sentence the
 * refusals end on.
 */
export const IDENTITY_PROMPT_PREAMBLE = `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The question `alcove init` asks, where a blank answer writes
 * {@link PLACEHOLDER_IDENTITY} into the template for hand-editing.
 */
export const INIT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact), or blank to fill in " +
  "by hand later:";

/**
 * The question `alcove accept` asks; an acceptance will not proceed unnamed
 * ({@link IDENTITY_REQUIRED}).
 */
export const ACCEPT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact):";

/**
 * Ask for this party's identity at the terminal and return the raw answer.
 * Both lines go to the prompt stream, not a logger, so `--log-level` and
 * `--log-file` cannot hide them. The caller decides whether asking is possible.
 */
export function askIdentityAtPrompt(question: string): Promise<string> {
  writePromptLine(IDENTITY_PROMPT_PREAMBLE);
  return promptFreeText(question);
}

/**
 * This party's label from `--identity`, else from `ask` when given, each under
 * {@link optionalIdentity}; `undefined` where neither names this party.
 */
export async function identityFromFlagOrPrompt(
  identity: string | undefined,
  ask: (() => Promise<string>) | undefined,
): Promise<string | undefined> {
  const supplied = optionalIdentity(identity);
  if (supplied !== undefined || ask === undefined) return supplied;
  return optionalIdentity(await ask());
}

/**
 * This party's identity label for an invitation minted from a saved
 * configuration: its `linkage_terms.identity`, refused where blank or the
 * placeholder. Returned untrimmed, since a certificate authorizes the exact
 * string every later `alcove exchange` reads from the same file.
 */
export function resolveInvitationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    configuredIdentityRequired,
  );
}

/**
 * This party's identity label for an acceptance that keeps the configuration
 * already at the path: that file's `linkage_terms.identity`, treated as
 * {@link resolveInvitationIdentity} treats it.
 */
export function resolveKeptConfigurationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    keptConfigurationIdentityRequired,
  );
}

/**
 * The refusal {@link resolveTermsUpdateIdentity} raises. The path is composed
 * raw, as in {@link configuredIdentityRequired}.
 */
export function termsUpdateIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    "linkage_terms.identity, and a terms update names each party by the " +
    `identity its configuration holds. ${PARTNER_READS_IT}, so set it there ` +
    "and run the command again."
  );
}

/**
 * This party's identity label for `alcove update` and `alcove apply`: the
 * configuration's own `linkage_terms.identity`, refused where blank or still
 * the placeholder, as {@link resolveInvitationIdentity} refuses it.
 */
export function resolveTermsUpdateIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    termsUpdateIdentityRequired,
  );
}

/**
 * The body the configured-label resolvers share; `required` is each command's
 * refusal for an absent label.
 */
function resolveConfiguredIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
  required: (configPath: string) => string,
): string {
  const unnamed = unnamedPartyIdentity(configuredIdentity);
  if (unnamed === "absent" || configuredIdentity === undefined)
    throw new UsageError(required(configPath));
  if (unnamed === "placeholder")
    throw new UsageError(configuredIdentityStillPlaceholder(configPath));
  return configuredIdentity;
}
