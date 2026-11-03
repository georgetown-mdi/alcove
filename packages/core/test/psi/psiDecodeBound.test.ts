import { afterEach, describe, expect, test, vi } from "vitest";
import PSI from "@openmined/psi.js";

import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { PSI_ELEMENT_BYTES } from "../../src/connection/psiElementScan";
import { ProtocolRefusalError } from "../../src/errors";
import { prepareForExchange, type PreparedExchange } from "../../src/exchange";
import { PSIParticipant, type PsiDecodeBound } from "../../src/psi/participant";
import { InProcessPsiEngine, type PsiEngine } from "../../src/psi/psiEngine";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { phaseResult, runPsiPhasePair } from "../utils/psiPhasePair";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { PsiElementBounds } from "../../src/connection/frameSize";

// The two bounds on what a partner's PSI set takes to decode
// (docs/spec/PROTOCOL.md, "Declared PSI element counts are bounded by a
// wire-format scan before deserialization"): the set maximum, and on
// single-pass over file-sync the exact element length in its place.

// The per-set maximum, lowered for the tests that show which bound applies,
// so a set of a few values reaches it.
const setMaximum = vi.hoisted(() => ({
  lowered: undefined as number | undefined,
}));
vi.mock("../../src/connection/frameSize", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/connection/frameSize")>();
  return {
    ...actual,
    get MAX_PSI_DECODE_ELEMENTS() {
      return setMaximum.lowered ?? actual.MAX_PSI_DECODE_ELEMENTS;
    },
  };
});
afterEach(() => {
  setMaximum.lowered = undefined;
  vi.restoreAllMocks();
});

const psiLibrary = await PSI();

const SERVER_VALUES = ["Alice", "Bob", "Carol", "David", "Erin", "Frank"];
const CLIENT_VALUES = ["Carol", "Erin", "Gus", "Hana", "Ivan", "Jo"];

function participant(
  role: "starter" | "joiner",
  decodeBound: PsiDecodeBound,
  elementBounds: PsiElementBounds = UNBOUNDED_PSI_ELEMENTS,
): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    elementBounds,
    undefined,
    undefined,
    undefined,
    decodeBound,
  );
}

// A set of `count` elements of `bytes` bytes each, distinct and ascending, in
// the message `kind` takes.
function elements(count: number, bytes: number): Array<Uint8Array> {
  return Array.from({ length: count }, (_, index) =>
    new Uint8Array(bytes).fill(index + 1, bytes - 1),
  );
}
function requestOf(list: Array<Uint8Array>): Uint8Array {
  const request = new psiLibrary.request();
  request.setRevealIntersection(true);
  request.setEncryptedElementsList(list);
  return request.serializeBinary();
}
function responseOf(list: Array<Uint8Array>): Uint8Array {
  const response = new psiLibrary.response();
  response.setEncryptedElementsList(list);
  return response.serializeBinary();
}
function setupOf(list: Array<Uint8Array>): Uint8Array {
  const setup = new psiLibrary.serverSetup();
  const raw = new psiLibrary.serverSetup.RawInfo();
  raw.setEncryptedElementsList(list);
  setup.setRaw(raw);
  return setup.serializeBinary();
}

// A real round: the sender's setup, the receiver's request and the sender's
// response to it, each built by `library`.
async function honestRound(library: PSILibrary = psiLibrary): Promise<{
  setup: Uint8Array;
  request: Uint8Array;
  response: Uint8Array;
}> {
  const sender = new InProcessPsiEngine(
    library,
    "starter",
    "sender",
    "identifier-revealing",
  );
  const receiver = new InProcessPsiEngine(
    library,
    "joiner",
    "receiver",
    "identifier-revealing",
  );
  try {
    const { setup } = await sender.createServerSetup(SERVER_VALUES);
    const request = await receiver.createClientRequest(CLIENT_VALUES);
    const response = await sender.processClientRequest(request);
    return { setup, request, response };
  } finally {
    sender.dispose();
    receiver.dispose();
  }
}

