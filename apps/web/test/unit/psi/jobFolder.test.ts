import { describe, expect, test } from "vitest";

import { discardFolderItems } from "@exchange/discardFolder";
import { fetchJobFolder } from "@psi/jobClient/jobFolder";

const FULL = {
  live: false,
  results: true,
  record: true,
  sharedSecret: true,
  receipt: true,
  log: true,
};

function answering(response: Response | Error): typeof fetch {
  return () =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
}

function ask(fetchImpl: typeof fetch) {
  return fetchJobFolder("job", new AbortController().signal, fetchImpl);
}

describe("fetchJobFolder", () => {
  test("a full body is present", async () => {
    expect(await ask(answering(Response.json(FULL)))).toEqual({
      kind: "present",
      ...FULL,
    });
  });

  test("only a 404 is absent", async () => {
    expect(await ask(answering(new Response(null, { status: 404 })))).toEqual({
      kind: "absent",
    });
  });

  test("a fault, a lost connection, or a body missing a field is unanswered", async () => {
    expect(await ask(answering(new Response(null, { status: 500 })))).toEqual({
      kind: "unanswered",
    });
    expect(await ask(answering(new Error("offline")))).toEqual({
      kind: "unanswered",
    });
    const { sharedSecret: _omitted, ...partial } = FULL;
    expect(await ask(answering(Response.json(partial)))).toEqual({
      kind: "unanswered",
    });
    expect(
      await ask(answering(Response.json({ ...FULL, sharedSecret: "yes" }))),
    ).toEqual({ kind: "unanswered" });
  });
});

describe("discardFolderItems", () => {
  test("names each file present by its name on disk", () => {
    expect(discardFolderItems(FULL).map((item) => item.files)).toEqual([
      "results.csv",
      "record.json and record.keys.json",
      ".alcove.key",
      "receipt.json",
      "run.log",
    ]);
  });

  test("lists nothing for an empty folder", () => {
    expect(
      discardFolderItems({
        results: false,
        record: false,
        sharedSecret: false,
        receipt: false,
        log: false,
      }),
    ).toEqual([]);
  });
});
