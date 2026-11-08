import { afterEach, describe, expect, test, vi } from "vitest";
import PSI from "@openmined/psi.js";

import { createMessagePipe } from "../../src/connection/messageConnection";
import { PartnerProtocolRefusalError } from "../../src/errors";
import { PSIParticipant, type PsiSetCeilings } from "../../src/psi/participant";
import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { PsiElementBounds } from "../../src/psi/singlePassSizing";

// A single-pass setup or request arrives whole in its message, so the element
// scan is the one check on its count: it is held to the least of the
// authenticated bound, the single-pass set maximum and this party's receive
// ceiling (docs/spec/PROTOCOL.md, The limits over file-sync). A cascade
// round's request is not held to the single-pass figure.

afterEach(() => {
  vi.restoreAllMocks();
});

const psiLibrary = await PSI();

function values(count: number, prefix: string): Array<string> {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function participant(
  role: "starter" | "joiner",
  elementBounds: PsiElementBounds = UNBOUNDED_PSI_ELEMENTS,
  setCeilings?: PsiSetCeilings,
): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    elementBounds,
    undefined,
    undefined,
    setCeilings,
  );
}

const SMALL_CEILING = 5;
const ceilings: PsiSetCeilings = {
  local: SMALL_CEILING,
  partner: MAX_PSI_DECODE_ELEMENTS,
};

// The single-pass setup or request of `count` elements put to a party holding
// the authenticated bound `bound`, under the receive ceiling `ceilings`.
async function putSetup(
  count: number,
  bound: number,
  held: PsiSetCeilings,
): Promise<unknown> {
  const sender = participant("starter");
  const receiver = participant(
    "joiner",
    { setup: bound, request: bound },
    held,
  );
  try {
    const { setup } = await sender.createServerSetup(values(count, "s"));
    const request = await receiver.createClientRequest(values(1, "c"));
    const response = await sender.processClientRequest(request);
    return await receiver.computeValueMatches(setup, response);
  } finally {
    sender.dispose();
    receiver.dispose();
  }
}

async function putRequest(
  count: number,
  bound: number,
  held: PsiSetCeilings,
): Promise<unknown> {
  const sender = participant("starter", { setup: bound, request: bound }, held);
  const receiver = participant("joiner");
  try {
    await sender.createServerSetup(values(1, "s"));
    const request = await receiver.createClientRequest(values(count, "c"));
    return await sender.processClientRequest(request);
  } finally {
    sender.dispose();
    receiver.dispose();
  }
}

const SINGLE_PASS_FRAMES = [
  ["setup", putSetup],
  ["request", putRequest],
] as const;

describe.each(SINGLE_PASS_FRAMES)("a single-pass %s", (_kind, put) => {
  test("at this party's receive ceiling is admitted", async () => {
    await expect(put(SMALL_CEILING, 100, ceilings)).resolves.toBeDefined();
  });

  test("one element over this party's receive ceiling is refused", async () => {
    const refusal = put(SMALL_CEILING + 1, 100, ceilings);
    await expect(refusal).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
    await expect(refusal).rejects.toThrow(
      `declares more than ${SMALL_CEILING} encrypted element(s)`,
    );
  });

  test("at the authenticated bound under the ceiling is admitted", async () => {
    await expect(put(3, 3, ceilings)).resolves.toBeDefined();
  });

  test("one element over the authenticated bound under the ceiling is refused by the bound", async () => {
    const refusal = put(4, 3, ceilings);
    await expect(refusal).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
    await expect(refusal).rejects.toThrow(
      "declares more than 3 encrypted element(s)",
    );
  });
});

describe("a cascade round's request under the same participant", () => {
  const assertSinglePass = () =>
    vi.spyOn(
      PSIParticipant.prototype as unknown as {
        assertSinglePassElementBound: (...held: Array<never>) => number;
      },
      "assertSinglePassElementBound",
    );

  async function cascadeRound(joinerValues: number): Promise<Array<unknown>> {
    const [a, b] = createMessagePipe();
    const starter = participant(
      "starter",
      { setup: 100, request: 100 },
      ceilings,
    );
    const joiner = participant("joiner");
    const settled = (run: Promise<unknown>) =>
      run.then(
        (table) => table,
        (err: unknown) => err,
      );
    try {
      return await Promise.all([
        settled(starter.identifyIntersection(a, values(3, "s"))),
        settled(joiner.identifyIntersection(b, values(joinerValues, "s"))),
      ]);
    } finally {
      starter.dispose();
      joiner.dispose();
      await a.close();
    }
  }

  test("is not checked as a single-pass request, and a single-pass request is", async () => {
    const scan = assertSinglePass();
    const [starterEnd, joinerEnd] = await cascadeRound(SMALL_CEILING);
    expect(starterEnd).not.toBeInstanceOf(Error);
    expect(joinerEnd).not.toBeInstanceOf(Error);
    expect(scan).not.toHaveBeenCalled();
    await putRequest(SMALL_CEILING, 100, ceilings);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  test("is held to this party's receive ceiling as the cascade holds it", async () => {
    const [starterEnd] = await cascadeRound(SMALL_CEILING + 1);
    expect(starterEnd).toBeInstanceOf(Error);
  });
});
