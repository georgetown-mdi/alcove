import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { MatchResult } from "@openmined/psi.js/implementation/match.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  InternalConsistencyError,
  isPsiLibraryFailure,
  ProtocolRefusalError,
} from "../../src/errors";
import { classifyFailure } from "../../src/failureClass";
import { buildResponse, serializeSetup } from "../../src/psi/psiChunks";
import {
  InProcessPsiEngine,
  type InProcessPsiEngineOptions,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

// The streamed match against the library's whole-setup calls, under one key on
// both sides, on every backend the platform has: the setup fed in pieces cut
// at any byte, the response in pieces of any element count, each response
// element decrypted once, and a setup refused at the piece that shows the
// fault, before any match runs.

const SERVER_KEY = psiTestKey(0x31);
const CLIENT_KEY = psiTestKey(0x42);
const MODES: ReadonlyArray<PsiEngineMode> = [
  "identifier-revealing",
  "count-only",
];

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

const serverValues = Array.from({ length: 120 }, (_, index) => `v-${index}`);
const clientValues = Array.from({ length: 90 }, (_, index) =>
  index % 3 === 0 ? `v-${index}` : `joiner-only-${index}`,
);

interface Recorded {
  readonly results: Array<MatchResult>;
  readonly wholeCalls: Array<string>;
}

// `library` under the fixed keys, its client recording each streamed match's
// result and every whole-setup match call it is asked for.
function recordingLibrary(library: PSILibrary, recorded: Recorded): PSILibrary {
  const keyed = fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY);
  const clients = keyed.client!;
  const recording = (client: PSIClient): PSIClient => ({
    ...client,
    getAssociationTable: (setup, response) => {
      recorded.wholeCalls.push("getAssociationTable");
      return client.getAssociationTable(setup, response);
    },
    getIntersectionSize: (setup, response) => {
      recorded.wholeCalls.push("getIntersectionSize");
      return client.getIntersectionSize(setup, response);
    },
    createMatch: () => {
      const match = client.createMatch();
      return {
        ...match,
        finish: () => {
          const result = match.finish();
          recorded.results.push(result);
          return result;
        },
      };
    },
  });
  return {
    ...keyed,
    client: {
      ...clients,
      createWithNewKey: (reveal) => recording(clients.createWithNewKey(reveal)),
    },
  };
}

interface Frames {
  readonly setup: Uint8Array;
  readonly response: Uint8Array;
  readonly responseElements: number;
  readonly expected: [Array<number>, Array<number>] | number;
}

// A round's setup and response under the fixed keys, and the library's own
// whole-setup result over them.
function frames(
  library: PSILibrary,
  mode: PsiEngineMode,
  response: (elements: Array<Uint8Array>) => Array<Uint8Array> = (e) => e,
): Frames {
  const reveal = mode === "identifier-revealing";
  const server = library.server!.createFromKey(SERVER_KEY, reveal);
  const client = library.client!.createFromKey(CLIENT_KEY, reveal);
  try {
    const setup = server.createSetupMessage(
      0,
      -1,
      serverValues,
      library.dataStructure.Raw,
      [],
    );
    const elements = response(
      server
        .processRequest(client.createRequest(clientValues))
        .getEncryptedElementsList_asU8(),
    );
    const responseMessage = buildResponse(library, elements);
    const table = reveal
      ? client.getAssociationTable(setup, responseMessage)
      : undefined;
    return {
      setup: setup.serializeBinary(),
      response: responseMessage.serializeBinary(),
      responseElements: elements.length,
      expected: table
        ? [table[0]!, table[1]!]
        : client.getIntersectionSize(setup, responseMessage),
    };
  } finally {
    server.delete();
    client.delete();
  }
}

// `bytes` cut every `size` bytes, with an empty piece between each two.
function pieces(bytes: Uint8Array, size: number): Array<Uint8Array> {
  const cut: Array<Uint8Array> = [];
  for (let start = 0; start < bytes.byteLength; start += size)
    cut.push(bytes.subarray(start, start + size), new Uint8Array(0));
  return cut;
}

function joiner(
  library: PSILibrary,
  mode: PsiEngineMode,
  options: InProcessPsiEngineOptions = {},
): InProcessPsiEngine {
  return new InProcessPsiEngine(library, "joiner", "joiner", mode, options);
}

