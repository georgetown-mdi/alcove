import { DistinctValues } from "./utils/distinctValues.js";

/**
 * One person field's cleaned values for one record: the value, the sorted
 * values where it has several, or `undefined` where it has none.
 *
 * @internal
 */
export type PersonComponent = string | ReadonlyArray<string> | undefined;

/**
 * One record's person for the shared-value screens, a component per person
 * field (docs/spec/DEFAULT_STANDARDIZATION.md, Shared-value screens).
 *
 * @internal
 */
export type PersonComponents = ReadonlyArray<PersonComponent>;

function sameComponent(a: PersonComponent, b: PersonComponent): boolean {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePerson(a: PersonComponents, b: PersonComponents): boolean {
  return a.every((component, index) => sameComponent(component, b[index]));
}

// Whether `other` agrees with `person` on every component `person` has and has
// one `person` lacks: a record missing a name or date is the same person as a
// record that fills it in.
function completesPerson(
  other: PersonComponents,
  person: PersonComponents,
): boolean {
  let fillsOne = false;
  for (const [index, component] of person.entries()) {
    const otherComponent = other[index];
    if (component === undefined) {
      if (otherComponent !== undefined) fillsOne = true;
    } else if (!sameComponent(component, otherComponent)) return false;
  }
  return fillsOne;
}

function presentComponentCount(person: PersonComponents): number {
  return person.filter((component) => component !== undefined).length;
}

/**
 * Whether `holders`, the distinct persons holding one value, count more than
 * `maxPeople` people once each person another one completes is set aside.
 *
 * @internal
 */
export function moreDistinctPeopleThan(
  maxPeople: number,
  holders: ReadonlyArray<PersonComponents>,
): boolean {
  if (holders.length <= maxPeople) return false;
  // Taken most components first, a person no counted one completes is completed
  // by no holder at all, since completion is transitive.
  const byComponents = [...holders].sort(
    (a, b) => presentComponentCount(b) - presentComponentCount(a),
  );
  const counted: PersonComponents[] = [];
  for (const person of byComponents) {
    if (counted.some((other) => completesPerson(other, person))) continue;
    counted.push(person);
    if (counted.length > maxPeople) return true;
  }
  return false;
}

/** The values a shared-value screen drops from a field. */
export interface DroppedSharedValues {
  /** Whether no value is dropped. */
  readonly none: boolean;
  /** Whether `value` is dropped. */
  has(value: string): boolean;
}

// The distinct persons holding one value, once it has more than one.
class SeveralHolders {
  constructor(readonly persons: PersonComponents[]) {}
}

/**
 * The values of one field that more than `maxPeople` distinct people hold
 * across `rowCount` records, given each record's values and person.
 *
 * Values are indexed through {@link DistinctValues} rather than a `Map` or
 * `Set` keyed by the value, since a cleaned SSN per record can pass the 2^24
 * strings a V8 string table holds before its lookups slow. A value one person
 * holds keeps the index of its first record rather than a person, so a file of
 * distinct values allocates nothing per record. A value keeps at most
 * `maxPeople` times as many distinct persons as a person has component subsets:
 * past that, more than `maxPeople` of them complete no other one, and the value
 * is dropped without keeping more.
 *
 * @internal
 */
export function droppedSharedValues(
  maxPeople: number,
  rowCount: number,
  valuesOf: (index: number) => ReadonlyArray<string>,
  personOf: (index: number) => PersonComponents,
): DroppedSharedValues {
  const values = new DistinctValues();
  // Per value position: the record index of its one person, its several
  // persons, or null once dropped.
  const holders: Array<number | SeveralHolders | null> = [];
  for (let index = 0; index < rowCount; index++) {
    const rowValues = valuesOf(index);
    if (rowValues.length === 0) continue;
    let person: PersonComponents | undefined;
    for (const value of rowValues) {
      const position = values.add(value);
      const held = holders[position];
      if (held === undefined) {
        holders[position] = index;
        continue;
      }
      if (held === null) continue;
      const current = (person ??= personOf(index));
      if (held instanceof SeveralHolders) {
        if (held.persons.some((other) => samePerson(other, current))) continue;
        held.persons.push(current);
        if (held.persons.length > maxPeople * 2 ** current.length)
          holders[position] = null;
        continue;
      }
      const first = personOf(held);
      if (!samePerson(first, current))
        holders[position] = new SeveralHolders([first, current]);
    }
  }
  // Only the dropped values are kept past the count, so the index over every
  // value is released once it is done.
  const dropped = new DistinctValues();
  holders.forEach((held, position) => {
    if (
      held === null ||
      (held instanceof SeveralHolders &&
        moreDistinctPeopleThan(maxPeople, held.persons))
    )
      dropped.add(values.values[position]);
  });
  return {
    none: dropped.size === 0,
    has: (value) => dropped.size !== 0 && dropped.indexOf(value) !== -1,
  };
}
