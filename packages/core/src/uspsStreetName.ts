/**
 * One row of the street suffix table of USPS Publication 28, as the ONC Project
 * US@ Technical Specification v1.0 reproduces it in its Appendix B: the primary
 * suffix name, the forms commonly written for it, and its standard abbreviation.
 */
export interface StreetSuffix {
  /** The primary street suffix name, the form a spelled-out word takes. */
  name: string;
  /** The commonly used forms the table lists, in its order. */
  forms: readonly string[];
  /** The standard suffix abbreviation. */
  abbreviation: string;
}

/**
 * The street suffix table the `usps_street_name` step reads, row for row and in
 * the published order.
 *
 * @internal exported so the doc-parity test can hold DEFAULT_STANDARDIZATION.md's
 * suffix table to this exact list.
 */
export const STREET_SUFFIXES: readonly StreetSuffix[] = [
  {
    name: "ALLEY",
    forms: ["ALLEE", "ALLEY", "ALLY", "ALY"],
    abbreviation: "ALY",
  },
  {
    name: "ANEX",
    forms: ["ANEX", "ANNEX", "ANNX", "ANX"],
    abbreviation: "ANX",
  },
  { name: "ARCADE", forms: ["ARC", "ARCADE"], abbreviation: "ARC" },
  {
    name: "AVENUE",
    forms: ["AV", "AVE", "AVEN", "AVENU", "AVENUE", "AVN", "AVNUE"],
    abbreviation: "AVE",
  },
  { name: "BAYOU", forms: ["BAYOO", "BAYOU"], abbreviation: "BYU" },
  { name: "BEACH", forms: ["BCH", "BEACH"], abbreviation: "BCH" },
  { name: "BEND", forms: ["BEND", "BND"], abbreviation: "BND" },
  { name: "BLUFF", forms: ["BLF", "BLUF", "BLUFF"], abbreviation: "BLF" },
  { name: "BLUFFS", forms: ["BLUFFS"], abbreviation: "BLFS" },
  {
    name: "BOTTOM",
    forms: ["BOT", "BTM", "BOTTM", "BOTTOM"],
    abbreviation: "BTM",
  },
  {
    name: "BOULEVARD",
    forms: ["BLVD", "BOUL", "BOULEVARD", "BOULV"],
    abbreviation: "BLVD",
  },
  { name: "BRANCH", forms: ["BR", "BRNCH", "BRANCH"], abbreviation: "BR" },
  { name: "BRIDGE", forms: ["BRDGE", "BRG", "BRIDGE"], abbreviation: "BRG" },
  { name: "BROOK", forms: ["BRK", "BROOK"], abbreviation: "BRK" },
  { name: "BROOKS", forms: ["BROOKS"], abbreviation: "BRKS" },
  { name: "BURG", forms: ["BURG"], abbreviation: "BG" },
  { name: "BURGS", forms: ["BURGS"], abbreviation: "BGS" },
  {
    name: "BYPASS",
    forms: ["BYP", "BYPA", "BYPAS", "BYPASS", "BYPS"],
    abbreviation: "BYP",
  },
  { name: "CAMP", forms: ["CAMP", "CP", "CMP"], abbreviation: "CP" },
  { name: "CANYON", forms: ["CANYN", "CANYON", "CNYN"], abbreviation: "CYN" },
  { name: "CAPE", forms: ["CAPE", "CPE"], abbreviation: "CPE" },
  {
    name: "CAUSEWAY",
    forms: ["CAUSEWAY", "CAUSWA", "CSWY"],
    abbreviation: "CSWY",
  },
  {
    name: "CENTER",
    forms: ["CEN", "CENT", "CENTER", "CENTR", "CENTRE", "CNTER", "CNTR", "CTR"],
    abbreviation: "CTR",
  },
  { name: "CENTERS", forms: ["CENTERS"], abbreviation: "CTRS" },
  {
    name: "CIRCLE",
    forms: ["CIR", "CIRC", "CIRCL", "CIRCLE", "CRCL", "CRCLE"],
    abbreviation: "CIR",
  },
  { name: "CIRCLES", forms: ["CIRCLES"], abbreviation: "CIRS" },
  { name: "CLIFF", forms: ["CLF", "CLIFF"], abbreviation: "CLF" },
  { name: "CLIFFS", forms: ["CLFS", "CLIFFS"], abbreviation: "CLFS" },
  { name: "CLUB", forms: ["CLB", "CLUB"], abbreviation: "CLB" },
  { name: "COMMON", forms: ["COMMON"], abbreviation: "CMN" },
  { name: "COMMONS", forms: ["COMMONS"], abbreviation: "CMNS" },
  { name: "CORNER", forms: ["COR", "CORNER"], abbreviation: "COR" },
  { name: "CORNERS", forms: ["CORNERS", "CORS"], abbreviation: "CORS" },
  { name: "COURSE", forms: ["COURSE", "CRSE"], abbreviation: "CRSE" },
  { name: "COURT", forms: ["COURT", "CT"], abbreviation: "CT" },
  { name: "COURTS", forms: ["COURTS", "CTS"], abbreviation: "CTS" },
  { name: "COVE", forms: ["COVE", "CV"], abbreviation: "CV" },
  { name: "COVES", forms: ["COVES"], abbreviation: "CVS" },
  { name: "CREEK", forms: ["CREEK", "CRK"], abbreviation: "CRK" },
  {
    name: "CRESCENT",
    forms: ["CRESCENT", "CRES", "CRSENT", "CRSNT"],
    abbreviation: "CRES",
  },
  { name: "CREST", forms: ["CREST"], abbreviation: "CRST" },
  {
    name: "CROSSING",
    forms: ["CROSSING", "CRSSNG", "XING"],
    abbreviation: "XING",
  },
  { name: "CROSSROAD", forms: ["CROSSROAD"], abbreviation: "XRD" },
  { name: "CROSSROADS", forms: ["CROSSROADS"], abbreviation: "XRDS" },
  { name: "CURVE", forms: ["CURVE"], abbreviation: "CURV" },
  { name: "DALE", forms: ["DALE", "DL"], abbreviation: "DL" },
  { name: "DAM", forms: ["DAM", "DM"], abbreviation: "DM" },
  { name: "DIVIDE", forms: ["DIV", "DIVIDE", "DV", "DVD"], abbreviation: "DV" },
  { name: "DRIVE", forms: ["DR", "DRIV", "DRIVE", "DRV"], abbreviation: "DR" },
  { name: "DRIVES", forms: ["DRIVES"], abbreviation: "DRS" },
  { name: "ESTATE", forms: ["EST", "ESTATE"], abbreviation: "EST" },
  { name: "ESTATES", forms: ["ESTATES", "ESTS"], abbreviation: "ESTS" },
  {
    name: "EXPRESSWAY",
    forms: ["EXP", "EXPR", "EXPRESS", "EXPRESSWAY", "EXPW", "EXPY"],
    abbreviation: "EXPY",
  },
  {
    name: "EXTENSION",
    forms: ["EXT", "EXTENSION", "EXTN", "EXTNSN"],
    abbreviation: "EXT",
  },
  { name: "EXTENSIONS", forms: ["EXTS"], abbreviation: "EXTS" },
  { name: "FALL", forms: ["FALL"], abbreviation: "FALL" },
  { name: "FALLS", forms: ["FALLS", "FLS"], abbreviation: "FLS" },
  { name: "FERRY", forms: ["FERRY", "FRRY", "FRY"], abbreviation: "FRY" },
  { name: "FIELD", forms: ["FIELD", "FLD"], abbreviation: "FLD" },
  { name: "FIELDS", forms: ["FIELDS", "FLDS"], abbreviation: "FLDS" },
  { name: "FLAT", forms: ["FLAT", "FLT"], abbreviation: "FLT" },
  { name: "FLATS", forms: ["FLATS", "FLTS"], abbreviation: "FLTS" },
  { name: "FORD", forms: ["FORD", "FRD"], abbreviation: "FRD" },
  { name: "FORDS", forms: ["FORDS"], abbreviation: "FRDS" },
  {
    name: "FOREST",
    forms: ["FOREST", "FORESTS", "FRST"],
    abbreviation: "FRST",
  },
  { name: "FORGE", forms: ["FORG", "FORGE", "FRG"], abbreviation: "FRG" },
  { name: "FORGES", forms: ["FORGES"], abbreviation: "FRGS" },
  { name: "FORK", forms: ["FORK", "FRK"], abbreviation: "FRK" },
  { name: "FORKS", forms: ["FORKS", "FRKS"], abbreviation: "FRKS" },
  { name: "FORT", forms: ["FORT", "FRT", "FT"], abbreviation: "FT" },
  {
    name: "FREEWAY",
    forms: ["FREEWAY", "FREEWY", "FRWAY", "FRWY", "FWY"],
    abbreviation: "FWY",
  },
  {
    name: "GARDEN",
    forms: ["GARDEN", "GARDN", "GRDEN", "GRDN"],
    abbreviation: "GDN",
  },
  {
    name: "GARDENS",
    forms: ["GARDENS", "GDNS", "GRDNS"],
    abbreviation: "GDNS",
  },
  {
    name: "GATEWAY",
    forms: ["GATEWAY", "GATEWY", "GATWAY", "GTWAY", "GTWY"],
    abbreviation: "GTWY",
  },
  { name: "GLEN", forms: ["GLEN", "GLN"], abbreviation: "GLN" },
  { name: "GLENS", forms: ["GLENS"], abbreviation: "GLNS" },
  { name: "GREEN", forms: ["GREEN", "GRN"], abbreviation: "GRN" },
  { name: "GREENS", forms: ["GREENS"], abbreviation: "GRNS" },
  { name: "GROVE", forms: ["GROV", "GROVE", "GRV"], abbreviation: "GRV" },
  { name: "GROVES", forms: ["GROVES"], abbreviation: "GRVS" },
  {
    name: "HARBOR",
    forms: ["HARB", "HARBOR", "HARBR", "HBR", "HRBOR"],
    abbreviation: "HBR",
  },
  { name: "HARBORS", forms: ["HARBORS"], abbreviation: "HBRS" },
  { name: "HAVEN", forms: ["HAVEN", "HVN"], abbreviation: "HVN" },
  { name: "HEIGHTS", forms: ["HT", "HTS"], abbreviation: "HTS" },
  {
    name: "HIGHWAY",
    forms: ["HIGHWAY", "HIGHWY", "HIWAY", "HIWY", "HWAY", "HWY"],
    abbreviation: "HWY",
  },
  { name: "HILL", forms: ["HILL", "HL"], abbreviation: "HL" },
  { name: "HILLS", forms: ["HILLS", "HLS"], abbreviation: "HLS" },
  {
    name: "HOLLOW",
    forms: ["HLLW", "HOLLOW", "HOLLOWS", "HOLW", "HOLWS"],
    abbreviation: "HOLW",
  },
  { name: "INLET", forms: ["INLT"], abbreviation: "INLT" },
  { name: "ISLAND", forms: ["IS", "ISLAND", "ISLND"], abbreviation: "IS" },
  { name: "ISLANDS", forms: ["ISLANDS", "ISLNDS", "ISS"], abbreviation: "ISS" },
  { name: "ISLE", forms: ["ISLE", "ISLES"], abbreviation: "ISLE" },
  {
    name: "JUNCTION",
    forms: ["JCT", "JCTION", "JCTN", "JUNCTION", "JUNCTN", "JUNCTON"],
    abbreviation: "JCT",
  },
  {
    name: "JUNCTIONS",
    forms: ["JCTNS", "JCTS", "JUNCTIONS"],
    abbreviation: "JCTS",
  },
  { name: "KEY", forms: ["KEY", "KY"], abbreviation: "KY" },
  { name: "KEYS", forms: ["KEYS", "KYS"], abbreviation: "KYS" },
  { name: "KNOLL", forms: ["KNL", "KNOL", "KNOLL"], abbreviation: "KNL" },
  { name: "KNOLLS", forms: ["KNLS", "KNOLLS"], abbreviation: "KNLS" },
  { name: "LAKE", forms: ["LK", "LAKE"], abbreviation: "LK" },
  { name: "LAKES", forms: ["LKS", "LAKES"], abbreviation: "LKS" },
  { name: "LAND", forms: ["LAND"], abbreviation: "LAND" },
  {
    name: "LANDING",
    forms: ["LANDING", "LNDG", "LNDNG"],
    abbreviation: "LNDG",
  },
  { name: "LANE", forms: ["LANE", "LN"], abbreviation: "LN" },
  { name: "LIGHT", forms: ["LGT", "LIGHT"], abbreviation: "LGT" },
  { name: "LIGHTS", forms: ["LIGHTS"], abbreviation: "LGTS" },
  { name: "LOAF", forms: ["LF", "LOAF"], abbreviation: "LF" },
  { name: "LOCK", forms: ["LCK", "LOCK"], abbreviation: "LCK" },
  { name: "LOCKS", forms: ["LCKS", "LOCKS"], abbreviation: "LCKS" },
  {
    name: "LODGE",
    forms: ["LDG", "LDGE", "LODG", "LODGE"],
    abbreviation: "LDG",
  },
  { name: "LOOP", forms: ["LOOP", "LOOPS"], abbreviation: "LOOP" },
  { name: "MALL", forms: ["MALL"], abbreviation: "MALL" },
  { name: "MANOR", forms: ["MNR", "MANOR"], abbreviation: "MNR" },
  { name: "MANORS", forms: ["MANORS", "MNRS"], abbreviation: "MNRS" },
  { name: "MEADOW", forms: ["MEADOW"], abbreviation: "MDW" },
  {
    name: "MEADOWS",
    forms: ["MDW", "MDWS", "MEADOWS", "MEDOWS"],
    abbreviation: "MDWS",
  },
  { name: "MEWS", forms: ["MEWS"], abbreviation: "MEWS" },
  { name: "MILL", forms: ["MILL"], abbreviation: "ML" },
  { name: "MILLS", forms: ["MILLS"], abbreviation: "MLS" },
  { name: "MISSION", forms: ["MISSN", "MSSN"], abbreviation: "MSN" },
  { name: "MOTORWAY", forms: ["MOTORWAY"], abbreviation: "MTWY" },
  { name: "MOUNT", forms: ["MNT", "MT", "MOUNT"], abbreviation: "MT" },
  {
    name: "MOUNTAIN",
    forms: ["MNTAIN", "MNTN", "MOUNTAIN", "MOUNTIN", "MTIN", "MTN"],
    abbreviation: "MTN",
  },
  { name: "MOUNTAINS", forms: ["MNTNS", "MOUNTAINS"], abbreviation: "MTNS" },
  { name: "NECK", forms: ["NCK", "NECK"], abbreviation: "NCK" },
  {
    name: "ORCHARD",
    forms: ["ORCH", "ORCHARD", "ORCHRD"],
    abbreviation: "ORCH",
  },
  { name: "OVAL", forms: ["OVAL", "OVL"], abbreviation: "OVAL" },
  { name: "OVERPASS", forms: ["OVERPASS"], abbreviation: "OPAS" },
  { name: "PARK", forms: ["PARK", "PRK"], abbreviation: "PARK" },
  { name: "PARKS", forms: ["PARKS"], abbreviation: "PARK" },
  {
    name: "PARKWAY",
    forms: ["PARKWAY", "PARKWY", "PKWAY", "PKWY", "PKY"],
    abbreviation: "PKWY",
  },
  { name: "PARKWAYS", forms: ["PARKWAYS", "PKWYS"], abbreviation: "PKWY" },
  { name: "PASS", forms: ["PASS"], abbreviation: "PASS" },
  { name: "PASSAGE", forms: ["PASSAGE"], abbreviation: "PSGE" },
  { name: "PATH", forms: ["PATH", "PATHS"], abbreviation: "PATH" },
  { name: "PIKE", forms: ["PIKE", "PIKES"], abbreviation: "PIKE" },
  { name: "PINE", forms: ["PINE"], abbreviation: "PNE" },
  { name: "PINES", forms: ["PINES", "PNES"], abbreviation: "PNES" },
  { name: "PLACE", forms: ["PL"], abbreviation: "PL" },
  { name: "PLAIN", forms: ["PLAIN", "PLN"], abbreviation: "PLN" },
  { name: "PLAINS", forms: ["PLAINS", "PLNS"], abbreviation: "PLNS" },
  { name: "PLAZA", forms: ["PLAZA", "PLZ", "PLZA"], abbreviation: "PLZ" },
  { name: "POINT", forms: ["POINT", "PT"], abbreviation: "PT" },
  { name: "POINTS", forms: ["POINTS", "PTS"], abbreviation: "PTS" },
  { name: "PORT", forms: ["PORT", "PRT"], abbreviation: "PRT" },
  { name: "PORTS", forms: ["PORTS", "PRTS"], abbreviation: "PRTS" },
  { name: "PRAIRIE", forms: ["PR", "PRAIRIE", "PRR"], abbreviation: "PR" },
  {
    name: "RADIAL",
    forms: ["RAD", "RADIAL", "RADIEL", "RADL"],
    abbreviation: "RADL",
  },
  { name: "RAMP", forms: ["RAMP"], abbreviation: "RAMP" },
  {
    name: "RANCH",
    forms: ["RANCH", "RANCHES", "RNCH", "RNCHS"],
    abbreviation: "RNCH",
  },
  { name: "RAPID", forms: ["RAPID", "RPD"], abbreviation: "RPD" },
  { name: "RAPIDS", forms: ["RAPIDS", "RPDS"], abbreviation: "RPDS" },
  { name: "REST", forms: ["REST", "RST"], abbreviation: "RST" },
  { name: "RIDGE", forms: ["RDG", "RDGE", "RIDGE"], abbreviation: "RDG" },
  { name: "RIDGES", forms: ["RDGS", "RIDGES"], abbreviation: "RDGS" },
  {
    name: "RIVER",
    forms: ["RIV", "RIVER", "RVR", "RIVR"],
    abbreviation: "RIV",
  },
  { name: "ROAD", forms: ["RD", "ROAD"], abbreviation: "RD" },
  { name: "ROADS", forms: ["ROADS", "RDS"], abbreviation: "RDS" },
  { name: "ROUTE", forms: ["ROUTE"], abbreviation: "RTE" },
  { name: "ROW", forms: ["ROW"], abbreviation: "ROW" },
  { name: "RUE", forms: ["RUE"], abbreviation: "RUE" },
  { name: "RUN", forms: ["RUN"], abbreviation: "RUN" },
  { name: "SHOAL", forms: ["SHL", "SHOAL"], abbreviation: "SHL" },
  { name: "SHOALS", forms: ["SHLS", "SHOALS"], abbreviation: "SHLS" },
  { name: "SHORE", forms: ["SHOAR", "SHORE", "SHR"], abbreviation: "SHR" },
  { name: "SHORES", forms: ["SHOARS", "SHORES", "SHRS"], abbreviation: "SHRS" },
  { name: "SKYWAY", forms: ["SKYWAY"], abbreviation: "SKWY" },
  {
    name: "SPRING",
    forms: ["SPG", "SPNG", "SPRING", "SPRNG"],
    abbreviation: "SPG",
  },
  {
    name: "SPRINGS",
    forms: ["SPGS", "SPNGS", "SPRINGS", "SPRNGS"],
    abbreviation: "SPGS",
  },
  { name: "SPUR", forms: ["SPUR"], abbreviation: "SPUR" },
  { name: "SPURS", forms: ["SPURS"], abbreviation: "SPUR" },
  {
    name: "SQUARE",
    forms: ["SQ", "SQR", "SQRE", "SQU", "SQUARE"],
    abbreviation: "SQ",
  },
  { name: "SQUARES", forms: ["SQRS", "SQUARES"], abbreviation: "SQS" },
  {
    name: "STATION",
    forms: ["STA", "STATION", "STATN", "STN"],
    abbreviation: "STA",
  },
  {
    name: "STRAVENUE",
    forms: [
      "STRA",
      "STRAV",
      "STRAVEN",
      "STRAVENUE",
      "STRAVN",
      "STRVN",
      "STRVNUE",
    ],
    abbreviation: "STRA",
  },
  { name: "STREAM", forms: ["STREAM", "STREME", "STRM"], abbreviation: "STRM" },
  {
    name: "STREET",
    forms: ["STREET", "STRT", "ST", "STR"],
    abbreviation: "ST",
  },
  { name: "STREETS", forms: ["STREETS"], abbreviation: "STS" },
  {
    name: "SUMMIT",
    forms: ["SMT", "SUMIT", "SUMITT", "SUMMIT"],
    abbreviation: "SMT",
  },
  { name: "TERRACE", forms: ["TER", "TERR", "TERRACE"], abbreviation: "TER" },
  { name: "THROUGHWAY", forms: ["THROUGHWAY"], abbreviation: "TRWY" },
  { name: "TRACE", forms: ["TRACE", "TRACES", "TRCE"], abbreviation: "TRCE" },
  {
    name: "TRACK",
    forms: ["TRACK", "TRACKS", "TRAK", "TRK", "TRKS"],
    abbreviation: "TRAK",
  },
  { name: "TRAFFICWAY", forms: ["TRAFFICWAY"], abbreviation: "TRFY" },
  {
    name: "TRAIL",
    forms: ["TRAIL", "TRAILS", "TRL", "TRLS"],
    abbreviation: "TRL",
  },
  {
    name: "TRAILER",
    forms: ["TRAILER", "TRLR", "TRLRS"],
    abbreviation: "TRLR",
  },
  {
    name: "TUNNEL",
    forms: ["TUNEL", "TUNL", "TUNLS", "TUNNEL", "TUNNELS", "TUNNL"],
    abbreviation: "TUNL",
  },
  {
    name: "TURNPIKE",
    forms: ["TRNPK", "TURNPIKE", "TURNPK"],
    abbreviation: "TPKE",
  },
  { name: "UNDERPASS", forms: ["UNDERPASS"], abbreviation: "UPAS" },
  { name: "UNION", forms: ["UN", "UNION"], abbreviation: "UN" },
  { name: "UNIONS", forms: ["UNIONS"], abbreviation: "UNS" },
  {
    name: "VALLEY",
    forms: ["VALLEY", "VALLY", "VLLY", "VLY"],
    abbreviation: "VLY",
  },
  { name: "VALLEYS", forms: ["VALLEYS", "VLYS"], abbreviation: "VLYS" },
  {
    name: "VIADUCT",
    forms: ["VDCT", "VIA", "VIADCT", "VIADUCT"],
    abbreviation: "VIA",
  },
  { name: "VIEW", forms: ["VIEW", "VW"], abbreviation: "VW" },
  { name: "VIEWS", forms: ["VIEWS", "VWS"], abbreviation: "VWS" },
  {
    name: "VILLAGE",
    forms: ["VILL", "VILLAG", "VILLAGE", "VILLG", "VILLIAGE", "VLG"],
    abbreviation: "VLG",
  },
  { name: "VILLAGES", forms: ["VILLAGES", "VLGS"], abbreviation: "VLGS" },
  { name: "VILLE", forms: ["VILLE", "VL"], abbreviation: "VL" },
  {
    name: "VISTA",
    forms: ["VIS", "VIST", "VISTA", "VST", "VSTA"],
    abbreviation: "VIS",
  },
  { name: "WALK", forms: ["WALK"], abbreviation: "WALK" },
  { name: "WALKS", forms: ["WALKS"], abbreviation: "WALK" },
  { name: "WALL", forms: ["WALL"], abbreviation: "WALL" },
  { name: "WAY", forms: ["WY", "WAY"], abbreviation: "WAY" },
  { name: "WAYS", forms: ["WAYS"], abbreviation: "WAYS" },
  { name: "WELL", forms: ["WELL"], abbreviation: "WL" },
  { name: "WELLS", forms: ["WELLS", "WLS"], abbreviation: "WLS" },
];

