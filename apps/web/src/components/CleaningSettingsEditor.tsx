import { useId } from "react";

import { Stack, TagsInput, Text } from "@mantine/core";

import {
  MAX_PEOPLE_PER_VALUE_REFUSAL,
  halfFilledLastNameRuleNotice,
  isMaxPeoplePerValueValid,
  lastNameRuleEntryCleaned,
  lastNameRuleEntryNotice,
  lastNameRuleLastNameNotice,
  nullIfLastNameFromLists,
} from "@psi/standardizationAuthoring";

import { NamedStepNumberInput } from "@components/NamedStepNumberInput";

import type { CleaningSettings } from "@psi/standardizationAuthoring";
import type { StandardizationStep } from "@alcove/core";

/**
 * A field's two cleaning settings that are not steps: the most people in the
 * operator's file who may share one value, and the values dropped beside a
 * listed last name. Presentational: it renders `settings` and emits the whole
 * next settings through {@link onChange}, a setting left out being one the
 * field no longer states.
 */
export function CleaningSettingsEditor({
  settings,
  steps,
  lastNameSteps,
  onChange,
}: {
  /** The settings the field states. */
  settings: CleaningSettings;
  /** The field's cleaning steps, which a value entry is checked against. */
  steps: ReadonlyArray<StandardizationStep>;
  /** The steps that clean the party's last names, which a last-name entry is
   * checked against; `undefined` where the party has no last name column. */
  lastNameSteps: ReadonlyArray<StandardizationStep> | undefined;
  /** Emit the field's next settings on any edit. */
  onChange: (settings: CleaningSettings) => void;
}) {
  const lastNameRuleHeadingId = useId();
  const lastNameRuleDescriptionId = useId();
  const { maxPeoplePerValue, nullIfLastName } = settings;
  const values = nullIfLastName?.values ?? [];
  const lastNames = nullIfLastName?.lastNames ?? [];
  const halfFilledNotice = halfFilledLastNameRuleNotice(values, lastNames);
  const valueNotices = values.flatMap((entry) => {
    const cleaned = lastNameRuleEntryCleaned(entry, steps);
    return cleaned === undefined
      ? []
      : [
          {
            key: `value:${entry}`,
            notice: lastNameRuleEntryNotice(entry, cleaned),
          },
        ];
  });
  const lastNameNotices =
    lastNameSteps === undefined
      ? []
      : lastNames.flatMap((entry) => {
          const cleaned = lastNameRuleEntryCleaned(entry, lastNameSteps);
          return cleaned === undefined
            ? []
            : [
                {
                  key: `last name:${entry}`,
                  notice: lastNameRuleLastNameNotice(entry, cleaned),
                },
              ];
        });

  const withLimit = (limit: number | undefined): CleaningSettings => ({
    ...(limit === undefined ? {} : { maxPeoplePerValue: limit }),
    ...(nullIfLastName === undefined ? {} : { nullIfLastName }),
  });
  const withLastNameRule = (
    nextValues: Array<string>,
    nextLastNames: Array<string>,
  ): CleaningSettings => {
    const rule = nullIfLastNameFromLists(nextValues, nextLastNames);
    return {
      ...(maxPeoplePerValue === undefined ? {} : { maxPeoplePerValue }),
      ...(rule === undefined ? {} : { nullIfLastName: rule }),
    };
  };

  return (
    <Stack gap="xs">
      <NamedStepNumberInput
        size="xs"
        label="Most people who may share one value"
        description="A value shared by more people in your file is dropped from every record that has it. Leave empty to keep shared values."
        stepUnit="person"
        fieldName="shared-value limit"
        value={maxPeoplePerValue ?? ""}
        // A cleared input reports `""`, which is an unset limit.
        onChange={(next) =>
          onChange(withLimit(next === "" ? undefined : Number(next)))
        }
        min={1}
        step={1}
        allowDecimal={false}
        allowNegative={false}
        error={
          isMaxPeoplePerValueValid(maxPeoplePerValue)
            ? undefined
            : MAX_PEOPLE_PER_VALUE_REFUSAL
        }
        errorProps={{ role: "alert" }}
      />
      <Stack
        gap={4}
        role="group"
        aria-labelledby={lastNameRuleHeadingId}
        aria-describedby={lastNameRuleDescriptionId}
      >
        <Text id={lastNameRuleHeadingId} size="xs" fw={500}>
          Drop a value beside a last name
        </Text>
        <Text id={lastNameRuleDescriptionId} size="xs" c="dimmed">
          This field&apos;s value is dropped from a record when it is one of the
          values and the record&apos;s last name is one of the last names. Each
          entry is compared with the value as cleaning leaves it, in capitals by
          default: enter JOHN beside DOE, not John beside Doe.
        </Text>
        <TagsInput
          size="xs"
          label="Values"
          value={values}
          onChange={(next) => onChange(withLastNameRule(next, lastNames))}
          placeholder="Type a value and press Enter"
        />
        <TagsInput
          size="xs"
          label="Last names"
          value={lastNames}
          onChange={(next) => onChange(withLastNameRule(values, next))}
          placeholder="Type a last name and press Enter"
        />
        <div aria-live="polite">
          {[...valueNotices, ...lastNameNotices].map(({ key, notice }) => (
            <Text key={key} size="xs" c="orange.8">
              {notice}
            </Text>
          ))}
          {halfFilledNotice !== undefined && (
            <Text size="xs" c="orange.8">
              {halfFilledNotice}
            </Text>
          )}
        </div>
      </Stack>
      <Text size="xs" c="dimmed">
        Coverage counts on this screen are taken before the limit and the
        last-name rule apply.
      </Text>
    </Stack>
  );
}
