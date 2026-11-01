import type { FormatMigrations } from "@alcove/core";

/**
 * Step tables standing in for a format's own, so a suite drives migration on
 * read through a store whose real table has no step yet. Each takes the
 * format's current literal as a parameter rather than importing it, so a
 * `vi.mock` factory of the module that declares the literal can build one
 * without importing itself.
 */

/** The field whose presence makes a test step fail. */
export const UNMOVABLE_FIELD = "unmovable";

/** The cause a failing test step names; it holds no value of the document. */
export const UNMOVABLE_CAUSE = "the test step cannot move this document";

/** The `<family>/v<n>` literal one ordinal before `current`. */
export function previousVersionOf(current: string): string {
  const match = /^(.+)\/v(\d+)$/.exec(current);
  if (match === null) throw new Error(`${current} holds no ordinal`);
  return `${match[1]}/v${Number(match[2]) - 1}`;
}

/** The `<family>/v<n>` literal one ordinal after `current`. */
export function nextVersionOf(current: string): string {
  const match = /^(.+)\/v(\d+)$/.exec(current);
  if (match === null) throw new Error(`${current} holds no ordinal`);
  return `${match[1]}/v${Number(match[2]) + 1}`;
}

/**
 * A table with one step, from the version before `current` to `current`. A
 * document at the earlier version holds `field` under `storedName`, which the
 * step renames; with no rename the step moves only the version. The step
 * fails, naming {@link UNMOVABLE_CAUSE}, on a document holding
 * {@link UNMOVABLE_FIELD}.
 */
export function previousVersionMigrations(
  fileName: string,
  versionField: string,
  current: string,
  rename?: { field: string; storedName: string },
): FormatMigrations<string> {
  return {
    fileName,
    versionField,
    current,
    steps: [
      {
        from: previousVersionOf(current),
        to: current,
        migrate: (document) => {
          if (Object.hasOwn(document, UNMOVABLE_FIELD))
            throw new Error(UNMOVABLE_CAUSE);
          if (rename === undefined) return document;
          const { [rename.storedName]: value, ...rest } = document;
          return { ...rest, [rename.field]: value };
        },
      },
    ],
    unchangedStatement: "The stored value was not changed.",
    failureRemedy: "Use the version that wrote it.",
  };
}

/**
 * `document` as the version before `current` stored it: the version field
 * moved back, and `field` held under `storedName` where a rename is given.
 */
export function atPreviousVersion(
  document: Record<string, unknown>,
  versionField: string,
  rename?: { field: string; storedName: string },
): Record<string, unknown> {
  const earlier: Record<string, unknown> = {
    ...document,
    [versionField]: previousVersionOf(String(document[versionField])),
  };
  if (rename === undefined) return earlier;
  const { [rename.field]: value, ...rest } = earlier;
  return { ...rest, [rename.storedName]: value };
}
