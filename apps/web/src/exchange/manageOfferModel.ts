/**
 * The pure decision half of the "manage this exchange" offer the console makes at
 * invite creation (the inviter) and at accept (the acceptor). It composes the
 * fields a managed-exchange deposit needs -- the credential-free webrtc locator,
 * this party's exchange-file document, the deposited secret, this party's `side`,
 * and the optional max-age policy -- from what each completion surface already
 * holds, and it derives the operator-facing copy (the label cap and the max-age
 * cadence line). It also holds the offer's progress value, which the host screen
 * keeps and the panel renders. No React, no IndexedDB: the deposit itself runs in
 * the components (through {@link createManagedExchange}), so the composition, the
 * progress value, and the decline discipline are unit-testable in Node.
 *
 * Deposit shape and composition rules are normative in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md: the record persists this party's whole
 * exchange-file document verbatim (no `authentication` block), composed from a
 * credential-free {@link WebRTCExchangeLocator} through the shared schema (see
 * {@link composeManagedExchangeFile}). The deposited secret is the one the
 * completed run's handshake rotated to; both parties derive the same value, so
 * either side's record authenticates the partnership's next run. Declining
 * leaves no record: the offer is skipped and the one-shot flow drops the rotated
 * secret with the run, so there is by design no "compose then throw away" path
 * here -- a caller that declines never composes.
 */

import { MAX_TEXT_LENGTH, MAX_TOKEN_MAX_AGE_DAYS } from "@alcove/core";

import { NOTE_CONTROL_CHAR_PATTERN } from "@jobs/intentSchemas";
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

/** The deposit's progress, driven by the host that owns the store write: `idle`
 * before the operator commits, `depositing` while the write is in flight,
 * `deposited` once the record lands, and `error` when the write failed. */
export type ManageOfferStatus = "idle" | "depositing" | "deposited" | "error";

/**
 * The offer's whole host-held state: the deposit's progress and, for an `error`,
 * what it was about when a column name explains it. One value rather than two,
 * so a reset cannot clear the progress and leave the refusal standing -- which
 * would disable the deposit with nothing on screen to explain it. A refusal is
 * representable only beside `error`, so no assignment can pair one with a
 * progress the operator would then be unable to explain.
 */
export type ManageOfferState =
  | { status: Exclude<ManageOfferStatus, "error">; refusal?: undefined }
  | { status: "error"; refusal?: AlertContent };

/** The offer's state before any deposit, and the value every path that abandons
 * or restarts an exchange resets to. */
export const MANAGE_OFFER_IDLE: ManageOfferState = { status: "idle" };

/**
 * Build the credential-free {@link WebRTCExchangeLocator} the managed record's
 * connection block is composed from, out of a webrtc {@link WebRTCEndpoint}. The
 * acceptor's endpoint is the invitation's own endpoint; the inviter's is the one
 * {@link webrtcEndpointFromAddress} built for the token from this app's signaling
 * address.
 * Both are already the invitation's `WebRTCEndpointSchema` shape (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block"); this only drops
 * an absent optional the composer's strict parse would otherwise reject as
 * `undefined`. The endpoint's relay is kept, and the composed connection holds
 * it as `invitation_relay`, so a scheduled re-run can use the relay the
 * invitation named.
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

/** The maximum operator label length, re-exported at the offer boundary so the
 * component enforces the same cap the record schema does (see
 * {@link MAX_LABEL_LENGTH}). */
export { MAX_LABEL_LENGTH };

/** The maximum max-token-age policy in days, re-exported at the offer boundary
 * so the component bounds its input at the same cap the record schema enforces
 * at write (core's {@link MAX_TOKEN_MAX_AGE_DAYS}). */
export { MAX_TOKEN_MAX_AGE_DAYS };

/** This party's own exchange-file substance at the completion surface, the parts
 * of the persisted document that are not the connection: the linkage terms this
 * party runs on (its own perspective), the optional per-party blocks, and the
 * payload-column commitments. The connection is supplied separately as a webrtc
 * locator, so this shape is transport-agnostic and identical for both sides. */
