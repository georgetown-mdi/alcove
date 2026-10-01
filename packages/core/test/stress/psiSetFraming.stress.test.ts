import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "../../src/connection/webrtcOutboundBound";
import { serializeSetup } from "../../src/psi/psiChunks";

// The framing a PSI set adds to its elements, at the largest set any sender
// sends: a server setup of the per-set maximum, the largest PSI message of a
// count, whose element list's length prefix is 5 bytes at this size. About
// 2 GB of heap, which is why it is the opt-in tier.

test("a setup of the per-set maximum adds the most framing a set adds", async () => {
  const values = MAX_PSI_DECODE_ELEMENTS;
  const element = new Uint8Array(PSI_ENCODED_ELEMENT_BYTES - 2).fill(7);
  const setup = serializeSetup(
    await PSI(),
    new Array<Uint8Array>(values).fill(element),
  );
  expect(setup.length - values * PSI_ENCODED_ELEMENT_BYTES).toBe(
    PSI_SET_MAX_FRAMING_BYTES,
  );
}, 300_000);
