import { beforeEach, describe, expect, test, vi } from "vitest";

import { useSupersedingCsvRead } from "@exchange/useSupersedingCsvRead";

import type { CsvReadAccepted } from "@exchange/useSupersedingCsvRead";

// The unit project runs in node with no DOM or React renderer, so the hook runs
// against a minimal React: `useRef` is a plain holder, and `useEffect` records
// its effect so a test can run it and its cleanup (the unmount). The hook is
// called once per test, which is one mounted component's life. The parse worker
// is a deferred, so a test decides when and how each read settles.

const mounted = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", () => ({
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => {
    mounted.effects.push(effect);
  },
}));

interface ParseCall {
  file: File;
  options: { signal: AbortSignal; delimiter?: string };
  resolve: (fields: Array<string> | undefined, rows?: Array<unknown>) => void;
  reject: (error: unknown) => void;
}

const parseCalls = vi.hoisted(() => [] as Array<ParseCall>);

vi.mock("@psi/workers/csvParseController", () => ({
  loadCSVFileOffMainThread: (
    file: File,
    options: { signal: AbortSignal; delimiter?: string },
  ) =>
    new Promise((resolve, reject) => {
      parseCalls.push({
        file,
        options,
        resolve: (fields, rows = []) =>
          resolve({
            data: rows,
            errors: [],
            meta: {
              ...(fields !== undefined ? { fields } : {}),
              sanitizedColumnPositions: [2],
            },
          }),
        reject,
      });
    }),
}));

beforeEach(() => {
  mounted.effects.length = 0;
  parseCalls.length = 0;
});

function mount() {
  const hook = useSupersedingCsvRead();
  const unmount = mounted.effects.map((effect) => effect()).at(-1);
  return { ...hook, unmount: unmount as () => void };
}

const fileA = new File(["a"], "a.csv");
const fileB = new File(["b"], "b.csv");

