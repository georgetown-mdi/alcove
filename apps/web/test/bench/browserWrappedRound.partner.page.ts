import { download, upload } from "./benchSetTransfer";
import { listen, runRound, wrap } from "./wrappedRoundParty";

import type { MessageConnection, PsiEngine } from "@alcove/core";
import type { RoundOutcome, RoundSide } from "./wrappedRoundParty";
import type { DataConnection } from "peerjs";

// The partner's page of browserWrappedRound.ts, bundled by it: the other end of
// the data channel, wrapped the same way, running core's participant whose
// engine is the bench's Node engine on the native addon. Each engine operation
// is one call to the bench, and its set bytes move over the bench's local
// HTTP server. This page is not measured.

/** The calls browserWrappedRound.ts makes on the partner's page. */
export interface PartnerProbe {
  listen: (brokerPort: number, sharedSecret: string) => Promise<void>;
  accept: (sessionKey: ReadonlyArray<number>) => Promise<void>;
  run: (side: RoundSide, elements: number) => Promise<RoundOutcome>;
}

// Exposed by the bench before the page loads: runs one operation on the Node
// engine, which builds this party's values itself from their count.
declare function benchPartnerEngine(
  operation: string,
  elements?: number,
): Promise<unknown>;

const INPUT = "partner-input";
const NOT_BENCHED = "the bench partner runs no count-only-permuted round";

function nodeEngine(): PsiEngine {
  const withInput = async (bytes: Uint8Array, operation: string) => {
    await upload(INPUT, bytes);
    return benchPartnerEngine(operation);
  };
  return {
    async createServerSetup(values) {
      await benchPartnerEngine("createServerSetup", values.length);
      const order = await download("partner-permutation");
      return {
        setup: await download("partner-setup"),
        permutation: Array.from(
          new Int32Array(order.buffer, order.byteOffset, order.byteLength / 4),
        ),
      };
    },
    async processClientRequest(request) {
      await withInput(request, "processClientRequest");
      return download("partner-response");
    },
    async createClientRequest(values) {
      await benchPartnerEngine("createClientRequest", values.length);
      return download("partner-request");
    },
    async receiveServerSetup(setup) {
      await withInput(setup, "receiveServerSetup");
    },
    async receiveServerSetupPiece(piece) {
      await withInput(piece, "receiveServerSetupPiece");
    },
    async completeServerSetup() {
      await benchPartnerEngine("completeServerSetup");
    },
    async discardServerSetup() {
      await benchPartnerEngine("discardServerSetup");
    },
    async computeAssociationTable(response) {
      return (await withInput(response, "computeAssociationTable")) as [
        Array<number>,
        Array<number>,
      ];
    },
    createPermutedSetup: () => Promise.reject(new Error(NOT_BENCHED)),
    receiveIndexTable: () => Promise.reject(new Error(NOT_BENCHED)),
    matchPermutedRound: () => Promise.reject(new Error(NOT_BENCHED)),
    finishPermutedCount: () => Promise.reject(new Error(NOT_BENCHED)),
    dispose() {
      void benchPartnerEngine("dispose");
    },
  };
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
  async run(side, elements) {
    if (!connection) throw new Error("accept has not run");
    // The Node engine builds the values from their count, so only the count
    // is real here.
    return runRound(
      connection,
      nodeEngine(),
      side,
      new Array<string>(elements).fill(""),
    );
  },
};

(globalThis as unknown as { partnerProbe: () => PartnerProbe }).partnerProbe =
  () => probe;
