import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import {
  chunkIdentityValues,
  expectBoundaryRepeatRefusedWhenSliced,
  expectChunkedCountMatchesSingleCall,
  expectChunkedRoundMatchesSingleCall,
  expectDuplicatedResponseCountMatchesSingleCall,
} from "../utils/psiChunkIdentity";

// A chunked operation goes on the wire as the single call's bytes. The chunk
// size is set here rather than taken from the shipped policy, so the chunked
// path runs over a set a unit run can afford; the policy's own sizes are driven
// at scale by test/stress/psiChunkPolicy.stress.test.ts, and the sizes
// themselves by test/psi/psiChunks.test.ts.

const TOTAL = 200;
const CHUNK_ELEMENTS = 40;
const BETWEEN_CHUNKS = [40, 80, 120, 160];
const SETUP_SLICE_ELEMENTS = 40;
// Five setup slices against five response chunks: 25 calls, each worth a
// fifth of a response chunk, reported between calls and never after the last.
const BETWEEN_SLICED_CALLS = Array.from(
  { length: 24 },
  (_, index) => 8 * (index + 1),
);

const { serverValues, clientValues } = chunkIdentityValues(TOTAL);

const wasm = await PSI();
// undefined when no prebuild ships for this platform (that leg skips); a broken
// addon throws through and fails rather than skipping silently.
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend", (_name, library) => {
  test("a chunked round reproduces the single call byte for byte", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const processed = await expectChunkedRoundMatchesSingleCall({
      library,
      serverValues,
      clientValues,
      chunkElements: CHUNK_ELEMENTS,
    });
    // Between chunks and never after the last: the count an operation ends on
    // is the one its settle report states.
    expect(processed).toStrictEqual({
      createServerSetup: BETWEEN_CHUNKS,
      createClientRequest: BETWEEN_CHUNKS,
      processClientRequest: BETWEEN_CHUNKS,
      computeAssociationTable: BETWEEN_CHUNKS,
    });
  });

  test("a chunked count-only round reports the single call's cardinality", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    // No count between: the match is one call at every size, so a count-only
    // round moves a figure through its masking steps alone.
    expect(
      await expectChunkedCountMatchesSingleCall({
        library,
        serverValues,
        clientValues,
        chunkElements: CHUNK_ELEMENTS,
      }),
    ).toStrictEqual([]);
  });

  test("a duplicated response counts each value once, not once per chunk", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    await expectDuplicatedResponseCountMatchesSingleCall({
      library,
      serverValues,
      clientValues,
      chunkElements: CHUNK_ELEMENTS,
    });
  });

  test("a set the policy takes in one chunk reports no count at all", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    expect(
      await expectChunkedRoundMatchesSingleCall({
        library,
        serverValues,
        clientValues,
      }),
    ).toStrictEqual({});
  });

  test("a setup-sliced round reproduces the single call's table", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const processed = await expectChunkedRoundMatchesSingleCall({
      library,
      serverValues,
      clientValues,
      chunkElements: CHUNK_ELEMENTS,
      setupSliceElements: SETUP_SLICE_ELEMENTS,
    });
    expect(processed).toStrictEqual({
      createServerSetup: BETWEEN_CHUNKS,
      createClientRequest: BETWEEN_CHUNKS,
      processClientRequest: BETWEEN_CHUNKS,
      computeAssociationTable: BETWEEN_SLICED_CALLS,
    });
  });

  test("a setup-sliced match over an unsplit response reproduces the single call's table", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    expect(
      await expectChunkedRoundMatchesSingleCall({
        library,
        serverValues,
        clientValues,
        setupSliceElements: SETUP_SLICE_ELEMENTS,
      }),
    ).toStrictEqual({ computeAssociationTable: BETWEEN_CHUNKS });
  });

  test("a setup-sliced count-only match reports the single call's cardinality", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    // One call per slice, each against the whole response.
    expect(
      await expectChunkedCountMatchesSingleCall({
        library,
        serverValues,
        clientValues,
        chunkElements: CHUNK_ELEMENTS,
        setupSliceElements: SETUP_SLICE_ELEMENTS,
      }),
    ).toStrictEqual(BETWEEN_CHUNKS);
  });

  test("a setup repeating an element across a slice boundary is refused when sliced", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    await expectBoundaryRepeatRefusedWhenSliced({
      library,
      serverValues,
      clientValues,
      setupSliceElements: SETUP_SLICE_ELEMENTS,
    });
  });
});
