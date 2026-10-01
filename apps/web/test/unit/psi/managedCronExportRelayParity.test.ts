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

// The web half of the command-line export relay set (`@alcove/core/testing`,
// whose module header states what it holds): each document is what this app's
// export writes for its record, compared as YAML data so the serializer's
// guidance comments stay out of the set. The CLI half,
// apps/cli/test/unit/managedCronExportRelayParity.test.ts, loads the same
// documents through the CLI's config loader, so a document this file pins is
// one a command-line run accepts.

const readOwn = (): OwnRelayRead => ({
  kind: "set",
  relay: { turn: [COMMAND_LINE_EXPORT_OWN_TURN_URL], stun: [] },
});

describe("the command-line export relay set", () => {
  test.each(Object.entries(COMMAND_LINE_EXPORT_RELAY_CASES))(
    "the %s record exports its document's data",
    (_id, one) => {
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
    },
  );
});
