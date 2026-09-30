/**
 * The managed (recurring) exchange record: the browser-persisted state that lets
 * a two-party PPRL exchange run again without re-authoring or re-establishing a
 * shared secret. Pure and IndexedDB-free -- the record's shape, its Zod
 * validation, and the credential-free document composition; the IndexedDB CRUD
 * layer is {@link ./managedExchangeStore.ts}. Normative shape:
 * docs/spec/MANAGED_EXCHANGE_RECORD.md.
 *
 * Holds this party's exchange-file document verbatim (no `authentication`
 * block), the one at-rest secret, and a small set of local-only fields; never
 * input content or a row value. The document's terms change only as a
 * partner's terms change is taken on and as this party chooses the columns it
 * sends; the local fields beside it update in place.
 *
 * A record may hold no secret. A record without one is a CONFIGURATION ONLY --
 * settings to edit and export, running nowhere here -- and
 * {@link runnableManagedExchange} is the narrowing every path that needs a
 * secret takes (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "The
 * configuration-only record"). Every record on a channel this app does not run
 * is one, and holds no `side` either.
 */

import {
  ExchangeSpecSchema,
  RelayRegistrarSchema,
  SHARED_SECRET_REGEX,
  UsageError,
  assembleExchangeSpec,
  connectionFromLocator,
  deriveAcceptedLinkageTerms,
  maxCodeUnits,
  termsStatingDeclaredPayloadSend,
} from "@alcove/core";

import { z } from "zod";

import { applyDisclosure } from "../metadataEditing";
import { tokenMaxAgeDaysSchema } from "../tokenMaxAge";

import { deriveEditedExpiry } from "./managedTokenAgeEdit";

import type {
  ColumnMetadata,
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  OwnColumnSelection,
  RelayRegistrar,
  TermsUpdate,
  WebRTCExchangeLocator,
} from "@alcove/core";
import type { ZodType } from "zod";

/**
 * The single recognized `schemaVersion` literal for the v4 record. A reader
 * rejects any other value rather than migrating it (the reader-rejects-unknown
 * rule the exchange-record and verification-keys files follow), the earlier
 * literals among them: a v1 record has no
 * {@link ManagedExchangeRecord.standingCondition} at all, and a v2 one's
 * condition holds no {@link ManagedStandingResponse}. The literal moves for that
 * member because a build not knowing it would read the record and offer a fresh
 * invitation over an answer it cannot see; the whole record is refused instead,
 * and the recovery is re-invite rather than a migration. A later shape change is
 * a new literal under a new version, never an existing version holding
 * speculative fields.
 */
export const MANAGED_EXCHANGE_SCHEMA_VERSION = "alcove-managed-exchange/v4";

/**
 * The single recognized `artifactVersion` literal for the v3 export/import
 * artifact (see {@link ./managedExchangeArtifact.ts}). Distinct from
 * {@link MANAGED_EXCHANGE_SCHEMA_VERSION}: the artifact is a separate on-disk
 * format (the embedded document plus the key pair plus the local block), so it
 * versions independently of the stored record. A reader rejects any other value
 * rather than migrating it, {@link MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION}
 * among them. The literal moves for the {@link ManagedStandingResponse} nested
 * in a raised condition: a build that does not know the member reads it with a
 * schema that drops what it cannot name, so it would import a condition
 * stripped of the operator's answer and offer a fresh invitation over it. The
 * whole file is refused on the literal instead, and the recovery is an export
 * taken from a build that matches.
 */
export const MANAGED_EXCHANGE_ARTIFACT_VERSION =
  "alcove-managed-exchange-backup/v3";

/**
 * The `artifactVersion` literal of the artifact format this one replaced. Every
 * backup taken before the operator's response existed holds it, and no build
 * reads one again. It is kept so the import can tell such a file from an
 * unreadable one and from a newer build's export, whose remedies are not an
 * older file's: the recovery here is a fresh exchange, not a version to move
 * between.
 */
export const MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION =
  "alcove-managed-exchange-backup/v2";

/**
 * Upper bound on the operator's {@link ManagedExchangeRecord.label}, in
 * characters (UTF-16 code units), enforced at write. The cap is the field's only
 * structural protection; keeping sensitive counterparty detail out of the label
 * is operator cooperation the app cannot enforce (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `label` row).
 */
export const MAX_LABEL_LENGTH = 120;

/** This party's side of the partnership, dispatching a re-run to the matching
 * rendezvous flow. Local-only: not the document's schema-only
 * `connection.role`. */
export type ManagedExchangeSide = "inviter" | "acceptor";

/** The one channel this app conducts an exchange over: a live browser-to-browser
 * connection. A record on any other channel holds a configuration only. */
export const MANAGED_RUN_CHANNEL = "webrtc";

/** A channel a stored document can name that this app does not conduct an
 * exchange over. */
export type ManagedElsewhereChannel = Exclude<
  ConnectionConfig["channel"],
  typeof MANAGED_RUN_CHANNEL
>;

/**
 * The channel a document's exchange runs over when this app cannot conduct it,
 * or undefined for the channel it runs. The one place "does this run here" is
 * read off a document's channel: every surface that withholds a run or a
 * schedule for the channel's sake, and names the channel in saying so, derives
 * it from here.
 */
export function channelThisAppDoesNotRun(
  exchangeFile: ExchangeSpec,
): ManagedElsewhereChannel | undefined {
  const { channel } = exchangeFile.connection;
  return channel === MANAGED_RUN_CHANNEL ? undefined : channel;
}

/**
 * The top-level document parts this app holds unchanged and may not run. A
 * `signing` block configures receipt signing, which this app does not do, so a
 * run here would complete without the receipt the document asks for -- unless
 * its mode is `none`, which asks for no receipt ({@link partAsksWhatThisAppLacks}).
 */
export const DOCUMENT_PARTS_THIS_APP_DOES_NOT_RUN = [
  "signing",
] as const satisfies ReadonlyArray<keyof ExchangeSpec>;

/** A top-level document part this app holds unchanged and cannot run. */
export type DocumentPartThisAppDoesNotRun =
  (typeof DOCUMENT_PARTS_THIS_APP_DOES_NOT_RUN)[number];

/** Whether `part`, as `exchangeFile` states it, asks for something this app
 * does not do. A `signing` block asks for a receipt unless its mode is `none`,
 * which the block states explicitly and this app meets by signing nothing. */
function partAsksWhatThisAppLacks(
  exchangeFile: ExchangeSpec,
  part: DocumentPartThisAppDoesNotRun,
): boolean {
  const stated = exchangeFile[part];
  return stated !== undefined && stated.mode !== "none";
}

/**
 * The parts of a document this app holds but cannot run, in a fixed order. The
 * one place "does this document run here" is read off its parts rather than
 * its channel: the record schema refuses a secret beside one, so a record
 * stating one is a configuration only, and every surface that withholds the
 * run for one names it from here. A part that asks for nothing this app lacks
 * -- a `signing` block whose mode is `none` -- is held unchanged and runs.
 */
export function documentPartsThisAppDoesNotRun(
  exchangeFile: ExchangeSpec,
): Array<DocumentPartThisAppDoesNotRun> {
  return DOCUMENT_PARTS_THIS_APP_DOES_NOT_RUN.filter((part) =>
    partAsksWhatThisAppLacks(exchangeFile, part),
  );
}

/**
 * Upper bound on {@link ManagedExchangeSchedule.intervalDays}: an annual cadence,
 * the longest partnership recurrence the design serves. It also bounds how far
 * past any instant a window can fall, which is what lets every surface render an
 * admitted schedule without a fallback (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * the `intervalDays` row and "Every admitted schedule renders").
 */
export const MAX_SCHEDULE_INTERVAL_DAYS = 366;

/**
 * Upper bound on {@link ManagedExchangeSchedule.windowSeconds}, in seconds: half
 * a day. It is below the shortest period {@link MAX_SCHEDULE_INTERVAL_DAYS}'s
 * companion floor of one day admits, so no schedule this schema accepts can
 * place two windows over the same instant (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `windowSeconds` row).
 */
export const MAX_SCHEDULE_WINDOW_SECONDS = 43_200;

/** The recurrence period, run window, and miss bookkeeping the unattended path
 * executes. Every field is a timestamp, an integer duration, or a count -- no
 * free text, so the object cannot accumulate schedule narrative. */
export interface ManagedExchangeSchedule {
  /** ISO 8601 UTC instant of the first agreed window's open, the phase the
   * recurrence counts from. Both parties persist the same value. */
  anchor: string;
  /** Recurrence period in whole days (1 through
   * {@link MAX_SCHEDULE_INTERVAL_DAYS}): the run window opens every
   * `intervalDays` after `anchor`. */
  intervalDays: number;
  /** Run window width in seconds (1 through
   * {@link MAX_SCHEDULE_WINDOW_SECONDS}): window n is open from
   * `anchor + n * intervalDays` for this many seconds. */
  windowSeconds: number;
  /** ISO 8601 UTC open instant of the next window the runner plans to attempt,
   * persisted rather than recomputed so a reader sees the planned attempt. */
  nextWindow: string;
  /** Count of consecutive agreed windows that passed without a completed
   * handshake (at least 0), regardless of which side was absent. */
  consecutiveMisses: number;
}

/** The outcome of a run, or of an agreed window no run occupied. Closed enum: a
 * benign `"missed"` window (a no-show on either side) is distinct from a
 * handshake that ran and failed (`"failed"`/`"desynced"`), and both are distinct
 * from `"skipped"` -- a due window the scheduled runner declined to open while
 * the operator's compromise response stood, which connected to nobody and
 * rotated nothing. */
export type ManagedExchangeRunOutcome =
  "succeeded" | "failed" | "desynced" | "missed" | "skipped";

/** For a non-succeeded outcome, the kind of failure. Closed enum: the four benign
 * pre-run problems -- an `"input"` problem (the file missing from the working
 * folder, or unreadable), a `"terms-shortfall"` refusal (the file cannot satisfy
 * every linkage key the standing terms declare), a `"handed-off"` refusal (an
 * export gave this device's copy away, so the run does not rotate a secret
 * whose owner is elsewhere), and a
 * `"custody-unreadable"` refusal (the sibling entry recording whether the copy
 * was handed off did not read, so the run does not rotate on custody it could
 * not establish) -- are detected before any connection and never routed through
 * desync/attack framing. A `"too-large"` refusal (a set this run had to send
 * was over the bound one WebRTC message holds) is benign the same way, but a
 * round past the first can meet it after data has moved. A `"terms-change"`
 * refusal (the partner's linkage terms changed and this run did not take them
 * on) is met at the terms exchange, after the handshake and before any linkage
 * key or data moves, and is benign too: its remedy is the operator's decision
 * on the change. */
