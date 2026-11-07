import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayCloseCode } from "../src/protocol.ts";

import {
  RELAY_KEY,
  connect,
  helloFrame,
  keyTableOf,
  startRelay,
} from "./harness.ts";

import type { RunningRelay } from "./harness.ts";

// The relay's proof check failing with an error that is not a refusal, on a
// well-formed key: core's proof key derivation throws for every key here. The
// harness builds its proofs through core's main entry, which this leaves alone.

vi.mock("@alcove/core/websocket-relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@alcove/core/websocket-relay")>()),
  deriveWebSocketRelayProofKey: () =>
    Promise.reject(new Error("the proof key could not be derived")),
}));

const running: RunningRelay[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

describe("a proof check that fails without refusing the proof", () => {
  it("refuses with 1011 and reports once for the whole relay, a malformed key still once for each exchange id", async () => {
    const started = await startRelay({
      keyTable: keyTableOf({
        "exchange-1": RELAY_KEY,
        "exchange-2": RELAY_KEY,
        "exchange-3": "not hex",
      }),
    });
    running.push(started);
    for (const exchangeId of ["exchange-1", "exchange-2", "exchange-3"]) {
      const party = await connect(started.url);
      party.send(await helloFrame({ role: "inviter", exchangeId }));
      expect((await party.closed).code).toBe(RelayCloseCode.internalError);
    }
    expect(started.faults).toEqual([
      "a hello could not be checked: the proof key could not be derived",
      "the relay key enrolled under exchange id exchange-3 is not 64 lowercase hex characters",
    ]);
  });
});