// Every element of a round `library` builds is PSI_ELEMENT_BYTES long.
async function expectElementsOfOneLength(library: PSILibrary): Promise<void> {
  const { setup, request, response } = await honestRound(library);
  expect(
    psiLibrary.serverSetup
      .deserializeBinary(setup)
      .getRaw()
      ?.getEncryptedElementsList_asU8()
      .map((element) => element.byteLength),
  ).toEqual(SERVER_VALUES.map(() => PSI_ELEMENT_BYTES));
  for (const list of [
    psiLibrary.request
      .deserializeBinary(request)
      .getEncryptedElementsList_asU8(),
    psiLibrary.response
      .deserializeBinary(response)
      .getEncryptedElementsList_asU8(),
  ])
    expect(list.map((element) => element.byteLength)).toEqual(
      CLIENT_VALUES.map(() => PSI_ELEMENT_BYTES),
    );
}

const nativeLibrary = await loadNativeAddonOrSkip();

describe("the element-length decode bound", () => {
  for (const [backend, library] of [
    ["wasm", psiLibrary],
    ["native", nativeLibrary],
  ] as const)
    test.skipIf(library === undefined)(
      `every element of a real setup, request and response is PSI_ELEMENT_BYTES long (${backend})`,
      async () => {
        await expectElementsOfOneLength(library!);
      },
    );

  test("a request of short elements is refused before decode, where the set maximum admits it", async () => {
    const hostile = requestOf(elements(64, 2));
    const deserialize = vi.spyOn(psiLibrary.request, "deserializeBinary");

    await expect(
      participant("starter", "element-length").processClientRequest(hostile),
    ).rejects.toThrow(/malformed inbound PSI request frame/);
    expect(deserialize).not.toHaveBeenCalled();

    await participant("starter", "set-maximum")
      .processClientRequest(hostile)
      .catch(() => undefined);
    expect(deserialize).toHaveBeenCalled();
  });

  test.each([
    ["one byte short", PSI_ELEMENT_BYTES - 1],
    ["one byte long", PSI_ELEMENT_BYTES + 1],
    ["empty", 0],
  ])(
    "a setup and a response with one element %s are refused as malformed",
    async (_label, bytes) => {
      const { setup, response } = await honestRound();
      const withOdd = (list: Array<Uint8Array>) => [
        ...list.slice(1),
        new Uint8Array(bytes),
      ];
      const honestSetupList = psiLibrary.serverSetup
        .deserializeBinary(setup)
        .getRaw()!
        .getEncryptedElementsList_asU8();
      const honestResponseList = psiLibrary.response
        .deserializeBinary(response)
        .getEncryptedElementsList_asU8();

      const receiver = participant("joiner", "element-length");
      await receiver.createClientRequest(CLIENT_VALUES);
      const setupRefusal = receiver.computeValueMatches(
        setupOf(withOdd(honestSetupList)),
        response,
      );
      await expect(setupRefusal).rejects.toThrow(
        /malformed inbound PSI serverSetup frame/,
      );
      await expect(setupRefusal).rejects.toBeInstanceOf(ProtocolRefusalError);

      const second = participant("joiner", "element-length");
      await second.createClientRequest(CLIENT_VALUES);
      await expect(
        second.computeValueMatches(
          setupOf(honestSetupList),
          responseOf(withOdd(honestResponseList)),
        ),
      ).rejects.toThrow(/malformed inbound PSI response frame/);
    },
  );

  test("an honest round past the set maximum matches, where the set maximum refuses it", async () => {
    setMaximum.lowered = 4;
    const run = async (decodeBound: PsiDecodeBound) => {
      const sender = participant("starter", decodeBound);
      const receiver = participant("joiner", decodeBound);
      try {
        const { setup } = await sender.createServerSetup(SERVER_VALUES);
        const request = await receiver.createClientRequest(CLIENT_VALUES);
        const response = await sender.processClientRequest(request);
        return await receiver.computeValueMatches(setup, response);
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    };

    const [local, partner] = await run("element-length");
    expect(local.map((index) => CLIENT_VALUES[index]).sort()).toEqual([
      "Carol",
      "Erin",
    ]);
    expect(partner).toHaveLength(2);
    await expect(run("set-maximum")).rejects.toThrow(
      /inbound PSI request declares more than 4 encrypted element\(s\)/,
    );
  });

  test("the authenticated bound still holds under the element-length bound", async () => {
    const { request } = await honestRound();
    await expect(
      participant("starter", "element-length", {
        ...UNBOUNDED_PSI_ELEMENTS,
        request: CLIENT_VALUES.length - 1,
      }).processClientRequest(request),
    ).rejects.toThrow(
      `inbound PSI request declares more than ${CLIENT_VALUES.length - 1} encrypted element(s)`,
    );
  });
});

// --- Which bound an exchange's PSI phase takes ---------------------------------

const TERMS: LinkageTerms = {
  version: "1.0.0",
  date: "2026-11-03",
  algorithm: "psi",
  linkageStrategy: "single-pass",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
  ],
  linkageKeys: [
    {
      name: "FN + LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
  ],
};

const COLUMNS = ["first_name", "last_name"];
const person = (first_name: string, last_name: string) => ({
  first_name,
  last_name,
});

function preparedParty(
  identity: string,
  rows: Array<Record<string, string>>,
): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...TERMS, identity } },
    identity,
    rows,
    COLUMNS,
  );
}