async function match(
  engine: InProcessPsiEngine,
  mode: PsiEngineMode,
  response: Uint8Array,
): Promise<[Array<number>, Array<number>] | number> {
  return mode === "count-only"
    ? engine.computeIntersectionCardinality(response)
    : engine.computeAssociationTable(response);
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (error: unknown) => error,
  );
}

const SETUP_PIECE_BYTES = [1, 2, 34, 35, 36, 1000];
const RESPONSE_PIECE_ELEMENTS = [undefined, 1, 7, 40];

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend", (_name, library) => {
  describe.each(MODES)("in %s mode", (mode) => {
    test("a setup fed in pieces, cut anywhere, matches as the whole-setup call does, decrypting each response element once", async (ctx) => {
      if (!library) {
        ctx.skip();
        return;
      }
      const round = frames(library, mode);
      for (const setupPieceBytes of [...SETUP_PIECE_BYTES, round.setup.length])
        for (const chunkElements of RESPONSE_PIECE_ELEMENTS) {
          const recorded: Recorded = { results: [], wholeCalls: [] };
          const engine = joiner(recordingLibrary(library, recorded), mode, {
            ...(chunkElements === undefined ? {} : { chunkElements }),
          });
          const ticks: Array<number> = [];
          engine.observeProcessedElements((processed) => ticks.push(processed));
          try {
            for (const piece of pieces(round.setup, setupPieceBytes))
              await engine.receiveServerSetupPiece(piece);
            await engine.completeServerSetup();
            expect(await match(engine, mode, round.response)).toStrictEqual(
              round.expected,
            );
          } finally {
            engine.dispose();
          }
          expect(recorded.wholeCalls).toStrictEqual([]);
          expect(recorded.results).toHaveLength(1);
          expect(recorded.results[0]!.decryptedCount).toBe(
            round.responseElements,
          );
          const pieceCount =
            chunkElements === undefined
              ? 1
              : Math.ceil(round.responseElements / chunkElements);
          expect(ticks).toHaveLength(pieceCount - 1);
        }
    });

    test("a response repeating its elements matches as the whole-setup call does, each repeat decrypted and counted once", async (ctx) => {
      if (!library) {
        ctx.skip();
        return;
      }
      const round = frames(library, mode, (elements) => [
        ...elements,
        ...elements.slice(0, 30),
      ]);
      const recorded: Recorded = { results: [], wholeCalls: [] };
      const engine = joiner(recordingLibrary(library, recorded), mode, {
        chunkElements: 11,
      });
      try {
        await engine.receiveServerSetup(round.setup);
        const result = await match(engine, mode, round.response);
        const expected = round.expected;
        if (typeof expected === "number") {
          expect(result).toBe(expected);
        } else {
          // The same pairs; ordered by partner index, ties by local index.
          const [local, partner] = result as [Array<number>, Array<number>];
          const pairs = local.map((value, index) => [value, partner[index]!]);
          const [expectedLocal, expectedPartner] = expected;
          const expectedPairs = expectedLocal.map((value, index) => [
            value,
            expectedPartner[index]!,
          ]);
          const byPartner = (a: Array<number>, b: Array<number>) =>
            a[1]! - b[1]! || a[0]! - b[0]!;
          expect(pairs).toStrictEqual([...expectedPairs].sort(byPartner));
          expect(pairs).toStrictEqual([...pairs].sort(byPartner));
        }
      } finally {
        engine.dispose();
      }
      expect(recorded.results[0]!.decryptedCount).toBe(round.responseElements);
    });

    test("a setup out of strictly ascending order is refused at the piece that shows it, before any match", async (ctx) => {
      if (!library) {
        ctx.skip();
        return;
      }
      const round = frames(library, mode);
      const elements = [
        ...library.serverSetup
          .deserializeBinary(round.setup)
          .getRaw()!
          .getEncryptedElementsList_asU8(),
      ];
      [elements[60], elements[61]] = [elements[61]!, elements[60]!];
      const reordered = serializeSetup(library, elements);
      // Each element takes 35 bytes after the setup's 3-byte head, so the
      // pair is out of order once element 61 ends.
      const pieceBytes = 500;
      const showing = Math.floor((3 + 62 * 35 - 1) / pieceBytes);
      const cut = pieces(reordered, pieceBytes).filter(
        (piece) => piece.length > 0,
      );
      expect(showing).toBeLessThan(cut.length - 1);
      const engine = joiner(library, mode);
      try {
        for (const piece of cut.slice(0, showing))
          await engine.receiveServerSetupPiece(piece);
        const refusal = await caught(() =>
          engine.receiveServerSetupPiece(cut[showing]!),
        );
        expect(refusal).toBeInstanceOf(ProtocolRefusalError);
        expect((refusal as Error).message).toBe(
          "joiner protocol error: PSI server setup is not in strictly ascending element order",
        );
        expect(classifyFailure(refusal)).toBe("partner-refused");
        expect(isPsiLibraryFailure(refusal)).toBe(false);
        expect(
          ((await caught(() => match(engine, mode, round.response))) as Error)
            .message,
        ).toMatch(/called before the partner's setup completed/);
      } finally {
        engine.dispose();
      }
    });
  });

  test.for(MODES)(
    "in %s mode, a response the element scan cannot read is refused as the partner's, before the engine sees it",
    async (mode, ctx) => {
      if (!library) {
        ctx.skip();
        return;
      }
      const round = frames(library, mode);
      const fed = vi.fn();
      const deleted = vi.fn();
      const clients = library.client!;
      const watching: PSILibrary = {
        ...library,
        client: {
          ...clients,
          createWithNewKey: (reveal) => {
            const client = clients.createWithNewKey(reveal);
            return {
              ...client,
              createMatch: () => {
                const match = client.createMatch();
                return {
                  ...match,
                  matchResponsePiece: (piece) => {
                    fed();
                    match.matchResponsePiece(piece);
                  },
                  delete: () => {
                    deleted();
                    match.delete();
                  },
                };
              },
            };
          },
        },
      };
      for (const unreadable of [
        round.response.subarray(0, round.response.length - 1),
        new Uint8Array([0x0a, 0x05, 0x01]),
        new Uint8Array([0x0b]),
      ]) {
        const engine = joiner(watching, mode);
        try {
          await engine.receiveServerSetup(round.setup);
          const refusal = await caught(() => match(engine, mode, unreadable));
          expect(refusal).toBeInstanceOf(ProtocolRefusalError);
          expect((refusal as Error).message).toBe(
            "joiner protocol error: malformed inbound PSI response frame",
          );
          expect(classifyFailure(refusal)).toBe("partner-refused");
          expect(deleted).toHaveBeenCalledTimes(1);
        } finally {
          engine.dispose();
          deleted.mockClear();
        }
      }
      expect(fed).not.toHaveBeenCalled();
    },
  );

  test("a setup that is not a Raw data structure is refused by name, and a setup the engine cannot read as the library's failure", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const gcs = new library.serverSetup();
    const info = new library.serverSetup.GCSInfo();
    info.setDiv(1);
    info.setHashRange(1000);
    info.setBits(new Uint8Array([1, 2, 3, 4]));
    gcs.setGcs(info);
    const round = frames(library, "identifier-revealing");
    const refusal = async (pieceList: Array<Uint8Array>): Promise<unknown> => {
      const engine = joiner(library, "identifier-revealing");
      try {
        return await caught(async () => {
          for (const piece of pieceList)
            await engine.receiveServerSetupPiece(piece);
          await engine.completeServerSetup();
        });
      } finally {
        engine.dispose();
      }
    };
    const named =
      "joiner protocol error: PSI server setup is not a Raw data structure";
    for (const notRaw of [
      [gcs.serializeBinary()],
      [new Uint8Array(0)],
      [new Uint8Array([0, 0])],
    ]) {
      const error = await refusal(notRaw);
      expect(error).toBeInstanceOf(ProtocolRefusalError);
      expect((error as Error).message).toBe(named);
      expect(classifyFailure(error)).toBe("partner-refused");
      expect(isPsiLibraryFailure(error)).toBe(false);
    }
    for (const unreadable of [
      [round.setup.subarray(0, round.setup.length - 1)],
      [new Uint8Array([0x0a, 0x02, 0x10, 0x01])],
      [round.setup, new Uint8Array([0x0a, 0x00])],
    ]) {
      const error = await refusal(unreadable);
      expect(isPsiLibraryFailure(error)).toBe(true);
    }
  });

  test("setup calls out of order are refused as the local faults they are", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const round = frames(library, "identifier-revealing");
    const engine = joiner(library, "identifier-revealing");
    try {
      expect(await caught(() => engine.completeServerSetup())).toBeInstanceOf(
        InternalConsistencyError,
      );
      await engine.receiveServerSetup(round.setup);
      const late = await caught(() =>
        engine.receiveServerSetupPiece(round.setup),
      );
      expect(late).toBeInstanceOf(InternalConsistencyError);
      expect(isPsiLibraryFailure(late)).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  test("dispose frees a setup's match whether it is being received or awaits its match", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const round = frames(library, "identifier-revealing");
    const deleted: Array<string> = [];
    const clients = library.client!;
    const deleting: PSILibrary = {
      ...library,
      client: {
        ...clients,
        createWithNewKey: (reveal) => {
          const client = clients.createWithNewKey(reveal);
          return {
            ...client,
            createMatch: () => {
              const match = client.createMatch();
              return {
                ...match,
                delete: () => {
                  deleted.push("match");
                  match.delete();
                },
              };
            },
          };
        },
      },
    };
    const receiving = joiner(deleting, "identifier-revealing");
    await receiving.receiveServerSetupPiece(round.setup.subarray(0, 100));
    receiving.dispose();
    const held = joiner(deleting, "identifier-revealing");
    await held.receiveServerSetup(round.setup);
    held.dispose();
    expect(deleted).toStrictEqual(["match", "match"]);
  });
});

