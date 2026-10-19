import { useId } from "react";

import { NumberInput, Stack, TagsInput, Text } from "@mantine/core";

import {
  MAX_PEOPLE_PER_VALUE_REFUSAL,
  isMaxPeoplePerValueValid,
  nullIfLastNameFromLists,
} from "@psi/standardizationAuthoring";

import type { CleaningSettings } from "@psi/standardizationAuthoring";

/**
 * A field's two cleaning settings that are not steps: the most people in the
 * operator's file who may share one value, and the values dropped beside a
 * listed last name. Presentational: it renders `settings` and emits the whole
 * next settings through {@link onChange}, a setting left out being one the
 * field no longer states.
 */
export function CleaningSettingsEditor({
  settings,
  onChange,
}: {
  /** The settings the field states. */
  settings: CleaningSettings;
  /** Emit the field's next settings on any edit. */
  onChange: (settings: CleaningSettings) => void;
}) {
  const lastNameRuleHeadingId = useId();
  const lastNameRuleDescriptionId = useId();
  const { maxPeoplePerValue, nullIfLastName } = settings;
  const values = nullIfLastName?.values ?? [];
  const lastNames = nullIfLastName?.lastNames ?? [];

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
      <NumberInput
        size="xs"
        label="Most people who may share one value"
        description="A value shared by more people in your file is dropped from every record that has it. Leave empty to keep shared values."
        value={maxPeoplePerValue ?? ""}
        // A cleared input reports `""`, which is an unset limit.
        onChange={(next) =>
          onChange(withLimit(next === "" ? undefined : Number(next)))
        }
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
          values and the record&apos;s last name is one of the last names. Enter
          each as the cleaning steps leave it, such as JOHN beside DOE.
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
      </Stack>
    </Stack>
  );
}
