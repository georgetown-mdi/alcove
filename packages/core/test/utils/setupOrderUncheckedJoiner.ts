import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";

import type { PsiEngine } from "../../src/psi/psiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "./fixedKeyPsiLibrary";
import { UNBOUNDED_PSI_ELEMENTS } from "./psiElementBounds";

// Every match refuses a partner setup that is not strictly ascending, so a
// round against a partner contributing one value twice ends before the table
// exists. The checks behind that refusal -- the resolver's drop and the
// mapped-element refusals -- stay as safety checks, and this joiner is how a
// test reaches them: it matches the held setup in one library call under the
// key its request went out under, skipping the order check and nothing else.

class SetupOrderUncheckedEngine implements PsiEngine {
  private readonly inner: InProcessPsiEngine;
  private heldSetup: Uint8Array | undefined;
  private setupPieces: Array<Uint8Array> = [];

  constructor(
    private readonly library: PSILibrary,
    private readonly clientKey: Uint8Array,
  ) {
    this.inner = new InProcessPsiEngine(
      fixedKeyPsiLibrary(library, clientKey, clientKey),
      "joiner",
      "client",
      "identifier-revealing",
    );
  }

  createServerSetup(): never {
    throw new Error("a joiner engine does not build a setup");
  }

  processClientRequest(): never {
    throw new Error("a joiner engine does not answer a request");
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    return this.inner.createClientRequest(values);
  }

  async receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    await this.receiveServerSetupPiece(setupBytes);
    await this.completeServerSetup();
  }

  receiveServerSetupPiece(piece: Uint8Array): Promise<void> {
    this.setupPieces.push(piece);
    return Promise.resolve();
  }

  completeServerSetup(): Promise<void> {
    const setupBytes = new Uint8Array(
      this.setupPieces.reduce((total, piece) => total + piece.byteLength, 0),
    );
    let filled = 0;
    for (const piece of this.setupPieces) {
      setupBytes.set(piece, filled);
      filled += piece.byteLength;
    }
    this.setupPieces = [];
    if (!this.library.serverSetup.deserializeBinary(setupBytes).getRaw())
      throw new Error("the partner's setup is not a Raw data structure");
    this.heldSetup = setupBytes;
    return Promise.resolve();
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const setupBytes = this.heldSetup;
    if (setupBytes === undefined)
      throw new Error("computeAssociationTable called before a setup");
    this.heldSetup = undefined;
    const client = this.library.client!.createFromKey(this.clientKey, true);
    try {
      const table = client.getAssociationTable(
        this.library.serverSetup.deserializeBinary(setupBytes),
        this.library.response.deserializeBinary(responseBytes),
      );
      return Promise.resolve([table[0], table[1]]);
    } finally {
      client.delete();
    }
  }

  computeIntersectionCardinality(): never {
    throw new Error("this engine runs identifier-revealing rounds only");
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/** @internal */
export function setupOrderUncheckedJoiner(library: PSILibrary): PSIParticipant {
  return new PSIParticipant(
    "client",
    library,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    new SetupOrderUncheckedEngine(library, psiTestKey(7)),
  );
}
