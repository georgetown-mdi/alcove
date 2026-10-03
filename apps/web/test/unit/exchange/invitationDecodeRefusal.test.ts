import { expect, test } from "vitest";

import {
  UsageError,
  decodeInvitation,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import { invitationDecodeRefusal } from "@exchange/invitationDecodeRefusal";

async function refusalFor(encoded: string) {
  const error = await decodeInvitation(encoded).catch((e: unknown) => e);
  return invitationDecodeRefusal(error);
}

async function validToken(): Promise<string> {
  return encodeInvitation({
    version: "1",
    linkageTerms: getDefaultLinkageTerms("County Health Department"),
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  });
}

test("a cut, wrapped, or altered link is damaged in transit", async () => {
  const encoded = await validToken();
  const last = encoded.slice(-1);
  for (const input of [
    "short",
    encoded.slice(0, 40) + "!" + encoded.slice(41),
    encoded.slice(0, -1) + (last === "A" ? "B" : "A"),
    encoded.slice(0, -20),
  ]) {
    const refusal = await refusalFor(input);
    expect(refusal.kind).toBe("damaged");
    if (refusal.kind === "damaged") expect(refusal.detail).not.toBe("");
  }
});

test("an intact string that is not an invitation this build reads is unreadable", async () => {
  const toBase64Url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const raw = async (payload: string) => {
    const bytes = new TextEncoder().encode(payload);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    ).slice(0, 4);
    return toBase64Url(bytes) + toBase64Url(hash);
  };
  expect((await refusalFor(await raw("not json"))).kind).toBe("unreadable");
  const schema = await refusalFor(
    await raw(JSON.stringify({ version: "1", sharedSecret: "x" })),
  );
  expect(schema.kind).toBe("unreadable");
  if (schema.kind === "unreadable") expect(schema.detail).toContain(":");
});

test("a readable invitation the page refuses keeps its own message", () => {
  const refusal = invitationDecodeRefusal(
    new UsageError(
      "This invitation has expired. Ask your partner to send a new one.",
    ),
  );
  expect(refusal).toEqual({
    kind: "refused",
    message: "This invitation has expired. Ask your partner to send a new one.",
  });
});
