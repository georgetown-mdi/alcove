import { describe, expect, test } from "vitest";

import * as diffieHellman from "@psi/transport/browserSsh/stubs/diffieHellman";
import * as vscodeJsonrpc from "@psi/transport/browserSsh/stubs/vscodeJsonrpc";
import {
  BrowserSshUnsupportedKeyExchangeError,
  BrowserSshVerifyOnlyError,
} from "@psi/transport/browserSsh/browserSshErrors";
import NodeRsa from "@psi/transport/browserSsh/stubs/nodeRsa";

describe("the diffie-hellman stub", () => {
  test.each([
    ["getDiffieHellman", "getDiffieHellman"],
    ["createDiffieHellman", "createDiffieHellman"],
    ["DiffieHellmanGroup", "getDiffieHellman"],
    ["createDiffieHellmanGroup", "getDiffieHellman"],
    ["DiffieHellman", "createDiffieHellman"],
  ] as const)("%s throws the named error", (name, entry) => {
    const call = diffieHellman[name] as (...args: Array<unknown>) => never;
    expect(() => call("modp14")).toThrow(BrowserSshUnsupportedKeyExchangeError);
    expect(() => call("modp14")).toThrow(
      expect.objectContaining({ entry }) as Error,
    );
  });
});

describe("the node-rsa stub", () => {
  test("throws when constructed", () => {
    expect(() => NodeRsa()).toThrow(BrowserSshVerifyOnlyError);
  });
});

describe("the vscode-jsonrpc shim", () => {
  test("provides the events and cancellation the library uses", () => {
    const emitter = new vscodeJsonrpc.Emitter<number>();
    const seen: Array<number> = [];
    const subscription = emitter.event((value) => seen.push(value));
    emitter.fire(1);
    subscription.dispose();
    emitter.fire(2);
    expect(seen).toEqual([1]);

    const source = new vscodeJsonrpc.CancellationTokenSource();
    expect(source.token.isCancellationRequested).toBe(false);
    source.cancel();
    expect(source.token.isCancellationRequested).toBe(true);
    expect(vscodeJsonrpc.CancellationToken.None.isCancellationRequested).toBe(
      false,
    );
  });
});
