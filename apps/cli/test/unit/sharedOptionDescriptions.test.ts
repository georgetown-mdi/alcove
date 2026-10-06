import { expect, test } from "vitest";
import type { Argv } from "yargs";

import { builder as acceptBuilder } from "../../src/commands/accept";
import { builder as applyBuilder } from "../../src/commands/apply";
import { builder as enrollRelayBuilder } from "../../src/commands/enrollRelay";
import { builder as exchangeBuilder } from "../../src/commands/exchange";
import { builder as fingerprintBuilder } from "../../src/commands/fingerprint";
import { builder as initBuilder } from "../../src/commands/init";
import { builder as inviteBuilder } from "../../src/commands/invite";
import { builder as probeHostKeyBuilder } from "../../src/commands/probeHostKey";
import { builder as updateBuilder } from "../../src/commands/update";
import { builder as verifyReceiptBuilder } from "../../src/commands/verifyReceipt";
import { builder as zeroSetupBuilder } from "../../src/commands/zeroSetup";

// Each builder only chains, so a stand-in for yargs that returns itself from
// every method collects the help text each option is declared with.
function optionDescriptions(
  builder: (cmd: Argv) => Argv,
): Record<string, string> {
  const described: Record<string, string> = {};
  const recorder: Argv = new Proxy({} as Argv, {
    get: (_target, method) => {
      if (method === "option")
        return (name: string, config: { describe: string }) => {
          described[name] = config.describe;
          return recorder;
        };
      return () => recorder;
    },
  });
  builder(recorder);
  return described;
}

const COMMANDS: Record<string, (cmd: Argv) => Argv> = {
  "quick exchange": zeroSetupBuilder,
  invite: inviteBuilder,
  accept: acceptBuilder,
  exchange: exchangeBuilder,
  init: initBuilder,
  update: updateBuilder,
  apply: applyBuilder,
  fingerprint: fingerprintBuilder,
  "enroll-relay": enrollRelayBuilder,
  "verify-receipt": verifyReceiptBuilder,
  "probe-host-key": probeHostKeyBuilder,
};

// Options whose help text states what the flag does on that command: the
// path flags name the file each command reads or writes, and the connection
// overrides name a URL or a loaded configuration.
const WORDED_PER_COMMAND = new Set([
  "config-file",
  "key-file",
  "identity",
  "identity-file",
  "json",
  "consent-to-terms",
  "linkage-strategy",
  "peer-id",
  "outbound-path",
  "server-port",
  "server-username",
  "server-password",
  "server-private-key",
  "server-private-key-passphrase",
  "server-keyboard-interactive",
  "server-host-key-fingerprint",
]);

test("an option two commands share has one description", () => {
  const byOption = new Map<string, Map<string, string[]>>();
  for (const [command, builder] of Object.entries(COMMANDS))
    for (const [option, text] of Object.entries(optionDescriptions(builder))) {
      if (WORDED_PER_COMMAND.has(option)) continue;
      const texts = byOption.get(option) ?? new Map<string, string[]>();
      texts.set(text, [...(texts.get(text) ?? []), command]);
      byOption.set(option, texts);
    }
  const differing = [...byOption]
    .filter(([, texts]) => texts.size > 1)
    .map(([option, texts]) => [option, [...texts.values()]]);
  expect(differing).toEqual([]);
  for (const option of [
    "retain-files",
    "timestamp-in-filename",
    "sweep-exchange-files",
    "force-retain-sweep",
    "verbose",
  ])
    expect(
      [...(byOption.get(option)?.values() ?? [])].flat().length,
    ).toBeGreaterThan(1);
});

test("--linkage-strategy differs only in the sentence for its command", () => {
  const invite = optionDescriptions(inviteBuilder)["linkage-strategy"];
  const quick = optionDescriptions(zeroSetupBuilder)["linkage-strategy"];
  const shared = "not a free speed-up. ";
  expect(invite.slice(0, invite.indexOf(shared))).toBe(
    quick.slice(0, quick.indexOf(shared)),
  );
  expect(invite).toContain("Has no effect when linkage terms come from");
  expect(quick).toContain("Both parties must select the same value");
});
