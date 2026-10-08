import { expect } from "vitest";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { buildResponse, serializeSetup } from "../../src/psi/psiChunks";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { isPsiLibraryFailure } from "../../src/errors";

import type {
  InProcessPsiEngineOptions,
  PsiMatchMethod,
} from "../../src/psi/psiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "./fixedKeyPsiLibrary";

// The wire claim the chunked engine rests on: splitting one operation and
// reassembling the chunk results yields the BYTES a single call over the whole
// set produces, for the server setup, the client request and the server
// response, and the element-identical association table and intersection size.
// Driven against the library under the same key on both sides rather than
// argued, and run over every backend the running platform has.

const SERVER_KEY = psiTestKey(0x11);
const CLIENT_KEY = psiTestKey(0x22);
const FALSE_POSITIVE_RATE = 0.0;
const CLIENT_INPUT_COUNT = -1;

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
  revealsIdentifiers: boolean,
  chunkElements: number | undefined,
  setupSliceElements?: number,
  matchMemoryBudgetBytes?: number,
  matchMethod?: PsiMatchMethod,
): InProcessPsiEngine {
  const options: InProcessPsiEngineOptions = {
    ...(matchMethod === undefined ? {} : { matchMethod }),
    ...(chunkElements === undefined ? {} : { chunkElements }),
    ...(setupSliceElements === undefined ? {} : { setupSliceElements }),
    ...(matchMemoryBudgetBytes === undefined ? {} : { matchMemoryBudgetBytes }),
  };
  return new InProcessPsiEngine(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    role,
    role,
    revealsIdentifiers ? "identifier-revealing" : "count-only",
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
 * `matchMethod` is the joiner's; `setupSliceElements` splits a sliced match
 * into setup slices. `matchMemoryBudgetBytes` sizes both parties' calls to
 * that engine memory.
 */
export async function expectChunkedRoundMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements?: number;
  matchMethod?: PsiMatchMethod;
  setupSliceElements?: number;
  matchMemoryBudgetBytes?: number;
}): Promise<Record<string, Array<number>>> {
  const {
    library,
    serverValues,
    clientValues,
    chunkElements,
    matchMemoryBudgetBytes,
  } = params;
  const server = library.server!.createFromKey(SERVER_KEY, true);
  const client = library.client!.createFromKey(CLIENT_KEY, true);
  const starter = engine(
    library,
    "starter",
    true,
    chunkElements,
    undefined,
    matchMemoryBudgetBytes,
  );
  const joiner = engine(
    library,
    "joiner",
    true,
    chunkElements,
    params.setupSliceElements,
    matchMemoryBudgetBytes,
    params.matchMethod,
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
 * Asserts that a chunked count-only round puts the single call's response
 * bytes on the wire and reports its cardinality, and returns the processed
 * counts the match reported: one between each pair of response pieces for a
 * streamed match; for a sliced one, none for a match in one call and one
 * between each pair of setup slices otherwise.
 */
export async function expectChunkedCountMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements?: number;
  matchMethod?: PsiMatchMethod;
  setupSliceElements?: number;
  matchMemoryBudgetBytes?: number;
}): Promise<Array<number>> {
  const {
    library,
    serverValues,
    clientValues,
    chunkElements,
    matchMemoryBudgetBytes,
  } = params;
  const server = library.server!.createFromKey(SERVER_KEY, false);
  const client = library.client!.createFromKey(CLIENT_KEY, false);
  const starter = engine(
    library,
    "starter",
    false,
    chunkElements,
    undefined,
    matchMemoryBudgetBytes,
  );
  const joiner = engine(
    library,
    "joiner",
    false,
    chunkElements,
    params.setupSliceElements,
    matchMemoryBudgetBytes,
    params.matchMethod,
  );
  const processed: Array<number> = [];
  try {
    const wholeSetup = server.createSetupMessage(
      FALSE_POSITIVE_RATE,
      CLIENT_INPUT_COUNT,
      serverValues,
      library.dataStructure.Raw,
      [],
    );
    const wholeRequest = client.createRequest(clientValues);
    const wholeResponse = server.processRequest(
      client.createRequest(clientValues),
    );
    const wholeSize = client.getIntersectionSize(wholeSetup, wholeResponse);

    const setup = await starter.createServerSetup(serverValues);
    expect(setup.setup).toEqual(wholeSetup.serializeBinary());
    expect(setup.permutation).toStrictEqual([]);
    const request = await joiner.createClientRequest(clientValues);
    expect(request).toEqual(wholeRequest.serializeBinary());
    const response = await starter.processClientRequest(request);
    // The count-only response is sorted rather than answered position by
    // position, so this is where a merge that concatenated the chunks would
    // put different bytes on the wire.
    expect(response).toEqual(wholeResponse.serializeBinary());
    await joiner.receiveServerSetup(setup.setup);
    joiner.observeProcessedElements((count) => processed.push(count));
    expect(await joiner.computeIntersectionCardinality(response)).toBe(
      wholeSize,
    );
    expect(wholeSize).toBeGreaterThan(0);
  } finally {
    starter.dispose();
    joiner.dispose();
    server.delete();
    client.delete();
  }
  return processed;
}

