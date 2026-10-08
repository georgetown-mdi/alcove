/**
 * The pure decision half of the "manage this exchange" offer made at invite
 * creation (the inviter) and at accept (the acceptor): it composes the fields a
 * managed-exchange deposit needs from what each completion screen already has,
 * derives the offer's copy, and keeps the offer's progress value. The deposit
 * itself runs in the components, through {@link createManagedExchange}.
 *
 * Deposit shape and composition rules: docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "Record shape". Declining leaves no record, so a caller that declines never
 * composes.
 */

import { MAX_TEXT_LENGTH, MAX_TOKEN_MAX_AGE_DAYS } from "@alcove/core";

import { NOTE_CONTROL_CHAR_PATTERN } from "@jobContract/intentSchemas";
import { RETENTION_NOTE_PROBLEM } from "@psi/receiptsModel";
import { maxAgeDaysError } from "@psi/tokenMaxAge";

import {
  MAX_LABEL_LENGTH,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import { rotationWriteBack } from "@psi/managed/managedRunRotate";

import type {
  ExchangeSpec,
  Metadata,
  Standardization,
  WebRTCEndpoint,
  WebRTCExchangeLocator,
} from "@alcove/core";
import type {
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { AlertContent } from "@components/csvIntake";

/** The deposit's progress, driven by the host that owns the store write. */
export type ManageOfferStatus = "idle" | "depositing" | "deposited" | "error";

/**
 * The offer's whole host-held state. A refusal is representable only beside
 * `error`, so a reset cannot clear the progress and leave a refusal disabling
 * the deposit with nothing on screen to explain it.
 */
export type ManageOfferState =
  | { status: Exclude<ManageOfferStatus, "error">; refusal?: undefined }
  | { status: "error"; refusal?: AlertContent };

/** The offer's state before any deposit, and the value every path that abandons
 * or restarts an exchange resets to. */
export const MANAGE_OFFER_IDLE: ManageOfferState = { status: "idle" };

/**
 * The credential-free {@link WebRTCExchangeLocator} the managed record's
 * connection block is composed from, out of the invitation's webrtc endpoint
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block:
 * credential-free by composition"). An absent optional is dropped, since the
 * composer's strict parse rejects `undefined`; the relay is kept so a
 * scheduled re-run uses the relay the invitation named.
 */
export function webrtcLocatorFromEndpoint(
  endpoint: WebRTCEndpoint,
): WebRTCExchangeLocator {
  return {
    channel: "webrtc",
    host: endpoint.host,
    ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
    ...(endpoint.path !== undefined ? { path: endpoint.path } : {}),
    ...(endpoint.relay !== undefined ? { relay: endpoint.relay } : {}),
  };
}

/** The record schema's label cap, re-exported for the offer component. */
export { MAX_LABEL_LENGTH };

/** The record schema's max-token-age cap in days, re-exported for the offer
 * component. */
export { MAX_TOKEN_MAX_AGE_DAYS };

/** This party's exchange-file document minus the connection, which is supplied
 * separately as a webrtc locator. */
export interface ManagedExchangeDocumentParts {
  /**
   * This party's side, and the deposit's one statement of it:
   * {@link buildManagedDeposit} records this same value as the record's `side`,
   * so a deposit cannot store one side with the other side's document.
   */
  side: ManagedExchangeSide;
  /** This party's linkage terms -- the inviter's minted terms, or the acceptor's
   * derived perspective (identity replaced, output/payload mirrored). */
  linkageTerms: ExchangeSpec["linkageTerms"];
  /** This party's edited column metadata, when authored. */
  metadata?: Metadata;
  /** This party's per-party standardization, when authored. */
  standardization?: Standardization;
  /**
   * The acceptor's record of the invitation's `linkageTerms.deduplicate`, so a
   * managed re-run refuses an inviter presenting anything else, as the CLI
   * accept persists it. The inviter omits it.
   */
  expectedPartnerDeduplicate?: boolean;
  /** This party's own-columns output choice from the mint, kept verbatim. */
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  /** The field delimiter this party's file was read by at the file step, kept
   * verbatim; absent where the operator left it to detection. */
  csvDelimiter?: ExchangeSpec["csvDelimiter"];
  /** This party's retention note, never sent; absent where the operator wrote
   * none. */
  retentionDisposition?: ExchangeSpec["retentionDisposition"];
}

/**
 * Compose this party's persisted exchange-file document from its parts and the
 * credential-free webrtc locator. `expectedPartnerDeduplicate` is copied verbatim,
 * never re-derived; `false` is preserved and only an absent field is omitted.
 *
 * @throws {ZodError} if the assembled document fails schema validation (a
 *   malformed locator, an out-of-range port).
 */
export function composeManagedDocument(
  parts: ManagedExchangeDocumentParts,
  connection: WebRTCExchangeLocator,
): ExchangeSpec {
  return composeManagedExchangeFile({
    connection,
    linkageTerms: parts.linkageTerms,
    ...(parts.metadata !== undefined ? { metadata: parts.metadata } : {}),
    ...(parts.standardization !== undefined
      ? { standardization: parts.standardization }
      : {}),
    ...(parts.expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate: parts.expectedPartnerDeduplicate }
      : {}),
    ...(parts.includeOwnColumns !== undefined
      ? { includeOwnColumns: parts.includeOwnColumns }
      : {}),
    ...(parts.csvDelimiter !== undefined
      ? { csvDelimiter: parts.csvDelimiter }
      : {}),
    ...(parts.retentionDisposition !== undefined
      ? { retentionDisposition: parts.retentionDisposition }
      : {}),
  });
}

/** The operator's choices on the manage offer. The schedule is set later, on
 * the exchange's own page (see {@link ./scheduleEntryModel.ts}). */
export interface ManageOfferChoices {
  /** The operator-supplied display label for the partnership. */
  label: string;
  /** The opt-in max-token-age policy in whole days; `undefined` is no bound. */
  tokenMaxAgeDays?: number;
  /** The retention note as {@link retentionNoteValue} resolves it. */
  retentionDisposition?: string;
}

/** Everything a completion screen supplies to turn the offer into a deposit. */
export interface ManagedDepositInputs {
  /** This party's document parts, including its `side`. */
  documentParts: ManagedExchangeDocumentParts;
  /** The locator the document's connection block is composed from. */
  connection: WebRTCExchangeLocator;
  /** The shared secret the completed run's handshake rotated to, stored as the
   * record's live secret. */
  rotatedSecret: string;
  /** The operator's label, opt-in max-age policy, and retention note. */
  choices: ManageOfferChoices;
}

/**
 * Assemble the {@link NewManagedExchange} fields a deposit persists, composing
 * the document here so the record's `side` comes from the same parts. The label
 * is stored verbatim; the record schema enforces its cap at the store write.
 * Opting into a max-age policy stamps `expires` through
 * {@link rotationWriteBack}; opting out leaves both fields absent
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` row).
 *
 * @param now The instant the max-age stamp counts from.
 * @throws {RangeError} (from {@link rotationWriteBack}) if `tokenMaxAgeDays` is
 *   not a positive integer or stamps an expiry outside the representable range.
 * @throws {ZodError} (from {@link composeManagedDocument}) if the composed
 *   document fails schema validation.
 */
export function buildManagedDeposit(
  inputs: ManagedDepositInputs,
  now: number,
): NewManagedExchange {
  const { tokenMaxAgeDays } = inputs.choices;
  const stamp = rotationWriteBack(inputs.rotatedSecret, tokenMaxAgeDays, now);
  return {
    label: inputs.choices.label,
    exchangeFile: composeManagedDocument(
      {
        ...inputs.documentParts,
        ...(inputs.choices.retentionDisposition !== undefined
          ? { retentionDisposition: inputs.choices.retentionDisposition }
          : {}),
      },
      inputs.connection,
    ),
    side: inputs.documentParts.side,
    sharedSecret: inputs.rotatedSecret,
    ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
    ...(stamp.expires !== null ? { expires: stamp.expires } : {}),
  };
}

/** Whether the label is within the cap the deposit enforces, so a component can
 * gate its action without catching the schema's throw. An empty label is
 * permitted. */
export function labelWithinCap(label: string): boolean {
  return label.length <= MAX_LABEL_LENGTH;
}

/** The opted-in max-age field's validation, re-exported for the offer
 * component. */
export { maxAgeDaysError };

/**
 * The cadence line shown when the operator sets a max-age policy, or
 * `undefined` when none is set (docs/MANAGED_EXCHANGE.md, "Expiry is its own
 * state, never routed through attack framing").
 */
export function maxAgeCadenceNote(
  tokenMaxAgeDays: number | undefined,
): string | undefined {
  if (tokenMaxAgeDays === undefined) return undefined;
  const days = tokenMaxAgeDays === 1 ? "1 day" : `${tokenMaxAgeDays} days`;
  return `This exchange must run or be renewed within ${days}, or its stored secret lapses and you re-invite your partner.`;
}

/** The operator guidance for the label field (docs/SECURITY_DESIGN.md,
 * "Metadata at rest: presence and shape"). */
export const LABEL_GUIDANCE =
  "Name the partnership so you recognize it later. The label is never sent, but three things show it: this browser's storage, which anyone reading it can see; the name of every results file, in a folder you choose and in a copy you download; and, if you turn on between-visit notifications, a notification your device may show on a locked screen or mirror to your other devices. Keep agreement numbers, contact details, and other sensitive counterparty information out of it.";

/** The problem a retention note holding a control character reports. */
export const RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM =
  "The retention note must not contain a control character (a NUL or an " +
  "ESC, for instance). A tab, a line break, or a carriage return is fine.";

/**
 * The field error for a retention note as typed, or `undefined` where it can be
 * saved. The length bound is the exchange document's; the control-character
 * rule is the console's, so a note one app accepts the other does too.
 */
export function retentionNoteError(note: string): string | undefined {
  const trimmed = note.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) return RETENTION_NOTE_PROBLEM;
  if (NOTE_CONTROL_CHAR_PATTERN.test(trimmed))
    return RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM;
  return undefined;
}

/** The retention note a document holds for the note as typed: trimmed, and
 * `undefined` where nothing is left. */
export function retentionNoteValue(note: string): string | undefined {
  const trimmed = note.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** What saving does and what it needs (docs/notes/managed-exchange-design.md,
 * "The automation goal and its platform envelope"). */
export const SAVE_OFFER_SCHEDULE_NOTE =
  "Once saved, it can run on a schedule you agree with your partner, in this " +
  "browser: the installed Alcove app must be open during each run window, or " +
  "you open this site and run it yourself.";