/** A directional word and the one- or two-letter abbreviation it takes. */
export interface Directional {
  /** The directional spelled out. */
  word: string;
  /** Its abbreviation. */
  abbreviation: string;
}

/**
 * The eight directionals, spelled out and abbreviated.
 *
 * @internal exported so the doc-parity test can hold DEFAULT_STANDARDIZATION.md's
 * directional table to this exact list.
 */
export const DIRECTIONALS: readonly Directional[] = [
  { word: "NORTH", abbreviation: "N" },
  { word: "SOUTH", abbreviation: "S" },
  { word: "EAST", abbreviation: "E" },
  { word: "WEST", abbreviation: "W" },
  { word: "NORTHEAST", abbreviation: "NE" },
  { word: "NORTHWEST", abbreviation: "NW" },
  { word: "SOUTHEAST", abbreviation: "SE" },
  { word: "SOUTHWEST", abbreviation: "SW" },
];

// A form listed in more than one row takes the first row listing it: MDW is a
// common form of MEADOWS but the standard abbreviation of MEADOW, the earlier
// row, so an abbreviation already in standard form keeps it.
const SUFFIX_BY_FORM: ReadonlyMap<string, StreetSuffix> = (() => {
  const byForm = new Map<string, StreetSuffix>();
  for (const suffix of STREET_SUFFIXES)
    for (const form of [suffix.name, ...suffix.forms, suffix.abbreviation])
      if (!byForm.has(form)) byForm.set(form, suffix);
  return byForm;
})();

