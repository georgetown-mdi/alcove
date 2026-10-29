// The next step the CLI states beneath a refusal over a difference in the
// linkage terms (core's `termsDifferenceRefusedBy`), by which party refused and
// by the kind of run: a run from a configuration and key file, which settles
// terms through `alcove update` and `alcove apply`; an online invite or accept,
// which writes its configuration and key file only once the terms are agreed on,
// so a fresh invitation sets it up again; or a quick exchange, whose terms each
// party infers from its own input file.

import {
  CONTACT_AND_LOCATION_FIELD_TYPES,
  annotate,
  annotationKey,
  annotationOf,
  matchedFieldColumns,
  redactAndSanitizeForDisplay,
  termsDifferenceLocalKeys,
  termsDifferenceRefusedBy,
} from "@alcove/core";
import type {
  LinkageTerms,
  Metadata,
  TermsDifferenceRefusedBy,
} from "@alcove/core";

/**
 * The kind of run a terms refusal ended: `configured` for a run from a
 * configuration and key file (`alcove exchange`), `online-invitation` for an
 * online `alcove invite` or `alcove accept`, and `quick-exchange` for a run
 * with no shared secret.
 */
export type TermsRefusalRun =
  "configured" | "online-invitation" | "quick-exchange";

const ONLINE_INVITATION_NEXT_STEP =
  "Agree on the linkage terms with your partner, then set the exchange up " +
  "again from a fresh invitation with alcove invite or alcove accept.";

const QUICK_EXCHANGE_NEXT_STEP =
  "Agree with your partner on the columns your input files share and " +
  "the --linkage-strategy you both pass, then run again. A phone, email, " +
  "street number, ZIP, state, or county column in only one of the two files " +
  "makes the terms differ: the party whose file has it removes that " +
  "column, or you agree on the terms through an invitation (alcove invite, " +
  "then alcove accept).";

/**
 * The next step for each run and each party that refused.
 *
 * @internal exported for testing
 */
export const TERMS_REFUSAL_NEXT_STEPS: {
  readonly [R in TermsRefusalRun]: {
    readonly [B in TermsDifferenceRefusedBy]: string;
  };
} = {
  configured: {
    "this-party":
      "Agree on the linkage terms with your partner: to take on theirs, ask " +
      "them for an update made with alcove update and apply it with alcove " +
      "apply, or change your configuration to match theirs, then run the same " +
      "command again.",
    partner:
      "Agree on the linkage terms with your partner: to have them take on " +
      "yours, send them an update made with alcove update for them to apply " +
      "with alcove apply, or change your configuration to match theirs, then " +
      "run the same command again.",
  },
  "online-invitation": {
    "this-party": ONLINE_INVITATION_NEXT_STEP,
    partner: ONLINE_INVITATION_NEXT_STEP,
  },
  "quick-exchange": {
    "this-party": QUICK_EXCHANGE_NEXT_STEP,
    partner: QUICK_EXCHANGE_NEXT_STEP,
  },
};

const TERMS_REFUSAL_RUN = annotationKey<TermsRefusalRun>("terms refusal run");

/**
 * Record on `err` the kind of run it ended, so the command boundary that
 * renders a terms refusal states the next step for that run. Any error that
 * is not a terms refusal is returned unchanged.
 */
export function markTermsRefusalRun<E>(err: E, run: TermsRefusalRun): E {
  if (
    typeof err === "object" &&
    err !== null &&
    termsDifferenceRefusedBy(err) !== undefined
  )
    annotate(err, TERMS_REFUSAL_RUN, run);
  return err;
}

const QUICK_EXCHANGE_CONTACT_COLUMNS = annotationKey<string>(
  "quick exchange contact columns",
);

/** The types whose column the line names: the contact and location types, and
 * the street number, state and county the built-in keys also match on beside
 * a name and a date of birth. */
const NAMED_COLUMN_TYPES = [
  ...CONTACT_AND_LOCATION_FIELD_TYPES,
  "street_number",
  "state",
  "county",
] as const;

type ContactType = (typeof NAMED_COLUMN_TYPES)[number];

/** What each contact or location type is called in the line naming a column. */
const CONTACT_TYPE_LABELS: { readonly [T in ContactType]: string } = {
  phone_number: "phone number",
  email_address: "email address",
  zip_code: "ZIP code",
  street_number: "street number",
  state: "state",
  county: "county",
};