export interface ManagedExchangeDocumentParts {
  /**
   * This party's side of the partnership, and the deposit's ONE statement of it:
   * {@link buildManagedDeposit} composes the document from these parts and records
   * this same value as the record's `side`, so a deposit cannot store one side
   * while holding the other side's document.
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
   * This party's TERMS-side enforcement -- the acceptor supplies the invitation
   * token's `linkageTerms.deduplicate` (the value the invitation declared for the
   * INVITER's own side, and the one the consent screen stated), so a managed
   * re-run refuses an inviter presenting anything else at the terms exchange,
   * exactly as the CLI accept persists it. The inviter omits it: it accepted no
   * declaration, and its partner's side is the acceptor's own mirrored `false`.
   */
  expectedPartnerDeduplicate?: boolean;
  /**
   * Which of this party's own input columns its result file holds beside the
   * partner's values -- the value the mint decided against the terms it emitted
   * (`generateInvitation`), held verbatim so a scheduled re-run writes the file
   * the operator authored. Local: it moves no term, and the partner's own
   * result is untouched by it. Absent where the operator chose nothing, or
   * where the terms leave it nothing to act on.
   */
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  /**
   * The field delimiter this party read its own file by at the file step,
   * held verbatim so a scheduled re-run reads the same file the same way and
   * writes its result the same way. Local: it moves no term, and the
   * partner's own file is read by whatever that party chose. Absent where
   * the operator left the delimiter to detection.
   */
  csvDelimiter?: ExchangeSpec["csvDelimiter"];
  /**
   * This party's note on where its results are filed and how long they are
   * kept, written into its own exchange record at each run. Local: it is never
   * sent and moves no term. Absent where the operator wrote none.
   */
  retentionDisposition?: ExchangeSpec["retentionDisposition"];
}

/**
 * Compose this party's persisted exchange-file document from its own document
 * parts and the credential-free webrtc locator. The terms-side record
 * (`expectedPartnerDeduplicate`) is caller-supplied and held verbatim, never
 * re-derived, so the persisted record cannot disagree with the token's. `false`
 * is a real record and is preserved; only an absent field is omitted.
 *
 * Exported so the composition rules stay the tested boundary, even though
 * {@link buildManagedDeposit} is its only caller.
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

/** The operator's choices on the manage offer: the display label, whether to
 * opt into a max-age policy, and the retention note. The schedule is not among them, by design: it is a
 * cadence agreed with the partner out of band, which the operator decides once
 * they have the exchange in front of them, on its own page's local-fields editor
 * (see {@link ./scheduleEntryModel.ts}). */
export interface ManageOfferChoices {
  /** The operator-supplied display label for the partnership. */
  label: string;
  /** The operator's opt-in max-token-age policy in whole days, or `undefined`
   * for the default (no bound). */
  tokenMaxAgeDays?: number;
  /** The retention note as {@link retentionNoteValue} resolves it, or
   * `undefined` where the operator wrote none. */
  retentionDisposition?: string;
}

/** Everything a completion surface supplies to turn the offer into a deposit: the
 * parts of this party's document and the locator to compose it from, the
 * completed run's rotated secret, and the operator's choices. */
export interface ManagedDepositInputs {
  /** This party's document parts, holding the deposit's one statement of its
   * `side` (see {@link ManagedExchangeDocumentParts}). */
  documentParts: ManagedExchangeDocumentParts;
  /** The credential-free webrtc locator the document's connection block is
   * composed from (see {@link webrtcLocatorFromEndpoint}). */
  connection: WebRTCExchangeLocator;
  /** The shared secret the completed one-shot run's handshake rotated to (the
   * seat hook's `rotatedSecret`), stored as the record's live secret. */
  rotatedSecret: string;
  /** The operator's label, opt-in max-age policy, and retention note. */
  choices: ManageOfferChoices;
}

