import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ConnectionError,
  deriveRelayKey,
  relayRegistrarAuthorization,
} from "@alcove/core";
import type { RelayRegistrar } from "@alcove/core";

import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import {
  logRotatedRelayKey,
  registerRelayKey,
  registerRotatedRelayKey,
  RELAY_REENROLLMENT_STEP,
  retryPendingRelayRegistration,
} from "../../src/relayKeyRotation";
import {
  exitCodeForError,
  renderFailureForOperator,
} from "../../src/util/exit";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
} from "./relayRegistrarFake";

// Two 43-char base64url secrets: the one a run starts with and the one its key
// exchange rotates to.
const PRE_ROTATION = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ROTATED = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "exchange-1",
};
const NOW = new Date("2026-01-01T00:00:00Z");
const noSleep = async (): Promise<void> => {};

let dir: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-relay-rotation-"));
  keyFile = path.join(dir, ".alcove.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("registerRelayKey", () => {
  test("signs with the signing secret's key and registers the other secret's key", async () => {
    const registrar = fakeRegistrar([registrationAnswer()]);
    await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
    );
    const [request] = registrar.requests;
    const body = JSON.stringify({
      key: await deriveRelayKey(ROTATED),
      maxAgeDays: 30,
    });
    expect(request?.body).toBe(body);
    expect(request?.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: await deriveRelayKey(PRE_ROTATION),
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body,
        now: NOW,
      }),
    );
  });

  test("sends maxAgeDays null for a row with no lapse", async () => {
    const registrar = fakeRegistrar([registrationAnswer()]);
    await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: null,
      },
      { fetch: registrar.fetch },
    );
    expect(JSON.parse(registrar.requests[0]!.body)).toEqual({
      key: await deriveRelayKey(ROTATED),
      maxAgeDays: null,
    });
  });

  test("retries an unavailable registrar after each wait, then gives up", async () => {
    const waits: number[] = [];
    const registrar = fakeRegistrar([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: 30,
      },
      {
        fetch: registrar.fetch,
        sleep: async (ms) => {
          waits.push(ms);
        },
        retryDelaysMs: [2_000, 5_000],
      },
    );
    expect(outcome.kind).toBe("unavailable");
    expect(waits).toEqual([2_000, 5_000]);
    expect(registrar.requests).toHaveLength(3);
  });

  test("a refusal is final, and no request ever holds the owner token", async () => {
    const registrar = fakeRegistrar([
      jsonResponse(409, { error: "does not verify" }),
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, sleep: noSleep },
    );
    expect(outcome).toMatchObject({ kind: "refused", status: 409 });
    expect(registrar.requests).toHaveLength(1);
    expect(registrar.requests[0]!.authorization).toMatch(
      /^Alcove-Relay-Proof /,
    );
  });

  test("a proof outside the clock window is signed again once at the registrar's time", async () => {
    const serverTime = NOW.getTime() / 1000 + 900;
    const registrar = fakeRegistrar([
      jsonResponse(401, { error: "skewed", serverTime }),
      registrationAnswer(),
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
    );
    expect(outcome.kind).toBe("registered");
    expect(registrar.requests[1]!.authorization).toMatch(
      new RegExp(`ts=${serverTime},`),
    );
  });

  test("a second clock refusal is a refusal", async () => {
    const registrar = fakeRegistrar([
      jsonResponse(401, { error: "skewed", serverTime: 1 }),
      jsonResponse(401, { error: "skewed", serverTime: 1 }),
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: PRE_ROTATION,
        registeredSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
    );
    expect(outcome).toMatchObject({ kind: "refused", status: 401 });
  });
});

