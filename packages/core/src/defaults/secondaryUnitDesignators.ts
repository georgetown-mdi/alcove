/**
 * One secondary unit designator of USPS Publication 28, as Table 1 of the ONC
 * Project US@ Technical Specification v1.0 lists it.
 */
export interface SecondaryUnitDesignator {
  /** The designator spelled out, in each spelling the sources give it. */
  names: readonly string[];
  /** Its approved abbreviation. */
  abbreviation: string;
  /** Whether it stands alone, needing no number or letter after it. */
  standsAlone: boolean;
}

/**
 * The secondary unit designators the default `unit` pipeline reads, in the
 * published order.
 *
 * @internal exported so the doc-parity test can hold DEFAULT_STANDARDIZATION.md's
 * designator table to this exact list.
 */
export const SECONDARY_UNIT_DESIGNATORS: readonly SecondaryUnitDesignator[] = [
  { names: ["APARTMENT"], abbreviation: "APT", standsAlone: false },
  { names: ["BASEMENT"], abbreviation: "BSMT", standsAlone: true },
  { names: ["BUILDING"], abbreviation: "BLDG", standsAlone: false },
  { names: ["DEPARTMENT"], abbreviation: "DEPT", standsAlone: false },
  { names: ["FLOOR"], abbreviation: "FL", standsAlone: false },
  { names: ["FRONT"], abbreviation: "FRNT", standsAlone: true },
  // Publication 28 spells it HANGAR, and Project US@ Table 1 prints HANGER.
  { names: ["HANGAR", "HANGER"], abbreviation: "HNGR", standsAlone: false },
  { names: ["KEY"], abbreviation: "KEY", standsAlone: false },
  { names: ["LOBBY"], abbreviation: "LBBY", standsAlone: true },
  { names: ["LOT"], abbreviation: "LOT", standsAlone: false },
  { names: ["LOWER"], abbreviation: "LOWR", standsAlone: true },
  { names: ["OFFICE"], abbreviation: "OFC", standsAlone: true },
  { names: ["PENTHOUSE"], abbreviation: "PH", standsAlone: true },
  { names: ["PIER"], abbreviation: "PIER", standsAlone: false },
  { names: ["REAR"], abbreviation: "REAR", standsAlone: true },
  { names: ["ROOM"], abbreviation: "RM", standsAlone: false },
  { names: ["SIDE"], abbreviation: "SIDE", standsAlone: true },
  { names: ["SLIP"], abbreviation: "SLIP", standsAlone: false },
  { names: ["SPACE"], abbreviation: "SPC", standsAlone: false },
  { names: ["STOP"], abbreviation: "STOP", standsAlone: false },
  { names: ["SUITE"], abbreviation: "STE", standsAlone: false },
  { names: ["TRAILER"], abbreviation: "TRLR", standsAlone: false },
  { names: ["UNIT"], abbreviation: "UNIT", standsAlone: false },
  { names: ["UPPER"], abbreviation: "UPPR", standsAlone: true },
];
