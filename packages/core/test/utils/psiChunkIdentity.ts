import { expect } from "vitest";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { serializeSetup } from "../../src/psi/psiChunks";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { isPsiLibraryFailure, ProtocolRefusalError } from "../../src/errors";
import { classifyFailure } from "../../src/failureClass";

import type {
  InProcessPsiEngineOptions,
  PsiEngineMode,
} from "../../src/psi/psiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "./fixedKeyPsiLibrary";

// The wire claim the chunked engine rests on: splitting one operation and
// reassembling the chunk results yields the BYTES a single call over the whole
// set produces, for the server setup, the client request and the server
// response, and the element-identical association table.
// Driven against the library under the same key on both sides rather than
// argued, and run over every backend the running platform has.

const SERVER_KEY = psiTestKey(0x11);
const CLIENT_KEY = psiTestKey(0x22);
const FALSE_POSITIVE_RATE = 0.0;
const CLIENT_INPUT_COUNT = -1;
const MODES: ReadonlyArray<PsiEngineMode> = [
  "identifier-revealing",
  "count-only-permuted",
];

/** A set and the partner set overlapping it on every other value. */
export function chunkIdentityValues(total: number): {
  serverValues: Array<string>;
  clientValues: Array<string>;
} {
  return {
    serverValues: Array.from({ length: total }, (_, index) => `v-${index}`),
    clientValues: Array.from({ length: total }, (_, index) =>
      index % 2 === 0 ? `v-${index}` : `joiner-only-${index}`,
    ),
  };
}

function engine(
  library: PSILibrary,
  role: "starter" | "joiner",
  mode: PsiEngineMode,
  chunkElements: number | undefined,
  maskingMemoryBudgetBytes?: number,
): InProcessPsiEngine {
  const options: InProcessPsiEngineOptions = {
    ...(chunkElements === undefined ? {} : { chunkElements }),
    ...(maskingMemoryBudgetBytes === undefined
      ? {}
      : { maskingMemoryBudgetBytes }),
  };
  return new InProcessPsiEngine(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    role,
    role,
    mode,
    options,
  );
}

/**
 * Asserts that a chunked engine reproduces the single call's output for every
 * operation of an identifier-revealing round, and returns the processed counts
 * each operation reported so a caller can assert the cadence.
 *
 * `chunkElements` sets the chunk size; left out, the shipped sizing policy
 * decides, which is what a run at production scale exercises.
 * `maskingMemoryBudgetBytes` sizes both parties' masking calls to that
 * engine memory.
 */
export async function expectChunkedRoundMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements?: number;
  maskingMemoryBudgetBytes?: number;
}): Promise<Record<string, Array<number>>> {
  const {
    library,
    serverValues,
    clientValues,
    chunkElements,
    maskingMemoryBudgetBytes,
  } = params;
  const server = library.server!.createFromKey(SERVER_KEY, true);
  const client = library.client!.createFromKey(CLIENT_KEY, true);
  const starter = engine(
    library,
    "starter",
    "identifier-revealing",
    chunkElements,
    maskingMemoryBudgetBytes,
  );
  const joiner = engine(
    library,
    "joiner",
    "identifier-revealing",
    chunkElements,
    maskingMemoryBudgetBytes,
  );
  const processed: Record<string, Array<number>> = {};
  let operation = "";
  const observe = (target: InProcessPsiEngine): void =>
    target.observeProcessedElements((count) =>
      (processed[operation] ??= []).push(count),
    );
  observe(starter);
  observe(joiner);
  try {
    const sortingPermutation: Array<number> = [];
    const wholeSetup = server.createSetupMessage(
      FALSE_POSITIVE_RATE,
      CLIENT_INPUT_COUNT,
      serverValues,
      library.dataStructure.Raw,
      sortingPermutation,
    );
    const wholeRequest = client.createRequest(clientValues);
    const wholeResponse = server.processRequest(wholeRequest);
    const wholeTable = client.getAssociationTable(wholeSetup, wholeResponse);

    operation = "createServerSetup";
    const chunkedSetup = await starter.createServerSetup(serverValues);
    expect(chunkedSetup.setup).toEqual(wholeSetup.serializeBinary());
    expect(chunkedSetup.permutation).toStrictEqual(sortingPermutation);

    operation = "createClientRequest";
    const chunkedRequest = await joiner.createClientRequest(clientValues);
    expect(chunkedRequest).toEqual(wholeRequest.serializeBinary());

    operation = "processClientRequest";
    const chunkedResponse = await starter.processClientRequest(chunkedRequest);
    expect(chunkedResponse).toEqual(wholeResponse.serializeBinary());

    operation = "computeAssociationTable";
    await joiner.receiveServerSetup(chunkedSetup.setup);
    expect(await joiner.computeAssociationTable(chunkedResponse)).toStrictEqual(
      [wholeTable[0], wholeTable[1]],
    );
  } finally {
    starter.dispose();
    joiner.dispose();
    server.delete();
    client.delete();
  }
  return processed;
}

/**
 * A serialized partner setup over `serverValues` whose element at `repeatAt`
 * repeats the element before it.
 */
export function repeatedSetupElement(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  repeatAt: number;
}): Uint8Array {
  const { library, serverValues, repeatAt } = params;
  const server = library.server!.createFromKey(SERVER_KEY, true);
  try {
    const elements = [
      ...server
        .createSetupMessage(
          FALSE_POSITIVE_RATE,
          CLIENT_INPUT_COUNT,
          serverValues,
          library.dataStructure.Raw,
          [],
        )
        .getRaw()!
        .getEncryptedElementsList_asU8(),
    ];
    elements[repeatAt] = elements[repeatAt - 1]!;
    return serializeSetup(library, elements);
  } finally {
    server.delete();
  }
}

/**
 * Asserts that a partner setup repeating one element, at `repeatAt` and the
 * element before it, is refused in either mode as the setup arrives, rather
 * than counted or paired twice: a protocol error with the named diagnosis,
 * never the library's failure.
 */
export async function expectRepeatedSetupElementRefused(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  repeatAt: number;
}): Promise<void> {
  const { library, serverValues, repeatAt } = params;
  for (const mode of MODES) {
    const joiner = engine(library, "joiner", mode, undefined);
    try {
      const setup = repeatedSetupElement({
        library,
        serverValues,
        repeatAt,
      });
      const caught = await joiner.receiveServerSetup(setup).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(ProtocolRefusalError);
      expect((caught as Error).message).toBe(
        "joiner protocol error: PSI server setup is not in strictly ascending element order",
      );
      expect(classifyFailure(caught)).toBe("partner-refused");
      expect(isPsiLibraryFailure(caught)).toBe(false);
    } finally {
      joiner.dispose();
    }
  }
}
