/**
 * The two synthetic CSVs behind the sample-data walkthrough, the single source
 * for the download, the in-place seed, and the console's copy into its folder.
 *
 * Every SSN has area 900, never issued and structurally invalid to
 * `isStructurallyValidSsn`; the sample relies on the default SSN pipeline not
 * enforcing `validOnly`, so these values standardize and match while avoiding
 * the placeholders the pipeline drops.
 */

/** The filename the inviter's sample downloads and seeds under. */
export const SAMPLE_INVITER_FILE_NAME = "alcove-sample-inviter.csv";

/** The filename the partner's sample downloads under. */
export const SAMPLE_PARTNER_FILE_NAME = "alcove-sample-partner.csv";

const SAMPLE_HEADER = "first_name,last_name,dob,ssn,zip,member_id";

/**
 * The inviter-side sample. Rows 1-7 each have a counterpart in the partner file
 * that standardizes equal under default cleaning; rows 8-9 look close to a
 * partner row but clean to a different key; rows 10-12 are unique to this side.
 */
export const SAMPLE_INVITER_CSV = [
  SAMPLE_HEADER,
  // 1. Exact match.
  "Maria,Alvarez,03/07/1988,900-31-2245,60614,INV-1001",
  // 2. Case and surrounding whitespace differ from the partner row.
  "James,Whitfield,11/23/1975,900-52-8830,10023,INV-1002",
  // 3. Accented letters resolve to their ASCII forms.
  "Renee,Etienne,07/14/1992,900-19-4471,94110,INV-1003",
  // 4. The partner row has a Jr. affix the default cleaning strips.
  "Harold,Brooks,02/09/1969,900-63-7712,30303,INV-1004",
  // 5. SSN punctuation differs from the partner's unpunctuated value.
  "Priya,Natarajan,05/30/1983,900-45-6789,02139,INV-1005",
  // 6. Hyphenated name; the partner spells it spaced.
  "Mary-Jane,Kowalski,09/18/1990,900-77-3391,48104,INV-1006",
  // 7. Exact match.
  "Devon,Osei,12/02/2001,900-28-5566,77004,INV-1007",
  // 8. Looks like the partner's Nguyen row but the surname is transposed
  //    (Nyguen) and the SSN differs, so no key fires.
  "Linh,Nyguen,04/22/1986,900-34-1180,95112,INV-1008",
  // 9. Shares the partner Sullivan row's name but the birth year and SSN both
  //    differ, so neither the name-and-date nor the SSN keys fire.
  "Grace,Sullivan,08/15/1994,900-41-9925,19104,INV-1009",
  // 10-12. Unique to the inviter.
  "Omar,Haddad,06/11/1979,900-58-2043,85004,INV-1010",
  "Beatrice,Fontaine,01/27/1963,900-12-6678,70112,INV-1011",
  "Tobias,Ridgeway,10/05/1998,900-90-4417,53703,INV-1012",
  "",
].join("\n");

/**
 * The partner-side sample. Rows 1-7 are the counterparts of the inviter's
 * matching rows (with the near-miss variations); rows 8-9 are the
 * look-close non-matches; rows 10-12 are unique to this side.
 */
export const SAMPLE_PARTNER_CSV = [
  SAMPLE_HEADER,
  "Maria,Alvarez,03/07/1988,900-31-2245,60614,PTR-2001",
  " james , whitfield ,11/23/1975,900-52-8830,10023,PTR-2002",
  "Renée,Étienne,07/14/1992,900-19-4471,94110,PTR-2003",
  "Harold,Brooks Jr.,02/09/1969,900-63-7712,30303,PTR-2004",
  "Priya,Natarajan,05/30/1983,900456789,02139,PTR-2005",
  "Mary Jane,Kowalski,09/18/1990,900-77-3391,48104,PTR-2006",
  "Devon,Osei,12/02/2001,900-28-5566,77004,PTR-2007",
  "Linh,Nguyen,04/22/1986,900-70-6624,95112,PTR-2008",
  "Grace,Sullivan,08/15/1991,900-88-2210,19104,PTR-2009",
  // 10-12. Unique to the partner.
  "Naomi,Petrov,03/19/1972,900-84-5501,33101,PTR-2010",
  "Kofi,Mensah,11/08/1985,900-26-7789,20001,PTR-2011",
  "Isabella,Marchetti,07/31/1996,900-15-3348,97201,PTR-2012",
  "",
].join("\n");