/**
 * Assemble the {@link NewManagedExchange} fields a deposit persists, composing
 * this party's document from `documentParts` here rather than accepting a
 * pre-composed one, so the record's `side` is read from the same parts the
 * document is composed from. A record reconstructed from an imported
 * artifact (`managedExchangeImport`) is a separate path, holding the
 * artifact's own side and document verbatim.
 *
 * The label is held verbatim -- its cap is enforced by the record schema at
 * the store write ({@link buildManagedExchangeRecord}), with
 * {@link labelWithinCap} as the UI gate.
 *
 * The max-age policy drives `expires`: opting in stamps `now + tokenMaxAgeDays`
 * through {@link rotationWriteBack} (reusing the run-rotate date math); opting
 * out leaves `tokenMaxAgeDays` and `expires` both absent. The invitation's setup
 * lifetime never flows into `expires`, whose provenance is single-source (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` row).
 *
 * @param now The instant the max-age stamp counts from, injected so the deposit
 *   stays pure and testable.
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

/** Whether the operator's label is within the cap the deposit enforces. Offered
 * so a component can gate its deposit action on a valid label without catching the
 * schema's throw. An empty label is permitted (the field has no minimum); the
 * content guidance -- name the partnership, no sensitive counterparty detail -- is
 * operator cooperation, not enforced. */
export function labelWithinCap(label: string): boolean {
  return label.length <= MAX_LABEL_LENGTH;
}

/** The opted-in max-age field's validation, re-exported at the offer boundary
 * beside the cap it enforces ({@link MAX_TOKEN_MAX_AGE_DAYS}). */
export { maxAgeDaysError };

/**
 * The cadence line shown when the operator sets a max-age policy, naming the
 * implication the operator weighs against the partnership's known cadence: the
 * exchange must run or be renewed within the bound or its stored secret lapses
 * (see docs/MANAGED_EXCHANGE.md, "Expiry is its own state"). Returns `undefined`
 * when no policy is set (the default), so a component renders nothing.
 */
export function maxAgeCadenceNote(
  tokenMaxAgeDays: number | undefined,
): string | undefined {
  if (tokenMaxAgeDays === undefined) return undefined;
  const days = tokenMaxAgeDays === 1 ? "1 day" : `${tokenMaxAgeDays} days`;
  return `This exchange must run or be renewed within ${days}, or its stored secret lapses and you re-invite your partner.`;
}

/** The operator guidance for the label field: name the partnership without
 * sensitive counterparty detail. The label is never sent, but it is disclosed to
 * any reader of the store, written into results file names, and shown in a
 * between-visit notification, so agreement numbers and contact details do not
 * belong in it (see docs/SECURITY_DESIGN.md, "Metadata at rest: presence and
 * shape"). */
export const LABEL_GUIDANCE =
  "Name the partnership so you recognize it later. The label is never sent, but three things show it: this browser's storage, which anyone reading it can see; the name of every results file, in a folder you grant and in a copy you download; and, if you turn on between-visit notifications, a notification your device may show on a locked screen or mirror to your other devices. Keep agreement numbers, contact details, and other sensitive counterparty information out of it.";

/** The problem a retention note holding a control character reports. A tab,
 * a line break, or a carriage return is fine: the note is written in a
 * multi-line field. */
export const RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM =
  "The retention note must not contain a control character (a NUL or an " +
  "ESC, for instance). A tab, a line break, or a carriage return is fine.";

/**
 * The field error for a retention note as typed, or `undefined` where the note
 * can be saved. The bound is the one the exchange document puts on the field;
 * the control-character rule is the console's for the same note, so a note
 * one app accepts the other does too. An empty note is no note.
 */
export function retentionNoteError(note: string): string | undefined {
  const trimmed = note.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) return RETENTION_NOTE_PROBLEM;
  if (NOTE_CONTROL_CHAR_PATTERN.test(trimmed))
    return RETENTION_NOTE_CONTROL_CHARACTER_PROBLEM;
  return undefined;
}

/** The retention note a document holds for the note as typed: trimmed, and
 * `undefined` where nothing is left, since the document field admits no empty
 * note. */
export function retentionNoteValue(note: string): string | undefined {
  const trimmed = note.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** What saving does and what it needs, stated on the offer: a saved exchange
 * runs on a schedule only in this browser, and only while the installed app is
 * open during a window (docs/MANAGED_EXCHANGE.md, "The automation goal and its
 * platform envelope"). */
export const SAVE_OFFER_SCHEDULE_NOTE =
  "Once saved, it can run on a schedule you agree with your partner, in this " +
  "browser: the installed Alcove app must be open during each run window, or " +
  "you open this site and run it yourself.";