test("a sliced match and a streamed one return the same table from the same setup pieces", async () => {
  const round = frames(wasm, "identifier-revealing");
  const results: Array<unknown> = [];
  for (const options of [
    { matchMethod: "sliced", setupSliceElements: 25 },
    {},
  ] as const) {
    const engine = joiner(
      fixedKeyPsiLibrary(wasm, SERVER_KEY, CLIENT_KEY),
      "identifier-revealing",
      options,
    );
    try {
      for (const piece of pieces(round.setup, 333))
        await engine.receiveServerSetupPiece(piece);
      await engine.completeServerSetup();
      results.push(await engine.computeAssociationTable(round.response));
    } finally {
      engine.dispose();
    }
  }
  expect(results[0]).toStrictEqual(round.expected);
  expect(results[1]).toStrictEqual(round.expected);
});

test("an association table out of response order is refused as a local fault", async () => {
  const round = frames(wasm, "identifier-revealing");
  const keyed = fixedKeyPsiLibrary(wasm, SERVER_KEY, CLIENT_KEY);
  const clients = keyed.client!;
  const reversing: PSILibrary = {
    ...keyed,
    client: {
      ...clients,
      createWithNewKey: (reveal) => {
        const client = clients.createWithNewKey(reveal);
        return {
          ...client,
          createMatch: () => {
            const match = client.createMatch();
            return {
              ...match,
              finish: () => {
                const result = match.finish();
                const [local, partner] = result.associationTable!;
                return {
                  ...result,
                  associationTable: [
                    local.slice().reverse(),
                    partner.slice().reverse(),
                  ] as const,
                };
              },
            };
          },
        };
      },
    },
  };
  const engine = joiner(reversing, "identifier-revealing");
  try {
    await engine.receiveServerSetup(round.setup);
    const refusal = await caught(() =>
      engine.computeAssociationTable(round.response),
    );
    expect(refusal).toBeInstanceOf(InternalConsistencyError);
  } finally {
    engine.dispose();
  }
});

test("a match whose decrypted count differs from the response's element count is refused as a local fault", async () => {
  const round = frames(wasm, "count-only");
  const keyed = fixedKeyPsiLibrary(wasm, SERVER_KEY, CLIENT_KEY);
  const clients = keyed.client!;
  const finish = vi.fn((result: MatchResult) => ({
    ...result,
    decryptedCount: result.decryptedCount * 2,
  }));
  const doubling: PSILibrary = {
    ...keyed,
    client: {
      ...clients,
      createWithNewKey: (reveal) => {
        const client = clients.createWithNewKey(reveal);
        return {
          ...client,
          createMatch: () => {
            const match = client.createMatch();
            return { ...match, finish: () => finish(match.finish()) };
          },
        };
      },
    },
  };
  const engine = joiner(doubling, "count-only", { chunkElements: 10 });
  try {
    await engine.receiveServerSetup(round.setup);
    const refusal = await caught(() =>
      engine.computeIntersectionCardinality(round.response),
    );
    expect(refusal).toBeInstanceOf(InternalConsistencyError);
    expect(finish).toHaveBeenCalledTimes(1);
  } finally {
    engine.dispose();
  }
});
