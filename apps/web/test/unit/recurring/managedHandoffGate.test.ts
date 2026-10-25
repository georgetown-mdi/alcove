import { describe, expect, test } from "vitest";

import {
  CUSTODY_UNREADABLE_IMPORT_TITLE,
  custodyUnreadableImportReason,
  handedOffImportReason,
} from "@recurring/managedHandoffGate";

describe("the import refusal for a handed-off copy", () => {
  test("the refused import names the exchange the operator knows", () => {
    expect(handedOffImportReason("command-line", "Riverbend")).toContain(
      '"Riverbend"',
    );
    expect(handedOffImportReason("command-line", "")).toContain(
      "That exchange",
    );
  });
});

describe("the import refusal for a stored copy that could not be read", () => {
  test("names this browser's stored copy, not the file it was given", () => {
    expect(CUSTODY_UNREADABLE_IMPORT_TITLE).toContain("stored copy");
    expect(CUSTODY_UNREADABLE_IMPORT_TITLE).not.toContain("file");
    expect(custodyUnreadableImportReason("Riverbend")).toContain(
      "This browser could not read the note it keeps beside",
    );
  });

  test("names no hand-off route, none having been read", () => {
    const reason = custodyUnreadableImportReason("Riverbend");
    expect(reason).not.toContain("command line");
    expect(reason).not.toContain("alcove.yaml");
  });

  test("names the exchange the operator knows", () => {
    expect(custodyUnreadableImportReason("Riverbend")).toContain('"Riverbend"');
    expect(custodyUnreadableImportReason("")).toContain("that exchange");
  });

  test("gives both branches of the answer only the operator has", () => {
    // Whether the exchange was handed off is the one thing this browser could not
    // read and the operator can, so the remedy is stated for each answer rather
    // than sending them to a control that cannot decide it.
    const reason = custodyUnreadableImportReason("Riverbend");
    expect(reason).toContain("If you handed this exchange off");
    expect(reason).toContain("If you did not, remove that exchange");
  });
});