export type ManagedExchangeFailureKind =
  | "auth"
  | "transport"
  | "storage"
  | "custody-unreadable"
  | "input"
  | "terms-shortfall"
  | "handed-off"
  | "too-large"
  | "terms-change"
  | "cancelled";

/** Whose set a `"too-large"` refusal found over the bound: `"local"` for this
 * party's own, `"partner"` for the partner's set a run had to send back. */
export type TooLargeSetOwner = "local" | "partner";

/** Which bound a `"too-large"` refusal found a set over: `"webrtc-message"`
 * for the bytes one WebRTC message holds. */
export type TooLargeBound = "webrtc-message";

/** Run bookkeeping the backup state and the desync UX read. Every field is a
 * timestamp, a closed enum, or a marker present only as `true` -- no free-text
 * field, so the record structurally cannot hold a match result, a count, or a
 * row value. */
export interface ManagedExchangeLastRun {
  /** ISO 8601 UTC instant of the run. */
  at: string;
  /** The run's outcome. */
  outcome: ManagedExchangeRunOutcome;
  /** For a non-succeeded outcome, the kind of failure; absent on success. */
  failureKind?: ManagedExchangeFailureKind;
  /** Present only on a `"terms-shortfall"` failure whose input file read as ONE
   * column -- the shape a file separated by something other than the delimiter
   * this record reads it by comes out as. The next visit's summary and the
   * between-visit notice state the delimiter remedy where it is set and the
   * agreed-keys copy where it is absent. */
  singleColumnInput?: true;
  /** Present only on a `"too-large"` failure: whose set was over the bound.
   * The next visit's summary and the between-visit notice name the one remedy
   * that side takes, and both remedies where it is absent. */
  tooLargeSetOwner?: TooLargeSetOwner;
  /** Present only on a `"too-large"` failure: which bound the set was over.
   * The next visit's summary and the between-visit notice name that bound and
   * its figure, and name no bound where it is absent. */
  tooLargeBound?: TooLargeBound;
}

/** The failure kinds that raise a standing condition: a rotation this device
 * could not save (`"storage"`, which may have left the two parties on different
 * secrets) and a handshake that failed closed (`"auth"`). A strict subset of
 * {@link ManagedExchangeFailureKind}: every other kind is answered by an act on
 * this device, so `lastRun` accounts for it whole. */
export type ManagedStandingConditionKind = "auth" | "storage";

/** Evidence that this device's secret may no longer be the partnership's, raised
 * by a run and unanswered since. It stands BESIDE `lastRun` rather than inside
 * it because `lastRun` holds one run: the next run's stamp replaces it, so a
 * no-show or a later success would otherwise carry the evidence off with the
 * entry that held it. No free text, like every other bookkeeping field -- two
 * instants and two closed enums at most. Its normative shape, and what clears
 * it, are in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row. */
export interface ManagedStandingCondition {
  /** ISO 8601 UTC instant of the run whose failure raised it. */
  since: string;
  /** The failure kind that raised it. */
  kind: ManagedStandingConditionKind;
  /** The operator's answer to the gate this condition was put through; absent
   * until one is given, and the first answer stands. */
  response?: ManagedStandingResponse;
}

/** The operator's answer at a failure gate that nothing about the failure adds
 * up: the compromise response (see docs/MANAGED_EXCHANGE.md, "Telling a desync
 * from an attack"). An instant and a closed enum, like every other bookkeeping
 * field. It is a member of the condition it answers rather than a field beside
 * it, so the three acts that clear a condition clear the answer with it and the
 * answer has no clearer of its own. */
export interface ManagedStandingResponse {
  /** The closed enum's one member: the operator treated the failure as a
   * possible compromise. */
  kind: "compromise";
  /** ISO 8601 UTC instant the operator answered. */
  at: string;
}

/** The `standingCondition` of a record holding none. The field is required, so a
 * record states that no condition stands rather than leaving the field out, and
 * a reader never has to tell that state from a record written by something that
 * did not know the field. */
export interface ManagedStandingConditionNone {
  /** The closed enum's unset member; a raised condition takes `"auth"` or
   * `"storage"`, with the instant that raised it. */
  kind: "none";
}

/** What the required `standingCondition` field holds: a raised condition, or the
 * explicit none form. */
export type ManagedStandingConditionField =
  ManagedStandingCondition | ManagedStandingConditionNone;

/** The `standingCondition` value of a record with none standing. */
export const NO_STANDING_CONDITION: ManagedStandingConditionNone = {
  kind: "none",
};

/**
 * A managed exchange record: the minimal state this party's browser retains so a
 * recurring exchange with the same partner over the same terms can run again. It
 * is not a saved copy of the exchange's inputs or outputs. See
 * docs/spec/MANAGED_EXCHANGE_RECORD.md for the field-by-field shape.
 */
export interface ManagedExchangeRecord {
  /** The single recognized v4 literal; a reader rejects an unrecognized value
   * rather than migrating (see {@link MANAGED_EXCHANGE_SCHEMA_VERSION}). */
  schemaVersion: typeof MANAGED_EXCHANGE_SCHEMA_VERSION;
  /** Locally-generated identifier for this managed exchange, distinct from any
   * rendezvous id. Used only to name the record in local UI; never sent. */
  id: string;
  /** Operator-supplied display name, at most {@link MAX_LABEL_LENGTH}
   * characters (enforced at write). Local only; never sent. */
  label: string;
  /**
   * This party's exchange-file document, verbatim: the validated
   * {@link ExchangeSpec} both applications share. Contains no `authentication`
   * block (the secret lives in {@link sharedSecret}) and its connection block is
   * composed from a credential-free locator (see
   * {@link composeManagedExchangeFile}), except a configuration-only sftp
   * record's, which holds the imported connection with each credential as an
   * `@path` reference (./managedCommandLineDocument.ts).
   */
  exchangeFile: ExchangeSpec;
  /** This party's side of the partnership; dispatches a re-run to the matching
   * rendezvous flow. Present exactly when the connection is webrtc: sftp and
   * filedrop connections name no `role`, so a configuration imported on one of
   * them has no side to record. */
  side?: ManagedExchangeSide;
  /**
   * A persisted pointer to the exchange's working folder, held where the File
   * System Access API exists. A run reads its input from the one file there named
   * `input.csv` (`MANAGED_INPUT_FILE_NAME`, ./managedInputHandle.ts), resolved
   * afresh each run, and a run with nobody present writes its results CSV beside
   * it; the folder is never enumerated. A reference, never a copy: no input
   * content or row value persists. Taken under an operator gesture, never at run
   * time (the picker needs one). Absent on browsers without the API and in any
   * imported record (the handle is a device- and profile-local platform object
   * stored by structured clone, with no serialization).
   */
  workingDirectoryHandle?: FileSystemDirectoryHandle;
  /** The current rotated shared secret (base64url, 43 chars / 32 bytes), matching
   * {@link SHARED_SECRET_REGEX}. The one at-rest secret in the record.
   *
   * Absent in a CONFIGURATION-ONLY record -- one imported from a command-line
   * `alcove.yaml` whose `.alcove.key` stayed on the machine that runs it. Such
   * a record holds settings to edit and export, and its absent secret is what
   * withholds every run here: {@link runnableManagedExchange} is the one
   * narrowing to the record shape the run, rotation, re-invite, and backup paths
   * take, so a configuration-only record cannot be handed to any of them.
   * Present only on a webrtc connection, the one channel this app runs, and
   * only beside a document stating no part this app cannot run
   * ({@link documentPartsThisAppDoesNotRun}), so a record on any other channel
   * or stating such a part is a configuration only. */
  sharedSecret?: string;
  /** ISO 8601 UTC instant after which {@link sharedSecret} must not be used;
   * absent means no bound is in force. Only {@link tokenMaxAgeDays} writes it. */
  expires?: string;
  /** The operator's max-token-age policy, off by default: absent means no bound.
   * When set, each successful run stamps {@link expires} this many days out. */
  tokenMaxAgeDays?: number;
  /** The partnership-agreed run schedule the unattended path executes; absent for
   * an exchange run attended-only. */
  schedule?: ManagedExchangeSchedule;
  /** Run bookkeeping; absent until the first run records an outcome. */
  lastRun?: ManagedExchangeLastRun;
  /** ISO 8601 UTC instant a run began a key exchange that has not saved its
   * rotated secret: written before the key exchange starts and removed by the
   * write that stores the rotated secret, so it outlives a run that stopped
   * between the two. Absent while no rotation is in flight. */
  rotationInFlightSince?: string;
  /** The relay registrar this browser enrolled the exchange at: where a run
   * that relays through this browser's own relay registers the relay key
   * derived from each rotated secret. Holds no credential; the relay-owner
   * token is asked for at enrollment and kept nowhere. Absent while the
   * exchange is not enrolled. */
  relayRegistrar?: RelayRegistrar;
  /** ISO 8601 UTC instant the secret this record holds was rotated to, while
   * the relay registrar has not confirmed that it holds the relay key derived
   * from it: written by the rotation write itself and removed once the
   * registrar confirms, so a record still holding it at the next run records a
   * registration that run retries before it dials. */
  relayRegistrationPendingSince?: string;
  /** Why the registration {@link relayRegistrationPendingSince} records cannot
   * be confirmed by a run, held only beside it: `"reinvite"` when a re-invite
   * replaced the secret and the registrar did not confirm the fresh secret's
   * key, so the key it holds is derived from a secret this record no longer
   * holds. Absent beside the marker, a registration signed under the current
   * key can confirm it. */
  relayRegistrationPendingReason?: ManagedRelayRegistrationPendingReason;
  /** The unanswered standing condition an `auth` or `storage` failure raised, or
   * {@link NO_STANDING_CONDITION} while none stands. Cleared by the operator's
   * explicit clear-and-acknowledge, by a re-invite, or with the record itself --
   * never by a no-show and never by a successful run alone. */
  standingCondition: ManagedStandingConditionField;
}

