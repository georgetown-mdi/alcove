import { describe, expect, test } from "vitest";

import {
  PLACEHOLDER_IDENTITY,
  unnamedPartyIdentity,
} from "../../src/config/partyIdentityLabel";

describe("unnamedPartyIdentity", () => {
  test("treats a missing, empty, or whitespace-only identity as absent", () => {
    expect(unnamedPartyIdentity(undefined)).toBe("absent");
    expect(unnamedPartyIdentity("")).toBe("absent");
    expect(unnamedPartyIdentity(" \t\n")).toBe("absent");
  });

  test("refuses the template placeholder, trimmed, and only alone on the field", () => {
    expect(unnamedPartyIdentity(PLACEHOLDER_IDENTITY)).toBe("placeholder");
    expect(unnamedPartyIdentity(`  ${PLACEHOLDER_IDENTITY} `)).toBe(
      "placeholder",
    );
    expect(
      unnamedPartyIdentity(PLACEHOLDER_IDENTITY.toLowerCase()),
    ).toBeUndefined();
    expect(
      unnamedPartyIdentity(`Agency A, not ${PLACEHOLDER_IDENTITY}`),
    ).toBeUndefined();
  });

  test("accepts a name", () => {
    expect(unnamedPartyIdentity("County Health Dept")).toBeUndefined();
  });
});
