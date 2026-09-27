import { describe, expect, test } from "vitest";

import { managedImportGrantNotice } from "@recurring/managedImportGrantNotice";

// What an import tells the operator about the grant it could not bring. The
// notice names only a grant the import is actually missing: an import that
// brought everything its source had says nothing at all.

describe("the import grant notice", () => {
  test("names the folder and what a run with nobody present does without it", () => {
    const notice = managedImportGrantNotice(["working-folder"]);
    expect(notice?.title).toBe("Choose this exchange's folder again");
    expect(notice?.lead).toContain(
      "This browser does not have the folder this exchange used",
    );
    expect(notice?.lead).toContain("Open the exchange to choose it now.");
    expect(notice?.consequences).toEqual([
      "Without its folder, a run that happens with nobody present cannot read its input and stops.",
    ]);
  });

  test("nothing missing shows no notice at all", () => {
    // The revive-in-place case: the record kept the grants it already had, so an
    // import that says anything here would be saying it about nothing.
    expect(managedImportGrantNotice([])).toBeUndefined();
  });
});