/**
 * Asserts that the cardinality reported over a response whose element list is
 * DUPLICATED, each repeat a whole list away from its twin so a split would put
 * the two in different chunks, is the one a single call over that response
 * reports. The response is the partner's message and no local rule constrains
 * what it holds, so the repeat is the shape the count has to survive. Returns
 * the processed counts the match reported.
 */
export async function expectDuplicatedResponseCountMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements: number;
  matchMethod?: PsiMatchMethod;
}): Promise<Array<number>> {
  const { library, serverValues, clientValues, chunkElements } = params;
  const server = library.server!.createFromKey(SERVER_KEY, false);
  const client = library.client!.createFromKey(CLIENT_KEY, false);
  const joiner = engine(
    library,
    "joiner",
    false,
    chunkElements,
    undefined,
    undefined,
    params.matchMethod,
  );
  const processed: Array<number> = [];
  joiner.observeProcessedElements((count) => processed.push(count));
  try {
    const setup = server.createSetupMessage(
      FALSE_POSITIVE_RATE,
      CLIENT_INPUT_COUNT,
      serverValues,
      library.dataStructure.Raw,
      [],
    );
    const elements = server
      .processRequest(client.createRequest(clientValues))
      .getEncryptedElementsList_asU8();
    const duplicated = buildResponse(library, [...elements, ...elements]);
    const wholeSize = client.getIntersectionSize(setup, duplicated);
    expect(wholeSize).toBeGreaterThan(0);
    // What a split would have reported, driven against the library rather than
    // argued: the library deduplicates within each call, so every repeat the
    // split separates is counted again.
    expect(
      client.getIntersectionSize(setup, buildResponse(library, elements)) +
        client.getIntersectionSize(setup, buildResponse(library, elements)),
    ).toBe(wholeSize * 2);

    await joiner.receiveServerSetup(setup.serializeBinary());
    expect(
      await joiner.computeIntersectionCardinality(duplicated.serializeBinary()),
    ).toBe(wholeSize);
  } finally {
    joiner.dispose();
    server.delete();
    client.delete();
  }
  return processed;
}

/**
 * Asserts that a partner setup repeating one element across a setup slice
 * boundary is refused in either mode, rather than counted or paired twice,
 * and refused alike by the match in slices, the match in one call and the
 * streamed match: the same error class, the same message, the same named
 * diagnosis. The streamed match refuses it as the setup arrives, the sliced
 * one at the match.
 */
export async function expectBoundaryRepeatRefused(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  setupSliceElements: number;
}): Promise<void> {
  const { library, serverValues, clientValues, setupSliceElements } = params;
  for (const revealsIdentifiers of [true, false]) {
    const server = library.server!.createFromKey(
      SERVER_KEY,
      revealsIdentifiers,
    );
    const client = library.client!.createFromKey(
      CLIENT_KEY,
      revealsIdentifiers,
    );
    const sliced = engine(
      library,
      "joiner",
      revealsIdentifiers,
      undefined,
      setupSliceElements,
      undefined,
      "sliced",
    );
    const whole = engine(
      library,
      "joiner",
      revealsIdentifiers,
      undefined,
      undefined,
      undefined,
      "sliced",
    );
    const streamed = engine(library, "joiner", revealsIdentifiers, undefined);
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
      elements[setupSliceElements] = elements[setupSliceElements - 1]!;
      const setupBytes = serializeSetup(library, elements);
      const responseBytes = server
        .processRequest(client.createRequest(clientValues))
        .serializeBinary();
      const match = async (target: InProcessPsiEngine): Promise<unknown> =>
        revealsIdentifiers
          ? target.computeAssociationTable(responseBytes)
          : target.computeIntersectionCardinality(responseBytes);

      const refusal = (target: InProcessPsiEngine): Promise<unknown> =>
        target
          .receiveServerSetup(setupBytes)
          .then(() => match(target))
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      for (const caught of [
        await refusal(sliced),
        await refusal(whole),
        await refusal(streamed),
      ]) {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).constructor).toBe(Error);
        expect((caught as Error).message).toBe(
          "joiner protocol error: PSI server setup is not in strictly ascending element order",
        );
        expect(isPsiLibraryFailure(caught)).toBe(false);
      }
    } finally {
      sliced.dispose();
      whole.dispose();
      streamed.dispose();
      server.delete();
      client.delete();
    }
  }
}
