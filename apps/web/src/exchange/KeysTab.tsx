import { useId, useMemo } from "react";

import {
  ActionIcon,
  Alert,
  Anchor,
  Checkbox,
  Input,
  Radio,
  Switch,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

import {
  CONTACT_AND_LOCATION_FIELD_TYPES,
  COUNT_ONLY_DECLARED_STRATEGY_STATEMENT,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  LESS_CERTAIN_KEY_COPY,
  LinkageStrategySchema,
  PRECISION_FLOORS,
  linkageKeyIsLessCertain,
  precisionFloorLabel,
  runsSinglePassLink,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  LINKAGE_STRATEGY_LABEL,
  LINKAGE_STRATEGY_OPTION_COPY,
  SINGLE_PASS_DISCLOSURE_BODY,
  SINGLE_PASS_DISCLOSURE_TITLE,
} from "@psi/linkageStrategyChoice";
import {
  USE_BUILT_IN_RULES_LABEL,
  buildAdvancedTerms,
} from "@psi/authoring/advancedInvite";

import { ConfirmedActionButton } from "@components/ConfirmedActionButton";
import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { InfoButton } from "@components/InfoButton";
import { LessCertainInfo } from "@components/LessCertainInfo";
import { TermsImportExport } from "@components/TermsImportExport";

import {
  AUTHORED_KEYS_FLOOR_NOTE,
  BUILT_IN_RULES_INFO,
  HIGHEST_PRECISION_UNAVAILABLE_REASON,
  MATCHING_KEYS_LESS_CERTAIN_REMEDY,
  OPENED_CONFIGURATION_KEYS_NOTE,
  USE_BUILT_IN_RULES_STATEMENT,
  declaredFieldsFor,
  editorOffersUseBuiltInRules,
  highestPrecisionHeldWithoutRules,
  highestPrecisionUnavailable,
  keyOrderHelp,
  keySatisfiabilityFor,
  seedRows,
} from "@psi/inviterEditor";

import styles from "@styles/app.module.css";

import { BUILT_IN_RULES_GUIDE_URL } from "./userGuide";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type {
  AdvancedInviteDraft,
  CleaningNotLoaded,
} from "@psi/authoring/advancedInvite";
import type {
  LinkageStrategy,
  LinkageTerms,
  PrecisionFloorSelection,
  Standardization,
} from "@alcove/core";

/** The types the guided list states the shared-value caveat beside. */
const SHARED_VALUE_CAVEAT_TYPES: ReadonlySet<string> = new Set([
  ...CONTACT_AND_LOCATION_FIELD_TYPES,
  "street_number",
  "state",
  "county",
]);

/** The caveat beside guided keys over a phone, email, street number, ZIP,
 * state or county field. */
const SHARED_VALUE_CAVEAT =
  "A phone number or email address many people share, such as a shelter's " +
  "phone or a site's email, matches people who are not the same person. A " +
  "street number, ZIP code, state, or county column must hold each person's " +
  "own, never that of a site that serves them.";

/**
 * The Matching keys tab: the built-in rule choice the guided keys are drawn from
 * the built-in catalog with, the guided ordered key list (enable + reorder),
 * the expert switch that opens element-by-element authoring and terms
 * import/export, and the matching settings -- the linkage strategy and
 * deduplication controls, each live while the exchange applies what it writes.
 *
 * The list holds the built-in keys the chosen floor selects for these
 * columns, each with a checkbox and the reorder pair, and a key core marks
 * less certain (`linkageKeyIsLessCertain`) states the mark in its label with
 * the button that explains it. Highest precision is disabled, naming the
 * columns it needs, while the columns supply none of its rules; still chosen
 * then, it keeps the list empty and that reason replaces the key error
 * (`highestPrecisionHeldWithoutRules`). The floor is withheld once the keys were
 * written in Expert authoring or loaded from a document, with a note saying
 * so and, where the file supplies a built-in
 * rule, an action that replaces those keys, fields and cleaning with a new
 * invitation's: no floor selected them. On the console, keys an opened
 * configuration states (`keysFromOpenedConfiguration`,
 * `@exchange/inviterScreenModel`), authored or guided, get a note naming the
 * file and the command that change them in place of the floor, and no action.
 */
export function KeysTab({
  editor,
  csv,
  expertMode,
  onExpertMode,
  onPrecisionFloorSelection,
  onUseBuiltInRules,
  keysFromOpenedConfiguration = false,
  onKeyEnabled,
  onKeyMoved,
  onAuthoredDraft,
  onStrategy,
  onDeduplicate,
  onImport,
  keysError,
  announce,
  onBack,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  expertMode: boolean;
  onExpertMode: (on: boolean) => void;
  /** Reseed the guided keys at a built-in rule choice. */
  onPrecisionFloorSelection: (selection: PrecisionFloorSelection) => void;
  /** Replace keys written in Expert authoring or loaded from a document, with
   * their fields and cleaning, by a new invitation's, once the operator
   * confirms. */
  onUseBuiltInRules: () => void;
  /** Whether the keys are an opened configuration's, which the partner
   * agreed to (`keysFromOpenedConfiguration`, `@exchange/inviterScreenModel`):
   * no action here replaces them. */
  keysFromOpenedConfiguration?: boolean;
  onKeyEnabled: (index: number, enabled: boolean) => void;
  onKeyMoved: (index: number, offset: -1 | 1) => void;
  onAuthoredDraft: (draft: AdvancedInviteDraft) => void;
  onStrategy: (strategy: LinkageStrategy) => void;
  onDeduplicate: (deduplicate: boolean) => void;
  /** Load imported terms and a pasted configuration's cleaning steps; returns
   * the cleaning that did not load. */
  onImport: (
    terms: LinkageTerms,
    standardization: Standardization | undefined,
  ) => ReadonlyArray<CleaningNotLoaded>;
  /** The validation message for the key set, rendered inline beside the list
   * it names (the work column's Problems block shows it too). */
  keysError: string | undefined;
  announce: (message: string) => void;
  onBack: () => void;
}) {
  const keyVerdict = useMemo(() => keySatisfiabilityFor(editor), [editor]);
  const declaredFields = useMemo(
    () => declaredFieldsFor(editor.draft),
    [editor.draft],
  );
  const currentTerms = useMemo(
    () => buildAdvancedTerms(editor.draft),
    [editor.draft],
  );
  // Types a field as the built terms do, so for terms that can be generated
  // this list and the partner's acceptance screen agree. A field the terms
  // omit (a turned-off key's, or a turned-on key's the columns cannot supply,
  // which blocks generation) takes the columns' type, then the loaded
  // document's, the order the terms' own reconciliation uses. A later entry
  // wins.
  const keyFields = useMemo(
    () => [
      ...(editor.draft.importedLinkageFields ?? []),
      ...declaredFields,
      ...currentTerms.linkageFields,
    ],
    [declaredFields, editor.draft.importedLinkageFields, currentTerms],
  );
  const keysAuthored = editor.keysAuthored === true;
  const offersUseBuiltInRules = useMemo(
    () => editorOffersUseBuiltInRules(editor, keysFromOpenedConfiguration),
    [editor, keysFromOpenedConfiguration],
  );
  const selection =
    editor.draft.precisionFloorSelection ?? DEFAULT_PRECISION_FLOOR_SELECTION;
  const highestUnavailable = useMemo(
    () => highestPrecisionUnavailable(editor),
    [editor],
  );
  const highestHeldWithoutRules = useMemo(
    () => highestPrecisionHeldWithoutRules(editor),
    [editor],
  );
  const builtInRulesLabelId = useId();
  const builtInRulesDescriptionId = useId();
  const builtInRulesName = useId();
  const keyCount = editor.draft.keys.length;
  const showsSharedValueKey = useMemo(() => {
    const typeOf = new Map(
      declaredFields.map((field) => [field.name, field.type]),
    );
    return editor.draft.keys.some(
      (entry) =>
        entry.enabled &&
        entry.key.elements.some((element) => {
          const type = typeOf.get(element.field);
          return type !== undefined && SHARED_VALUE_CAVEAT_TYPES.has(type);
        }),
    );
  }, [editor.draft.keys, declaredFields]);
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"\u2190"} Back to Review &amp; create
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1}>Matching keys</h1>
      {keysFromOpenedConfiguration && (
        <Alert variant="light" color="gray" role="note" my="sm">
          {OPENED_CONFIGURATION_KEYS_NOTE}
        </Alert>
      )}
      {keysAuthored && !keysFromOpenedConfiguration && (
        <Alert variant="light" color="gray" role="note" my="sm">
          <p>{AUTHORED_KEYS_FLOOR_NOTE}</p>
          {offersUseBuiltInRules && (
            <ConfirmedActionButton
              label={USE_BUILT_IN_RULES_LABEL}
              variant="default"
              statement={USE_BUILT_IN_RULES_STATEMENT}
              onConfirm={onUseBuiltInRules}
            />
          )}
        </Alert>
      )}
      {!keysAuthored && !keysFromOpenedConfiguration && (
        <InfoButton
          label={BUILT_IN_RULES_INFO.label}
          explanation={
            <>
              {BUILT_IN_RULES_INFO.explanation}{" "}
              <Anchor
                inherit
                href={BUILT_IN_RULES_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
              >
                {BUILT_IN_RULES_INFO.linkText}
              </Anchor>
            </>
          }
          controls={(explanationId) => (
            <>
              <Input.Description id={builtInRulesDescriptionId}>
                Changing this lists the rules it selects that your file
                supplies, in the built-in order. Keys you turned off stay off,
                and keys it adds are turned on.
              </Input.Description>
              {/* Not Radio.Group: the button beside the label would sit inside
                  that label, and the group's name would take in the button's.
                  Each radio takes the explanation. */}
              <div
                role="radiogroup"
                aria-labelledby={builtInRulesLabelId}
                aria-describedby={builtInRulesDescriptionId}
              >
                {PRECISION_FLOORS.map((floor) => {
                  const unavailable =
                    floor === PRECISION_FLOORS[0] && highestUnavailable;
                  return (
                    <Radio
                      key={floor}
                      name={builtInRulesName}
                      value={String(floor)}
                      checked={selection.floor === floor}
                      onChange={() =>
                        onPrecisionFloorSelection({ ...selection, floor })
                      }
                      label={precisionFloorLabel(floor)}
                      disabled={unavailable}
                      description={
                        unavailable
                          ? HIGHEST_PRECISION_UNAVAILABLE_REASON
                          : undefined
                      }
                      aria-describedby={explanationId}
                      mt="xs"
                    />
                  );
                })}
              </div>
            </>
          )}
        >
          <Input.Label id={builtInRulesLabelId} labelElement="div">
            Built-in rules
          </Input.Label>
        </InfoButton>
      )}
      <p id="key-order-help">
        {keyOrderHelp(editor, keysFromOpenedConfiguration)}
      </p>
      <ol className={styles.guidedKeys} aria-describedby="key-order-help">
        {editor.draft.keys.map((entry, index) => {
          const displayName = sanitizeForDisplay(entry.key.name);
          const lessCertain = linkageKeyIsLessCertain(entry.key, keyFields);
          const checkbox = (explanationId?: string) => (
            <Checkbox
              aria-describedby={explanationId}
              checked={entry.enabled}
              onChange={(event) =>
                onKeyEnabled(index, event.currentTarget.checked)
              }
              label={
                <>
                  Key {index + 1} -{" "}
                  <span className={styles.mono}>{displayName}</span>
                  {lessCertain && ` (${LESS_CERTAIN_KEY_COPY.mark})`}
                </>
              }
            />
          );
          return (
            <li key={entry.key.name}>
              {lessCertain ? (
                <LessCertainInfo
                  keyName={displayName}
                  remedy={
                    keysFromOpenedConfiguration
                      ? MATCHING_KEYS_LESS_CERTAIN_REMEDY.openedConfiguration
                      : MATCHING_KEYS_LESS_CERTAIN_REMEDY.checkbox
                  }
                >
                  {checkbox}
                </LessCertainInfo>
              ) : (
                checkbox()
              )}
              <span className={styles.movers}>
                <ActionIcon
                  variant="default"
                  aria-label={`Move ${displayName} earlier`}
                  disabled={index === 0}
                  onClick={() => onKeyMoved(index, -1)}
                >
                  <IconArrowUp size={15} />
                </ActionIcon>
                <ActionIcon
                  variant="default"
                  aria-label={`Move ${displayName} later`}
                  disabled={index === keyCount - 1}
                  onClick={() => onKeyMoved(index, 1)}
                >
                  <IconArrowDown size={15} />
                </ActionIcon>
              </span>
            </li>
          );
        })}
      </ol>
      {showsSharedValueKey && (
        <Alert variant="light" color="gray" role="note" my="sm">
          {SHARED_VALUE_CAVEAT}
        </Alert>
      )}
      {keysError !== undefined && !highestHeldWithoutRules && (
        <p
          role="alert"
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineDanger}`}
        >
          {keysError}
        </p>
      )}
      <Switch
        label="Expert authoring"
        description="Build linkage keys element by element, edit transforms and swaps, and import or export the terms as JSON or YAML. Editing keys here replaces the choice of built-in rules above."
        checked={expertMode}
        onChange={(event) => onExpertMode(event.currentTarget.checked)}
        my="md"
      />
      {expertMode ? (
        <ExpertKeyEditor
          draft={editor.draft}
          declaredFields={declaredFields}
          keyVerdict={keyVerdict}
          onChange={onAuthoredDraft}
          announce={announce}
        />
      ) : (
        <Alert variant="light" color="gray" role="note">
          Turn on expert authoring to edit keys element by element and to import
          or export the terms.
        </Alert>
      )}
      <h2>Matching settings</h2>
      <Radio.Group
        label={LINKAGE_STRATEGY_LABEL}
        value={editor.draft.linkageStrategy}
        // Parsed rather than trusted so a Radio value literal drifting from
        // the enum throws loudly instead of typechecking clean.
        onChange={(value) => onStrategy(LinkageStrategySchema.parse(value))}
      >
        <Radio
          value="cascade"
          label={LINKAGE_STRATEGY_OPTION_COPY.cascade.label}
          description={LINKAGE_STRATEGY_OPTION_COPY.cascade.description}
          mt="xs"
        />
        <Radio
          value="single-pass"
          label={LINKAGE_STRATEGY_OPTION_COPY["single-pass"].label}
          description={LINKAGE_STRATEGY_OPTION_COPY["single-pass"].description}
          mt="xs"
        />
      </Radio.Group>
      {runsSinglePassLink(editor.draft) && (
        <Alert
          color="yellow"
          title={SINGLE_PASS_DISCLOSURE_TITLE}
          // Pinned so the consent-critical warning is announced on selection
          // even if Mantine's default role changes.
          role="alert"
          mt="sm"
        >
          {SINGLE_PASS_DISCLOSURE_BODY}
        </Alert>
      )}
      {editor.draft.algorithm === "psi-c" && (
        <Alert variant="light" color="gray" role="note" mt="sm">
          {COUNT_ONLY_DECLARED_STRATEGY_STATEMENT}
        </Alert>
      )}
      {/* The accepting party's own side of the cardinality is not this control's
      to set: acceptance derives it as false, so what this authors is one-sided
      by construction. */}
      <Checkbox
        label="Allow several of your records to match one partner record"
        checked={editor.draft.deduplicate}
        onChange={(event) => onDeduplicate(event.currentTarget.checked)}
        mt="md"
      />
      {expertMode && (
        <>
          <h2>Import or export</h2>
          <p className={`${styles.small} ${styles.sub}`}>
            Reuse these terms between exchanges, or keep them under version
            control.
          </p>
          <TermsImportExport
            currentTerms={currentTerms}
            seed={editor.seed}
            rawRows={seedRows(csv)}
            dateInputFormats={csv.dateInputFormats}
            onImport={onImport}
          />
        </>
      )}
    </>
  );
}
