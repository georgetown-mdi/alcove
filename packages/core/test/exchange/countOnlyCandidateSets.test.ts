import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { DEFAULT_LINKAGE_RULE_SET } from "../../src/defaults/builtInLinkageTerms";
import { UsageError } from "../../src/errors";
import { prepareForExchange } from "../../src/exchange";
import { assertFirstRoundWithinSetMaximum } from "../../src/exchange/firstRoundCapacity";
import {
  declaredFanOutFunction,
  declaredKeyWidth,
} from "../../src/fanOutFunctions";
import { expandsOnReceiverOnly } from "../../src/fuzzyComparisons";
import {
  countOnlyRoundWidths,
  countOnlyWidthsOfRounds,
} from "../../src/psi/countOnlyRounds";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  servePsiWorker,
  WorkerPsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import {
  phaseResult,
  runPsiPhasePair,
  type EngineFor,
} from "../utils/psiPhasePair";

import type {
  LinkageKey,
  LinkageTerms,
} from "../../src/config/linkageTermsSchema";
import type { PreparedExchange } from "../../src/exchange";
import type { PsiProgress } from "../../src/psi/participant";

// Count-only terms whose keys declare candidate sets -- a fuzzy comparison, a
// fan-out -- beside a swapped key order, run through the PSI phase both parties enter
// once the agreed terms are resolved, against a `psi` run over the same terms
// and data (docs/spec/PROTOCOL.md, PSI-C, Candidate sets under count-only:
// "Each round adds what the `psi` round accepts").

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();
const backends: Array<[string, PSILibrary]> = [
  ["wasm", wasm],
  ...(native === undefined ? [] : [["native", native] as [string, PSILibrary]]),
];

const split = [{ function: "split_on", params: { delimiter: " " } }];

const PSI_TERMS: LinkageTerms = {
  version: "1.0.0",
  date: "2026-11-02",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "FN + LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
    {
      name: "FN + LN, either order",
      elements: [{ field: "first_name" }, { field: "last_name" }],
      swap: ["first_name", "last_name"],
    },
    {
      name: "FN + LN part",
      elements: [
        { field: "first_name" },
        { field: "last_name", transform: split },
      ],
    },
    {
      name: "FN approximately + LN",
      elements: [
        { field: "first_name", generateFuzzyComparisons: "edit_distances" },
        { field: "last_name" },
      ],
    },
  ],
};
const countOnly = (
  terms: LinkageTerms,
  linkageStrategy: LinkageTerms["linkageStrategy"] = "cascade",
): LinkageTerms => ({ ...terms, algorithm: "psi-c", linkageStrategy });

const COLUMNS = ["first_name", "last_name", "date_of_birth"];
type Row = Record<string, string>;
const person = (
  first_name: string,
  last_name: string,
  date_of_birth = "01/02/1980",
): Row => ({ first_name, last_name, date_of_birth });

// Ann matches on every key and is counted once; Cal only in either order; Ben
// only on one part of a two-part last name; Dee only one edit apart. No value
// repeats within either party's file.
const FIRST: Array<Row> = [
  person("Ann", "Moss"),
  person("Ben", "Hart Lund"),
  person("Cal", "Ross"),
  person("Dee", "Kent"),
  person("Eve", "Wolf"),
];
const SECOND: Array<Row> = [
  person("Ann", "Moss"),
  person("Ben", "Lund"),
  person("Ross", "Cal"),
  person("Dea", "Kent"),
  person("Fay", "Pike"),
  person("Gus", "Hart"),
];
const MATCHED = 4;

function preparedParty(
  identity: string,
  rows: Array<Row>,
  terms: LinkageTerms,
): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...terms, identity } },
    identity,
    rows,
    COLUMNS,
  );
}

