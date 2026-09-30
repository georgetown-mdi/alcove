import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  deriveRelayRegistrarProofKey,
  RELAY_REGISTRAR_PROOF_SCHEME,
  relayRegistrarAuthorization,
} from "../src/relayRegistrarProof";
import { toHex } from "../src/utils/crypto";

const PROTOCOL = fileURLToPath(
  new URL("../../../docs/spec/PROTOCOL.md", import.meta.url),
);

// The vector block under PROTOCOL.md's "The registrar request proof": a group
// of shared fields, then one group per request, groups split by blank lines.
function protocolVectors(): {
  shared: Record<string, string>;
  requests: Record<string, string>[];
} {
  const text = readFileSync(PROTOCOL, "utf8");
  const section = text.slice(text.indexOf("\n### The registrar request proof"));
  const open = section.indexOf("\n```text\n");
  const block = section.slice(open + 9, section.indexOf("\n```", open + 9));
  const groups = block.split("\n\n").map((group) =>
    Object.fromEntries(
      group.split("\n").map((line) => {
        const match = /^([a-z0-9_]+) +=(?: (.*))?$/.exec(line);
        if (match === null) throw new Error(`unparsed vector line: ${line}`);
        return [match[1], match[2] ?? ""];
      }),
    ),
  );
  const [shared, ...requests] = groups;
  return { shared, requests };
}

const { shared, requests } = protocolVectors();

describe("relayRegistrarAuthorization", () => {
  test("the vector block holds a PUT and a DELETE", () => {
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "DELETE"]);
  });

  test("derives the proof key from the relay key's decoded bytes", async () => {
    expect(toHex(await deriveRelayRegistrarProofKey(shared.relay_key))).toBe(
      shared.proof_key,
    );
  });

  test.each(requests)(
    "matches PROTOCOL.md's $method vector",
    async ({ method, body, authorization, mac }) => {
      const header = await relayRegistrarAuthorization({
        relayKey: shared.relay_key,
        method: method as "PUT" | "DELETE",
        exchangeId: shared.exchange_id,
        body,
        now: new Date(Number(shared.ts) * 1000 + 999),
      });
      expect(header).toBe(authorization);
      expect(header.endsWith(`,mac=${mac}`)).toBe(true);
      expect(header.startsWith(`${RELAY_REGISTRAR_PROOF_SCHEME} `)).toBe(true);
    },
  );

  test("signs a byte body the same as its UTF-8 string", async () => {
    const put = requests[0];
    const options = {
      relayKey: shared.relay_key,
      method: "PUT" as const,
      exchangeId: shared.exchange_id,
      now: new Date(Number(shared.ts) * 1000),
    };
    expect(
      await relayRegistrarAuthorization({
        ...options,
        body: new TextEncoder().encode(put.body),
      }),
    ).toBe(put.authorization);
  });

  test("binds the method, the exchange id, the body and the time", async () => {
    const base = {
      relayKey: shared.relay_key,
      method: "PUT" as const,
      exchangeId: shared.exchange_id,
      body: requests[0].body,
      now: new Date(Number(shared.ts) * 1000),
    };
    const variants = await Promise.all(
      [
        base,
        { ...base, method: "DELETE" as const },
        { ...base, exchangeId: "exchange-2" },
        { ...base, body: `${base.body} ` },
        { ...base, now: new Date(base.now.getTime() + 1000) },
        { ...base, relayKey: "0".repeat(64) },
      ].map(relayRegistrarAuthorization),
    );
    expect(new Set(variants).size).toBe(variants.length);
  });

  test("never holds a Bearer credential", async () => {
    for (const { method, body } of requests) {
      const header = await relayRegistrarAuthorization({
        relayKey: shared.relay_key,
        method: method as "PUT" | "DELETE",
        exchangeId: shared.exchange_id,
        body,
        now: new Date(),
      });
      expect(header).toMatch(/^Alcove-Relay-Proof ts=\d+,mac=[0-9a-f]{64}$/);
      expect(header.toLowerCase()).not.toContain("bearer");
    }
  });

  test.each([
    ["an uppercase relay key", { relayKey: shared.relay_key.toUpperCase() }],
    ["a short relay key", { relayKey: shared.relay_key.slice(1) }],
    ["a method it does not sign", { method: "POST" }],
    ["an exchange id holding a newline", { exchangeId: "exchange-1\nPUT" }],
    ["an exchange id starting with '-'", { exchangeId: "-exchange" }],
    ["an invalid date", { now: new Date(Number.NaN) }],
    ["a date before the epoch", { now: new Date(-1000) }],
  ])("refuses %s", async (_, override) => {
    await expect(
      relayRegistrarAuthorization({
        relayKey: shared.relay_key,
        method: "PUT",
        exchangeId: shared.exchange_id,
        body: "",
        now: new Date(),
        ...(override as object),
      }),
    ).rejects.toThrow(
      /relayRegistrarAuthorization|deriveRelayRegistrarProofKey/,
    );
  });
});