describe("registerRotatedRelayKey", () => {
  test("registers the rotated key signed with the pre-rotation key, and confirms it in the key file", async () => {
    saveKeyFile(keyFile, {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: NOW.toISOString(),
    });
    const registrar = fakeRegistrar([
      jsonResponse(200, { maxAgeDays: 30, lapsesAt: "2026-01-31T00:00:00Z" }),
    ]);
    const result = await registerRotatedRelayKey(
      {
        registrar: REGISTRAR,
        preRotationSecret: PRE_ROTATION,
        keyFilePath: keyFile,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
    );
    expect(result.kind).toBe("registered");
    const body = registrar.requests[0]!.body;
    expect(JSON.parse(body)).toEqual({
      key: await deriveRelayKey(ROTATED),
      maxAgeDays: 30,
    });
    expect(registrar.requests[0]!.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: await deriveRelayKey(PRE_ROTATION),
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body,
        now: NOW,
      }),
    );
    expect(loadKeyFile(keyFile)).toEqual({ sharedSecret: ROTATED });
  });

  test("sends nothing when the run did not rotate the secret", async () => {
    saveKeyFile(keyFile, { sharedSecret: PRE_ROTATION });
    const registrar = fakeRegistrar([]);
    const result = await registerRotatedRelayKey(
      {
        registrar: REGISTRAR,
        preRotationSecret: PRE_ROTATION,
        keyFilePath: keyFile,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch },
    );
    expect(result.kind).toBe("not-rotated");
    expect(registrar.requests).toHaveLength(0);
  });

  test("a refusal keeps the rotated secret and the pending record, stores nothing of the old key, and names the recovery", async () => {
    const pendingSince = NOW.toISOString();
    saveKeyFile(keyFile, {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: pendingSince,
    });
    const registrar = fakeRegistrar([
      jsonResponse(409, { error: "the proof does not verify" }),
    ]);
    const result = await registerRotatedRelayKey(
      {
        registrar: REGISTRAR,
        preRotationSecret: PRE_ROTATION,
        keyFilePath: keyFile,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, sleep: noSleep },
    );
    expect(result.kind).toBe("failed");
    const error = (result as { error: Error }).error;
    expect(exitCodeForError(error)).toBe(77);
    expect(error.message).toContain("relay.example.org:8443");
    expect(error.message).toContain("exchange-1");
    expect(error.message).toContain("alcove enroll-relay --replace-relay-key");
    expect(loadKeyFile(keyFile)).toEqual({
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: pendingSince,
    });
    const onDisk = fs.readFileSync(keyFile, "utf8");
    expect(onDisk).not.toContain(PRE_ROTATION);
    expect(onDisk).not.toContain(await deriveRelayKey(PRE_ROTATION));
  });

  test("an unavailable registrar is a transport failure naming the retry before the next run", async () => {
    saveKeyFile(keyFile, { sharedSecret: ROTATED });
    const registrar = fakeRegistrar([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const result = await registerRotatedRelayKey(
      {
        registrar: REGISTRAR,
        preRotationSecret: PRE_ROTATION,
        keyFilePath: keyFile,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, sleep: noSleep },
    );
    const error = (result as { error: Error }).error;
    expect(error).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(error)).toBe(69);
    expect(error.message).toContain("The next run retries the registration");
    expect(loadKeyFile(keyFile)?.sharedSecret).toBe(ROTATED);
  });
});

describe("retryPendingRelayRegistration", () => {
  test("renews the current key signed with it, and confirms it in the key file", async () => {
    saveKeyFile(keyFile, {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: NOW.toISOString(),
    });
    const registrar = fakeRegistrar([registrationAnswer()]);
    await retryPendingRelayRegistration(
      {
        registrar: REGISTRAR,
        keyFilePath: keyFile,
        sharedSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
    );
    const body = registrar.requests[0]!.body;
    expect(JSON.parse(body).key).toBe(await deriveRelayKey(ROTATED));
    expect(registrar.requests[0]!.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: await deriveRelayKey(ROTATED),
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body,
        now: NOW,
      }),
    );
    expect(loadKeyFile(keyFile)).toEqual({ sharedSecret: ROTATED });
  });

  test("a registrar holding another key is exit 77 naming the relay and re-enrollment, and changes nothing", async () => {
    const pending = {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: NOW.toISOString(),
    };
    saveKeyFile(keyFile, pending);
    const registrar = fakeRegistrar([
      jsonResponse(409, { error: "the proof does not verify" }),
    ]);
    const failure = await retryPendingRelayRegistration(
      {
        registrar: REGISTRAR,
        keyFilePath: keyFile,
        sharedSecret: ROTATED,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, sleep: noSleep },
    ).catch((err: unknown) => err as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(exitCodeForError(failure)).toBe(77);
    expect((failure as Error).message).toContain(
      "the relay registrar at https://relay.example.org:8443 (exchange exchange-1)",
    );
    expect((failure as Error).message).toContain("Nothing was sent");
    expect((failure as Error).message).toContain(
      "alcove enroll-relay --replace-relay-key",
    );
    expect(loadKeyFile(keyFile)).toEqual(pending);
  });

  test("an unreachable registrar is exit 69 and keeps the pending record", async () => {
    const pending = {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: NOW.toISOString(),
    };
    saveKeyFile(keyFile, pending);
    const failure = await retryPendingRelayRegistration(
      {
        registrar: REGISTRAR,
        keyFilePath: keyFile,
        sharedSecret: ROTATED,
        maxAgeDays: 30,
      },
      {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
        sleep: noSleep,
      },
    ).catch((err: unknown) => err);
    expect(exitCodeForError(failure)).toBe(69);
    expect(loadKeyFile(keyFile)).toEqual(pending);
  });
});

