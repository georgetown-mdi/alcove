import { listen, runRound, wrap } from "./wrappedRoundParty";
import { nodeEngine } from "./benchNodeEngine";
import { partyValues } from "./partyValues";

import type { RoundOutcome, RoundSide } from "./wrappedRoundParty";
import type { DataConnection } from "peerjs";
import type { MessageConnection } from "@alcove/core";

// The partner's page of browserWrappedRound.ts, bundled by it: the other end of
// the data channel, wrapped the same way, running core's participant whose
// engine is the bench's Node engine on the native addon (benchNodeEngine.ts).
// This page is not measured.

/** The calls browserWrappedRound.ts makes on the partner's page. */
export interface PartnerProbe {
  listen: (brokerPort: number, sharedSecret: string) => Promise<void>;
  accept: (sessionKey: ReadonlyArray<number>) => Promise<void>;
  run: (
    side: RoundSide,
    elements: number,
    overlap: number,
  ) => Promise<RoundOutcome>;
}

let channel: Promise<DataConnection> | undefined;
let connection: MessageConnection | undefined;

const probe: PartnerProbe = {
  async listen(brokerPort, sharedSecret) {
    ({ channel } = await listen(brokerPort, sharedSecret));
  },
  async accept(sessionKey) {
    if (!channel) throw new Error("listen has not run");
    connection = await wrap(await channel, sessionKey, "responder");
  },
  async run(side, elements, overlap) {
    if (!connection) throw new Error("accept has not run");
    // The Node engine builds the values from their count. A single-pass
    // exchange counts this party's distinct values before the engine sees
    // them, so it is handed the same values; a cascade round, only the count.
    return runRound(
      connection,
      nodeEngine(),
      side,
      side.strategy === "single-pass"
        ? partyValues(elements, overlap, "node")
        : new Array<string>(elements).fill(""),
    );
  },
};

(globalThis as unknown as { partnerProbe: () => PartnerProbe }).partnerProbe =
  () => probe;
