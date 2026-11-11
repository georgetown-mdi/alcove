import { describe, expect, test } from "vitest";

import {
  BrowserSshNoCommonAlgorithmError,
  noCommonAlgorithmError,
} from "@psi/transport/browserSsh/browserSshErrors";

describe("noCommonAlgorithmError", () => {
  test("names the category and both lists from the library's message", () => {
    const original = new Error(
      "Failed KeyExchange negotiation: Server (diffie-hellman-group14-sha256, diffie-hellman-group16-sha512) Client (ecdh-sha2-nistp256)",
    );
    const named = noCommonAlgorithmError(original);
    expect(named).toBeInstanceOf(BrowserSshNoCommonAlgorithmError);
    expect(named).toMatchObject({
      category: "KeyExchange",
      serverAlgorithms: [
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group16-sha512",
      ],
      clientAlgorithms: ["ecdh-sha2-nistp256"],
      cause: original,
    });
    expect(named?.message).toBe(
      "The SFTP server offers no key exchange algorithm this client supports. " +
        "Server: diffie-hellman-group14-sha256, diffie-hellman-group16-sha512. " +
        "Client: ecdh-sha2-nistp256. " +
        "Ask the SFTP server's administrator to enable one of the client's algorithms.",
    );
  });

  test.each([
    ["KeyExchange", "key exchange"],
    ["PublicKey", "host key"],
    ["ClientEncryption", "encryption"],
    ["ServerEncryption", "encryption"],
    ["ClientHmac", "message authentication"],
    ["ServerHmac", "message authentication"],
    ["ClientCompression", "compression"],
    ["ServerCompression", "compression"],
  ])("names %s in plain words", (category, words) => {
    const named = noCommonAlgorithmError(
      new Error(`Failed ${category} negotiation: Server (x) Client (y)`),
    );
    expect(named?.category).toBe(category);
    expect(named?.message).toMatch(
      new RegExp(`^The SFTP server offers no ${words} algorithm `),
    );
    expect(named?.message).not.toContain(category);
  });

  test("reads an empty server list as none", () => {
    const named = noCommonAlgorithmError(
      new Error(
        "Failed ClientEncryption negotiation: Server () Client (aes256-ctr)",
      ),
    );
    expect(named?.serverAlgorithms).toEqual([]);
    expect(named?.message).toContain("Server: (none)");
  });

  test("keeps a server list that spans lines as the server's own text", () => {
    const named = noCommonAlgorithmError(
      new Error("Failed PublicKey negotiation: Server (a\nb) Client (c)"),
    );
    expect(named?.serverAlgorithms).toEqual(["a\nb"]);
  });

  test.each([
    { label: "another error", error: new Error("Connection lost") },
    {
      label: "an unknown category",
      error: new Error("Failed Banner negotiation: Server (x) Client (y)"),
    },
    {
      label: "the message inside a longer one",
      error: new Error(
        "Note: Failed KeyExchange negotiation: Server (x) Client (y)",
      ),
    },
    {
      label: "a non-Error",
      error: "Failed KeyExchange negotiation: Server (x) Client (y)",
    },
  ])("returns null for $label", ({ error }) => {
    expect(noCommonAlgorithmError(error)).toBeNull();
  });
});
