import { useMemo } from "react";

import {
  ActionIcon,
  Alert,
  Checkbox,
  NativeSelect,
  Radio,
  Switch,
  VisuallyHidden,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

import {
  AlgorithmSchema,
  CONTACT_AND_LOCATION_FIELD_TYPES,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  LinkageStrategySchema,
  ONE_STATE_OR_METRO_AREA_HELP,
  ONE_STATE_OR_METRO_AREA_NOT_ASKED,
  ONE_STATE_OR_METRO_AREA_QUESTION,
  PRECISION_FLOORS,
  precisionFloorAsksCoverage,
  precisionFloorStatement,
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

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { TermsImportExport } from "@components/TermsImportExport";

import {
  AUTHORED_KEYS_FLOOR_NOTE,
  OPENED_CONFIGURATION_KEYS_NOTE,
  USE_BUILT_IN_RULES_STATEMENT,
  declaredFieldsFor,
  editorCitationDrop,
  editorOffersUseBuiltInRules,
  emptyGuidedKeysNotice,
  keyOrderHelp,
  keySatisfiabilityFor,
  seedRows,
} from "@psi/inviterEditor";

import styles from "@styles/app.module.css";

import { CitationDropNotice } from "./CitationDropNotice";
import { ConfirmedActionButton } from "./ConfirmedActionButton";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type {
  AdvancedInviteDraft,
  CleaningNotLoaded,
} from "@psi/authoring/advancedInvite";
import type {
  Algorithm,
  LinkageStrategy,
  LinkageTerms,
  PrecisionFloorSelection,
  Standardization,
} from "@alcove/core";

/** The types the guided list states the shared-value caveat beside. */
const SHARED_VALUE_CAVEAT_TYPES: ReadonlySet<string> = new Set([
  ...CONTACT_AND_LOCATION_FIELD_TYPES,
  "state",
  "county",
]);

/** The caveat beside guided keys over a phone, email, ZIP, state or county
 * field. */
const SHARED_VALUE_CAVEAT =
  "A phone number or email address many people share, such as a shelter's " +
  "phone or a site's email, matches people who are not the same person. A " +
  "ZIP code, state or county column must hold each person's own, never that " +
  "of a site that serves them.";

/** The coverage question's two answers, as the radio values hold them. */
const COVERAGE_ANSWER = { yes: "yes", no: "no" } as const;

/**
 * The Matching keys tab: the precision floor and coverage question the guided
 * keys are drawn from the built-in catalog with, the guided ordered key list
 * (enable + reorder), the expert switch that opens element-by-element
 * authoring and terms import/export, and the matching settings -- the linkage
 * strategy, matching method, and deduplication controls, each live while the
 * exchange applies what it writes.
 *
 * The list holds the built-in keys the chosen floor and answer select for
 * these columns, each with a checkbox and the reorder pair. Both choices are
 * withheld once the keys were written in Expert authoring or loaded from a
 * document, with a note saying so and, where the file supplies a built-in
 * rule, an action that replaces those keys, fields and cleaning with a new
 * invitation's: no floor selected them. On the console, keys an opened
 * configuration states (`keysFromOpenedConfiguration`,
 * `@exchange/inviterScreenModel`) get a note naming the file and the command
 * that change them instead, and no action.
 *
 * Also renders {@link editorCitationDrop} live from the draft, so a rule-set
 * citation the rebuild drops is flagged as soon as the import lands or an
 * edit costs it. Review & create restates the same notice, for an operator
 * who edits here and leaves without reading it.
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
  onAlgorithm,
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
  /** Reseed the guided keys at a precision floor and coverage answer. */
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
  onAlgorithm: (algorithm: Algorithm) => void;
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
  const citationDrop = useMemo(
    () => editorCitationDrop(editor, keysFromOpenedConfiguration, currentTerms),
    [editor, keysFromOpenedConfiguration, currentTerms],
  );
  const emptyGuidedKeys = useMemo(
    () => emptyGuidedKeysNotice(editor),
    [editor],
  );
  const keysAuthored = editor.keysAuthored === true;
  const offersUseBuiltInRules = useMemo(
    () => editorOffersUseBuiltInRules(editor, keysFromOpenedConfiguration),
    [editor, keysFromOpenedConfiguration],
  );
  const selection =
    editor.draft.precisionFloorSelection ?? DEFAULT_PRECISION_FLOOR_SELECTION;
  const asksCoverage = precisionFloorAsksCoverage(selection.floor);
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
      {keysAuthored && keysFromOpenedConfiguration && (
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
      {!keysAuthored && (
        <>
          <Radio.Group
            label="Built-in rules"
            description="Changing this or the answer below lists the rules it selects that your file supplies, in the built-in order. Keys you turned off stay off, and keys it adds are turned on."
            value={String(selection.floor)}
            onChange={(value) => {
              const floor = PRECISION_FLOORS.find(
                (candidate) => String(candidate) === value,
              );
              if (floor !== undefined)
                onPrecisionFloorSelection({ ...selection, floor });
            }}
          >
            {PRECISION_FLOORS.map((floor) => {
              const statement = precisionFloorStatement(floor);
              return (
                <Radio
                  key={floor}
                  value={String(floor)}
                  label={statement.label}
                  description={statement.description}
                  mt="xs"
                />
              );
            })}
          </Radio.Group>
          <Radio.Group
            label={ONE_STATE_OR_METRO_AREA_QUESTION}
            description={
              asksCoverage
                ? ONE_STATE_OR_METRO_AREA_HELP.join(" ")
                : ONE_STATE_OR_METRO_AREA_NOT_ASKED
            }
            disabled={!asksCoverage}
            value={
              selection.oneStateOrMetroArea
                ? COVERAGE_ANSWER.yes
                : COVERAGE_ANSWER.no
            }
            onChange={(value) =>
              onPrecisionFloorSelection({
                ...selection,
                oneStateOrMetroArea: value === COVERAGE_ANSWER.yes,
              })
            }
            mt="md"
          >
            <Radio value={COVERAGE_ANSWER.yes} label="Yes" mt="xs" />
            <Radio
              value={COVERAGE_ANSWER.no}
              label="No"
              description="The rules that match on a name and a date of birth alone are left out."
              mt="xs"
            />
          </Radio.Group>
        </>
      )}
      <p id="key-order-help">{keyOrderHelp(editor)}</p>
      <ol className={styles.guidedKeys} aria-describedby="key-order-help">
        {editor.draft.keys.map((entry, index) => {
          const displayName = sanitizeForDisplay(entry.key.name);
          return (
            <li key={entry.key.name}>
              <Checkbox
                checked={entry.enabled}
                onChange={(event) =>
                  onKeyEnabled(index, event.currentTarget.checked)
                }
                label={
                  <>
                    Key {index + 1} -{" "}
                    <span className={styles.mono}>{displayName}</span>
                  </>
                }
              />
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
      {emptyGuidedKeys !== undefined && (
        <Alert variant="light" color="gray" role="note" my="sm">
          {emptyGuidedKeys}
        </Alert>
      )}
      {showsSharedValueKey && (
        <Alert variant="light" color="gray" role="note" my="sm">
          {SHARED_VALUE_CAVEAT}
        </Alert>
      )}
      {keysError !== undefined && (
        <p
          role="alert"
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineDanger}`}
        >
          {keysError}
        </p>
      )}
      {/* Rendered against the key list, not beside the import control: the list
        is what costs and restores the citation, and the drop outlives the
        Expert switch the import hides behind. The persistent region announces
        only the notice's title, not its body: a conditionally-mounted region
        is missed by screen readers watching only what is already in the DOM,
        and repeating the whole body would voice it twice -- once live, once in
        reading order. */}
      {citationDrop !== undefined && <CitationDropNotice drop={citationDrop} />}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {citationDrop?.title ?? ""}
      </VisuallyHidden>
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
          Turn on Expert authoring to edit keys element by element and to import
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
      {editor.draft.linkageStrategy === "single-pass" && (
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
      <NativeSelect
        label="Matching method"
        description="Reveal the matched identifiers, or only the count."
        value={editor.draft.algorithm}
        data={[
          { value: "psi", label: "Reveal the matched identifiers (standard)" },
          { value: "psi-c", label: "Reveal only the count (psi-c)" },
        ]}
        onChange={(event) =>
          onAlgorithm(AlgorithmSchema.parse(event.currentTarget.value))
        }
        mt="md"
      />
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