/**
 * The canonical `schedule` validator, with the schema's own bounds
 * (`intervalDays` from 1 to {@link MAX_SCHEDULE_INTERVAL_DAYS}, `windowSeconds`
 * from 1 to {@link MAX_SCHEDULE_WINDOW_SECONDS}, `consecutiveMisses` at least 0).
 * Exported so the export/import artifact reuses it rather than re-declaring a
 * laxer copy -- a tampered artifact with `intervalDays: 0` must be rejected
 * exactly as a stored record would be.
 *
 * Within these bounds, the next window off any anchor the schema admits lands on
 * a calendar `Intl` can format, so no display has a fallback for a recurrence
 * whose instants no calendar has (see {@link ../recurring/scheduleSurfacingModel.ts}).
 */
export const scheduleSchema: ZodType<ManagedExchangeSchedule> = z.object({
  anchor: z.iso.datetime(),
  intervalDays: z.int().min(1).max(MAX_SCHEDULE_INTERVAL_DAYS),
  windowSeconds: z.int().min(1).max(MAX_SCHEDULE_WINDOW_SECONDS),
  nextWindow: z.iso.datetime(),
  consecutiveMisses: z.int().min(0),
});

/** The instant a stored ISO datetime denotes, or `NaN` for a string the
 * validators above would not admit as one: unparseable, or having no UTC
 * designator (they take `Z`, never a bare offset). Without the designator,
 * `Date.parse` reads the wall clock against the host zone -- five hours off
 * under America/New_York -- so the same record would name a different instant
 * on every machine that read it. Shared with the schedule arithmetic, which
 * reads these same fields and must land on the same moments (see
 * {@link ./managedSchedule.ts}). */
export function parseStoredInstant(value: string): number {
  return value.endsWith("Z") ? Date.parse(value) : Number.NaN;
}

/** The canonical `lastRun` validator. Exported so the export/import artifact
 * reuses it rather than re-declaring a laxer copy. Every earlier `outcome` and
 * `failureKind` remains a member of its enum, so a record written before a value
 * was added still reads and tiers exactly as it did, and neither enum growing
 * moves {@link MANAGED_EXCHANGE_SCHEMA_VERSION}. An artifact holding a value
 * this reader does not know is refused whole rather than read with the value
 * dropped -- the reader-rejects-unknown rule. `singleColumnInput` is admitted
 * only as `true`, so the field cannot hold a reading its absence already
 * states. */
export const lastRunSchema: ZodType<ManagedExchangeLastRun> = z.object({
  at: z.iso.datetime(),
  outcome: z.enum(["succeeded", "failed", "desynced", "missed", "skipped"]),
  failureKind: z
    .enum([
      "auth",
      "transport",
      "storage",
      "custody-unreadable",
      "input",
      "terms-shortfall",
      "handed-off",
      "too-large",
      "terms-change",
      "cancelled",
    ])
    .optional(),
  singleColumnInput: z.literal(true).optional(),
  tooLargeSetOwner: z.enum(["local", "partner"]).optional(),
  tooLargeBound: z.enum(["webrtc-message"]).optional(),
});

/** The canonical validator for the operator's answer. Strict, so a member a
 * later shape adds is refused by a build that does not know it rather than
 * dropped from the value that build parses -- the reader-rejects-unknown rule
 * held one level down, where the condition's own `response` sits. */
export const standingResponseSchema: ZodType<ManagedStandingResponse> = z
  .object({
    kind: z.literal("compromise"),
    at: z.iso.datetime(),
  })
  .strict();

/** The canonical `standingCondition` validator. Exported so the export/import
 * artifact reuses it rather than re-declaring a laxer copy: the condition travels
 * with the record, since an export that dropped it would clear a state only the
 * operator, a re-invite, or a delete may clear. */
export const standingConditionSchema: ZodType<ManagedStandingCondition> = z
  .object({
    since: z.iso.datetime(),
    kind: z.enum(["auth", "storage"]),
    response: standingResponseSchema.optional(),
  })
  .strict();

/** The canonical validator for the record's required `standingCondition` field:
 * a raised condition, or the none form. The artifact validates the raised shape
 * alone, its own field being optional and omitted where none stands. */
export const standingConditionFieldSchema: ZodType<ManagedStandingConditionField> =
  z.union([
    standingConditionSchema,
    z.object({ kind: z.literal("none") }).strict(),
  ]);

/** The canonical `tokenMaxAgeDays` validator, re-exported for the
 * export/import artifact ({@link ../tokenMaxAge}). */
export { tokenMaxAgeDaysSchema };

/**
 * The persisted exchange-file document, validated when a record is read back: a
 * full {@link ExchangeSpec} that additionally must hold no `authentication`
 * block. The secret lives in {@link ManagedExchangeRecord.sharedSecret}, never in
 * the document, so a stored record cannot smuggle a secret through the document
 * half. Guards the read path against a hand-edited or corrupted store;
 * composition never produces the block (see {@link composeManagedExchangeFile}).
 *
 * A stored document holding the retired `expectedPayloadColumns` reads without
 * it, as the record drops the retired `inputFileHandle` and
 * `outputDirectoryHandle`: the agreed terms' `payload.receive` states that set,
 * and the next write leaves the field out.
 */
const persistedExchangeFileSchema = z.preprocess(
  (stored) => {
    if (typeof stored !== "object" || stored === null) return stored;
    const { expectedPayloadColumns: _retired, ...document } = stored as Record<
      string,
      unknown
    >;
    return document;
  },
  ExchangeSpecSchema.refine((spec) => spec.authentication === undefined, {
    message: "exchangeFile must not carry an authentication block",
  }),
);

/**
 * The `.alcove.key` fields: `sharedSecret`, `expires`, `rotationInFlightSince`,
 * `relayRegistrationPendingSince`. The artifact's key half and the key file
 * this app writes are the fields without the rotation-in-flight marker
 * ({@link ManagedExchangeKeyPair}), so a record's secret half maps onto a valid
 * `.alcove.key` and one read back maps onto a record.
 */
export interface ManagedExchangeKeyFields {
  /** The current rotated shared secret (base64url, 43 chars / 32 bytes). */
  sharedSecret: string;
  /** The instant after which the secret must not be used; absent means no bound. */
  expires?: string;
  /** A command-line key file's rotation-in-flight marker. Admitted so such a
   * file reads; never carried onto a record, whose import is read through the
   * import marker instead. */
  rotationInFlightSince?: string;
  /** An unconfirmed relay key registration: the record's
   * `relayRegistrationPendingSince`, written by both exports and set on the
   * record an import builds, so its first run retries it. */
  relayRegistrationPendingSince?: string;
}

/** The key fields without the command line's rotation-in-flight marker: what
 * the export artifact's key block and the key file this app writes hold. */
export type ManagedExchangeKeyPair = Omit<
  ManagedExchangeKeyFields,
  "rotationInFlightSince"
>;

const keyPairShape = {
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
  expires: z.iso.datetime().optional(),
  relayRegistrationPendingSince: z.iso.datetime().optional(),
};

/**
 * The key pair's validator, for the export artifact's key block:
 * `sharedSecret`, an optional ISO 8601 `expires`, and an optional pending
 * relay registration. Strict, so an artifact whose key block holds the
 * rotation-in-flight marker, which the artifact never holds, is refused rather
 * than read with the field dropped.
 */
export const keyPairFieldsSchema: ZodType<ManagedExchangeKeyPair> = z
  .object(keyPairShape)
  .strict();

/**
 * The command-line key file's validator: the key pair plus the optional
 * rotation-in-flight and pending relay registration markers the command line
 * writes there. Shares the pair's field schemas so neither reader validates
 * against a looser copy. Strict, so a reader rejects an unknown key rather
 * than silently accepting it.
 */
export const keyFileFieldsSchema: ZodType<ManagedExchangeKeyFields> = z
  .object({
    ...keyPairShape,
    rotationInFlightSince: z.iso.datetime().optional(),
  })
  .strict();

/**
 * The record validator. The interface is defined first and the schema derived as
 * a `z.ZodType<ManagedExchangeRecord>`, per the repo's validation convention. The
 * folder handle is validated only for its presence, not its structure: a
 * `FileSystemDirectoryHandle` is an opaque platform object IndexedDB stores by
 * structured clone, so there is no serializable shape to assert -- the schema
 * treats it as an optional unknown, and the
 * no-input-content invariant is a property of the type (a handle is a pointer),
 * not a runtime check.
 *
 * The first refine holds the configuration-only shape together: a record with
 * no `sharedSecret` runs nothing here, so it may hold nothing a run or a secret
 * produces. Every such field is bound to the secret's presence at the schema, so
 * a record whose shape withholds the run cannot also hold a lapse instant for a
 * secret it does not have, a schedule nothing here would execute, or the
 * bookkeeping of runs it never made.
 *
 * The next two bind the secret to a document this app runs. A secret is held
 * only on a webrtc connection, the one channel this app runs, and only beside a
 * document stating no part this app cannot run
 * ({@link documentPartsThisAppDoesNotRun}), so a record on any other channel or
 * stating such a part is a configuration only, and the narrowing that withholds
 * its run is the same one. `side` is held exactly when the connection is
 * webrtc, the one channel whose document names a `role` for it to stand for.
 */
const ManagedExchangeRecordSchema: ZodType<ManagedExchangeRecord> = z
  .object({
    schemaVersion: z.literal(MANAGED_EXCHANGE_SCHEMA_VERSION),
    id: z.string().min(1),
    label: z.string().check(maxCodeUnits(MAX_LABEL_LENGTH)),
    exchangeFile: persistedExchangeFileSchema,
    side: z.enum(["inviter", "acceptor"]).optional(),
    workingDirectoryHandle: z.custom<FileSystemDirectoryHandle>().optional(),
    sharedSecret: z.string().regex(SHARED_SECRET_REGEX).optional(),
    expires: z.iso.datetime().optional(),
    tokenMaxAgeDays: tokenMaxAgeDaysSchema.optional(),
    schedule: scheduleSchema.optional(),
    lastRun: lastRunSchema.optional(),
    rotationInFlightSince: z.iso.datetime().optional(),
    relayRegistrar: RelayRegistrarSchema.optional(),
    relayRegistrationPendingSince: z.iso.datetime().optional(),
    relayRegistrationPendingReason: z.literal("reinvite").optional(),
    standingCondition: standingConditionFieldSchema,
  })
  .refine(
    (record) =>
      record.relayRegistrationPendingReason === undefined ||
      record.relayRegistrationPendingSince !== undefined,
    {
      message:
        "relayRegistrationPendingReason is held only beside " +
        "relayRegistrationPendingSince",
    },
  )
  .refine(
    (record) =>
      record.sharedSecret !== undefined ||
      (record.expires === undefined &&
        record.schedule === undefined &&
        record.lastRun === undefined &&
        record.rotationInFlightSince === undefined &&
        record.relayRegistrar === undefined &&
        record.relayRegistrationPendingSince === undefined &&
        record.workingDirectoryHandle === undefined),
    {
      message:
        "a record without a sharedSecret is configuration only and must hold " +
        "no expires, schedule, lastRun, rotationInFlightSince, relayRegistrar, " +
        "relayRegistrationPendingSince, or platform handle",
    },
  )
  .refine(
    (record) =>
      record.sharedSecret === undefined ||
      record.exchangeFile.connection.channel === MANAGED_RUN_CHANNEL,
    {
      message:
        "a record holding a sharedSecret runs in this app, which runs webrtc " +
        "exchanges only",
    },
  )
  .refine(
    (record) =>
      record.sharedSecret === undefined ||
      documentPartsThisAppDoesNotRun(record.exchangeFile).length === 0,
    {
      message:
        "a record holding a sharedSecret runs in this app, so its document " +
        `states no part this app cannot run (${DOCUMENT_PARTS_THIS_APP_DOES_NOT_RUN.join(", ")})`,
    },
  )
  .refine(
    (record) =>
      (record.side !== undefined) ===
      (record.exchangeFile.connection.channel === MANAGED_RUN_CHANNEL),
    {
      message:
        "a record holds a side exactly when its connection is webrtc, the one " +
        "channel whose document names a role",
    },
  );

