/**
 * The places the `state_code` step recognizes: the 50 states, the District of
 * Columbia, and the five inhabited territories with a USPS code, each with its
 * code and the names that map to it, uppercase with punctuation removed. The
 * freely associated states (FM, MH, PW) are sovereign countries and the
 * military codes (AA, AE, AP) are mail routes, not places of residence, so
 * neither is listed.
 *
 * @internal exported so the doc-parity test can hold DEFAULT_STANDARDIZATION.md's
 * state table to this exact list.
 */
export const US_STATE_CODES: ReadonlyArray<{
  code: string;
  names: readonly string[];
}> = [
  { code: "AL", names: ["ALABAMA"] },
  { code: "AK", names: ["ALASKA"] },
  { code: "AZ", names: ["ARIZONA"] },
  { code: "AR", names: ["ARKANSAS"] },
  { code: "CA", names: ["CALIFORNIA"] },
  { code: "CO", names: ["COLORADO"] },
  { code: "CT", names: ["CONNECTICUT"] },
  { code: "DE", names: ["DELAWARE"] },
  { code: "FL", names: ["FLORIDA"] },
  { code: "GA", names: ["GEORGIA"] },
  { code: "HI", names: ["HAWAII"] },
  { code: "ID", names: ["IDAHO"] },
  { code: "IL", names: ["ILLINOIS"] },
  { code: "IN", names: ["INDIANA"] },
  { code: "IA", names: ["IOWA"] },
  { code: "KS", names: ["KANSAS"] },
  { code: "KY", names: ["KENTUCKY"] },
  { code: "LA", names: ["LOUISIANA"] },
  { code: "ME", names: ["MAINE"] },
  { code: "MD", names: ["MARYLAND"] },
  { code: "MA", names: ["MASSACHUSETTS"] },
  { code: "MI", names: ["MICHIGAN"] },
  { code: "MN", names: ["MINNESOTA"] },
  { code: "MS", names: ["MISSISSIPPI"] },
  { code: "MO", names: ["MISSOURI"] },
  { code: "MT", names: ["MONTANA"] },
  { code: "NE", names: ["NEBRASKA"] },
  { code: "NV", names: ["NEVADA"] },
  { code: "NH", names: ["NEW HAMPSHIRE"] },
  { code: "NJ", names: ["NEW JERSEY"] },
  { code: "NM", names: ["NEW MEXICO"] },
  { code: "NY", names: ["NEW YORK"] },
  { code: "NC", names: ["NORTH CAROLINA"] },
  { code: "ND", names: ["NORTH DAKOTA"] },
  { code: "OH", names: ["OHIO"] },
  { code: "OK", names: ["OKLAHOMA"] },
  { code: "OR", names: ["OREGON"] },
  { code: "PA", names: ["PENNSYLVANIA"] },
  { code: "RI", names: ["RHODE ISLAND"] },
  { code: "SC", names: ["SOUTH CAROLINA"] },
  { code: "SD", names: ["SOUTH DAKOTA"] },
  { code: "TN", names: ["TENNESSEE"] },
  { code: "TX", names: ["TEXAS"] },
  { code: "UT", names: ["UTAH"] },
  { code: "VT", names: ["VERMONT"] },
  { code: "VA", names: ["VIRGINIA"] },
  { code: "WA", names: ["WASHINGTON"] },
  { code: "WV", names: ["WEST VIRGINIA"] },
  { code: "WI", names: ["WISCONSIN"] },
  { code: "WY", names: ["WYOMING"] },
  { code: "DC", names: ["DISTRICT OF COLUMBIA"] },
  { code: "AS", names: ["AMERICAN SAMOA"] },
  { code: "GU", names: ["GUAM"] },
  { code: "MP", names: ["NORTHERN MARIANA ISLANDS"] },
  { code: "PR", names: ["PUERTO RICO"] },
  { code: "VI", names: ["VIRGIN ISLANDS", "US VIRGIN ISLANDS"] },
];

const STATE_CODE_BY_SPELLING: ReadonlyMap<string, string> = new Map(
  US_STATE_CODES.flatMap(({ code, names }) => [
    [code, code] as const,
    ...names.map((name) => [name, code] as const),
  ]),
);

/**
 * The two-letter code of a recognized code or name, in any letter case but
 * otherwise spelled as {@link US_STATE_CODES} lists it, or `null` for any other
 * value.
 */
export function usStateCode(value: string): string | null {
  return STATE_CODE_BY_SPELLING.get(value.toUpperCase()) ?? null;
}