describe("useSupersedingCsvRead", () => {
  test("a read whose header names every column is accepted and handed to accept", async () => {
    const { read } = mount();
    const accepted: Array<CsvReadAccepted> = [];
    const outcome = read(fileA, undefined, (value) => accepted.push(value));
    parseCalls[0].resolve(["id", "name"], [{ id: "1", name: "x" }]);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });
    expect(accepted).toEqual([
      {
        columns: ["id", "name"],
        rows: [{ id: "1", name: "x" }],
        sanitizedPositions: [2],
      },
    ]);
  });

  test("a read with no header fields is accepted with no columns", async () => {
    const { read } = mount();
    const accepted: Array<CsvReadAccepted> = [];
    const outcome = read(fileA, undefined, (value) => accepted.push(value));
    parseCalls[0].resolve(undefined);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });
    expect(accepted[0].columns).toEqual([]);
  });

  test("passes the delimiter to the parse only when one is chosen", async () => {
    const { read } = mount();
    const first = read(fileA, ";", () => undefined);
    const second = read(fileB, undefined, () => undefined);
    expect(parseCalls[0].file).toBe(fileA);
    expect(parseCalls[0].options.delimiter).toBe(";");
    expect(parseCalls[1].file).toBe(fileB);
    expect("delimiter" in parseCalls[1].options).toBe(false);
    parseCalls[0].resolve(["id"]);
    parseCalls[1].resolve(["id"]);
    await Promise.all([first, second]);
  });

  test("refuses a file whose header leaves a column unnamed, without calling accept", async () => {
    const { read } = mount();
    let acceptCalls = 0;
    const outcome = read(fileA, undefined, () => {
      acceptCalls += 1;
    });
    parseCalls[0].resolve(["id", "", "dob", ""]);
    await expect(outcome).resolves.toEqual({
      kind: "refused",
      emptyPositions: [2, 4],
      sanitizedPositions: [2],
    });
    expect(acceptCalls).toBe(0);
  });

  test("a read error is a failed outcome carrying the error", async () => {
    const { read } = mount();
    const error = new Error("parse blew up");
    const outcome = read(fileA, undefined, () => undefined);
    parseCalls[0].reject(error);
    const result = await outcome;
    expect(result).toEqual({ kind: "failed", error });
    expect(result.kind === "failed" && result.error).toBe(error);
  });

  test("a throw from accept is a failed outcome", async () => {
    const { read } = mount();
    const error = new Error("screen could not seed");
    const outcome = read(fileA, undefined, () => {
      throw error;
    });
    parseCalls[0].resolve(["id"]);
    await expect(outcome).resolves.toEqual({ kind: "failed", error });
  });

  test("an older read that resolves after a newer one started is dropped as superseded", async () => {
    const { read } = mount();
    const accepted: Array<Array<string>> = [];
    const older = read(fileA, undefined, (value) =>
      accepted.push(value.columns),
    );
    const newer = read(fileB, undefined, (value) =>
      accepted.push(value.columns),
    );
    expect(parseCalls[0].options.signal.aborted).toBe(true);
    expect(parseCalls[1].options.signal.aborted).toBe(false);

    parseCalls[1].resolve(["newer"]);
    await expect(newer).resolves.toEqual({ kind: "accepted" });
    parseCalls[0].resolve(["older"]);
    await expect(older).resolves.toEqual({ kind: "superseded" });
    expect(accepted).toEqual([["newer"]]);
  });

  test("an older read that is aborted into an error is superseded, not failed", async () => {
    const { read } = mount();
    const older = read(fileA, undefined, () => undefined);
    const newer = read(fileB, undefined, () => undefined);
    parseCalls[0].reject(new DOMException("aborted", "AbortError"));
    await expect(older).resolves.toEqual({ kind: "superseded" });
    parseCalls[1].resolve(["id"]);
    await expect(newer).resolves.toEqual({ kind: "accepted" });
  });

  test("an older read with an unnamed column is superseded, not refused", async () => {
    const { read } = mount();
    const older = read(fileA, undefined, () => undefined);
    const newer = read(fileB, undefined, () => undefined);
    parseCalls[0].resolve(["", "id"]);
    await expect(older).resolves.toEqual({ kind: "superseded" });
    parseCalls[1].resolve(["id"]);
    await newer;
  });

  test("discard drops an in-flight read: aborted, then superseded with accept never called", async () => {
    const { read, discard } = mount();
    let acceptCalls = 0;
    const outcome = read(fileA, undefined, () => {
      acceptCalls += 1;
    });
    discard();
    expect(parseCalls[0].options.signal.aborted).toBe(true);
    parseCalls[0].resolve(["id"]);
    await expect(outcome).resolves.toEqual({ kind: "superseded" });
    expect(acceptCalls).toBe(0);
  });

  test("discard drops an in-flight read that then errors", async () => {
    const { read, discard } = mount();
    const outcome = read(fileA, undefined, () => undefined);
    discard();
    parseCalls[0].reject(new Error("worker terminated"));
    await expect(outcome).resolves.toEqual({ kind: "superseded" });
  });

  test("a read started after a discard runs normally", async () => {
    const { read, discard } = mount();
    const dropped = read(fileA, undefined, () => undefined);
    discard();
    const next = read(fileB, undefined, () => undefined);
    parseCalls[1].resolve(["id"]);
    parseCalls[0].resolve(["id"]);
    await expect(next).resolves.toEqual({ kind: "accepted" });
    await expect(dropped).resolves.toEqual({ kind: "superseded" });
  });

  test("discard with no read in flight is harmless", () => {
    const { discard } = mount();
    expect(() => discard()).not.toThrow();
  });

  test("unmounting discards the in-flight read", async () => {
    const { read, unmount } = mount();
    let acceptCalls = 0;
    const outcome = read(fileA, undefined, () => {
      acceptCalls += 1;
    });
    unmount();
    expect(parseCalls[0].options.signal.aborted).toBe(true);
    parseCalls[0].resolve(["id"]);
    await expect(outcome).resolves.toEqual({ kind: "superseded" });
    expect(acceptCalls).toBe(0);
  });
});
