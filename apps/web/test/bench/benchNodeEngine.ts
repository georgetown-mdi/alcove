import { download, upload } from "./benchSetTransfer";

import type { PsiEngine } from "@alcove/core";

// The page half of a bench partner's engine, bundled into the partner's page:
// each engine operation is one call to the bench, which runs it on a Node
// engine (nodePartnerEngine.ts is the Node half), and its set bytes move over
// the bench's local HTTP server.

// Exposed by the bench before the page loads: runs one operation on the Node
// engine, which builds this party's values itself from their count.
declare function benchPartnerEngine(
  operation: string,
  elements?: number,
): Promise<unknown>;

const INPUT = "partner-input";
const NOT_BENCHED = "the bench partner runs no count-only-permuted round";

/** The engine a bench partner's page hands core's participant. */
export function nodeEngine(): PsiEngine {
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
