import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { ConnectionConfig, RelayRegistrar } from "@alcove/core";

import { relayRegistrarForRun } from "../../src/relayRegistrar";
import { promptHiddenText } from "../../src/util/prompt";

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "exchange-1",
};

describe("relayRegistrarForRun", () => {
  const webrtc = (extra: Record<string, unknown>): ConnectionConfig =>
    ({
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      turn: [{ url: "turns:relay.example.org:443?transport=tcp" }],
      relayRegistrar: REGISTRAR,
      ...extra,
    }) as ConnectionConfig;

  test("registers at the registrar of the party's own minted relay", () => {
    expect(relayRegistrarForRun(webrtc({}))).toEqual(REGISTRAR);
  });

  test("keeps registering when the run lists the invitation's relay beside its own", () => {
    expect(
      relayRegistrarForRun(
        webrtc({
          invitationRelay: {
            turn: ["turns:partner.example.org:443"],
            registrar: "https://partner.example.org",
          },
        }),
      ),
    ).toEqual(REGISTRAR);
  });

  test("registers nothing when no registrar is named", () => {
    expect(
      relayRegistrarForRun(webrtc({ relayRegistrar: undefined })),
    ).toBeUndefined();
  });
});

describe("promptHiddenText", () => {
  test("returns the typed line and writes only the question", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const answer = promptHiddenText("Token:", { input, output });
    input.write("s3cret-token\n");
    await expect(answer).resolves.toBe("s3cret-token");
    expect(written.join("")).toBe("Token: \n");
  });
});