/**
 * Parse and validate a value read from the store as a {@link ManagedExchangeRecord}.
 * Throws on an unrecognized `schemaVersion`, an over-long label, a malformed
 * secret, or a document holding an `authentication` block, rather than migrating
 * or silently accepting -- the reader-rejects-unknown rule.
 *
 * @throws {ZodError} if the value is not a valid v4 record.
 */
export function parseManagedExchangeRecord(
  raw: unknown,
): ManagedExchangeRecord {
  return ManagedExchangeRecordSchema.parse(raw);
}

/** Non-throwing {@link parseManagedExchangeRecord}. */
export function safeParseManagedExchangeRecord(raw: unknown) {
  return ManagedExchangeRecordSchema.safeParse(raw);
}

/**
 * A record holding the secret its exchange runs on: the shape every run,
 * rotation, re-invite, hand-off, and backup path takes. The narrowing is the
 * type, so a configuration-only record (no {@link
 * ManagedExchangeRecord.sharedSecret}) cannot be passed to one of them at all.
 */
export type RunnableManagedExchangeRecord = ManagedExchangeRecord & {
  sharedSecret: string;
  side: ManagedExchangeSide;
};

/**
 * Whether a stored record holds the secret its exchange runs on, narrowing it to
 * {@link RunnableManagedExchangeRecord} where it does. The one place the withheld
 * run is decided, and it decides on the record's own shape rather than on a
 * stored flag: a surface offering a run narrows first and shows the
 * configuration-only state where the narrowing fails. The record schema holds a
 * secret only on a webrtc connection, which always has a side, so the side is
 * read here for the narrowed type rather than as a second condition.
 */
export function runnableManagedExchange(
  record: ManagedExchangeRecord,
): record is RunnableManagedExchangeRecord {
  return record.sharedSecret !== undefined && record.side !== undefined;
}

/**
 * The same narrowing as a refusal, for a path a configuration-only record has no
 * answer for at all -- a backup of a secret that is not stored, a hand-off of a
 * copy this browser never held. The surfaces withhold those controls on the
 * record's shape; this is the boundary that refuses one reached anyway, rather
 * than composing a file with an empty secret in it.
 *
 * It is also the runtime half of the narrowing where the type is erased: a
 * store entry point takes the record's `id`, which carries no shape, so the
 * rotation and re-invite writes narrow the record they read inside the
 * transaction and abort it here rather than writing a secret onto a record that
 * holds none (see {@link ./managedExchangeStore.ts}).
 *
 * @throws {Error} if the record holds no shared secret.
 */
export function runnableManagedExchangeOrRefuse(
  record: ManagedExchangeRecord,
): RunnableManagedExchangeRecord {
  if (!runnableManagedExchange(record))
    throw new Error(
      "this exchange holds a configuration only: its shared secret stayed " +
        "with the command line, so there is nothing here to rotate, " +
        "re-invite from, back up, hand off, or run",
    );
  return record;
}

/**
 * A per-entry read of the stored list: the entries that parsed as v4 records, and
 * the stored keys of the entries that did not. The unreadable half is the STORED
 * KEY rather than the entry's own `id`, which a failed parse leaves untrusted --
 * the same reason the diagnostic read's unreadable marker holds the key (see
 * {@link ManagedExchangeDiagnosticEssentials}).
 */
export interface ManagedExchangeReadableRecords {
  /** The entries that parsed, in the order the store yielded them. */
  records: Array<ManagedExchangeRecord>;
  /** The stored keys of the entries that did not parse. */
  unreadableIds: Array<string>;
}

/**
 * Partition a store's parallel key and value arrays into the records that parse
 * and the stored keys of those that do not -- the tolerant counterpart of mapping
 * {@link parseManagedExchangeRecord} over the values, which rejects the whole read
 * on the first entry that fails.
 *
 * Tolerance here is for the UNATTENDED read (see
 * {@link ./managedScheduleRunner.ts}); the attended list read stays strict, so an
 * operator still meets the read-failed recovery surface that identifies and
 * discards the offending entry.
 *
 * Never throws: every parse is per-entry, so an unreadable value becomes a
 * reported key rather than a rejection.
 */
export function partitionReadableManagedExchanges(
  keys: ReadonlyArray<IDBValidKey>,
  values: ReadonlyArray<unknown>,
): ManagedExchangeReadableRecords {
  const records: Array<ManagedExchangeRecord> = [];
  const unreadableIds: Array<string> = [];
  for (let index = 0; index < keys.length; index += 1) {
    try {
      records.push(parseManagedExchangeRecord(values[index]));
    } catch {
      unreadableIds.push(String(keys[index]));
    }
  }
  return { records, unreadableIds };
}

/**
 * The display essentials a diagnostic read reports for one stored entry that
 * parses: only the fields a recovery listing renders -- the label, this party's
 * side or the channel this app does not run, and the last run's instant when
 * recorded. Not the whole record: the diagnostic path must never return the
 * `sharedSecret` or any document field to a component, so this type
 * structurally cannot hold secret material (see
 * docs/MANAGED_EXCHANGE.md, "Deleting a managed exchange", and the read-failed
 * recovery listing). The `id` is the stored key a delete-by-key acts on.
 */
export interface ManagedExchangeDiagnosticEssentials {
  /** The stored key, the delete acts on it (matches the record's `id`). */
  id: string;
  /** The operator's display label; may be empty. */
  label: string;
  /** This party's side of the partnership; absent on a configuration on a
   * channel that names no side. */
  side?: ManagedExchangeSide;
  /** The channel the stored document runs over when this app does not run it
   * (see {@link channelThisAppDoesNotRun}), which the listing names in place
   * of a side. */
  elsewhereChannel?: ManagedElsewhereChannel;
  /** ISO 8601 UTC instant of the last recorded run, when one exists. */
  lastRunAt?: string;
}

/**
 * Extract only the display essentials from a stored value for the read-failed
 * recovery listing: the `id`, `label`, `side`, the channel this app does not
 * run, and the last-run instant, and nothing else. Structurally incapable of
 * returning secret material: it reads named scalar fields off the validated
 * record into a {@link ManagedExchangeDiagnosticEssentials}, so the
 * `sharedSecret`, the document, and the folder handle never leave this
 * function. Full record validation runs first, so a value that would fail
 * {@link parseManagedExchangeRecord} throws here exactly as it would on the
 * strict read; the caller catches that to mark the entry unreadable.
 *
 * @throws {ZodError} if the value is not a valid v4 record.
 */
export function diagnoseManagedExchangeRecord(
  raw: unknown,
): ManagedExchangeDiagnosticEssentials {
  const record = parseManagedExchangeRecord(raw);
  const elsewhereChannel = channelThisAppDoesNotRun(record.exchangeFile);
  return {
    id: record.id,
    label: record.label,
    ...(record.side !== undefined ? { side: record.side } : {}),
    ...(elsewhereChannel !== undefined ? { elsewhereChannel } : {}),
    ...(record.lastRun !== undefined ? { lastRunAt: record.lastRun.at } : {}),
  };
}

/** Everything a caller supplies to compose the persisted exchange-file document
 * from a credential-free webrtc locator. The linkage terms and connection locator
 * are the document's substance; the optional blocks mirror
 * {@link mintExchangeFile}'s input. */
export interface ManagedExchangeFileComposition {
  /** The credential-free webrtc rendezvous locator the connection block is
   * composed from. No credential is representable (see
   * {@link WebRTCExchangeLocator}). */
  connection: WebRTCExchangeLocator;
  /** The validated linkage terms both parties agreed. */
  linkageTerms: ExchangeSpec["linkageTerms"];
  /** This party's column metadata, when authored. */
  metadata?: ExchangeSpec["metadata"];
  /** This party's per-party standardization, when authored. */
  standardization?: ExchangeSpec["standardization"];
  /** The `deduplicate` an accepted invitation declared for the partner's own
   * side -- this party's terms-side commitment. Absent for a party that accepted
   * no invitation, which has no declaration to bind. */
  expectedPartnerDeduplicate?: boolean;
  /** Which of this party's own input columns its result file holds beside the
   * partner's values, decided at the mint and held verbatim so a scheduled
   * re-run writes the same file the one-shot run did. Absent where the
   * operator chose nothing, or the terms leave it nothing to act on. */
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  /** The field-delimiter choice this party's input file is read under and its
   * result file written with -- a character, or the reserved detect word --
   * chosen at the file step and held verbatim so a run with nobody present reads
   * the file the way the operator does. Absent reads and writes commas. */
  csvDelimiter?: ExchangeSpec["csvDelimiter"];
  /** This party's note on where its results are filed and how long they are
   * kept, written into its own exchange record at each run. Absent where the
   * operator wrote none. */
  retentionDisposition?: ExchangeSpec["retentionDisposition"];
}

/**
 * Compose the persisted exchange-file document from a credential-free webrtc
 * locator, through the same {@link assembleExchangeSpec} the mint path
 * serializes, so one code path holds the assembly rule for both artifacts. The
 * connection is expanded from the locator through {@link connectionFromLocator}
 * (validated through the strict `WebRTCEndpointSchema`, so a credential-bearing
 * field is rejected rather than stripped); the schema's parse result, never the
 * raw input, is what the record persists, so no credential is representable in a
 * stored document and no `authentication` block is ever assembled.
 *
 * @throws {ZodError} if the assembled spec fails validation (an out-of-range port,
 *   a malformed locator, a smuggled unknown key on the locator).
 */
