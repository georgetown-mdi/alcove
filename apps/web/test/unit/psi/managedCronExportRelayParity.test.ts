import { describe, expect, test } from "vitest";

import {
  COMMAND_LINE_EXPORT_LINKAGE_TERMS,
  COMMAND_LINE_EXPORT_OWN_TURN_URL,
  COMMAND_LINE_EXPORT_RELAY_CASES,
  COMMAND_LINE_EXPORT_RELAY_REGISTRAR,
} from "@alcove/core/testing";
import { generateSharedSecret, parseSensitiveYaml } from "@alcove/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import { composeManagedCronExportConfig } from "@psi/managed/managedCronExport";

import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

// The web half of the set in `@alcove/core/testing`; its module header states the design.

const readOwn = (): OwnRelayRead => ({
  kind: "set",
  relay: { turn: [COMMAND_LINE_EXPORT_OWN_TURN_URL], stun: [] },
});

describe("the command-line export relay set", () => {
  test.each(
    Object.values(COMMAND_LINE_EXPORT_RELAY_CASES).map(
      (one) => [one.because, one] as const,
    ),
  )("%s", (_because, one) => {
    const record = buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: one.locator,
        linkageTerms: COMMAND_LINE_EXPORT_LINKAGE_TERMS,
      }),
      side: one.side,
      sharedSecret: generateSharedSecret(),
      relayRegistrar: COMMAND_LINE_EXPORT_RELAY_REGISTRAR,
    });
    expect(
      parseSensitiveYaml(
        composeManagedCronExportConfig(record, readOwn).config.text,
        "exported alcove.yaml",
      ),
    ).toEqual(parseSensitiveYaml(one.document, "the set's document"));
  });
});
