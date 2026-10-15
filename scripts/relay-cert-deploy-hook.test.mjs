import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay's certificate deploy hook, driven against a fixture host.
//
// What it stands in for: renew.sh handing the hook the ACME client's
// certificate and key every day, renewed or not. `systemctl` and `chown` are
// stubs on PATH that record their calls, so the test needs no root and no
// systemd; everything else the hook runs is the real tool.
//
// What it cannot reach: a real lego or acme.sh run. The hook decides from the
// files it is handed, so a fixture file standing in for the client's output
// exercises the same decision.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const HOOK = resolve(repoRoot, "infra/relay/certs/deploy-hook.sh");

const OWN_UID = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
const OWN_GID = execFileSync("id", ["-g"], { encoding: "utf8" }).trim();

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const writeStub = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

const fixtureHost = () => {
  const root = mkdtempSync(join(tmpdir(), "relay-cert-hook-"));
  tmpDirs.push(root);
  const bin = join(root, "bin");
  const acme = join(root, "acme");
  mkdirSync(bin);
  mkdirSync(acme);
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");
  const active = join(root, "service-active");
  writeFileSync(active, "");
  writeStub(
    join(bin, "systemctl"),
    [
      `printf 'systemctl %s\\n' "$*" >> '${calls}'`,
      `if [ "$1" = is-active ]; then [ -f '${active}' ]; fi`,
    ].join("\n"),
  );
  writeStub(join(bin, "chown"), `printf 'chown %s\\n' "$*" >> '${calls}'`);
  const envFile = join(root, "relay.env");
  writeFileSync(envFile, "ALCOVE_RELAY_REALM=relay.example\n");
  const crt = join(acme, "relay.example.crt");
  const key = join(acme, "relay.example.key");
  const dest = join(root, "certs");
  const host = {
    dest,
    issue: (serial) => {
      writeFileSync(crt, `certificate ${serial}\n`);
      writeFileSync(key, `key ${serial}\n`);
    },
    stopService: () => rmSync(active),
    run: () => {
      writeFileSync(calls, "");
      const result = spawnSync(BASH, [HOOK], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ALCOVE_RELAY_ENV_FILE: envFile,
          ALCOVE_RELAY_CERT_DIR: dest,
          ALCOVE_RELAY_CERT_SOURCE: crt,
          ALCOVE_RELAY_KEY_SOURCE: key,
        },
      });
      expect(result.status, `the hook failed with:\n${result.stderr}`).toBe(0);
      const lines = readFileSync(calls, "utf8").split("\n");
      return {
        restarted: lines.includes(
          "systemctl restart alcove-relay-front.service",
        ),
        coturnRestarted: lines.some((line) =>
          /^systemctl \S*restart alcove-relay\.service$/.test(line),
        ),
        chowned: lines.filter((line) => line.startsWith("chown ")),
        registrarRestarted: lines.includes(
          "systemctl try-restart alcove-relay-registrar.service",
        ),
        stderr: result.stderr,
      };
    },
    key,
  };
  return host;
};

describe("the relay certificate deploy hook", () => {
  it("restarts a running front onto a first certificate", () => {
    const host = fixtureHost();
    host.issue(1);
    const run = host.run();
    expect(run.restarted).toBe(true);
    expect(run.coturnRestarted).toBe(false);
    expect(readFileSync(join(host.dest, "fullchain.pem"), "utf8")).toBe(
      "certificate 1\n",
    );
    expect(readFileSync(join(host.dest, "privkey.pem"), "utf8")).toBe(
      "key 1\n",
    );
  });

  // The front's nginx master reads the key as root with every capability
  // dropped, so the files are owned by the account running the hook, root on
  // the relay host.
  it("gives the files to the account that runs it", () => {
    const host = fixtureHost();
    host.issue(1);
    expect(host.run().chowned).toEqual([
      `chown ${OWN_UID}:${OWN_GID} ${join(host.dest, "privkey.pem")} ${join(host.dest, "fullchain.pem")}`,
    ]);
  });

  it("leaves the front running on a day the client renewed nothing", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    const noop = host.run();
    expect(noop.restarted).toBe(false);
    expect(noop.stderr).toContain("unchanged");
  });

  it("says the front is not running on a no-op day while it is stopped", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    host.stopService();
    const noop = host.run();
    expect(noop.restarted).toBe(false);
    expect(noop.stderr).toContain("not running");
  });

  it("restarts the front once the client renews the certificate", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    host.issue(2);
    expect(host.run().restarted).toBe(true);
    expect(host.run().restarted).toBe(false);
  });

  it("restarts a running registrar onto a renewed certificate, and only then", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    host.issue(2);
    expect(host.run().registrarRestarted).toBe(true);
    expect(host.run().registrarRestarted).toBe(false);
  });

  it("restarts the front when only the key changed", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    writeFileSync(host.key, "key 2\n");
    expect(host.run().restarted).toBe(true);
  });

  it("starts nothing on a first install, before the front is running", () => {
    const host = fixtureHost();
    host.stopService();
    host.issue(1);
    expect(host.run().restarted).toBe(false);
  });
});