// A worker-backed engine served on this thread; structuredClone stands in for
// the worker boundary.
const inWorker: EngineFor = (role, id, mode) => {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(wasm, { role, id, mode }, (response) =>
    deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
};

// The count both parties hold, and the size of the `psi` table over the same
// terms and data in the same role assignment.
async function countAndTable(
  library: PSILibrary,
  terms: LinkageTerms,
  receiverRows: Array<Row>,
  senderRows: Array<Row>,
  engineFor?: EngineFor,
): Promise<{ count: number | undefined; table: number | undefined }> {
  const receiver = preparedParty("Receiver Co", receiverRows, terms);
  const sender = preparedParty("Sender Co", senderRows, terms);
  const counted = await runPsiPhasePair(
    library,
    countOnly(terms),
    receiver,
    sender,
    engineFor,
  );
  const matched = await runPsiPhasePair(library, terms, receiver, sender);
  const count = phaseResult(counted.receiver).intersectionCount;
  expect(phaseResult(counted.sender).intersectionCount).toBe(count);
  expect(phaseResult(counted.receiver).associationTable).toBeUndefined();
  return {
    count,
    table: phaseResult(matched.receiver).associationTable?.[0].length,
  };
}

describe.each(backends)("on the %s backend", (_name, library) => {
  test.each([
    ["the first party", FIRST, SECOND],
    ["the second party", SECOND, FIRST],
  ])(
    "%s receiving: the count over candidate sets is the psi table's size",
    async (_label, receiverRows, senderRows) => {
      const { count, table } = await countAndTable(
        library,
        PSI_TERMS,
        receiverRows,
        senderRows,
      );
      expect(table).toBe(MATCHED);
      expect(count).toBe(MATCHED);
    },
  );
});

test("the count over candidate sets is the same through the worker-backed engine", async () => {
  const { count } = await countAndTable(
    wasm,
    PSI_TERMS,
    FIRST,
    SECOND,
    inWorker,
  );
  expect(count).toBe(MATCHED);
});

test("each round's sets are blocks of the party's width, real candidates unique and the rest dummies", async () => {
  const terms = countOnly(PSI_TERMS);
  const outcome = await runPsiPhasePair(
    wasm,
    terms,
    preparedParty("Receiver Co", FIRST, terms),
    preparedParty("Sender Co", SECOND, terms),
  );
  const widths = countOnlyWidthsOfRounds(terms);
  expect(widths.map((width) => width.receiverWidth)).toEqual([1, 1, 20, 129]);
  expect(widths.map((width) => width.senderWidth)).toEqual([1, 1, 20, 129]);
  for (const [party, records] of [
    ["receiver", FIRST.length],
    ["sender", SECOND.length],
  ] as const) {
    const sets = outcome[party].sets;
    expect(sets).toHaveLength(widths.length);
    sets.forEach((set, round) => {
      const width =
        party === "receiver"
          ? widths[round]!.receiverWidth
          : widths[round]!.senderWidth;
      expect(set.values).toHaveLength(records * width);
      expect(new Set(set.values).size).toBe(set.values.length);
      for (const value of set.values)
        expect(value).toMatch(
          new RegExp(`^(${String(round)}:.*|[0-9a-f]{64})$`),
        );
    });
  }
  // Each party's second round holds Cal's name once, in sorted order.
  for (const party of ["receiver", "sender"] as const) {
    const cal = outcome[party].sets[1]!.values.filter(
      (value) =>
        value.startsWith("1:") &&
        value.includes("ROSS") &&
        value.includes("CAL"),
    );
    expect(cal).toHaveLength(1);
    expect(cal[0]!.indexOf("CAL")).toBeLessThan(cal[0]!.indexOf("ROSS"));
  }
});

describe("the sender's block is the receiver's width on a key combining a fan-out with a receiver-only expansion", () => {
  // A last name of 25 parts beside a date the receiver alone reads in its
  // adjacent years: 25 candidates on the sender, more than the fan-out's
  // factor of 20 and within the key's declared width of 60.
  const terms: LinkageTerms = {
    ...PSI_TERMS,
    linkageKeys: [
      {
        name: "LN part + DOB",
        elements: [
          { field: "last_name", transform: split },
          {
            field: "date_of_birth",
            generateFuzzyComparisons: "adjacent_years",
          },
        ],
      },
    ],
  };
  const longName = Array.from(
    { length: 25 },
    (_, index) => `Q${String.fromCharCode(65 + index)}X`,
  ).join(" ");
  const sender = [person("Zed", longName, "03/04/1975"), person("Amy", "Bell")];
  const receiver = [person("Zed", "QMX", "03/04/1976"), person("Bob", "Cole")];

  test("both widths are the declared width", () => {
    expect(countOnlyWidthsOfRounds(terms)).toEqual([
      { receiverWidth: 60, senderWidth: 60 },
    ]);
  });

  test("the record is counted as the psi table pairs it", async () => {
    const { count, table } = await countAndTable(wasm, terms, receiver, sender);
    expect(table).toBe(1);
    expect(count).toBe(1);
  });

  test("the sender pays padding here: its width is over the key's width with receiver-only factors at 1", () => {
    expect(countOnlyRoundWidths(terms.linkageKeys[0]!).senderWidth).toBe(60);
    expect(
      declaredKeyWidth(withoutReceiverOnlyExpansions(terms.linkageKeys[0]!)),
    ).toBe(20);
  });

  test("a padding element and a real element have the same length in the setup the receiver is sent", async () => {
    const keyHolder = new InProcessPsiEngine(
      wasm,
      "starter",
      "key holder",
      "count-only-permuted",
    );
    const secretKey = keyHolder.copySecretKey();
    keyHolder.dispose();
    const receivedPieces: Array<Uint8Array> = [];
    const engineFor: EngineFor = (role, id, mode) => {
      if (role === "starter")
        return new InProcessPsiEngine(wasm, role, id, mode, { secretKey });
      const engine = new InProcessPsiEngine(wasm, role, id, mode);
      return new Proxy(engine, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property, target);
          if (typeof member !== "function") return member;
          if (property === "receiveServerSetupPiece")
            return (piece: Uint8Array) => {
              receivedPieces.push(piece.slice());
              return target.receiveServerSetupPiece(piece);
            };
          return (member as (...a: Array<unknown>) => unknown).bind(target);
        },
      });
    };
    const counted = countOnly(terms);
    const outcome = await runPsiPhasePair(
      wasm,
      counted,
      preparedParty("Receiver Co", receiver, counted),
      preparedParty("Sender Co", sender, counted),
      engineFor,
    );
    expect(phaseResult(outcome.receiver).intersectionCount).toBe(1);

    const setupValues = outcome.sender.sets.find(
      (set) => set.kind === "setup",
    )!.values;
    expect(setupValues).toHaveLength(sender.length * 60);
    const padding = setupValues.find((value) => /^[0-9a-f]{64}$/.test(value));
    const real = setupValues.find((value) => value.startsWith("0:"));
    expect(padding).toBeDefined();
    expect(real).toBeDefined();

    const reference = wasm.server!.createFromKey(secretKey, true);
    const encrypted = (value: string): string =>
      Buffer.from(
        reference
          .createSetupMessage(0, -1, [value], wasm.dataStructure.Raw)
          .getRaw()!
          .getEncryptedElementsList_asU8()[0]!,
      ).toString("hex");
    const encryptedPadding = encrypted(padding!);
    const encryptedReal = encrypted(real!);
    reference.delete();

    const received = wasm.serverSetup
      .deserializeBinary(Buffer.concat(receivedPieces))
      .getRaw()!
      .getEncryptedElementsList_asU8()
      .map((element) => Buffer.from(element).toString("hex"));
    expect(received).toHaveLength(setupValues.length);
    expect(received).toContain(encryptedPadding);
    expect(received).toContain(encryptedReal);
    expect(encryptedPadding.length).toBe(encryptedReal.length);
    expect(new Set(received.map((element) => element.length))).toEqual(
      new Set([encryptedReal.length]),
    );
  });
});

