import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { createMessagePipe } from "../../src/connection/messageConnection";
import { PartnerProtocolRefusalError } from "../../src/errors";
import {
  PSI_SET_PART_HEADER_BYTES,
  psiSetParts,
  receivePsiSet,
} from "../../src/psi/psiSetParts";

// Replays psi-set-part-vectors.json (generate-psi-set-part-vectors.mjs): the
// parts a round cuts a PSI set into, byte for byte, and the part sequences a
// receiver refuses before joining them.

interface PartVectors {
  headerBytes: number;
  sets: Array<{
    name: string;
    setHex: string;
    partPayloadBytes: number;
    partsHex: Array<string>;
  }>;
  refusals: Array<{
    name: string;
    partsHex: Array<string>;
    maxSetBytes: number;
    refusal: string;
  }>;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../vectors/psi-set-part-vectors.json", import.meta.url),
    "utf8",
  ),
) as PartVectors;

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function received(
  partsHex: Array<string>,
  maxSetBytes: number,
): Promise<Uint8Array> {
  const [a, b] = createMessagePipe();
  for (const part of partsHex) await a.send(fromHex(part));
  return receivePsiSet(b, "client", "response", maxSetBytes);
}

test("the header length is the one the vectors state", () => {
  expect(PSI_SET_PART_HEADER_BYTES).toBe(vectors.headerBytes);
});

test.each(vectors.sets.map((v) => [v.name, v] as const))(
  "%s",
  async (_name, vector) => {
    const set = fromHex(vector.setHex);
    expect([...psiSetParts(set, vector.partPayloadBytes)].map(toHex)).toEqual(
      vector.partsHex,
    );
    expect(toHex(await received(vector.partsHex, set.byteLength))).toBe(
      vector.setHex,
    );
  },
);

test.each(vectors.refusals.map((v) => [v.name, v] as const))(
  "%s is refused",
  async (_name, vector) => {
    await expect(received(vector.partsHex, vector.maxSetBytes)).rejects.toThrow(
      new PartnerProtocolRefusalError(
        `client protocol error: inbound PSI response ${vector.refusal}`,
      ),
    );
  },
);