export function composeManagedExchangeFile(
  composition: ManagedExchangeFileComposition,
): ExchangeSpec {
  return assembleExchangeSpec({
    ...composition,
    connection: connectionFromLocator(composition.connection),
  });
}

/** The fields a caller supplies to create a new managed exchange record. The
 * `id` and `schemaVersion` are assigned by {@link buildManagedExchangeRecord};
 * the local policy and bookkeeping fields default to absent (the opt-in
 * policy). */
export interface NewManagedExchange {
  /** The operator's display label (validated to {@link MAX_LABEL_LENGTH}). */
  label: string;
  /** The composed exchange-file document (see
   * {@link composeManagedExchangeFile}). */
  exchangeFile: ExchangeSpec;
  /** This party's side of the partnership. Present exactly when the document's
   * connection is webrtc (see {@link ManagedExchangeRecord.side}). */
  side?: ManagedExchangeSide;
  /** The current rotated shared secret. Absent only for a configuration-only
   * record, which holds settings to edit and export and runs nothing here (see
   * {@link ManagedExchangeRecord.sharedSecret}). */
  sharedSecret?: string;
  /** A working-folder grant, when the operator has already taken one. */
  workingDirectoryHandle?: FileSystemDirectoryHandle;
  /** The max-token-age policy, when the operator opts in. */
  tokenMaxAgeDays?: number;
  /** The `expires` stamp, when a policy is already in force. */
  expires?: string;
  /** The agreed run schedule, when saved as recurring. */
  schedule?: ManagedExchangeSchedule;
  /** Prior run bookkeeping to retain. Set only by an import, which restores
   * the artifact's snapshot of `lastRun` so the first wake after an import reads the
   * same catch-up state the source had; a freshly-created record has no run yet. */
  lastRun?: ManagedExchangeLastRun;
  /** A standing condition to retain. Set only by an import, for the reason
   * `lastRun` is: an import that dropped one would be a way to clear a condition
   * only the operator, a re-invite, or a delete may clear. */
  standingCondition?: ManagedStandingCondition;
  /** The relay registrar the exchange registers at, set only by an import of
   * a backup or a command-line pair naming one. */
  relayRegistrar?: RelayRegistrar;
  /** An unconfirmed relay key registration, set only by an import of a backup
   * or a key file recording one, so the first run here retries it. */
  relayRegistrationPendingSince?: string;
  /** Why no run can confirm {@link relayRegistrationPendingSince}, set only by
   * a backup import holding it beside the marker. */
  relayRegistrationPendingReason?: ManagedRelayRegistrationPendingReason;
}

/**
 * Build a complete {@link ManagedExchangeRecord} from the caller's fields: assign
 * a fresh `id` and the v4 `schemaVersion`, then validate the whole record through
 * the schema so the label cap, the credential-free document, and the secret
 * format are enforced at write. The optional local fields are attached only when
 * present, so an absent policy is an omitted key rather than an explicit
 * `undefined`; `standingCondition` is required, so it is always written, holding
 * {@link NO_STANDING_CONDITION} unless an import supplies one to retain.
 *
 * @throws {ZodError} if the assembled record is invalid (an over-long label, a
 *   malformed secret, a document holding an `authentication` block).
 */
export function buildManagedExchangeRecord(
  fields: NewManagedExchange,
): ManagedExchangeRecord {
  const record = {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    label: fields.label,
    exchangeFile: fields.exchangeFile,
    ...(fields.side !== undefined ? { side: fields.side } : {}),
    ...(fields.sharedSecret !== undefined
      ? { sharedSecret: fields.sharedSecret }
      : {}),
    ...(fields.workingDirectoryHandle !== undefined
      ? { workingDirectoryHandle: fields.workingDirectoryHandle }
      : {}),
    ...(fields.tokenMaxAgeDays !== undefined
      ? { tokenMaxAgeDays: fields.tokenMaxAgeDays }
      : {}),
    ...(fields.expires !== undefined ? { expires: fields.expires } : {}),
    ...(fields.schedule !== undefined ? { schedule: fields.schedule } : {}),
    ...(fields.lastRun !== undefined ? { lastRun: fields.lastRun } : {}),
    ...(fields.relayRegistrar !== undefined
      ? { relayRegistrar: fields.relayRegistrar }
      : {}),
    ...(fields.relayRegistrationPendingSince !== undefined
      ? { relayRegistrationPendingSince: fields.relayRegistrationPendingSince }
      : {}),
    ...(fields.relayRegistrationPendingReason !== undefined
      ? {
          relayRegistrationPendingReason: fields.relayRegistrationPendingReason,
        }
      : {}),
    standingCondition: fields.standingCondition ?? NO_STANDING_CONDITION,
  };
  return parseManagedExchangeRecord(record);
}

/** The rotation fields a successful run advances on the stored record: the
 * rotated secret always, the `expires` bound restamped from the max-age policy
 * (a string to set it, `null` to clear any standing bound), and the pending
 * relay registration. The only fields {@link applyManagedExchangeRotation}
 * touches, so a rotation write cannot hold a stale secret or a stale document
 * -- the persist-before-success write is structurally incapable of it (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "Persist-before-success ordering"). */
export interface ManagedExchangeRotation {
  /** The rotated shared secret (base64url) to persist as the current secret. */
  sharedSecret: string;
  /** The restamped bound to set, or `null` to clear any standing bound. */
  expires: string | null;
  /** The pending relay registration to store: the instant of the rotation,
   * on a record that names a relay registrar. Absent, the record keeps the
   * pending registration it held
   * ({@link pendingRelayRegistrationAfterRotation}). */
  relayRegistrationPendingSince?: string;
  /** Why the pending registration cannot be confirmed by a run, stored with
   * {@link relayRegistrationPendingSince}: a re-invite's. */
  relayRegistrationPendingReason?: ManagedRelayRegistrationPendingReason;
}

/** Why a pending relay registration cannot be confirmed by a run
 * ({@link ManagedExchangeRecord.relayRegistrationPendingReason}). */
export type ManagedRelayRegistrationPendingReason = "reinvite";

/** A record's pending relay registration: the marker and its reason. */
interface PendingRelayRegistration {
  since: string;
  reason?: ManagedRelayRegistrationPendingReason;
}

/**
 * The pending relay registration a rotation write leaves: the one the
 * rotation states, else the one the record held, since a rotation confirms
 * nothing -- on a record naming no registrar only an enrollment does. A
 * reason the record held is kept with the marker, since no rotation recovers
 * the key the registrar holds.
 */
function pendingRelayRegistrationAfterRotation(
  record: RunnableManagedExchangeRecord,
  rotation: ManagedExchangeRotation,
): PendingRelayRegistration | undefined {
  const since =
    rotation.relayRegistrationPendingSince ??
    record.relayRegistrationPendingSince;
  if (since === undefined) return undefined;
  const reason =
    rotation.relayRegistrationPendingReason ??
    record.relayRegistrationPendingReason;
  return reason === undefined ? { since } : { since, reason };
}

/**
 * Apply a rotation to a record, producing a validated new record with only the
 * rotated secret, the `expires` bound, and the pending relay registration
 * changed and the rotation-in-flight marker removed in the same write -- the
 * document, the label, the schedule, the handle, and the run bookkeeping
 * remain untouched. A string `expires` sets the bound; `null` clears it (a
 * policy dropped between runs must not leave a stale bound armed). The result
 * is re-validated through the schema, so a malformed rotated secret is
 * rejected here. The input record is not mutated.
 *
 * @throws {ZodError} if the rotated record is invalid (a malformed secret).
 */
export function applyManagedExchangeRotation(
  record: RunnableManagedExchangeRecord,
  rotation: ManagedExchangeRotation,
): RunnableManagedExchangeRecord {
  const next: ManagedExchangeRecord = {
    ...record,
    sharedSecret: rotation.sharedSecret,
  };
  if (rotation.expires === null) delete next.expires;
  else next.expires = rotation.expires;
  delete next.rotationInFlightSince;
  setPendingRelayRegistration(
    next,
    pendingRelayRegistrationAfterRotation(record, rotation),
  );
  return runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(next));
}

function setPendingRelayRegistration(
  next: ManagedExchangeRecord,
  pending: PendingRelayRegistration | undefined,
): void {
  delete next.relayRegistrationPendingSince;
  delete next.relayRegistrationPendingReason;
  if (pending === undefined) return;
  next.relayRegistrationPendingSince = pending.since;
  if (pending.reason !== undefined)
    next.relayRegistrationPendingReason = pending.reason;
}

/**
 * Raised when an enrollment's confirmation is laid over a record whose secret
 * moved while the registrar was being asked: the key it confirmed is not the
 * one the record now holds, so nothing is stored.
 */
export class ManagedRelayRegistrarStaleError extends Error {
  constructor() {
    super(
      "the exchange ran while the relay registrar was being asked, so the key " +
        "it confirmed is no longer this exchange's; enroll it again",
    );
    this.name = "ManagedRelayRegistrarStaleError";
  }
}

/**
 * Set the relay registrar a record registers at, once the registrar has
 * confirmed it holds the relay key derived from `confirmedSecret`, and drop
 * any pending registration with it; or, with `registrar` undefined, stop
 * registering, dropping the pending registration too, since nothing would
 * retry it. The input record is not mutated.
 *
 * @throws {ManagedRelayRegistrarStaleError} if `confirmedSecret` is not the
 *   secret the record holds.
 * @throws {ZodError} if the result is not a valid record.
 */
export function applyManagedExchangeRelayRegistrar(
  record: RunnableManagedExchangeRecord,
  registrar: RelayRegistrar | undefined,
  confirmedSecret?: string,
): RunnableManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  setPendingRelayRegistration(next, undefined);
  if (registrar === undefined) delete next.relayRegistrar;
  else {
    if (confirmedSecret !== record.sharedSecret)
      throw new ManagedRelayRegistrarStaleError();
    next.relayRegistrar = registrar;
  }
  return runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(next));
}

/**
 * Whether the invitation `record` was accepted from names a TURN relay. Its
 * runs then relay through the partner's relay, which the partner registers
 * at, so this browser registers nothing for it.
 */