const DIRECTIONAL_BY_FORM: ReadonlyMap<string, Directional> = new Map(
  DIRECTIONALS.flatMap((directional) => [
    [directional.word, directional] as const,
    [directional.abbreviation, directional] as const,
  ]),
);

/** One word of the value, or two directional words read as one. */
interface StreetNameUnit {
  text: string;
  directional?: Directional;
  suffix?: StreetSuffix;
}

function asciiUpperCase(word: string): string {
  return word.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

function unitOf(text: string): StreetNameUnit {
  const key = asciiUpperCase(text);
  return {
    text,
    directional: DIRECTIONAL_BY_FORM.get(key),
    suffix: SUFFIX_BY_FORM.get(key),
  };
}

// NORTH or SOUTH followed by EAST or WEST, in either spelling, names the
// two-letter directional; NORTH SOUTH and EAST WEST name none.
function combinedDirectional(
  first: StreetNameUnit,
  second: StreetNameUnit,
): StreetNameUnit | undefined {
  const a = first.directional?.abbreviation;
  const b = second.directional?.abbreviation;
  if ((a !== "N" && a !== "S") || (b !== "E" && b !== "W")) return undefined;
  return {
    text: `${first.text} ${second.text}`,
    directional: DIRECTIONAL_BY_FORM.get(a + b),
  };
}

function spelledOut(unit: StreetNameUnit): string {
  return unit.directional?.word ?? unit.suffix?.name ?? unit.text;
}

const WHITESPACE_RUN_PATTERN = /\p{White_Space}+/u;

/**
 * The street name with its suffix and directionals in their USPS Publication 28
 * forms, read by position: a trailing directional is the postdirectional, the
 * last word before it a suffix, a leading directional the predirectional, and
 * each is abbreviated. A directional or suffix word that is part of the street
 * name is spelled out where the standard places it there; every other word is
 * kept as written. Words are compared in any ASCII letter case and rejoined
 * with one space. The rules: docs/spec/DEFAULT_STANDARDIZATION.md#street_name.
 */
export function uspsStreetName(value: string): string {
  let units = value
    .split(WHITESPACE_RUN_PATTERN)
    .filter((word) => word !== "")
    .map(unitOf);
  const leadingPair =
    units.length >= 2 ? combinedDirectional(units[0], units[1]) : undefined;
  if (leadingPair !== undefined) units = [leadingPair, ...units.slice(2)];
  const trailingPair =
    units.length >= 3
      ? combinedDirectional(units[units.length - 2], units[units.length - 1])
      : undefined;
  if (trailingPair !== undefined) units = [...units.slice(0, -2), trailingPair];

  let begin = 0;
  let end = units.length;
  let postdirectional: string | undefined;
  let suffix: string | undefined;
  let predirectional: string | undefined;
  if (end >= 2 && units[end - 1].directional !== undefined) {
    postdirectional = units[end - 1].directional?.abbreviation;
    end -= 1;
  }
  if (end >= 2 && units[end - 1].suffix !== undefined) {
    suffix = units[end - 1].suffix?.abbreviation;
    end -= 1;
  }
  if (end >= 2 && units[0].directional !== undefined) {
    predirectional = units[0].directional.abbreviation;
    begin = 1;
  }

  const name = units.slice(begin, end);
  const nameWords = name.map((unit) => unit.text);
  const last = name.length - 1;
  if (name.length === 1) nameWords[0] = spelledOut(name[0]);
  else {
    // The second of two directionals that do not combine is part of the name.
    if (predirectional !== undefined && name[0].directional !== undefined)
      nameWords[0] = spelledOut(name[0]);
    if (suffix !== undefined) nameWords[last] = spelledOut(name[last]);
  }
  return [predirectional, ...nameWords, suffix, postdirectional]
    .filter((word) => word !== undefined)
    .join(" ");
}