// The key with each expansion only the receiver executes removed: each fuzzy
// kind expandsOnReceiverOnly names.
function withoutReceiverOnlyExpansions(key: LinkageKey): LinkageKey {
  return {
    ...key,
    elements: key.elements.map((element) => {
      const kind = element.generateFuzzyComparisons;
      if (kind === undefined || !expandsOnReceiverOnly(kind)) return element;
      const { generateFuzzyComparisons: _kind, ...shared } = element;
      return shared;
    }),
  };
}

test("no built-in key pays the padding: each sender width is the key's width with receiver-only factors at 1", () => {
  const keys = DEFAULT_LINKAGE_RULE_SET.linkageKeys;
  for (const [index, key] of keys.entries())
    expect(countOnlyRoundWidths(key, index).senderWidth, key.name).toBe(
      declaredKeyWidth(withoutReceiverOnlyExpansions(key), index),
    );
  // The set holds both halves of the padded combination, on separate keys.
  const fansOut = (key: LinkageKey): boolean =>
    key.elements.some(
      (element) => declaredFanOutFunction(element.transform) !== undefined,
    );
  const expandsOnReceiver = (key: LinkageKey): boolean =>
    declaredKeyWidth(withoutReceiverOnlyExpansions(key)) <
    declaredKeyWidth(key);
  expect(keys.some(fansOut)).toBe(true);
  expect(keys.some(expandsOnReceiver)).toBe(true);
});