export function managedExchangeRelaysThroughPartner(
  record: Pick<ManagedExchangeRecord, "exchangeFile">,
): boolean {
  const connection = record.exchangeFile.connection;
  return (
    connection.channel === "webrtc" &&
    (connection.invitationRelay?.turn ?? []).length > 0
  );
}

/**
 * Drop the pending relay key registration once the registrar confirmed it
 * holds the key derived from `confirmedSecret`. A record holding another
 * secret, or no pending registration, comes back unchanged, the same object.
 *
 * @throws {ZodError} if the result is not a valid record.
 */
export function applyManagedExchangeRelayRegistrationConfirmed(
  record: RunnableManagedExchangeRecord,
  confirmedSecret: string,
): RunnableManagedExchangeRecord {
  if (
    record.sharedSecret !== confirmedSecret ||
    record.relayRegistrationPendingSince === undefined
  )
    return record;
  const next: ManagedExchangeRecord = { ...record };
  setPendingRelayRegistration(next, undefined);
  return runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(next));
}

/**
 * Record the `payload.receive` a run filled from the partner's declared send
 * set into the record's terms, where they left it unset, so the next run holds
 * the partner to it. Everything else on the record is untouched, and the
 * result is re-validated through the schema. The input record is not mutated.
 *
 * @throws {Error} if the record's terms already state the list.
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangePayloadReceiveFill(
  record: ManagedExchangeRecord,
  columns: ReadonlyArray<string>,
): ManagedExchangeRecord {
  const terms = record.exchangeFile.linkageTerms;
  if (terms.payload?.receive !== undefined)
    throw new Error("the stored terms already state payload.receive");
  return parseManagedExchangeRecord({
    ...record,
    exchangeFile: {
      ...record.exchangeFile,
      linkageTerms: {
        ...terms,
        payload: {
          ...terms.payload,
          receive: columns.map((name) => ({ name })),
        },
      },
    },
  });
}

/**
 * How a record takes on a partner's changed linkage terms, mirroring the
 * writes the command line makes (docs/CLI.md, "When your partner's terms
 * change", and `alcove apply`):
 *
 * - `run`: an attended run took the change on at the terms exchange and
 *   continues under `adoptedTerms` (core's `TermsChange.adoptedTerms`), whose
 *   `payload.receive` follows the partner's send set; the `deduplicate` this
 *   party holds the partner to is left as it was, since the change is not to
 *   it.
 * - `apply`: the operator applied a change a run did not take on -- a stored
 *   proposal, or one the run could not continue under. The terms are derived
 *   from `partnerTerms` as an acceptance derives them, keeping this party's
 *   identity and `deduplicate` and mirroring the partner's `payload.send` into
 *   this party's `payload.receive`, and the partner is held to its stated
 *   `deduplicate`. A `lastRun` recording a refused
 *   terms change is dropped: the change it refused is the one applied, so a
 *   later visit has nothing left to answer.
 * - `update`: the operator applied a partner's terms update, as `alcove
 *   apply` writes one: as `apply` with the update's `linkageTerms`.
 */
export type ManagedTermsChangeWrite =
  | { scope: "run"; adoptedTerms: LinkageTerms; partnerTerms: LinkageTerms }
  | { scope: "apply"; partnerTerms: LinkageTerms }
  | { scope: "update"; update: TermsUpdate };

/**
 * Record a partner's changed linkage terms into the record's exchange file
 * ({@link ManagedTermsChangeWrite}); the connection, secret, and bookkeeping
 * are untouched. The result is
 * re-validated through the schema, and the input record is not mutated.
 *
 * @throws {UsageError} for an `apply` or `update` on a record whose terms
 *   name no identity for this party, or name one the terms cannot hold, or
 *   whose partner terms core's `deriveAcceptedLinkageTerms` refuses.
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangeTermsChange(
  record: ManagedExchangeRecord,
  write: ManagedTermsChangeWrite,
): ManagedExchangeRecord {
  const current = record.exchangeFile;
  const partnerTerms =
    write.scope === "update" ? write.update.linkageTerms : write.partnerTerms;
  let exchangeFile: ExchangeSpec;
  if (write.scope === "run") {
    exchangeFile = { ...current, linkageTerms: write.adoptedTerms };
  } else {
    const identity = current.linkageTerms.identity;
    if (identity === undefined)
      throw new UsageError(
        "this exchange's terms name no identity for this party, so your " +
          "partner's terms cannot be applied to it. Re-invite your partner.",
      );
    const linkageTerms = deriveAcceptedLinkageTerms(
      partnerTerms,
      identity,
      current.linkageTerms.deduplicate,
    );
    exchangeFile = {
      ...current,
      linkageTerms,
      expectedPartnerDeduplicate: partnerTerms.deduplicate,
    };
  }
  const next: ManagedExchangeRecord = { ...record, exchangeFile };
  if (write.scope !== "run" && record.lastRun?.failureKind === "terms-change")
    delete next.lastRun;
  return parseManagedExchangeRecord(next);
}

/**
 * Whether the operator can choose which of this party's own columns an
 * exchange sends: the document declares its columns (`metadata`), and its
 * terms send the partner payload columns at all -- not a count-only exchange,
 * and not one whose `output` gives the partner no result.
 */
export function managedSentColumnsEditable(
  exchangeFile: ExchangeSpec,
): boolean {
  const { algorithm, output } = exchangeFile.linkageTerms;
  return (
    exchangeFile.metadata !== undefined &&
    algorithm !== "psi-c" &&
    output.shareWithPartner
  );
}

/**
 * Whether a declared column's send choice is the operator's to change here: a
 * column that only carries payload, or is ignored. A column used to match or
 * as the record identifier changes with the linkage terms, not here.
 */
export function sentColumnChoiceOffered(column: ColumnMetadata): boolean {
  return column.role === "payload" || column.role === "ignored";
}

/**
 * Set which of the record's offered columns ({@link sentColumnChoiceOffered})
 * are sent to the partner: each named in `sent` is sent, each other one is
 * not, and every other column is left as it is. The terms' `payload.send` is
 * restated from the edited metadata (`termsStatingDeclaredPayloadSend`), so
 * the next run and a terms update state the new set. The connection, secret,
 * and bookkeeping are untouched; the input record is not mutated.
 *
 * @throws {UsageError} where the exchange offers no column choice
 *   ({@link managedSentColumnsEditable}) or `sent` names a column it does not
 *   offer.
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangeSentColumns(
  record: ManagedExchangeRecord,
  sent: ReadonlyArray<string>,
): ManagedExchangeRecord {
  const current = record.exchangeFile;
  if (!managedSentColumnsEditable(current) || current.metadata === undefined)
    throw new UsageError(
      "this exchange's terms send your partner no columns, so there is no " +
        "column choice to change",
    );
  const offered = new Set(
    current.metadata
      .filter(sentColumnChoiceOffered)
      .map((column) => column.name),
  );
  if (sent.some((name) => !offered.has(name)))
    throw new UsageError(
      "a column chosen to send is not one of this exchange's own payload " +
        "columns; reload the page and choose again",
    );
  const chosen = new Set(sent);
  const metadata = current.metadata.map((column) =>
    sentColumnChoiceOffered(column)
      ? applyDisclosure(column, chosen.has(column.name) ? "payload" : "ignored")
      : column,
  );
  return parseManagedExchangeRecord({
    ...record,
    exchangeFile: {
      ...current,
      metadata,
      linkageTerms: termsStatingDeclaredPayloadSend(
        current.linkageTerms,
        metadata,
      ),
    },
  });
}

/**
 * Apply a re-invite rotation to a record: advance the rotated secret and the
 * `expires` bound and remove the rotation-in-flight marker exactly as
 * {@link applyManagedExchangeRotation}, AND drop any `lastRun` bookkeeping. A
 * re-invite is the recovery for the failure `lastRun` recorded; leaving that
 * entry in place would re-derive the consumed failure at the next visit, and
 * once the import marker is cleared in the same rotation, a stale `auth`
 * failure would re-derive as the attack tier. Clearing it in the same
 * field-scoped write makes the post-re-invite record treated as holding no
 * failure to tier (see {@link ./managedFailureTiers.ts}). The document, the
 * label, the schedule, and the handle remain untouched; the input record is not
 * mutated.
 *
 * @throws {ZodError} if the rotated record is invalid (a malformed secret).
 */
export function applyManagedExchangeReinviteRotation(
  record: RunnableManagedExchangeRecord,
  rotation: ManagedExchangeRotation,
): RunnableManagedExchangeRecord {
  const next: ManagedExchangeRecord = {
    ...record,
    sharedSecret: rotation.sharedSecret,
  };
  if (rotation.expires === null) delete next.expires;
  else next.expires = rotation.expires;
  delete next.lastRun;
  delete next.rotationInFlightSince;
  setPendingRelayRegistration(
    next,
    pendingRelayRegistrationAfterRotation(record, rotation),
  );
  next.standingCondition = NO_STANDING_CONDITION;
  return runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(next));
}

/**
 * Mark a record's rotation as in flight at `since`, producing a validated new
 * record: the key exchange is about to start and may rotate the secret before
 * this device saves the result. A marker already present is kept with its
 * first instant, since the rotation it records has not completed since. Only
 * the marker changes; the input record is not mutated.
 *
 * @throws {ZodError} if the result is not a valid record.
 */
export function applyManagedExchangeRotationInFlight(
  record: RunnableManagedExchangeRecord,
  since: string,
): RunnableManagedExchangeRecord {
  if (record.rotationInFlightSince !== undefined) return record;
  return runnableManagedExchangeOrRefuse(
    parseManagedExchangeRecord({ ...record, rotationInFlightSince: since }),
  );
}

/**
 * Lay a record read from a command-line `alcove.yaml` and its `.alcove.key`
 * over the stored record it revives, producing a validated new record: the
 * document, `side`, max-age policy, and key pair come from the pair, an absent
 * `expires` or policy clearing the stored one, and everything the pair has no
 * field for -- the `id`, label, schedule, `lastRun`, standing condition, and
 * platform grants -- stays as stored, so the revive clears no condition only
 * the operator, a re-invite, or a delete may clear. A rotation-in-flight
 * marker goes with the stored secret when the pair replaces it. A pair naming
 * a relay registrar states the whole registration: its registrar and the key
 * file's pending registration, or none, replace the stored ones. A pair naming
 * none keeps the stored registrar, and the key file's pending registration
 * replaces the stored one only where it holds one. The inputs are not mutated.
 *
 * @throws {ZodError} if the result is not a valid record.
 */
