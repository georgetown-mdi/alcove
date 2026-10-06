import { describe, expect, test, vi } from "vitest";

import { generateSharedSecret } from "../src/config/connection";
import {
  TermsUpdateRefusedError,
  decodeTermsUpdate,
  encodeTermsUpdate,
} from "../src/config/termsUpdate";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";

const failure = vi.hoisted(() => ({ next: undefined as Error | undefined }));

vi.mock("../src/utils/boundedJson", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/utils/boundedJson")>();
  return {
    ...actual,
    parseBoundedJson: (input: Uint8Array | string): unknown => {
      const err = failure.next;
      failure.next = undefined;
      if (err !== undefined) throw err;
      return actual.parseBoundedJson(input);
    },
  };
});

async function decodeFailure(next: Error): Promise<unknown> {
  const secret = generateSharedSecret();
  const encoded = await encodeTermsUpdate(
    { linkageTerms: getDefaultLinkageTerms("Agency A") },
    secret,
  );
  failure.next = next;
  return decodeTermsUpdate(encoded, secret).then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe("a terms update decode failure", () => {
  test("it does not classify reaches the caller as raised", async () => {
    const raised = new RangeError("out of memory reading the body");
    const err = await decodeFailure(raised);
    expect(err).toBe(raised);
    expect(err).not.toBeInstanceOf(TermsUpdateRefusedError);
  });

  test("on a body that is not JSON is a format refusal", async () => {
    const err = await decodeFailure(new SyntaxError("Unexpected token"));
    expect(err).toBeInstanceOf(TermsUpdateRefusedError);
    expect((err as TermsUpdateRefusedError).check).toBe("format");
    expect((err as Error).message).toContain("not valid JSON");
  });
});
