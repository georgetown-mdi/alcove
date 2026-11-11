import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

// The relay's certificate renewal, driven against a fixture host.
//
// What it stands in for: the ACME client the renewal invokes. `lego` and
// `acme.sh` are stubs on PATH that record their arguments and leave a
// certificate where the real client would, and the deploy hook beside the
// copied renew.sh is a stub, so the test needs no root, no network and no DNS.
//
// What it cannot reach: whether the real client accepts those arguments, or
// writes the challenge where the CNAME points. A Let's Encrypt staging
// issuance on the host proves that (infra/relay/README.md, Certificates).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const RENEW = resolve(repoRoot, "infra/relay/certs/renew.sh");

const REALM = "turn.example.org";
const REGISTRAR = "registrar.example.org";
const WEBSOCKET = "relay.example.org";
const CHALLENGE_DOMAIN = "challenge.example.net";

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

const fixtureHost = ({ client, challengeDomain }) => {
  const root = mkdtempSync(join(tmpdir(), "relay-cert-renew-"));
  tmpDirs.push(root);
  const bin = join(root, "bin");
  const certs = join(root, "certs");
  const acmeHome = join(root, "acme");
  mkdirSync(bin);
  mkdirSync(certs);
  const args = join(root, "client-args");
  const hookRan = join(root, "hook-ran");

  copyFileSync(RENEW, join(certs, "renew.sh"));
  writeStub(join(certs, "deploy-hook.sh"), `touch '${hookRan}'`);
  writeStub(
    join(bin, "lego"),
    [
      `printf '%s\\n' "$@" > '${args}'`,
      `mkdir -p '${acmeHome}/certificates'`,
      `echo crt > '${acmeHome}/certificates/${REALM}.crt'`,
      `echo key > '${acmeHome}/certificates/${REALM}.key'`,
    ].join("\n"),
  );
  writeStub(
    join(bin, "acme.sh"),
    [
      `printf '%s\\n' "$@" > '${args}'`,
      `mkdir -p '${acmeHome}/${REALM}'`,
      `echo crt > '${acmeHome}/${REALM}/fullchain.cer'`,
      `echo key > '${acmeHome}/${REALM}/${REALM}.key'`,
    ].join("\n"),
  );

  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    [
      `ALCOVE_RELAY_REALM=${REALM}`,
      `ALCOVE_RELAY_REGISTRAR_NAME=${REGISTRAR}`,
      `ALCOVE_RELAY_WEBSOCKET_NAME=${WEBSOCKET}`,
      "",
    ].join("\n"),
  );
  const acmeEnv = join(root, "acme.env");
  writeFileSync(
    acmeEnv,
    [
      "ALCOVE_RELAY_ACME_EMAIL=relay-admin@example.org",
      `ALCOVE_RELAY_ACME_CLIENT=${client}`,
      "ALCOVE_RELAY_DNS_PROVIDER=cloudflare",
      `ALCOVE_RELAY_ACME_CHALLENGE_DOMAIN=${challengeDomain}`,
      "CLOUDFLARE_DNS_API_TOKEN=placeholder-not-a-token",
      "",
    ].join("\n"),
  );

  return {
    run: () => {
      const result = spawnSync(BASH, [join(certs, "renew.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ALCOVE_RELAY_ENV_FILE: envFile,
          ALCOVE_RELAY_ACME_ENV: acmeEnv,
          ALCOVE_RELAY_ACME_HOME: acmeHome,
        },
      });
      expect(result.status, `renew.sh failed with:\n${result.stderr}`).toBe(0);
      expect(existsSync(hookRan)).toBe(true);
      return readFileSync(args, "utf8").trimEnd().split("\n");
    },
  };
};

const namesAfter = (args, flag) =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

describe("the relay certificate renewal", () => {
  it("passes acme.sh the challenge domain after every name when one is set", () => {
    const args = fixtureHost({
      client: "acme.sh",
      challengeDomain: CHALLENGE_DOMAIN,
    }).run();
    const start = args.indexOf("-d");
    expect(args.slice(start, start + 12)).toEqual([
      "-d",
      REALM,
      "--challenge-alias",
      CHALLENGE_DOMAIN,
      "-d",
      REGISTRAR,
      "--challenge-alias",
      CHALLENGE_DOMAIN,
      "-d",
      WEBSOCKET,
      "--challenge-alias",
      CHALLENGE_DOMAIN,
    ]);
  });

  it("passes acme.sh no challenge alias when no challenge domain is set", () => {
    const args = fixtureHost({ client: "acme.sh", challengeDomain: "" }).run();
    expect(namesAfter(args, "-d")).toEqual([REALM, REGISTRAR, WEBSOCKET]);
    expect(args).not.toContain("--challenge-alias");
  });

  it("gives lego the same arguments whether or not a challenge domain is set", () => {
    const withDomain = fixtureHost({
      client: "lego",
      challengeDomain: CHALLENGE_DOMAIN,
    }).run();
    const withoutDomain = fixtureHost({
      client: "lego",
      challengeDomain: "",
    }).run();
    expect(namesAfter(withDomain, "--domains")).toEqual([
      REALM,
      REGISTRAR,
      WEBSOCKET,
    ]);
    expect(withDomain.join("\n")).not.toContain(CHALLENGE_DOMAIN);
    const withoutPath = (args) =>
      args.filter((_, index) => args[index - 1] !== "--path");
    expect(withoutPath(withDomain)).toEqual(withoutPath(withoutDomain));
  });
});