test("count-only terms declaring single-pass give the same count over candidate sets", async () => {
  const receiver = preparedParty("Receiver Co", FIRST, PSI_TERMS);
  const sender = preparedParty("Sender Co", SECOND, PSI_TERMS);
  const outcome = await runPsiPhasePair(
    wasm,
    countOnly(PSI_TERMS, "single-pass"),
    receiver,
    sender,
  );
  expect(phaseResult(outcome.receiver).intersectionCount).toBe(MATCHED);
});

describe("a refusal building a round's candidates comes before contact", () => {
  // A date the adjacent-years expansion cannot read refuses its row, and the
  // check at the start reads every round in both roles, so it is raised there
  // rather than in a round the partner has joined.
  const terms = countOnly({
    ...PSI_TERMS,
    linkageKeys: [
      {
        name: "LN + DOB",
        elements: [
          { field: "last_name" },
          {
            field: "date_of_birth",
            generateFuzzyComparisons: "adjacent_years",
          },
        ],
      },
    ],
  });

  test("the start-of-exchange check raises it", async () => {
    const prepared = {
      ...preparedParty("Tester", FIRST, terms),
      linkageTerms: terms,
    };
    const unreadable = prepareForExchange(
      {
        linkageTerms: { ...terms, identity: "Tester" },
        standardization: [
          {
            output: "date_of_birth",
            input: "date_of_birth",
            steps: [{ function: "trim_whitespace" }],
          },
        ],
      },
      "Tester",
      [person("Ann", "Moss", "1980")],
      COLUMNS,
    );
    await expect(
      assertFirstRoundWithinSetMaximum(prepared),
    ).resolves.toBeUndefined();
    await expect(
      assertFirstRoundWithinSetMaximum(unreadable),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(assertFirstRoundWithinSetMaximum(unreadable)).rejects.toThrow(
      /YYYYMMDD/,
    );
    const reports: Array<PsiProgress> = [];
    await expect(
      assertFirstRoundWithinSetMaximum(unreadable, {
        onProgress: (report) => reports.push(report),
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(reports.map((report) => report.state)).toEqual([
      "started",
      "failed",
    ]);
  });
});

test("the read of every count-only round reports its progress as the first-round count does", async () => {
  const rows = Array.from({ length: 2048 }, (_, index) =>
    person(`First${index}`, `Last${index}`),
  );
  const terms = countOnly(PSI_TERMS);
  const prepared = {
    ...preparedParty("Tester", rows, terms),
    linkageTerms: terms,
  };
  const reports: Array<PsiProgress> = [];
  await assertFirstRoundWithinSetMaximum(prepared, {
    onProgress: (report) => reports.push(report),
    progressIntervalMs: 0,
  });
  const readsInBothRoles = 2 * countOnlyWidthsOfRounds(terms).length;
  expect(
    reports.every((report) => report.operation === "countFirstRoundValues"),
  ).toBe(true);
  const started = reports.filter((report) => report.state === "started");
  const finished = reports.filter((report) => report.state === "finished");
  expect(started).toHaveLength(readsInBothRoles);
  expect(started.every((report) => report.elements === rows.length)).toBe(true);
  expect(finished).toHaveLength(readsInBothRoles);
  expect(finished.every((report) => report.elements === rows.length)).toBe(
    true,
  );
  expect(
    reports
      .filter((report) => report.state === "progress")
      .map((report) => report.processed),
  ).toEqual(
    Array.from({ length: readsInBothRoles }, () => [1024, 2048]).flat(),
  );
});