describe("a registrar this computer cannot connect to", () => {
  // Real fetches against local ports: one nothing listens on, and one that
  // accepts the connection and never answers, as a dropped connection does.
  let silent: net.Server;
  let silentSockets: net.Socket[];
  let closedPort: number;

  beforeEach(async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    closedPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    silentSockets = [];
    silent = net.createServer((socket) => silentSockets.push(socket));
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    for (const socket of silentSockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  const localRegistrar = (port: number): RelayRegistrar => ({
    url: `https://127.0.0.1:${port}`,
    exchangeId: "exchange-1",
  });

  const outbound = (port: number): string =>
    `This computer needs outbound access to 127.0.0.1 on TCP port ${port}: ` +
    "if this network allows only some ports out (such as 443), have that " +
    "port opened or run from a network that allows it.";

  async function rotationFailure(
    registrar: RelayRegistrar,
  ): Promise<{ error: Error; logged: string }> {
    saveKeyFile(keyFile, { sharedSecret: ROTATED });
    const result = await registerRotatedRelayKey(
      {
        registrar,
        preRotationSecret: PRE_ROTATION,
        keyFilePath: keyFile,
        maxAgeDays: 30,
      },
      { timeoutMs: 200, retryDelaysMs: [] },
    );
    const errors: string[] = [];
    logRotatedRelayKey(result, registrar, {
      info: () => {},
      warn: () => {},
      error: (m) => errors.push(m),
    });
    return {
      error: (result as { error: Error }).error,
      logged: errors.join("\n"),
    };
  }

  test("a refused connection names the host and port and the outbound access it needs", async () => {
    const { error, logged } = await rotationFailure(localRegistrar(closedPort));
    expect(logged).toBe(
      "the exchange's shared secret rotated, and the relay registrar at " +
        `https://127.0.0.1:${closedPort} (exchange exchange-1) did not ` +
        "register the relay key derived from the new secret. The relay " +
        `registrar at 127.0.0.1 port ${closedPort} could not be reached ` +
        "(ECONNREFUSED). The rotated shared secret is kept. The next run " +
        "retries the registration before it dials; if the registrar then " +
        `refuses it, ${RELAY_REENROLLMENT_STEP}.\n${outbound(closedPort)}`,
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(error)).toBe(69);
  });

  test("a connection that never answers names the host and port and the outbound access it needs", async () => {
    const port = (silent.address() as net.AddressInfo).port;
    const { error, logged } = await rotationFailure(localRegistrar(port));
    expect(logged).toBe(
      "the exchange's shared secret rotated, and the relay registrar at " +
        `https://127.0.0.1:${port} (exchange exchange-1) did not register ` +
        "the relay key derived from the new secret. The relay registrar at " +
        `127.0.0.1 port ${port} did not answer within 0.2 seconds. The ` +
        "rotated shared secret is kept. The next run retries the " +
        "registration before it dials; if the registrar then refuses it, " +
        `${RELAY_REENROLLMENT_STEP}.\n${outbound(port)}`,
    );
    expect(exitCodeForError(error)).toBe(69);
  });

  test("the retry before dialing states the same requirement and exits 69", async () => {
    saveKeyFile(keyFile, {
      sharedSecret: ROTATED,
      relayRegistrationPendingSince: NOW.toISOString(),
    });
    const failure = await retryPendingRelayRegistration(
      {
        registrar: localRegistrar(closedPort),
        keyFilePath: keyFile,
        sharedSecret: ROTATED,
        maxAgeDays: 30,
      },
      { timeoutMs: 200, retryDelaysMs: [] },
    ).catch((err: unknown) => err);
    expect(renderFailureForOperator(failure)).toBe(
      "the key file records a relay key registration that was not " +
        "confirmed, and the relay registrar at " +
        `https://127.0.0.1:${closedPort} (exchange exchange-1) did not ` +
        "confirm it before this run dialed. The relay registrar at " +
        `127.0.0.1 port ${closedPort} could not be reached (ECONNREFUSED). ` +
        "Nothing was sent to your partner, and the shared secret is " +
        "unchanged. Run the exchange again once the registrar answers.\n" +
        outbound(closedPort),
    );
    expect(exitCodeForError(failure)).toBe(69);
  });
});
