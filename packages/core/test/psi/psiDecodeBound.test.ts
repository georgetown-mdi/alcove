import { afterEach, describe, expect, test, vi } from "vitest";
import PSI from "@openmined/psi.js";

import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { PSI_ELEMENT_BYTES } from "../../src/connection/psiElementScan";
import { ProtocolRefusalError } from "../../src/errors";
import { prepareForExchange, type PreparedExchange } from "../../src/exchange";
import { PSIParticipant } from "../../src/psi/participant";
import {
  InProcessPsiEngine,
  type PsiEngine,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { phaseResult, runPsiPhasePair } from "../utils/psiPhasePair";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { PsiElementBounds } from "../../src/psi/singlePassSizing";

// Every element of a partner's PSI setup, request and response must be
// PSI_ELEMENT_BYTES long, on every channel and strategy, so a frame's decode
// is held to the rate of an honest frame's (docs/spec/PROTOCOL.md, "Declared
// PSI element counts are bounded by a wire-format scan before
// deserialization").

afterEach(() => {
  vi.restoreAllMocks();
});

const psiLibrary = await PSI();

const SERVER_VALUES = ["Alice", "Bob", "Carol", "David", "Erin", "Frank"];
const CLIENT_VALUES = ["Carol", "Erin", "Gus", "Hana", "Ivan", "Jo"];

function participant(
  role: "starter" | "joiner",
  elementBounds: PsiElementBounds = UNBOUNDED_PSI_ELEMENTS,
): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    elementBounds,
  );
}

// `count` elements of `bytes` bytes each, distinct and ascending.
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

describe("the element length", () => {
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

  test("a request of short elements is refused before decode", async () => {
    const deserialize = vi.spyOn(psiLibrary.request, "deserializeBinary");
    const refusal = participant("starter").processClientRequest(
      requestOf(elements(64, 2)),
    );
    await expect(refusal).rejects.toThrow(
      /malformed inbound PSI request frame/,
    );
    await expect(refusal).rejects.toBeInstanceOf(ProtocolRefusalError);
    expect(deserialize).not.toHaveBeenCalled();
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

      const receiver = participant("joiner");
      await receiver.createClientRequest(CLIENT_VALUES);
      const setupRefusal = receiver.computeValueMatches(
        setupOf(withOdd(honestSetupList)),
        response,
      );
      await expect(setupRefusal).rejects.toThrow(
        /malformed inbound PSI serverSetup frame/,
      );
      await expect(setupRefusal).rejects.toBeInstanceOf(ProtocolRefusalError);

      const second = participant("joiner");
      await second.createClientRequest(CLIENT_VALUES);
      await expect(
        second.computeValueMatches(
          setupOf(honestSetupList),
          responseOf(withOdd(honestResponseList)),
        ),
      ).rejects.toThrow(/malformed inbound PSI response frame/);
    },
  );

  test("an honest round matches", async () => {
    const sender = participant("starter");
    const receiver = participant("joiner");
    try {
      const { setup } = await sender.createServerSetup(SERVER_VALUES);
      const request = await receiver.createClientRequest(CLIENT_VALUES);
      const response = await sender.processClientRequest(request);
      const [local, partner] = await receiver.computeValueMatches(
        setup,
        response,
      );
      expect(local.map((index) => CLIENT_VALUES[index]).sort()).toEqual([
        "Carol",
        "Erin",
      ]);
      expect(partner).toHaveLength(2);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });
});

// --- Every channel and strategy -------------------------------------------------

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

const STRATEGIES: Array<[string, LinkageTerms]> = [
  ["single-pass", TERMS],
  ["the cascade", { ...TERMS, linkageStrategy: "cascade" }],
  ["count-only", { ...TERMS, algorithm: "psi-c", linkageStrategy: "cascade" }],
];
const CHANNELS: Array<[string, number | undefined]> = [
  ["file-sync", MAX_FRAME_SIZE_BYTES],
  ["another channel", undefined],
];

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
    { linkageTerms: { ...TERMS, linkageStrategy: "cascade", identity } },
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

// The message one engine operation builds, rewritten to hold elements of two
// bytes: the receiver's request, the sender's setup, or its response.
type Rewritten = "request" | "setup" | "response";

// Each party's in-process engine, the `rewritten` message replaced, and
// every engine call recorded.
function hostileEngines(rewritten: Rewritten, calls: Array<string>) {
  return (
    role: "starter" | "joiner",
    id: string,
    mode: PsiEngineMode,
  ): PsiEngine => {
    const engine = new InProcessPsiEngine(psiLibrary, role, id, mode);
    return new Proxy(engine, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return async (...args: Array<unknown>) => {
          calls.push(`${role} ${String(property)}`);
          const result: unknown = await (
            member as (...a: Array<unknown>) => unknown
          ).apply(target, args);
          if (rewritten === "request" && property === "createClientRequest")
            return requestOf(
              elements((args[0] as ReadonlyArray<string>).length, 2),
            );
          if (rewritten === "setup" && property === "createServerSetup")
            return {
              ...(result as object),
              setup: setupOf(
                elements((args[0] as ReadonlyArray<string>).length, 2),
              ),
            };
          if (rewritten === "response" && property === "processClientRequest")
            return responseOf(elements(1, 2));
          return result;
        };
      },
    });
  };
}

describe.each(CHANNELS)("over %s", (_channel, fileSyncFrameBound) => {
  test.each(STRATEGIES)(
    "%s matches an honest partner",
    async (_strategy, terms) => {
      const outcome = await runPsiPhasePair(
        psiLibrary,
        terms,
        RECEIVER,
        SENDER,
        undefined,
        fileSyncFrameBound,
      );
      const result = phaseResult(outcome.receiver);
      expect(
        result.associationTable?.[0].length ?? result.intersectionCount,
      ).toBe(2);
    },
  );

  test.each(STRATEGIES)(
    "%s refuses a request of short elements before the engine decodes it",
    async (_strategy, terms) => {
      const calls: Array<string> = [];
      const outcome = await runPsiPhasePair(
        psiLibrary,
        terms,
        RECEIVER,
        SENDER,
        hostileEngines("request", calls),
        fileSyncFrameBound,
      );
      expect(() => phaseResult(outcome.sender)).toThrow(
        /malformed inbound PSI request frame/,
      );
      expect(calls).not.toContain("starter processClientRequest");
    },
  );

  test.each(STRATEGIES.slice(0, 2))(
    "%s refuses a setup of short elements before the engine takes it",
    async (_strategy, terms) => {
      const calls: Array<string> = [];
      const outcome = await runPsiPhasePair(
        psiLibrary,
        terms,
        RECEIVER,
        SENDER,
        hostileEngines("setup", calls),
        fileSyncFrameBound,
      );
      expect(() => phaseResult(outcome.receiver)).toThrow(
        /malformed inbound PSI serverSetup frame/,
      );
      expect(
        calls.filter((call) =>
          /^joiner (receive|complete)ServerSetup/.test(call),
        ),
      ).toEqual([]);
    },
  );

  test.each(STRATEGIES.slice(0, 2))(
    "%s refuses a response of short elements before the engine matches it",
    async (_strategy, terms) => {
      const calls: Array<string> = [];
      const outcome = await runPsiPhasePair(
        psiLibrary,
        terms,
        RECEIVER,
        SENDER,
        hostileEngines("response", calls),
        fileSyncFrameBound,
      );
      expect(() => phaseResult(outcome.receiver)).toThrow(
        /malformed inbound PSI response frame/,
      );
      expect(calls).not.toContain("joiner computeAssociationTable");
    },
  );
});