export function applyManagedExchangeCommandLinePair(
  stored: ManagedExchangeRecord,
  imported: RunnableManagedExchangeRecord,
): RunnableManagedExchangeRecord {
  const next: ManagedExchangeRecord = {
    ...stored,
    exchangeFile: imported.exchangeFile,
    side: imported.side,
    sharedSecret: imported.sharedSecret,
  };
  if (imported.expires === undefined) delete next.expires;
  else next.expires = imported.expires;
  if (imported.tokenMaxAgeDays === undefined) delete next.tokenMaxAgeDays;
  else next.tokenMaxAgeDays = imported.tokenMaxAgeDays;
  if (imported.sharedSecret !== stored.sharedSecret)
    delete next.rotationInFlightSince;
  if (imported.relayRegistrar !== undefined) {
    next.relayRegistrar = imported.relayRegistrar;
    setPendingRelayRegistration(
      next,
      imported.relayRegistrationPendingSince === undefined
        ? undefined
        : { since: imported.relayRegistrationPendingSince },
    );
  } else if (imported.relayRegistrationPendingSince !== undefined)
    setPendingRelayRegistration(next, {
      since: imported.relayRegistrationPendingSince,
    });
  return runnableManagedExchangeOrRefuse(parseManagedExchangeRecord(next));
}

/**
 * Drop a `lastRun` recording the `handed-off` refusal -- a run that found this
 * device's copy spent ({@link ./managedExchangeRun.ts}) -- producing a validated
 * new record. The entry records a state a take-back ends, and left in place it
 * tiers the record that runs here again as handed off (see
 * {@link ./managedFailureTiers.ts}). Any other entry is run history and is kept,
 * as is a record holding none: both come back unchanged, the same object. The
 * refusal raises no standing condition ({@link standingConditionFrom}), so there
 * is none to answer with it. The input record is not mutated.
 *
 * @throws {ZodError} if the stored record is invalid.
 */
export function clearHandedOffLastRun(
  record: ManagedExchangeRecord,
): ManagedExchangeRecord {
  if (record.lastRun?.failureKind !== "handed-off") return record;
  const next: ManagedExchangeRecord = { ...record };
  delete next.lastRun;
  return parseManagedExchangeRecord(next);
}

/** Apply a `lastRun` bookkeeping entry to a record, producing a validated new
 * record with only `lastRun` changed. The document and the secret remain
 * untouched. Separate from a rotation write so the run outcome is recorded
 * without re-touching the rotated secret. The input record is not mutated.
 *
 * Two write rules drop an entry rather than store it, both comparing parsed
 * instants rather than strings, since the schema admits ISO datetimes of
 * varying fractional precision whose lexicographic order diverges from
 * chronological.
 *
 * Monotonic on `at`: an entry older than the stored one leaves the record
 * unchanged. The run+rotate lock serializes the runs it binds, but a failing
 * run's bookkeeping tail ({@link ./managedRun.ts}) is stamped and written after
 * its lock has released, so an entry stamped behind the stored one could
 * otherwise land after -- and mask -- a newer outcome; this guard makes the
 * stale write a no-op instead.
 *
 * A standing condition the entry raises ({@link standingConditionFrom}) is
 * raised whether or not the entry itself lands: the two rules below choose which
 * of two runs' STAMPS the record keeps, while the condition is not one run's
 * stamp but evidence nobody has answered yet, so the run that met it raises it
 * even where a newer entry keeps the `lastRun` slot.
 *
 * A failure never overwrites a success stamped after its own run began:
 * `runStartedAtMs` is the instant the run producing `lastRun` began, and a
 * non-`"succeeded"` outcome is dropped when the stored entry is a
 * `"succeeded"` one stamped at or after it. The `at` comparison alone does not
 * cover this: a failing run's tail is stamped after its lock has released, so
 * another context can run a whole exchange under the lock and record its
 * success in between, leaving the failure as the newer stamp that would land
 * over it. A success is the unrecoverable entry -- nothing re-derives it once
 * overwritten, and a scheduled window that then folds to a miss counts one that
 * was met -- so a stamp sharing the run's start instant is kept too.
 *
 * Neither rule holds for a stored stamp later than `nowMs`, the writer's clock:
 * a stamp from the future (a clock since corrected, or an imported record)
 * would otherwise drop every outcome until wall time passed it. */
export function applyManagedExchangeLastRun(
  record: ManagedExchangeRecord,
  lastRun: ManagedExchangeLastRun,
  runStartedAtMs: number,
  nowMs: number = Date.now(),
): ManagedExchangeRecord {
  const raised = withoutAnsweredRotationInFlight(
    withStandingCondition(record, standingConditionFrom(lastRun)),
    lastRun,
  );
  const stored = lastRunNotAfter(record.lastRun, nowMs);
  if (stored !== undefined && Date.parse(stored.at) > Date.parse(lastRun.at))
    return parseManagedExchangeRecord(raised);
  if (
    lastRun.outcome !== "succeeded" &&
    stored?.outcome === "succeeded" &&
    Date.parse(stored.at) >= runStartedAtMs
  )
    return parseManagedExchangeRecord(raised);
  return parseManagedExchangeRecord({ ...raised, lastRun });
}

/** The stored entry the `lastRun` write rules compare against: `undefined`
 * where it is stamped later than `nowMs`, so the incoming entry replaces it. */
function lastRunNotAfter(
  stored: ManagedExchangeLastRun | undefined,
  nowMs: number,
): ManagedExchangeLastRun | undefined {
  return stored !== undefined && Date.parse(stored.at) > nowMs
    ? undefined
    : stored;
}

/** Whether `lastRun` records an outcome that supersedes a rotation-in-flight
 * marker set at `since`: a key exchange that reached a verdict at or after the
 * marker -- it succeeded, failed closed, or could not save its rotation. A
 * no-show, a dropped connection, or a refusal before connecting says nothing
 * about the secret the partner holds, and leaves the marker standing. */
export function answersRotationInFlight(
  lastRun: ManagedExchangeLastRun,
  since: string,
): boolean {
  if (Date.parse(lastRun.at) < Date.parse(since)) return false;
  return (
    lastRun.outcome === "succeeded" ||
    standingConditionFrom(lastRun) !== undefined
  );
}

/** `record` with its rotation-in-flight marker removed where `lastRun`
 * supersedes it ({@link answersRotationInFlight}), removed whether or not the
 * entry itself lands, as the condition it raises is. A marker set after the
 * entry's stamp belongs to a later run and stays. */
function withoutAnsweredRotationInFlight(
  record: ManagedExchangeRecord,
  lastRun: ManagedExchangeLastRun,
): ManagedExchangeRecord {
  const since = record.rotationInFlightSince;
  if (since === undefined || !answersRotationInFlight(lastRun, since))
    return record;
  const next: ManagedExchangeRecord = { ...record };
  delete next.rotationInFlightSince;
  return next;
}

/** The standing condition a `lastRun` entry raises, or `undefined` for an entry
 * that raises none. Read off the entry's own `failureKind`, so the stamp a run
 * writes and the condition it raises cannot disagree about what failed. */
export function standingConditionFrom(
  lastRun: ManagedExchangeLastRun,
): ManagedStandingCondition | undefined {
  const kind = lastRun.failureKind;
  if (kind !== "auth" && kind !== "storage") return undefined;
  return { since: lastRun.at, kind };
}

/** The raised condition a record holds, or `undefined` where its
 * `standingCondition` records that none stands. The one place the none form is
 * read, so every surface asks the field the same question. */
export function raisedStandingCondition(
  record: ManagedExchangeRecord,
): ManagedStandingCondition | undefined {
  const condition = record.standingCondition;
  return condition.kind === "none" ? undefined : condition;
}

/** The compromise response standing on a record, or `undefined` where the
 * operator has answered no gate. A response rides on the condition it answers,
 * so a record holding none holds no response either. */
export function standingCompromiseResponse(
  record: ManagedExchangeRecord,
): ManagedStandingResponse | undefined {
  return raisedStandingCondition(record)?.response;
}

/** Raise a standing condition on a record, unless one already stands or there is
 * none to raise. First raise wins: the standing condition is the one the operator
 * has yet to answer, and answering it is a single act over everything that stood
 * before it. The input record is not mutated. */
function withStandingCondition(
  record: ManagedExchangeRecord,
  condition: ManagedStandingCondition | undefined,
): ManagedExchangeRecord {
  if (condition === undefined || raisedStandingCondition(record) !== undefined)
    return record;
  return { ...record, standingCondition: condition };
}

/** Apply the operator's clear-and-acknowledge to a record, producing a validated
 * new record whose `standingCondition` is back to {@link NO_STANDING_CONDITION}
 * -- the run bookkeeping, the secret, and the document remain untouched. A record
 * holding none is returned unchanged. The input record is not mutated.
 *
 * @throws {ZodError} if the stored record is invalid. */
export function applyManagedExchangeStandingConditionCleared(
  record: ManagedExchangeRecord,
): ManagedExchangeRecord {
  return parseManagedExchangeRecord({
    ...record,
    standingCondition: NO_STANDING_CONDITION,
  });
}

/**
 * Apply the operator's compromise response -- "something does not add up" at a
 * failure gate -- to a record, producing a validated new record whose standing
 * condition holds it. The secret, the document, and the run bookkeeping remain
 * untouched, and the input record is not mutated.
 *
 * First answer stands: a record already holding one comes back unchanged, the
 * same object, so a second gate cannot restamp the instant of the first.
 *
 * The answer always has a carrier. Where no condition stands -- the raise write
 * the failure earned never landed -- this write raises one, of the `"auth"` kind
 * at the last run's instant (the failure being answered) or at `at` where the
 * record holds no run either. Without it the answer would have nowhere to live,
 * and the gate would be put again at the next visit.
 *
 * @throws {ZodError} if the stored record is invalid, or `at` is not an ISO 8601
 *   UTC instant.
 */
export function applyManagedExchangeCompromiseResponse(
  record: ManagedExchangeRecord,
  at: string,
): ManagedExchangeRecord {
  const standing = raisedStandingCondition(record);
  if (standing?.response !== undefined) return record;
  const carrier: ManagedStandingCondition = standing ?? {
    since: record.lastRun?.at ?? at,
    kind: "auth",
  };
  return parseManagedExchangeRecord({
    ...record,
    standingCondition: { ...carrier, response: { kind: "compromise", at } },
  });
}

