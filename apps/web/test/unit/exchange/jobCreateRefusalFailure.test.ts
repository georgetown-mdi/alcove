import { describe, expect, test } from "vitest";

import { JobApiRequestError } from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";

import type { ExchangeSeat } from "@exchange/exchangeRun";
import type { JobCreateRefusalReason } from "@jobContract/jobCreateRefusal";
import type { JobInputSource } from "@psi/jobClient/serverJobExchangeDriver";
import type { Transport } from "@psi/transportChooser";

const WORK_FILE: JobInputSource = { kind: "workFile", name: "clients.csv" };

// The category each token's alert takes today, by seat where it differs.
const TOKEN_CATEGORIES: Record<
  JobCreateRefusalReason,
  Record<ExchangeSeat, "config" | "exchange">
> = {
  "signing-identity-in-rendezvous": { inviter: "config", acceptor: "config" },
  "sftp-fingerprint-list": { inviter: "config", acceptor: "config" },
  "sftp-url-directory": { inviter: "config", acceptor: "config" },
  "mounted-key-file-absent": { inviter: "config", acceptor: "config" },
  "mounted-key-file-invalid": { inviter: "config", acceptor: "config" },
  "mounted-key-file-newer": { inviter: "config", acceptor: "config" },
  "mounted-signing-paths-unconverted": {
    inviter: "config",
    acceptor: "config",
  },
  "mounted-signing-identity-mismatch": {
    inviter: "config",
    acceptor: "config",
  },
  "opened-configuration-not-runnable": {
    inviter: "config",
    acceptor: "config",
  },
  "sftp-credential-console-file": { inviter: "config", acceptor: "config" },
  "working-folder-configuration-present": {
    inviter: "config",
    acceptor: "config",
  },
  "working-folder-console-exchange": { inviter: "config", acceptor: "config" },
  "working-folder-unwritable": { inviter: "exchange", acceptor: "exchange" },
  "coordination-server-changed": { inviter: "config", acceptor: "exchange" },
};

// The titles of the branches below the token copy that a token must not reach:
// the mounted-file 400, which blames the input file, and the generic copy.
const FALLTHROUGH_TITLES = [
  "The console could not start this exchange",
  "Could not prepare the exchange",
  "Exchange failed",
];

const SEATS: ReadonlyArray<ExchangeSeat> = ["inviter", "acceptor"];
const CHANNELS: ReadonlyArray<Transport> = ["filedrop", "sftp", "webrtc"];

describe("the job-create refusal copy", () => {
  test.each(Object.keys(TOKEN_CATEGORIES) as Array<JobCreateRefusalReason>)(
    "%s has its own copy, never the input file's",
    (reason) => {
      for (const seat of SEATS)
        for (const channel of CHANNELS)
          for (const status of [400, 500])
            for (const category of ["config", "exchange"] as const) {
              const failure = failureFor(
                category,
                new JobApiRequestError(status, "refused", undefined, reason),
                { inputSource: WORK_FILE, channel, seat },
              );
              expect(FALLTHROUGH_TITLES).not.toContain(failure.title);
              expect(failure.category).toBe(TOKEN_CATEGORIES[reason][seat]);
              expect(failure.retry).toBe(
                failure.category === "exchange" ? "offered" : "withheld",
              );
            }
    },
  );

  test("the signing-identity copy names the picked location only when one was picked", () => {
    const refusal = new JobApiRequestError(
      400,
      "refused",
      undefined,
      "signing-identity-in-rendezvous",
    );
    const picked = failureFor("config", refusal, {
      inputSource: WORK_FILE,
      channel: "filedrop",
      seat: "inviter",
      identityLocationPicked: true,
    });
    const unpicked = failureFor("config", refusal, {
      inputSource: WORK_FILE,
      channel: "filedrop",
      seat: "inviter",
      identityLocationPicked: false,
    });
    expect(picked.title).toBe(unpicked.title);
    expect(picked.message).toContain("the location you picked");
    expect(unpicked.message).not.toContain("the location you picked");
  });

  test("a busy create keeps its own copy whatever token it states", () => {
    const failure = failureFor(
      "exchange",
      new JobApiRequestError(
        409,
        "busy",
        "job-1",
        "coordination-server-changed",
      ),
    );
    expect(failure.title).toBe("This console is already running an exchange");
  });
});