const RECEIVER = preparedParty("Receiver Co", [
  person("Ann", "Moss"),
  person("Cal", "Hart"),
  person("Eve", "Lund"),
]);
const SENDER = preparedParty("Sender Co", [
  person("Ann", "Moss"),
  person("Ben", "Moss"),
  person("Eve", "Lund"),
  person("Fay", "Ross"),
]);

// Each party's in-process engine, the receiver's request rewritten to hold
// elements of two bytes, one per value, and every engine call recorded.
function hostileReceiverEngines(calls: Array<string>) {
  return (
    role: "starter" | "joiner",
    id: string,
    mode: "identifier-revealing" | "count-only-permuted",
  ): PsiEngine => {
    const engine = new InProcessPsiEngine(psiLibrary, role, id, mode);
    return new Proxy(engine, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return (...args: Array<unknown>) => {
          calls.push(`${role} ${String(property)}`);
          if (property === "createClientRequest")
            return Promise.resolve(
              requestOf(elements((args[0] as ReadonlyArray<string>).length, 2)),
            );
          return (member as (...a: Array<unknown>) => unknown).apply(
            target,
            args,
          );
        };
      },
    });
  };
}

describe("the PSI phase of a single-pass exchange", () => {
  test("over file-sync matches an honest partner as over any other channel", async () => {
    const plain = await runPsiPhasePair(psiLibrary, TERMS, RECEIVER, SENDER);
    const fileSync = await runPsiPhasePair(
      psiLibrary,
      TERMS,
      RECEIVER,
      SENDER,
      undefined,
      MAX_FRAME_SIZE_BYTES,
    );
    for (const party of ["receiver", "sender"] as const) {
      const table = phaseResult(fileSync[party]).associationTable;
      expect(table?.[0]).toHaveLength(2);
      expect(table).toEqual(phaseResult(plain[party]).associationTable);
    }
  });

  test("over file-sync refuses a request of short elements before the engine decodes it", async () => {
    const calls: Array<string> = [];
    const outcome = await runPsiPhasePair(
      psiLibrary,
      TERMS,
      RECEIVER,
      SENDER,
      hostileReceiverEngines(calls),
      MAX_FRAME_SIZE_BYTES,
    );
    expect(() => phaseResult(outcome.sender)).toThrow(
      /malformed inbound PSI request frame/,
    );
    expect(calls).not.toContain("starter processClientRequest");
  });

  test("over another channel hands the same request to the engine, under the set maximum", async () => {
    const calls: Array<string> = [];
    const outcome = await runPsiPhasePair(
      psiLibrary,
      TERMS,
      RECEIVER,
      SENDER,
      hostileReceiverEngines(calls),
    );
    expect(() => phaseResult(outcome.sender)).toThrow();
    expect(calls).toContain("starter processClientRequest");
  });
});
