import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { z } from "zod";

import {
  ALLOWED_OMISSIONS,
  compareKeyPaths,
  schemaKeyPaths,
  templateKeyPaths,
} from "./check-init-template-coverage.mjs";
import { CHECKS } from "./run-checks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("schemaKeyPaths", () => {
  it("reads keys through wrappers, both sides of a pipe, unions and arrays", () => {
    const schema = z.strictObject({
      connection: z.union([
        z.object({
          channel: z.literal("sftp"),
          server: z.object({ host: z.string() }),
        }),
        z.object({ channel: z.literal("filedrop"), path: z.string() }),
      ]),
      items: z
        .array(z.unknown())
        .pipe(z.array(z.object({ fooBar: z.string() })))
        .transform((x) => x)
        .optional(),
      steps: z.array(z.object({ params: z.record(z.string(), z.string()) })),
    });
    const { paths, records } = schemaKeyPaths(schema);
    expect([...paths].sort()).toEqual([
      "connection",
      "connection.channel",
      "connection.path",
      "connection.server",
      "connection.server.host",
      "items",
      "items.foo_bar",
      "steps",
      "steps.params",
    ]);
    expect([...records]).toEqual(["steps.params"]);
  });

  it("refuses a node type it does not walk", () => {
    const schema = z.object({ when: z.map(z.string(), z.string()) });
    expect(() => schemaKeyPaths(schema)).toThrow(/type "map" at "when"/);
  });
});

describe("templateKeyPaths", () => {
  const paths = (text) => [...templateKeyPaths(text, YAML)].sort();

  it("reads active keys and a commented top-level example, skipping prose", () => {
    const text = [
      "connection:",
      "  channel: sftp",
      "# signing: receipt signing and partner-certificate trust.",
      "# signing:",
      "#   mode: none",
      "#   # identity_file: /run/identity.json",
      "#   # a prose line inside the example",
      "#   # partner_fingerprint: <43-char base64url>   # pin it",
    ].join("\n");
    expect(paths(text)).toEqual([
      "connection",
      "connection.channel",
      "signing",
      "signing.identity_file",
      "signing.mode",
      "signing.partner_fingerprint",
    ]);
  });

  it("places an indented example in a comment above a key under that key", () => {
    const text = [
      "connection:",
      "  channel: sftp",
      "  # Supply a credential by adding one of:",
      '  #   password: "@./pw.txt"',
      "  # Optionally beside it:",
      "  # peer_id: agency-a",
      "  server:",
      "    host: example.org",
    ].join("\n");
    expect(paths(text)).toEqual([
      "connection",
      "connection.channel",
      "connection.peer_id",
      "connection.server",
      "connection.server.host",
      "connection.server.password",
    ]);
  });

  it("places a trailing commented sequence entry under the open key", () => {
    const text = [
      "metadata:",
      "  - name: a",
      "  # Uncomment to send it:",
      "  # - name: b",
      "  #   is_payload: true",
      "# Cleaning steps.",
      "standardization: []",
    ].join("\n");
    expect(paths(text)).toEqual([
      "metadata",
      "metadata.is_payload",
      "metadata.name",
      "standardization",
    ]);
  });
});

describe("compareKeyPaths", () => {
  const schema = {
    paths: new Set(["a", "a.b", "a.c", "a.c.d", "r", "x"]),
    records: new Set(["r"]),
  };

  it("names omitted and unknown paths, covering under an allowance and a record", () => {
    const result = compareKeyPaths({
      schema,
      documented: new Set(["a", "a.b", "r", "r.free", "y"]),
      allowed: new Map([["a.c", "reason"]]),
    });
    expect(result).toEqual({
      omitted: ["x"],
      unknown: ["y"],
      staleAllowances: [],
    });
  });

  it("names an allowance the template documents or the schema lacks", () => {
    const result = compareKeyPaths({
      schema,
      documented: new Set(["a", "a.b", "a.c.d", "r", "x"]),
      allowed: new Map([
        ["a.c", "reason"],
        ["gone", "reason"],
      ]),
    });
    expect(result.staleAllowances).toEqual(["a.c", "gone"]);
  });
});

describe("the repository", () => {
  it("gives every allowance a reason", () => {
    for (const [path, reason] of ALLOWED_OMISSIONS)
      expect(reason.length, path).toBeGreaterThan(0);
  });

  it("is on the check:all list", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:init-template-coverage",
    );
  });

  it("passes the check against the real schema and template", () => {
    const stdout = execFileSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        resolve(repoRoot, "scripts/check-init-template-coverage.mjs"),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(stdout).toContain("Init-template coverage check passed");
  });
});
