import { describe, expect, test } from "vitest";

import {
  EMPTY_SAVE_FIELDS,
  credentialAlertCopy,
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
  liveRunLedgerFooter,
  runCommand,
  saveCapabilityCopy,
  saveExchangeError,
  saveLeadCopy,
} from "@exchange/saveExchangeModel";
import { preRunTrustFooter, settledTrustFooter } from "@exchange/trustFooter";

import type { LinkageTerms, Metadata } from "@alcove/core";
import type { GeneratedInvitation } from "@psi/invitation";
import type { SaveExchangeFields } from "@exchange/saveExchangeModel";

const terms = {
  identity: "Dana",
  linkageKeys: [{ name: "key 1", elements: [] }],
} as unknown as LinkageTerms;

// Two columns, one disclosed (`program_code`, isPayload) and one match-only
// (`dob`).
const metadata = [
  { name: "program_code", role: "payload", isPayload: true },
  { name: "dob", role: "match", isPayload: false },
] as unknown as Metadata;

function invitationStub(
  overrides: Partial<GeneratedInvitation> = {},
): GeneratedInvitation {
  return {
    encoded: "ENCODED_TOKEN",
    deepLink: "https://example.org/accept#ENCODED_TOKEN",
    sharedSecret: "secret",
    expires: "2026-07-08T19:32:00.000Z",
    linkageTerms: terms,
    rawRows: [],
    columns: ["program_code", "dob"],
    metadata,
    standardization: undefined,
    ...overrides,
  };
}

const sftpFields: SaveExchangeFields = {
  ...EMPTY_SAVE_FIELDS,
  host: "sftp.riverbend.example.gov",
  remoteDirectory: "/exchanges/alcove",
};

const filedropFields: SaveExchangeFields = {
  ...EMPTY_SAVE_FIELDS,
  sharedDirectory: "/exchanges/alcove",
};

describe("save-surface field validation", () => {
  test("SFTP requires a non-empty host; directory is optional", () => {
    expect(saveExchangeError("sftp", EMPTY_SAVE_FIELDS)?.field).toBe("host");
    expect(
      saveExchangeError("sftp", { ...EMPTY_SAVE_FIELDS, host: "   " })?.field,
    ).toBe("host");
    expect(
      saveExchangeError("sftp", { ...EMPTY_SAVE_FIELDS, host: "sftp.example" }),
    ).toBeUndefined();
    expect(saveExchangeError("sftp", sftpFields)).toBeUndefined();
  });

  test("filedrop requires an absolute shared directory", () => {
    expect(saveExchangeError("filedrop", EMPTY_SAVE_FIELDS)?.field).toBe(
      "sharedDirectory",
    );
    const relative = saveExchangeError("filedrop", {
      ...EMPTY_SAVE_FIELDS,
      sharedDirectory: "exchanges/alcove",
    });
    expect(relative?.field).toBe("sharedDirectory");
    expect(relative?.message).toContain("absolute");
    expect(saveExchangeError("filedrop", filedropFields)).toBeUndefined();
    expect(
      saveExchangeError("filedrop", {
        ...EMPTY_SAVE_FIELDS,
        sharedDirectory: "C:\\exchanges",
      }),
    ).toBeUndefined();
  });
});

describe("filename derivation", () => {
  test("stamps the local calendar day of the mint moment", () => {
    expect(exchangeFileName(new Date(2026, 6, 8, 15, 32))).toBe(
      "alcove-exchange-2026-07-08.yaml",
    );
    expect(exchangeFileName(new Date(2026, 11, 1, 0, 0))).toBe(
      "alcove-exchange-2026-12-01.yaml",
    );
  });
});

describe("copy is transport-specific", () => {
  test("lead names the transport and the capability statement is explicit", () => {
    expect(saveLeadCopy("sftp")).toContain("over SFTP");
    expect(saveLeadCopy("filedrop")).toContain("over a shared folder");
    expect(saveCapabilityCopy("sftp")).toContain("Alcove command-line tool");
    expect(saveCapabilityCopy("sftp")).toContain("does not run SFTP");
    expect(saveCapabilityCopy("filedrop")).toContain(
      "does not run shared-folder",
    );
  });

  test("the SFTP credential alert names what the operator actually supplies", () => {
    const copy = credentialAlertCopy("sftp");
    expect(copy).toContain("Credentials are never stored in this file");
    expect(copy).toContain("SSH username");
    expect(copy).toContain("@file reference");
    expect(copy).toContain("exchange secret");
    expect(copy).not.toMatch(/supplies them at run time from its own key/);
  });

  test("the filedrop credential alert is untouched: no credentials at all", () => {
    expect(credentialAlertCopy("filedrop")).toBe(
      "A shared-folder exchange has no credentials at all. The file " +
        "names only the folder both parties can reach.",
    );
  });
});

describe("live-run ledger footer by driver", () => {
  test("states the pre-run footer until a result lands, whatever the driver", () => {
    expect(liveRunLedgerFooter(false, false)).toBe(preRunTrustFooter(2));
    expect(liveRunLedgerFooter(true, false)).toBe(preRunTrustFooter(2));
  });

  test("states the settled footer for the driver once a result lands", () => {
    expect(liveRunLedgerFooter(false, true)).toBe(settledTrustFooter(false));
    expect(liveRunLedgerFooter(true, true)).toBe(settledTrustFooter(true));
  });
});

describe("the run command names the minted config file", () => {
  test("interpolates the exact filename with --config-file, ahead of --invitation", () => {
    expect(runCommand("alcove-exchange-2026-07-10.yaml")).toBe(
      "alcove exchange your-data.csv --config-file " +
        "alcove-exchange-2026-07-10.yaml --invitation @invitation.txt",
    );
  });

  test("a re-save's new date-derived filename flows straight through", () => {
    expect(runCommand(exchangeFileName(new Date(2026, 11, 25)))).toBe(
      "alcove exchange your-data.csv --config-file " +
        "alcove-exchange-2026-12-25.yaml --invitation @invitation.txt",
    );
  });
});

describe("endpoint and config derive from one locator", () => {
  test("SFTP request and config hold the authored host and path", () => {
    const request = endpointRequestFor("sftp", sftpFields);
    expect(request).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
      path: "/exchanges/alcove",
    });
    const input = exchangeFileInputFor("sftp", sftpFields, invitationStub());
    expect(input.connection).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
      path: "/exchanges/alcove",
    });
    // The config's terms and metadata are read off the same minted invitation
    // the code came from -- config and token agree.
    expect(input.linkageTerms).toBe(terms);
    expect(input.metadata).toBe(metadata);
  });

  test("an empty remote directory is omitted, not sent as an empty path", () => {
    const fields = { ...sftpFields, remoteDirectory: "" };
    expect(endpointRequestFor("sftp", fields)).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
    });
    expect(
      exchangeFileInputFor("sftp", fields, invitationStub()).connection,
    ).toEqual({ channel: "sftp", host: "sftp.riverbend.example.gov" });
  });

  test("filedrop request and config hold the shared directory only", () => {
    expect(endpointRequestFor("filedrop", filedropFields)).toEqual({
      channel: "filedrop",
      path: "/exchanges/alcove",
    });
    expect(
      exchangeFileInputFor("filedrop", filedropFields, invitationStub())
        .connection,
    ).toEqual({ channel: "filedrop", path: "/exchanges/alcove" });
  });
});
