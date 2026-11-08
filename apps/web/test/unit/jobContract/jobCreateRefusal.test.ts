import { describe, expect, test } from "vitest";

import {
  JobApiRequestError,
  createFetchJobApiClient,
} from "@psi/jobClient/serverJobExchangeDriver";
import {
  isJobCreateRefusalReason,
  isZeroSetupSftpRefusalReason,
} from "@jobContract/jobCreateRefusal";
import { failureFor } from "@exchange/useInviterExchange";

import {
  VALID_SHARED_SECRET,
  validLinkageTerms,
} from "../../utils/jobFixtures";

import type { JobInputSource } from "@psi/jobClient/serverJobExchangeDriver";

// The tokens a console sends today, written out rather than read from the
// module, so a token dropped from or renamed in the list fails here.
const SENT_TOKENS = [
  "signing-identity-in-rendezvous",
  "sftp-fingerprint-list",
  "sftp-url-directory",
  "mounted-key-file-absent",
  "mounted-key-file-invalid",
  "mounted-key-file-newer",
  "mounted-signing-paths-unconverted",
  "mounted-signing-identity-mismatch",
  "opened-configuration-not-runnable",
  "sftp-credential-console-file",
  "working-folder-configuration-present",
  "working-folder-console-exchange",
  "working-folder-unwritable",
  "coordination-server-changed",
] as const;

const ZERO_SETUP_TOKENS = ["sftp-fingerprint-list", "sftp-url-directory"];

const UNLISTED_VALUES: ReadonlyArray<unknown> = [
  "who-knows",
  "",
  "SFTP-URL-DIRECTORY",
  "sftp-url-directory ",
  " sftp-url-directory",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  undefined,
  null,
  0,
  true,
  {},
  ["sftp-url-directory"],
  { reason: "sftp-url-directory" },
  new String("sftp-url-directory"),
];

const WORK_FILE: JobInputSource = { kind: "workFile", name: "clients.csv" };

describe("the job-create refusal allowlist", () => {
  test.each(SENT_TOKENS)("admits the sent token %s", (token) => {
    expect(isJobCreateRefusalReason(token)).toBe(true);
  });

  test("refuses every value that is not a listed token", () => {
    for (const value of UNLISTED_VALUES)
      expect(isJobCreateRefusalReason(value)).toBe(false);
  });

  test("admits only the two direct-run tokens as zero-setup refusals", () => {
    for (const token of SENT_TOKENS)
      expect(isZeroSetupSftpRefusalReason(token)).toBe(
        ZERO_SETUP_TOKENS.includes(token),
      );
    for (const value of UNLISTED_VALUES)
      expect(isZeroSetupSftpRefusalReason(value)).toBe(false);
  });

  test("an unknown token from a newer console gets the generic refusal copy", async () => {
    const refusedCreate = async (
      body: string | null,
    ): Promise<JobApiRequestError> => {
      const thrown: unknown = await createFetchJobApiClient(() =>
        Promise.resolve(new Response(body, { status: 400 })),
      )
        .createJob(
          {
            channel: "filedrop",
            linkageTerms: validLinkageTerms(),
            sharedSecret: VALID_SHARED_SECRET,
            inputCsv: "x\n",
            eventStream: true,
          },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      if (!(thrown instanceof JobApiRequestError))
        throw new Error("the create was not refused");
      return thrown;
    };

    const unknown = await refusedCreate(
      JSON.stringify({ reason: "a-token-from-a-newer-console" }),
    );
    expect(unknown.refusalReason).toBeUndefined();
    const empty = await refusedCreate(null);
    const unknownFailure = failureFor("config", unknown, {
      inputSource: WORK_FILE,
    });
    expect(unknownFailure.title).toBe(
      "The console could not start this exchange",
    );
    expect(unknownFailure).toEqual(
      failureFor("config", empty, { inputSource: WORK_FILE }),
    );
  });
});
