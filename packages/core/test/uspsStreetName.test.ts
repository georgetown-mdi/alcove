import { describe, expect, test } from "vitest";

import { runPipeline } from "../src/standardization";
import {
  DIRECTIONALS,
  STREET_SUFFIXES,
  uspsStreetName,
} from "../src/uspsStreetName";

const step = [{ function: "usps_street_name" }];

describe("usps_street_name: the street suffix", () => {
  test("abbreviates a suffix word in suffix position", () => {
    expect(uspsStreetName("MAIN STREET")).toBe("MAIN ST");
    expect(uspsStreetName("ELM AVENUE")).toBe("ELM AVE");
    expect(uspsStreetName("PACIFIC COAST HIGHWAY")).toBe("PACIFIC COAST HWY");
  });

  test("abbreviates every listed form of a row to its standard abbreviation", () => {
    for (const suffix of STREET_SUFFIXES)
      for (const form of [suffix.name, ...suffix.forms])
        if (suffix.name !== "MEADOWS" || form !== "MDW")
          expect(uspsStreetName(`OAK ${form}`), form).toBe(
            `OAK ${suffix.abbreviation}`,
          );
  });

  test("keeps a standard abbreviation as it is, even where another row lists it", () => {
    for (const suffix of STREET_SUFFIXES)
      expect(uspsStreetName(`OAK ${suffix.abbreviation}`)).toBe(
        `OAK ${suffix.abbreviation}`,
      );
    expect(uspsStreetName("SUNNY MDW")).toBe("SUNNY MDW");
    expect(uspsStreetName("SUNNY MEADOWS")).toBe("SUNNY MDWS");
  });

  test("keeps a suffix word outside suffix position", () => {
    expect(uspsStreetName("ST MARYS RD")).toBe("ST MARYS RD");
    expect(uspsStreetName("MT VERNON AVE")).toBe("MT VERNON AVE");
    expect(uspsStreetName("HIGHWAY 64")).toBe("HIGHWAY 64");
    expect(uspsStreetName("AVENUE OF THE AMERICAS")).toBe(
      "AVENUE OF THE AMERICAS",
    );
  });

  test("spells out the first of two suffix words, which is part of the name", () => {
    expect(uspsStreetName("MAIN AVENUE DRIVE")).toBe("MAIN AVENUE DR");
    expect(uspsStreetName("MAIN AVE DR")).toBe("MAIN AVENUE DR");
    expect(uspsStreetName("3RD STREET CIRCLE WEST")).toBe("3RD STREET CIR W");
    expect(uspsStreetName("PRK AVE")).toBe("PARK AVE");
  });

  test("spells out a suffix word that is the whole street name", () => {
    expect(uspsStreetName("AVE E")).toBe("AVENUE E");
    expect(uspsStreetName("AVENUE E")).toBe("AVENUE E");
    expect(uspsStreetName("PKWY")).toBe("PARKWAY");
    expect(uspsStreetName("PARK")).toBe("PARK");
  });
});

describe("usps_street_name: directionals", () => {
  test("abbreviates a leading directional, the predirectional", () => {
    expect(uspsStreetName("NORTH BAY STREET")).toBe("N BAY ST");
    expect(uspsStreetName("EAST END AVE")).toBe("E END AVE");
    expect(uspsStreetName("WEST 8TH")).toBe("W 8TH");
  });

  test("abbreviates a trailing directional, the postdirectional", () => {
    expect(uspsStreetName("BAY DRIVE WEST")).toBe("BAY DR W");
    expect(uspsStreetName("MAIN NORTH")).toBe("MAIN N");
  });

  test("abbreviates each directional in either position", () => {
    for (const { word, abbreviation } of DIRECTIONALS) {
      expect(uspsStreetName(`${word} OAK ST`)).toBe(`${abbreviation} OAK ST`);
      expect(uspsStreetName(`OAK ST ${word}`)).toBe(`OAK ST ${abbreviation}`);
    }
  });

  test("reads two directional words that combine as one", () => {
    expect(uspsStreetName("NORTH E MAIN STREET")).toBe("NE MAIN ST");
    expect(uspsStreetName("SOUTH WEST 8TH ST")).toBe("SW 8TH ST");
    expect(uspsStreetName("S W 8TH ST")).toBe("SW 8TH ST");
    expect(uspsStreetName("MAIN ST NORTH EAST")).toBe("MAIN ST NE");
    expect(uspsStreetName("NORTH EAST ST")).toBe(uspsStreetName("NE ST"));
  });

  test("keeps the second of NORTH SOUTH or EAST WEST as part of the name", () => {
    expect(uspsStreetName("EAST WEST HWY")).toBe("E WEST HWY");
    expect(uspsStreetName("E W HWY")).toBe("E WEST HWY");
    expect(uspsStreetName("NORTH SOUTH ST")).toBe("N SOUTH ST");
  });

  test("spells out a directional between the name and the suffix", () => {
    expect(uspsStreetName("BAY W DRIVE")).toBe("BAY WEST DR");
    expect(uspsStreetName("BAY WEST DR")).toBe("BAY WEST DR");
  });

  test("spells out a directional that is the whole street name", () => {
    expect(uspsStreetName("NORTH AVENUE")).toBe("NORTH AVE");
    expect(uspsStreetName("N AVE")).toBe("NORTH AVE");
    expect(uspsStreetName("SOUTHEAST FREEWAY NORTH")).toBe("SOUTHEAST FWY N");
    expect(uspsStreetName("NE")).toBe("NORTHEAST");
  });

  test("reads a grid address's two directionals around a numbered name", () => {
    expect(uspsStreetName("E 1700 S")).toBe("E 1700 S");
    expect(uspsStreetName("EAST 1700 SOUTH")).toBe("E 1700 S");
  });

  test("no form is both a directional and a suffix", () => {
    const suffixForms = new Set(
      STREET_SUFFIXES.flatMap((s) => [s.name, ...s.forms, s.abbreviation]),
    );
    for (const { word, abbreviation } of DIRECTIONALS) {
      expect(suffixForms.has(word)).toBe(false);
      expect(suffixForms.has(abbreviation)).toBe(false);
    }
  });
});

describe("usps_street_name: words and whitespace", () => {
  test("compares words in any ASCII letter case and keeps other words as written", () => {
    expect(uspsStreetName("Main Street")).toBe("Main ST");
    expect(uspsStreetName("north Bay st")).toBe("N Bay ST");
  });

  test("rejoins the words with one space", () => {
    expect(uspsStreetName("  MAIN \t STREET  ")).toBe("MAIN ST");
  });

  test("returns an empty value for a value with no word", () => {
    expect(uspsStreetName("")).toBe("");
    expect(uspsStreetName("   ")).toBe("");
  });

  test("leaves a value with no suffix or directional as it is", () => {
    expect(uspsStreetName("BROADWAY")).toBe("BROADWAY");
    expect(uspsStreetName("CALLE 3 NO")).toBe("CALLE 3 NO");
  });

  test("is idempotent over its own output", () => {
    for (const value of [
      "NORTH BAY STREET",
      "MAIN AVENUE DRIVE",
      "AVE E",
      "BAY W DRIVE",
      "EAST WEST HWY",
      "NORTH E MAIN STREET",
      "SOUTHEAST FREEWAY NORTH",
    ]) {
      const once = uspsStreetName(value);
      expect(uspsStreetName(once), value).toBe(once);
    }
  });

  test("runs as a standardization step", () => {
    expect(runPipeline("NORTH BAY STREET", step)).toBe("N BAY ST");
  });
});
