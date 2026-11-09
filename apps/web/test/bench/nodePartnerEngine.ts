import type { InProcessPsiEngine } from "@alcove/core";
import type { Page } from "playwright";

// The Node half of a bench partner whose page drives its engine by calls to
// the bench (benchNodeEngine.ts is the page half): each call runs one
// operation on a Node engine, and set bytes move over the bench's local server
// (startBenchServer in browserRoundMemory.ts).

/**
 * Exposes `benchPartnerEngine` on `page`, running each operation it names on
 * `partner` with the values `values` builds from a count, set bytes taken from
 * and left in `sets`, and each operation's wall time added to `stepsMs`.
 */
export async function exposeNodePartnerEngine(
  page: Page,
  partner: InProcessPsiEngine,
  sets: Map<string, Uint8Array>,
  values: (count: number) => Array<string>,
  stepsMs: Record<string, number>,
): Promise<void> {
  const take = (name: string): Uint8Array => {
    const bytes = sets.get(name);
    if (!bytes) throw new Error(`the partner's page sent no ${name} set`);
    sets.delete(name);
    return bytes;
  };
  const operate = async (
    operation: string,
    count: number | undefined,
  ): Promise<unknown> => {
    switch (operation) {
      case "createServerSetup": {
        const built = await partner.createServerSetup(values(count!));
        sets.set("partner-setup", built.setup);
        sets.set(
          "partner-permutation",
          new Uint8Array(Int32Array.from(built.permutation).buffer),
        );
        return undefined;
      }
      case "createClientRequest":
        sets.set(
          "partner-request",
          await partner.createClientRequest(values(count!)),
        );
        return undefined;
      case "processClientRequest":
        sets.set(
          "partner-response",
          await partner.processClientRequest(take("partner-input")),
        );
        return undefined;
      case "receiveServerSetup":
        return partner.receiveServerSetup(take("partner-input"));
      case "receiveServerSetupPiece":
        return partner.receiveServerSetupPiece(take("partner-input"));
      case "completeServerSetup":
        return partner.completeServerSetup();
      case "discardServerSetup":
        return partner.discardServerSetup();
      case "computeAssociationTable":
        return partner.computeAssociationTable(take("partner-input"));
      case "dispose":
        partner.dispose();
        return undefined;
    }
    throw new Error(`the bench's partner engine has no ${operation}`);
  };
  await page.exposeFunction(
    "benchPartnerEngine",
    async (operation: string, count?: number): Promise<unknown> => {
      const started = performance.now();
      try {
        return await operate(operation, count);
      } finally {
        stepsMs[operation] =
          (stepsMs[operation] ?? 0) + performance.now() - started;
      }
    },
  );
}
