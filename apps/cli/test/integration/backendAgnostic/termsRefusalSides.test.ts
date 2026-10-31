import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { getLogger, prepareForExchange } from "@alcove/core";
import type { LinkageTerms, PreparedExchange, TermsChange } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";
import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import {
  termsChangeHandler,
  termsProposalPath,
} from "../../../src/termsChange";
import { TERMS_REFUSAL_NEXT_STEPS } from "../../../src/termsRefusalRemedy";
import { renderFailureForOperator } from "../../../src/util/exit";
import { firstNameTerms } from "../../support";

// Two CLI parties whose linkage strategies differ run a real file-drop
// exchange. The party that refuses and the party whose run its abort ends each
// state the difference from their own side, and the next step for that side.

const SHARED_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-terms-sides-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function prepared(
  identity: string,
  strategy: LinkageTerms["linkageStrategy"],
): PreparedExchange {
  return prepareForExchange(
    {
      linkageTerms: { ...firstNameTerms, identity, linkageStrategy: strategy },
    },
    identity,
    [{ first_name: "Bob" }],
    ["first_name"],
  );
}

async function run(
  name: string,
  dropDir: string,
  exchange: PreparedExchange,
  onAuthenticated?: () => void,
  onTermsChange?: (change: TermsChange) => Promise<void>,
): Promise<string> {
  const keyFilePath = path.join(work, `${name}.key`);
  saveKeyFile(keyFilePath, { sharedSecret: SHARED_SECRET });
  const connection: ProtocolConnectionConfig = {
    channel: "filedrop",
    path: dropDir,
    options: {
      pollIntervalMs: 1,
      peerTimeoutMs: 20_000,
      inactivityTimeoutMs: 20_000,
    },
  };
  try {
    await runProtocol({
      connection,
      auth: { sharedSecret: SHARED_SECRET, keyFilePath },
      prepared: exchange,
      output: path.join(work, `${name}-out`),
      verbosity: -1,
      loggerName: `terms-sides-${name}`,
      ...(onTermsChange === undefined ? {} : { onTermsChange }),
      ...(onAuthenticated === undefined
        ? {}
        : {
            onAuthenticated,
            onlineSetup: {
              configPath: path.join(work, `${name}.yaml`),
              kept: false,
            },
          }),
    });
  } catch (err) {
    return renderFailureForOperator(err);
  }
  throw new Error(`${name} completed an exchange its terms should refuse`);
}

test("each party states a linkage strategy difference from its own side", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const [[cascade, singlePass]] = await withCapturedLogs(
    () =>
      Promise.all([
        run("cascade", dropDir, prepared("Cascade Co", "cascade")),
        run("single-pass", dropDir, prepared("Single Pass Co", "single-pass")),
      ]),
    () => true,
  );
  const sides = [
    {
      rendered: cascade,
      own: `linkage strategy mismatch: yours is "cascade", your partner's is "single-pass"`,
    },
    {
      rendered: singlePass,
      own: `linkage strategy mismatch: yours is "single-pass", your partner's is "cascade"`,
    },
  ];
  for (const { rendered, own } of sides) expect(rendered).toContain(own);
  // One party refused, and the other read the refusal from the partner.
  expect(
    sides.filter(({ rendered }) =>
      rendered.includes("linkage terms are incompatible: "),
    ),
  ).toHaveLength(1);
  expect(
    sides.filter(({ rendered }) =>
      rendered.includes(
        "Your partner stopped the exchange because the linkage terms differ: ",
      ),
    ),
  ).toHaveLength(1);
  for (const { rendered } of sides) {
    const refusedBy = rendered.includes("linkage terms are incompatible: ")
      ? "this-party"
      : "partner";
    expect(
      rendered.endsWith(`\n${TERMS_REFUSAL_NEXT_STEPS.configured[refusedBy]}`),
    ).toBe(true);
  }
}, 30_000);

// The key-file save runs inside the terms exchange once the terms are agreed
// on, and the configuration write after it, so a run the terms refuse reaches
// neither and keeps its secret. The run passing that write states the online
// invitation's step.
test("a run refused at the terms exchange runs no configuration write", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  let configurationWrites = 0;
  const configurationWrite = (): void => {
    configurationWrites += 1;
  };
  const [[hooked, plain]] = await withCapturedLogs(
    () =>
      Promise.all([
        run(
          "hooked",
          dropDir,
          prepared("Cascade Co", "cascade"),
          configurationWrite,
        ),
        run("plain", dropDir, prepared("Single Pass Co", "single-pass")),
      ]),
    () => true,
  );
  expect(configurationWrites).toBe(0);
  for (const name of ["hooked", "plain"])
    expect(loadKeyFile(path.join(work, `${name}.key`))?.sharedSecret).toBe(
      SHARED_SECRET,
    );
  expect(
    hooked.endsWith(
      `\n${TERMS_REFUSAL_NEXT_STEPS["online-invitation"]["this-party"]}`,
    ),
  ).toBe(true);
  const plainRefusedBy = plain.includes("linkage terms are incompatible: ")
    ? "this-party"
    : "partner";
  expect(
    plain.endsWith(`\n${TERMS_REFUSAL_NEXT_STEPS.configured[plainRefusedBy]}`),
  ).toBe(true);
}, 30_000);

// A configuration `alcove accept` kept holds the previous acceptance's
// expected_partner_deduplicate until the run's step after the terms exchange
// refreshes it, so a run cut before that step leaves the old value. The
// `alcove exchange` its step advises holds the partner to that value, with the
// exchange command's terms-change handler.
test("a kept configuration's stale acceptance record stops the next exchange at the terms, naming alcove apply", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const kept: PreparedExchange = {
    ...prepared("Kept Co", "cascade"),
    expectedPartnerDeduplicate: false,
  };
  const partner = prepareForExchange(
    {
      linkageTerms: {
        ...firstNameTerms,
        identity: "Partner Co",
        deduplicate: true,
      },
    },
    "Partner Co",
    [{ first_name: "Bob" }],
    ["first_name"],
  );
  const keptConfig = path.join(work, "kept.yaml");
  const [[keptRendered]] = await withCapturedLogs(
    () =>
      Promise.all([
        run(
          "kept",
          dropDir,
          kept,
          undefined,
          termsChangeHandler({
            configPath: keptConfig,
            keyPath: path.join(work, "kept.key"),
            interactive: false,
            log: getLogger("terms-sides-kept"),
          }),
        ),
        run("partner", dropDir, partner),
      ]),
    () => true,
  );
  expect(keptRendered).toContain(
    "your partner's deduplicate, which only alcove apply takes on",
  );
  expect(keptRendered).toContain("alcove apply ");
  expect(fs.existsSync(termsProposalPath(keptConfig))).toBe(true);
  expect(loadKeyFile(path.join(work, "kept.key"))?.sharedSecret).toBe(
    SHARED_SECRET,
  );
}, 30_000);
