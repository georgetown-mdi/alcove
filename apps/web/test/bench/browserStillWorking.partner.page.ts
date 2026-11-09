import { partyLog, runStillWorkingRound, wrapAsApp } from "./stillWorkingParty";
import { listen } from "./wrappedRoundParty";
import { nodeEngine } from "./benchNodeEngine";

import type { PartyLog, PartyResult } from "./stillWorkingParty";
import type { DataConnection } from "peerjs";
import type { MessageConnection } from "@alcove/core";
import type { RoundSide } from "./wrappedRoundParty";

// The partner's page of browserStillWorking.ts, bundled by it: the other end of
// the data channel, wrapped the same way and running the same still-working
// layer, whose engine is the bench's Node engine (benchNodeEngine.ts). It waits
// through the measured page's steps, so the frames it reads are the ones the
// measured page's timer sent. This page stays visible.

/** The calls browserStillWorking.ts makes on the partner's page. */
export interface StillWorkingPartnerProbe {
  listen: (brokerPort: number, sharedSecret: string) => Promise<void>;
  accept: (sessionKey: ReadonlyArray<number>) => Promise<void>;
  run: (side: RoundSide, elements: number) => Promise<PartyResult>;
  log: () => PartyLog;
}

const log = partyLog();
let channel: Promise<DataConnection> | undefined;
let connection: MessageConnection | undefined;

const probe: StillWorkingPartnerProbe = {
  async listen(brokerPort, sharedSecret) {
    ({ channel } = await listen(brokerPort, sharedSecret));
  },
  async accept(sessionKey) {
    if (!channel) throw new Error("listen has not run");
    connection = await wrapAsApp(await channel, sessionKey, "responder");
  },
  async run(side, elements) {
    if (!connection) throw new Error("accept has not run");
    // The Node engine builds the values from their count.
    return runStillWorkingRound(
      connection,
      nodeEngine(),
      side,
      new Array<string>(elements).fill(""),
      log,
    );
  },
  log: () => log,
};

(
  globalThis as unknown as {
    stillWorkingPartnerProbe: () => StillWorkingPartnerProbe;
  }
).stillWorkingPartnerProbe = () => probe;