/** Whether two stored instants denote the same moment, compared as parsed
 * instants for the precision reason {@link applyManagedExchangeLastRun} gives.
 * A string {@link parseStoredInstant} cannot read parses to `NaN`, which never
 * equals itself, so it matches nothing -- holding a conditioned write off a plan
 * it cannot read. */
function sameStoredInstant(left: string, right: string): boolean {
  return parseStoredInstant(left) === parseStoredInstant(right);
}

/** The schedule bookkeeping one closed window produces, written as a unit: the
 * advanced schedule and, when the window earned one, the run entry that goes with
 * it. `nextWindow`, `consecutiveMisses`, and `lastRun` describe a single window's
 * disposition, so a reader must never see a count advanced past a window whose
 * planned attempt has not moved, or the reverse. */
export interface ManagedExchangeScheduleAdvance {
  /** The schedule with `nextWindow` and `consecutiveMisses` advanced. Its
   * `anchor`, `intervalDays`, and `windowSeconds` are the cadence the advance was
   * computed against, and are matched against the stored record rather than
   * written (see {@link applyManagedExchangeScheduleAdvance}). */
  schedule: ManagedExchangeSchedule;
  /** The `nextWindow` the advance was computed FROM, matched against the stored
   * one exactly as the cadence is: the advance is the successor of that one
   * plan, so it lands only while the record still holds it. */
  fromNextWindow: string;
  /** The `consecutiveMisses` the advance was computed FROM, matched the same
   * way: the count is the escalation's own input, and an operator may clear it
   * on the plan the wake is running, so an advance that counted from the old
   * value must not restore it. */
  fromConsecutiveMisses: number;
  /** The window's run bookkeeping. Omitted when the window produced none -- one
   * the single-writer lock was held through, or one a run already recorded its
   * own outcome for. */
  lastRun?: ManagedExchangeLastRun;
  /** The standing condition the window's run raised, carried here so a window
   * whose run could not write its own stamp still leaves the evidence behind
   * (see {@link ./managedScheduleRunner.ts}). Omitted when the window raised
   * none. */
  standingCondition?: ManagedStandingCondition;
}

/** Apply a scheduled window's bookkeeping to a record, producing a validated new
 * record with `schedule` and `lastRun` advanced together and everything else --
 * the document, the secret, the handle -- stays untouched. The input
 * record is not mutated. This is the runner's write; the attended run path
 * records `lastRun` alone and never touches `schedule`.
 *
 * Conditioned on the whole stored plan, which the operator may edit and another
 * wake may advance at any time: the write lands only while the record still
 * holds the cadence the advance was computed against (`anchor`, `intervalDays`,
 * `windowSeconds`) AND still plans the `nextWindow` and holds the
 * `consecutiveMisses` it was computed from. Any other stored schedule leaves the
 * record entirely unchanged; a wake against the stored plan recomputes both.
 *
 * The stored instants are compared as parsed moments rather than strings, for
 * the varying-ISO-precision reason {@link applyManagedExchangeLastRun} states.
 *
 * `lastRun` alone stays monotonic on `at`, the first of the rules
 * {@link applyManagedExchangeLastRun} holds: the schedule advance still applies
 * -- the window did close, whatever landed afterwards -- while a bookkeeping
 * entry staler than the stored one is dropped rather than masking a newer
 * outcome. The entry an advance carries is the catch-up walk's, stamped at an
 * already-closed window, or a skipped window's own, rather than a run in
 * flight, so the monotonic rule is what holds a newer success off it and there
 * is no run start to state.
 * Both stamps are read through {@link parseStoredInstant} rather than
 * `Date.parse`, so a stamp having no UTC designator compares as no run at all,
 * letting the window's own bookkeeping land over it. A stored stamp later than
 * `nowMs` holds nothing off, for the reason {@link applyManagedExchangeLastRun}
 * gives.
 *
 * A standing condition the advance carries is raised under the same plan
 * condition as the rest -- it is this write's second chance at evidence the
 * window's own run may not have persisted, not a guarantee. */
export function applyManagedExchangeScheduleAdvance(
  record: ManagedExchangeRecord,
  advance: ManagedExchangeScheduleAdvance,
  nowMs: number = Date.now(),
): ManagedExchangeRecord {
  const stored = record.schedule;
  if (
    stored === undefined ||
    !sameStoredInstant(stored.anchor, advance.schedule.anchor) ||
    stored.intervalDays !== advance.schedule.intervalDays ||
    stored.windowSeconds !== advance.schedule.windowSeconds ||
    !sameStoredInstant(stored.nextWindow, advance.fromNextWindow) ||
    stored.consecutiveMisses !== advance.fromConsecutiveMisses
  )
    return parseManagedExchangeRecord(record);
  const next: ManagedExchangeRecord = {
    ...withStandingCondition(record, advance.standingCondition),
    schedule: advance.schedule,
  };
  const storedAtMs =
    record.lastRun === undefined
      ? Number.NaN
      : parseStoredInstant(record.lastRun.at);
  if (
    advance.lastRun !== undefined &&
    !(
      storedAtMs > parseStoredInstant(advance.lastRun.at) && storedAtMs <= nowMs
    )
  )
    next.lastRun = advance.lastRun;
  return parseManagedExchangeRecord(next);
}

/**
 * Apply a working-folder grant to a record, producing a validated new record with
 * only `workingDirectoryHandle` changed. A `FileSystemDirectoryHandle` sets (or
 * re-points) the grant; `null` drops it, which leaves no run of this exchange
 * able to read its input with nobody present. Field-scoped, separate from a
 * rotation or a local edit, so taking a folder grant cannot hold a stale secret
 * or a stale document back over a concurrent write. The input record is not
 * mutated.
 *
 * @throws {ZodError} if the resulting record is invalid.
 */
export function applyManagedExchangeWorkingDirectory(
  record: ManagedExchangeRecord,
  handle: FileSystemDirectoryHandle | null,
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  if (handle === null) delete next.workingDirectoryHandle;
  else next.workingDirectoryHandle = handle;
  return parseManagedExchangeRecord(next);
}

/** The local fields an operator may edit in place without a re-invite: the
 * display label, the run schedule, the max-token-age policy, and the three
 * per-party settings of the document that are not terms (its own-columns
 * choice, its field delimiter, and its retention note). The agreed terms, the
 * connection, and the secret are not editable here: the columns this party
 * sends change in place through {@link applyManagedExchangeSentColumns}, while
 * a change to the match or identifier columns is a new exchange. */
export interface ManagedExchangeLocalEdits {
  /** A new display label (validated to {@link MAX_LABEL_LENGTH}). */
  label?: string;
  /** A new run schedule, or `null` to drop it (revert to attended-only). */
  schedule?: ManagedExchangeSchedule | null;
  /** A new max-token-age policy, or `null` to drop it. */
  tokenMaxAgeDays?: number | null;
  /** A new `includeOwnColumns` for the document, or `null` to drop it. */
  includeOwnColumns?: OwnColumnSelection | null;
  /** A new `csvDelimiter` for the document, or `null` to drop it (a comma). */
  csvDelimiter?: string | null;
  /** A new `retentionDisposition` for the document, or `null` to drop it. */
  retentionDisposition?: string | null;
}

/** The edits that change the document rather than a record field. */
const LOCAL_DOCUMENT_EDIT_FIELDS = [
  "includeOwnColumns",
  "csvDelimiter",
  "retentionDisposition",
] as const satisfies ReadonlyArray<
  keyof ManagedExchangeLocalEdits & keyof ExchangeSpec
>;

/**
 * Apply local edits to a record, producing a validated new record. Only the
 * label, schedule, max-token-age policy, and the document's three per-party
 * settings update in place; a `null` drops the corresponding optional field. The
 * result is re-validated through the schema, so an over-long label, a refused
 * delimiter, or an own-columns choice on a count-only exchange is rejected here
 * exactly as at create or import. The input record is not mutated.
 *
 * An edit to `tokenMaxAgeDays` re-derives `expires` conservatively through
 * {@link deriveEditedExpiry}: a shorter policy recomputes the bound from the
 * reconstructed advance anchor, a longer one keeps the current bound (it takes
 * effect only at the next rotation), an added policy stamps `now + days`, and a
 * cleared policy drops the bound. The rule never moves `expires` later, so an edit
 * cannot stretch a stored credential's life without a rotation (see
 * {@link ./managedTokenAgeEdit.ts}). `now` is the anchor for an added policy;
 * default `Date.now()` for callers that do not inject a clock. An edit that does
 * not touch `tokenMaxAgeDays` leaves `expires` untouched.
 *
 * @throws {ZodError} if the edited record is invalid.
 */
export function applyManagedExchangeLocalEdits(
  record: ManagedExchangeRecord,
  edits: ManagedExchangeLocalEdits,
  now: number = Date.now(),
): ManagedExchangeRecord {
  const next: ManagedExchangeRecord = { ...record };
  if (edits.label !== undefined) next.label = edits.label;
  if (edits.schedule !== undefined) {
    if (edits.schedule === null) delete next.schedule;
    else next.schedule = edits.schedule;
  }
  if (LOCAL_DOCUMENT_EDIT_FIELDS.some((field) => edits[field] !== undefined)) {
    const exchangeFile: ExchangeSpec = { ...record.exchangeFile };
    if (edits.includeOwnColumns === null) delete exchangeFile.includeOwnColumns;
    else if (edits.includeOwnColumns !== undefined)
      exchangeFile.includeOwnColumns = edits.includeOwnColumns;
    if (edits.csvDelimiter === null) delete exchangeFile.csvDelimiter;
    else if (edits.csvDelimiter !== undefined)
      exchangeFile.csvDelimiter = edits.csvDelimiter;
    if (edits.retentionDisposition === null)
      delete exchangeFile.retentionDisposition;
    else if (edits.retentionDisposition !== undefined)
      exchangeFile.retentionDisposition = edits.retentionDisposition;
    next.exchangeFile = exchangeFile;
  }
  if (edits.tokenMaxAgeDays !== undefined) {
    if (edits.tokenMaxAgeDays === null) delete next.tokenMaxAgeDays;
    else next.tokenMaxAgeDays = edits.tokenMaxAgeDays;
    // `expires` bounds the stored secret, so a record holding none takes the
    // policy alone: the bound is stamped by the run that gives it a secret.
    if (record.sharedSecret !== undefined) {
      const expires = deriveEditedExpiry(record, edits.tokenMaxAgeDays, now);
      if (expires === null) delete next.expires;
      else next.expires = expires;
    }
  }
  return parseManagedExchangeRecord(next);
}
