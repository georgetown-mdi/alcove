import { expect, test } from "vitest";

import {
  INVITATION_NEWER_REMEDY,
  KeyFoldCollisionError,
  UsageError,
  decodeInvitation,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  NEWER_INVITATION_BODY,
  invitationDecodeRefusal,
} from "@exchange/invitationDecodeRefusal";

async function refusalFor(encoded: string) {
  const error = await decodeInvitation(encoded).catch((e: unknown) => e);
  return invitationDecodeRefusal(error);
}

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

async function raw(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  ).slice(0, 4);
  return toBase64Url(bytes) + toBase64Url(hash);
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
  expect((await refusalFor(await raw("not json"))).kind).toBe("unreadable");
  const schema = await refusalFor(
    await raw(JSON.stringify({ version: "1", sharedSecret: "x" })),
  );
  expect(schema.kind).toBe("unreadable");
  if (schema.kind === "unreadable") expect(schema.detail).toContain(":");
});

test("an invitation on a newer format version asks for an update, not a new invitation", async () => {
  const newer = await refusalFor(
    await raw(
      JSON.stringify({
        version: "999",
        linkageTerms: getDefaultLinkageTerms("County Health Department"),
        sharedSecret: generateSharedSecret(),
      }),
    ),
  );
  expect(newer.kind).toBe("newer");
  if (newer.kind === "newer")
    expect(newer.detail).toContain("made by a newer version of Alcove");
  expect(NEWER_INVITATION_BODY).toBe(
    "This invitation was made by a newer version of Alcove than this one. " +
      INVITATION_NEWER_REMEDY,
  );
  expect(INVITATION_NEWER_REMEDY).toMatch(/^Update Alcove/);
});

test("a schema failure on the version this build reads is still unreadable", async () => {
  const malformed = await refusalFor(
    await raw(JSON.stringify({ version: "1", sharedSecret: "x" })),
  );
  expect(malformed.kind).toBe("unreadable");
  const unknownMember = await refusalFor(
    await raw(
      JSON.stringify({
        version: "1",
        linkageTerms: getDefaultLinkageTerms("County Health Department"),
        sharedSecret: generateSharedSecret(),
        fromALaterBuild: true,
      }),
    ),
  );
  expect(unknownMember.kind).toBe("unreadable");
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

test("two invitation keys that fold to one name are unreadable", async () => {
  const linkageTerms = structuredClone(
    getDefaultLinkageTerms("County Health Department"),
  );
  const element = linkageTerms.linkageKeys[0].elements[0];
  element.transform = [
    { function: "lowercase", params: { my_param: 1, myParam: 2 } },
  ];
  const payload = JSON.stringify({
    version: "1",
    linkageTerms,
    sharedSecret: generateSharedSecret(),
  });
  const error = await decodeInvitation(await raw(payload)).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(KeyFoldCollisionError);
  const refusal = invitationDecodeRefusal(error);
  expect(refusal.kind).toBe("unreadable");
  if (refusal.kind === "unreadable")
    expect(refusal.detail).toContain("myParam");
});

test("a non-Zod error holding an issues array is refused, not unreadable", () => {
  const error = Object.assign(new Error("terms this page will not run"), {
    issues: [{ path: ["x"], message: "bad" }],
  });
  expect(invitationDecodeRefusal(error).kind).toBe("refused");
});
