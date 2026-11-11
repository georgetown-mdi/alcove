import { describe, expect, test, vi } from "vitest";

import { UsageError } from "@alcove/core";

import { establishBrowserHostKeyTrust } from "@psi/transport/browserSsh/browserHostKeyTrust";

import type { BrowserHostKeyTrustDeps } from "@psi/transport/browserSsh/browserHostKeyTrust";
import type { SFTPConnectionConfig } from "@alcove/core";

const PRESENTED = `SHA256:${"P".repeat(42)}A`;
const PUBLISHED = `SHA256:${"Q".repeat(42)}A`;

function sftpConnection(hostKeyFingerprint?: string): SFTPConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      username: "exchange",
      ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    },
  };
}

function deps(
  answers: { confirm?: boolean; entered?: string } = {},
): BrowserHostKeyTrustDeps {
  return {
    probe: vi.fn(() =>
      Promise.resolve({ fingerprint: PRESENTED, keyType: "ssh-ed25519" }),
    ),
    confirmPresentedKey: vi.fn(() => Promise.resolve(answers.confirm ?? false)),
    enterServerFingerprint: vi.fn(() => Promise.resolve(answers.entered)),
  };
}

describe("establishBrowserHostKeyTrust", () => {
  test("leaves a pinned connection as it is and asks nothing", async () => {
    const steps = deps();
    const connection = sftpConnection(PUBLISHED);
    const trust = await establishBrowserHostKeyTrust(
      connection,
      { attended: false, relay: "invitation" },
      steps,
    );
    expect(trust).toEqual({ connection });
    expect(steps.probe).not.toHaveBeenCalled();
    expect(steps.confirmPresentedKey).not.toHaveBeenCalled();
    expect(steps.enterServerFingerprint).not.toHaveBeenCalled();
  });

  test.each(["own", "invitation"] as const)(
    "refuses an unattended first use through the %s relay without reaching the server",
    async (relay) => {
      const steps = deps({ confirm: true, entered: PUBLISHED });
      await expect(
        establishBrowserHostKeyTrust(
          sftpConnection(),
          { attended: false, relay },
          steps,
        ),
      ).rejects.toThrow(
        new UsageError(
          "The SFTP server's host key is not pinned, so a scheduled run " +
            "cannot check the server and did not connect. Open the exchange " +
            "and run it once to pin the server's host key.",
        ),
      );
      expect(steps.probe).not.toHaveBeenCalled();
    },
  );

  test("through the party's own relay, pins the presented key on a yes", async () => {
    const steps = deps({ confirm: true });
    const connection = sftpConnection();
    const trust = await establishBrowserHostKeyTrust(
      connection,
      { attended: true, relay: "own" },
      steps,
    );
    expect(steps.confirmPresentedKey).toHaveBeenCalledWith({
      fingerprint: PRESENTED,
      keyType: "ssh-ed25519",
    });
    expect(trust.newPin).toBe(PRESENTED);
    expect(trust.connection.server.hostKeyFingerprint).toBe(PRESENTED);
    expect(connection.server.hostKeyFingerprint).toBeUndefined();
    expect(steps.enterServerFingerprint).not.toHaveBeenCalled();
  });

  test("through the party's own relay, a no pins nothing", async () => {
    await expect(
      establishBrowserHostKeyTrust(
        sftpConnection(),
        { attended: true, relay: "own" },
        deps({ confirm: false }),
      ),
    ).rejects.toThrow(/was not trusted, so nothing was sent/);
  });

  test("through the invitation's relay, pins the entered fingerprint and never the presented key", async () => {
    const steps = deps({ confirm: true, entered: `  ${PUBLISHED}\n` });
    const trust = await establishBrowserHostKeyTrust(
      sftpConnection(),
      { attended: true, relay: "invitation" },
      steps,
    );
    expect(trust.newPin).toBe(PUBLISHED);
    expect(trust.connection.server.hostKeyFingerprint).toBe(PUBLISHED);
    expect(steps.probe).not.toHaveBeenCalled();
    expect(steps.confirmPresentedKey).not.toHaveBeenCalled();
  });

  test.each([
    ["nothing entered", undefined, /No host key fingerprint was entered/],
    ["a blank entry", "   ", /No host key fingerprint was entered/],
    [
      "a signing fingerprint",
      "Q".repeat(42) + "A",
      /is not a host key fingerprint/,
    ],
    [
      "a non-canonical last character",
      `SHA256:${"Q".repeat(42)}B`,
      /is not a host key fingerprint/,
    ],
  ])(
    "through the invitation's relay, refuses %s",
    async (_name, entered, message) => {
      await expect(
        establishBrowserHostKeyTrust(
          sftpConnection(),
          { attended: true, relay: "invitation" },
          deps({ entered }),
        ),
      ).rejects.toThrow(message);
    },
  );
});
