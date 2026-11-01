/**
 * Migration on read of the files that hold partner or audit state: a file an
 * earlier version wrote is moved to the current version in memory, and the
 * file itself is written again only at its next natural write
 * (docs/RELEASES.md, "Compatibility policy").
 */

/** One step moving a stored document from one format version to the next. */
export interface FormatMigrationStep<Version> {
  /** The version the step reads. */
  readonly from: Version;
  /** The version the step's result is at. */
  readonly to: Version;
  /**
   * The document at {@link to}, from a copy at {@link from} the step may
   * modify. Throws where the document cannot be moved, its message naming
   * why and holding no value from the document, which may be a secret. The
   * version field is set by the caller.
   */
  readonly migrate: (
    document: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/** One format's migrations: its current version and the steps leading to it. */
export interface FormatMigrations<Version> {
  /** The file as a refusal names it, such as "The key file". */
  readonly fileName: string;
  /** The top-level field holding the version. */
  readonly versionField: string;
  /** The version a document without {@link versionField} is at, if any. */
  readonly absentVersion?: Version;
  /** The version this build reads and writes. */
  readonly current: Version;
  /** Every step, each `from` at most once. */
  readonly steps: ReadonlyArray<FormatMigrationStep<Version>>;
  /** What the operator does when a migration fails. */
  readonly failureRemedy: string;
}

/** A stored document whose migration to the current version failed. */
export class FormatMigrationError extends Error {
  /** The version the document declares. */
  readonly fromVersion: unknown;
  /** The version the failed step moves to. */
  readonly toVersion: unknown;

  constructor(
    migrations: FormatMigrations<unknown>,
    step: FormatMigrationStep<unknown>,
    declared: unknown,
    stepError: unknown,
  ) {
    const reason = (
      stepError instanceof Error ? stepError.message : String(stepError)
    ).replace(/\.$/, "");
    super(
      `${migrations.fileName} is format version ${String(declared)}, and ` +
        `this version of Alcove could not move it to version ` +
        `${String(step.to)}: ${reason}. The file was not changed. ` +
        migrations.failureRemedy,
    );
    this.name = "FormatMigrationError";
    this.fromVersion = declared;
    this.toVersion = step.to;
  }
}

function declaredVersion<Version>(
  document: Record<string, unknown>,
  migrations: FormatMigrations<Version>,
): Version | undefined {
  return Object.hasOwn(document, migrations.versionField)
    ? (document[migrations.versionField] as Version)
    : migrations.absentVersion;
}

function stepFrom<Version>(
  migrations: FormatMigrations<Version>,
  version: Version | undefined,
): FormatMigrationStep<Version> | undefined {
  return migrations.steps.find((step) => step.from === version);
}

/**
 * The versions a reader of `migrations` reads: the current one and every
 * version a chain of steps leads from to it.
 */
export function readableFormatVersions<Version>(
  migrations: FormatMigrations<Version>,
): ReadonlyArray<Version> {
  return [
    migrations.current,
    ...migrations.steps
      .filter((step) => migrationChainEnd(migrations, step.from).reaches)
      .map((step) => step.from),
  ];
}

/**
 * Where the steps from `version` lead: whether they reach the current
 * version, and how many steps they take. A chain that revisits a version
 * reaches nothing.
 */
export function migrationChainEnd<Version>(
  migrations: FormatMigrations<Version>,
  version: Version,
): { reaches: boolean; steps: number } {
  let at = version;
  for (let taken = 0; taken <= migrations.steps.length; taken++) {
    if (at === migrations.current) return { reaches: true, steps: taken };
    const step = stepFrom(migrations, at);
    if (step === undefined) return { reaches: false, steps: taken };
    at = step.to;
  }
  return { reaches: false, steps: migrations.steps.length };
}

/**
 * `raw` at the current version of `migrations`, moved there in memory. A
 * value that is not a plain object, one at the current version, and one at a
 * version no chain of steps leads from to the current one are returned as
 * they are, for the format's schema to read or refuse. Otherwise the steps
 * run on a copy: `raw` is never modified.
 *
 * @throws {FormatMigrationError} if a step throws, naming the version and
 *   the step's reason.
 */
export function migrateOnRead<Version>(
  raw: unknown,
  migrations: FormatMigrations<Version>,
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const document = raw as Record<string, unknown>;
  const declared = declaredVersion(document, migrations);
  if (declared === migrations.current || declared === undefined) return raw;
  if (!migrationChainEnd(migrations, declared).reaches) return raw;
  let migrated: Record<string, unknown> = structuredClone(document);
  let at: Version = declared;
  while (at !== migrations.current) {
    const step = stepFrom(migrations, at) as FormatMigrationStep<Version>;
    try {
      migrated = step.migrate(migrated);
    } catch (error) {
      throw new FormatMigrationError(
        migrations as FormatMigrations<unknown>,
        step as FormatMigrationStep<unknown>,
        declared,
        error,
      );
    }
    migrated = { ...migrated, [migrations.versionField]: step.to };
    at = step.to;
  }
  return migrated;
}
