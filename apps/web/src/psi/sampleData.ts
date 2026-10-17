/**
 * The two synthetic CSVs behind the sample-data walkthrough, the single source
 * for the download, the in-place seed, and the console's copy into its folder.
 *
 * The sample has no SSN column: a value the default SSN pipeline keeps could be
 * a real person's, so its pairs match on names and dates.
 */

/** The filename the inviter's sample downloads and seeds under. */
export const SAMPLE_INVITER_FILE_NAME = "alcove-sample-inviter.csv";

/** The filename the partner's sample downloads under. */
export const SAMPLE_PARTNER_FILE_NAME = "alcove-sample-partner.csv";

const SAMPLE_HEADER = "first_name,last_name,dob,zip,member_id";

/**
 * The inviter-side sample. Rows 1-6 each have a counterpart in the partner file
 * that standardizes equal under default cleaning; rows 7-8 look close to a
 * partner row but clean to a different key; rows 9-11 are unique to this side.
 */
export const SAMPLE_INVITER_CSV = [
  SAMPLE_HEADER,
  // 1. Exact match.
  "Maria,Alvarez,03/07/1988,60614,INV-1001",
  // 2. Case and surrounding whitespace differ from the partner row.
  "James,Whitfield,11/23/1975,10023,INV-1002",
  // 3. Accented letters resolve to their ASCII forms.
  "Renee,Etienne,07/14/1992,94110,INV-1003",
  // 4. The partner row has a Jr. affix the default cleaning strips.
  "Harold,Brooks,02/09/1969,30303,INV-1004",
  // 5. Hyphenated name; the partner spells it spaced.
  "Mary-Jane,Kowalski,09/18/1990,48104,INV-1005",
  // 6. Exact match.
  "Devon,Osei,12/02/2001,77004,INV-1006",
  // 7. Looks like the partner's Nguyen row but the surname is transposed
  //    (Nyguen), so no key fires.
  "Linh,Nyguen,04/22/1986,95112,INV-1007",
  // 8. Shares the partner Sullivan row's name but the birth year differs, so
  //    no name-and-date key fires.
  "Grace,Sullivan,08/15/1994,19104,INV-1008",
  // 9-11. Unique to the inviter.
  "Omar,Haddad,06/11/1979,85004,INV-1009",
  "Beatrice,Fontaine,01/27/1963,70112,INV-1010",
  "Tobias,Ridgeway,10/05/1998,53703,INV-1011",
  "",
].join("\n");

/**
 * The partner-side sample. Rows 1-6 are the counterparts of the inviter's
 * matching rows (with the near-miss variations); rows 7-8 are the
 * look-close non-matches; rows 9-11 are unique to this side.
 */
export const SAMPLE_PARTNER_CSV = [
  SAMPLE_HEADER,
  "Maria,Alvarez,03/07/1988,60614,PTR-2001",
  " james , whitfield ,11/23/1975,10023,PTR-2002",
  "Renée,Étienne,07/14/1992,94110,PTR-2003",
  "Harold,Brooks Jr.,02/09/1969,30303,PTR-2004",
  "Mary Jane,Kowalski,09/18/1990,48104,PTR-2005",
  "Devon,Osei,12/02/2001,77004,PTR-2006",
  "Linh,Nguyen,04/22/1986,95112,PTR-2007",
  "Grace,Sullivan,08/15/1991,19104,PTR-2008",
  // 9-11. Unique to the partner.
  "Naomi,Petrov,03/19/1972,33101,PTR-2009",
  "Kofi,Mensah,11/08/1985,20001,PTR-2010",
  "Isabella,Marchetti,07/31/1996,97201,PTR-2011",
  "",
].join("\n");
