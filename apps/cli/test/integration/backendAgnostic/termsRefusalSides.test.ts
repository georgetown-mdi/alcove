import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { prepareForExchange } from "@alcove/core";
import type { LinkageTerms, PreparedExchange } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { saveKeyFile } from "../../../src/keyFile";
import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
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
      ...(onAuthenticated === undefined ? {} : { onAuthenticated }),
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

test("a run whose configuration write failed names a fresh invitation as the step", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const configurationWriteFails = (): void => {
    throw new Error("the configuration directory is read-only");
  };
  const [[unwritten, configured]] = await withCapturedLogs(
    () =>
      Promise.all([
        run(
          "unwritten",
          dropDir,
          prepared("Cascade Co", "cascade"),
          configurationWriteFails,
        ),
        run("configured", dropDir, prepared("Single Pass Co", "single-pass")),
      ]),
    () => true,
  );
  const unwrittenStep =
    TERMS_REFUSAL_NEXT_STEPS["configuration-unwritten"]["this-party"];
  expect(unwritten.endsWith(`\n${unwrittenStep}`)).toBe(true);
  expect(unwritten).not.toContain("alcove update");
  const configuredRefusedBy = configured.includes(
    "linkage terms are incompatible: ",
  )
    ? "this-party"
    : "partner";
  expect(
    configured.endsWith(
      `\n${TERMS_REFUSAL_NEXT_STEPS.configured[configuredRefusedBy]}`,
    ),
  ).toBe(true);
}, 30_000);
