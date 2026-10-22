/**
 * One secondary unit designator of USPS Publication 28, as Table 1 of the ONC
 * Project US@ Technical Specification v1.0 lists it.
 */
export interface SecondaryUnitDesignator {
  /** The designator spelled out. */
  name: string;
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
  { name: "APARTMENT", abbreviation: "APT", standsAlone: false },
  { name: "BASEMENT", abbreviation: "BSMT", standsAlone: true },
  { name: "BUILDING", abbreviation: "BLDG", standsAlone: false },
  { name: "DEPARTMENT", abbreviation: "DEPT", standsAlone: false },
  { name: "FLOOR", abbreviation: "FL", standsAlone: false },
  { name: "FRONT", abbreviation: "FRNT", standsAlone: true },
  { name: "HANGER", abbreviation: "HNGR", standsAlone: false },
  { name: "KEY", abbreviation: "KEY", standsAlone: false },
  { name: "LOBBY", abbreviation: "LBBY", standsAlone: true },
  { name: "LOT", abbreviation: "LOT", standsAlone: false },
  { name: "LOWER", abbreviation: "LOWR", standsAlone: true },
  { name: "OFFICE", abbreviation: "OFC", standsAlone: true },
  { name: "PENTHOUSE", abbreviation: "PH", standsAlone: true },
  { name: "PIER", abbreviation: "PIER", standsAlone: false },
  { name: "REAR", abbreviation: "REAR", standsAlone: true },
  { name: "ROOM", abbreviation: "RM", standsAlone: false },
  { name: "SIDE", abbreviation: "SIDE", standsAlone: true },
  { name: "SLIP", abbreviation: "SLIP", standsAlone: false },
  { name: "SPACE", abbreviation: "SPC", standsAlone: false },
  { name: "STOP", abbreviation: "STOP", standsAlone: false },
  { name: "SUITE", abbreviation: "STE", standsAlone: false },
  { name: "TRAILER", abbreviation: "TRLR", standsAlone: false },
  { name: "UNIT", abbreviation: "UNIT", standsAlone: false },
  { name: "UPPER", abbreviation: "UPPR", standsAlone: true },
];