const isContactType = (type: string): type is ContactType =>
  (NAMED_COLUMN_TYPES as ReadonlyArray<string>).includes(type);

/**
 * The line naming this party's own phone, email, street number, ZIP, state and
 * county columns that the keys named `differingKeys` of its quick-exchange
 * terms match on, each header escaped for display, or `undefined` where those
 * keys match on none. Only the column each such field is bound to is named: a
 * second column of the same type is held back, not matched on. A column a key
 * that does not differ also reads is left out, as removing it would lose
 * those keys too.
 *
 * @internal exported for testing
 */
export function quickExchangeContactColumnsLine(
  metadata: Metadata,
  terms: LinkageTerms,
  differingKeys: ReadonlyArray<string>,
): string | undefined {
  const named = new Set(differingKeys);
  const differing: LinkageTerms = {
    ...terms,
    linkageKeys: terms.linkageKeys.filter((key) => named.has(key.name)),
  };
  const shared: LinkageTerms = {
    ...terms,
    linkageKeys: terms.linkageKeys.filter((key) => !named.has(key.name)),
  };
  const sharedColumns = new Set(
    matchedFieldColumns(metadata, shared, undefined).values(),
  );
  const contactTypeOf = new Map(
    terms.linkageFields.flatMap((field) =>
      isContactType(field.type) ? [[field.name, field.type] as const] : [],
    ),
  );
  const boundTypeByColumn = new Map<string, ContactType>();
  for (const [field, column] of matchedFieldColumns(
    metadata,
    differing,
    undefined,
  )) {
    const type = contactTypeOf.get(field);
    if (type !== undefined && !sharedColumns.has(column))
      boundTypeByColumn.set(column, type);
  }
  const columns = metadata.flatMap((column) => {
    const type = boundTypeByColumn.get(column.name);
    return type === undefined
      ? []
      : [
          `"${redactAndSanitizeForDisplay(column.name)}" ` +
            `(${CONTACT_TYPE_LABELS[type]})`,
        ];
  });
  if (columns.length === 0) return undefined;
  const one = columns.length === 1;
  const list = one
    ? columns[0]
    : `${columns.slice(0, -1).join(", ")} and ${columns.at(-1)}`;
  return (
    `Your file's ${one ? "column" : "columns"} ${list} ` +
    `${one ? "is" : "are"} matched on. Where your partner's file has no ` +
    `such column, remove ${one ? "it" : "that column"} from your file and ` +
    "run again, or agree on the terms through an invitation (alcove invite, " +
    "then alcove accept)."
  );
}

/**
 * Record on `err`, a quick exchange's failure, the line naming this party's
 * own phone, email, street number, ZIP, state and county columns
 * ({@link quickExchangeContactColumnsLine}), stated beneath a terms refusal
 * whose differing keys include one over such a column
 * (`termsDifferenceLocalKeys`). Any other error is returned unchanged.
 */
export function markQuickExchangeContactColumns<E>(
  err: E,
  metadata: Metadata,
  terms: LinkageTerms,
): E {
  if (
    typeof err !== "object" ||
    err === null ||
    termsDifferenceRefusedBy(err) === undefined
  )
    return err;
  const differingKeys = termsDifferenceLocalKeys(err);
  if (differingKeys === undefined) return err;
  const line = quickExchangeContactColumnsLine(metadata, terms, differingKeys);
  if (line !== undefined) annotate(err, QUICK_EXCHANGE_CONTACT_COLUMNS, line);
  return err;
}

/**
 * The next step beneath `err` when it is a refusal over a difference in the
 * linkage terms, else `undefined`. A refusal no run recorded itself on is
 * taken as a configured run's. A quick exchange's step is followed by the
 * line {@link markQuickExchangeContactColumns} recorded, where it did.
 */
export function termsRefusalNextStep(err: unknown): string | undefined {
  const refusedBy = termsDifferenceRefusedBy(err);
  if (refusedBy === undefined) return undefined;
  const run = annotationOf(err, TERMS_REFUSAL_RUN) ?? "configured";
  const step = TERMS_REFUSAL_NEXT_STEPS[run][refusedBy];
  const columns =
    run === "quick-exchange"
      ? annotationOf(err, QUICK_EXCHANGE_CONTACT_COLUMNS)
      : undefined;
  return columns === undefined ? step : `${step}\n${columns}`;
}
