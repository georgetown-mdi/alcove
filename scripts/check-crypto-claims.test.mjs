import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CORE_MODULES,
  ENCRYPTING_MODULES,
  NODE_CRYPTO_USES,
  packageOf,
  readFile,
  scanRepo,
  violationsOf,
} from "./check-crypto-claims.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The scan parses every shipped source; generous for a loaded machine, so it
// stays a hang safety check rather than a speed assertion.
const SCAN_TIMEOUT_MS = 60_000;

const CORE_FILE = "packages/core/src/keyStore.ts";
const APP_FILE = "apps/cli/src/keyFile.ts";

// Every list empty, so a fixture is judged only by what it holds.
const NO_LISTS = { coreModules: [], nodeCryptoUses: [], encryptingModules: [] };

function violations(files, lists = NO_LISTS) {
  const readings = new Map(
    Object.entries(files).map(([path, source]) => [
      path,
      readFile(path, source),
    ]),
  );
  return violationsOf(readings, lists);
}

describe("the real tree", () => {
  it(
    "passes, over the shipped sources of core and both applications",
    () => {
      const { files, violations: found } = scanRepo(repoRoot);
      expect(found).toEqual([]);
      expect(files).toContain(
        "packages/core/src/connection/encryptedMessageConnection.ts",
      );
      expect(files).toContain("apps/cli/src/resultFile.ts");
      expect(files).toContain("apps/web/src/jobs/workdir.ts");
      expect(files).toContain("support/fips-probe/engagement.mjs");
    },
    SCAN_TIMEOUT_MS,
  );

  it("states a reason for every entry", () => {
    for (const entry of [
      ...CORE_MODULES,
      ...NODE_CRYPTO_USES,
      ...ENCRYPTING_MODULES,
    ]) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("cryptography in core is crypto.subtle", () => {
  it("fails a node:crypto import in core", () => {
    expect(
      violations({
        [CORE_FILE]: 'import { createHash } from "node:crypto";\n',
      }),
    ).toEqual([
      expect.stringContaining(
        `${CORE_FILE}:1: packages/core/src loads \`node:crypto\``,
      ),
      expect.stringContaining(`${CORE_FILE}:1: node:crypto \`createHash\``),
    ]);
  });

  it("fails a third-party cryptographic library in core", () => {
    expect(
      violations({
        [CORE_FILE]: 'import { sha256 } from "@noble/hashes/sha2";\n',
      }),
    ).toEqual([
      expect.stringContaining("loads `@noble/hashes/sha2`, which is not on"),
    ]);
  });

  it("fails a dynamic load, a require, and a builtin lookup of crypto in core", () => {
    const found = violations({
      [CORE_FILE]: [
        'const a = await import("node:crypto");',
        'const b = require("crypto");',
        'const c = process.getBuiltinModule("node:crypto");',
        'const d = module.require("node:crypto");',
        'const e = createRequire(import.meta.url)("node:crypto");',
      ].join("\n"),
    });
    for (const line of [1, 2, 3, 4, 5]) {
      expect(found).toContainEqual(
        expect.stringContaining(
          `${CORE_FILE}:${line}: packages/core/src loads`,
        ),
      );
      expect(found).toContainEqual(
        expect.stringContaining(`${CORE_FILE}:${line}: a dynamic load`),
      );
    }
  });

  it("fails a load whose module is not a literal", () => {
    expect(
      violations({ [APP_FILE]: "const m = await import(name);\n" }),
    ).toEqual([expect.stringContaining("is not a string literal")]);
  });

  it("passes a relative import and a listed package, and reports an unused entry", () => {
    const lists = {
      ...NO_LISTS,
      coreModules: [
        { module: "zod", reason: "schema validation" },
        { module: "yaml", reason: "YAML parsing" },
      ],
    };
    expect(
      violations(
        {
          [CORE_FILE]:
            'import { z } from "zod";\nimport { f } from "./utils/f";\n',
        },
        lists,
      ),
    ).toEqual([expect.stringContaining("CORE_MODULES lists `yaml`")]);
  });

  it("names the package of a scoped and a subpath specifier", () => {
    expect(packageOf("@openmined/psi.js/implementation/psi.d.ts")).toBe(
      "@openmined/psi.js",
    );
    expect(packageOf("yaml/util")).toBe("yaml");
    expect(packageOf("./x")).toBeUndefined();
  });
});

describe("node:crypto outside core names or identifies", () => {
  const lists = {
    ...NO_LISTS,
    nodeCryptoUses: [
      { file: APP_FILE, members: ["randomUUID"], reason: "a file name" },
    ],
  };

  it("passes a listed member, through a default import", () => {
    expect(
      violations(
        {
          [APP_FILE]:
            'import crypto from "node:crypto";\nconst n = crypto.randomUUID();\n',
        },
        lists,
      ),
    ).toEqual([]);
  });

  it("fails a cipher in a file that is not listed", () => {
    expect(
      violations({
        "apps/web/src/jobs/keyVault.ts":
          'import { createCipheriv } from "node:crypto";\n',
      }),
    ).toEqual([
      expect.stringContaining(
        "apps/web/src/jobs/keyVault.ts:1: node:crypto `createCipheriv` is not on NODE_CRYPTO_USES",
      ),
    ]);
  });

  it("fails an unlisted member of a listed file, through a namespace import", () => {
    expect(
      violations(
        {
          [APP_FILE]: [
            'import * as nodeCrypto from "node:crypto";',
            "const n = nodeCrypto.randomUUID();",
            'const c = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);',
          ].join("\n"),
        },
        lists,
      ),
    ).toEqual([
      expect.stringContaining(`${APP_FILE}:3: node:crypto \`createCipheriv\``),
    ]);
  });

  it("fails a use of the module it cannot name a member of", () => {
    expect(
      violations(
        {
          [APP_FILE]: [
            'import crypto from "node:crypto";',
            "const n = crypto.randomUUID();",
            "hand(crypto);",
            'export { createCipheriv } from "node:crypto";',
          ].join("\n"),
        },
        lists,
      ),
    ).toEqual([
      expect.stringContaining(`${APP_FILE}:4: a re-export of node:crypto`),
      expect.stringContaining(`${APP_FILE}:3: \`crypto\` used other than as`),
    ]);
  });

  it("reports a listed member the file no longer uses", () => {
    expect(
      violations({ [APP_FILE]: 'import crypto from "node:crypto";\n' }, lists),
    ).toEqual([
      expect.stringContaining(
        `NODE_CRYPTO_USES lists \`randomUUID\` for ${APP_FILE}`,
      ),
    ]);
  });
});

describe("nothing encrypts but the listed modules", () => {
  it("fails a crypto.subtle encryption in a module that writes a file", () => {
    expect(
      violations({
        [APP_FILE]: [
          "const sealed = await crypto.subtle.encrypt(",
          '  { name: "AES-GCM", iv },',
          "  key,",
          "  plaintext,",
          ");",
          "await writeFile(path, new Uint8Array(sealed));",
        ].join("\n"),
      }),
    ).toEqual([
      expect.stringContaining(
        `${APP_FILE}: 1 encrypting reference(s) where ENCRYPTING_MODULES lists 0 (\`encrypt\` at line 1)`,
      ),
    ]);
  });

  it("fails a wrap reached by element access or destructuring", () => {
    expect(
      violations({
        [CORE_FILE]: [
          'const wrapped = await globalThis.crypto.subtle["wrapKey"]("raw", k, w, "AES-KW");',
          "const { encrypt } = crypto.subtle;",
        ].join("\n"),
      }),
    ).toEqual([
      expect.stringContaining(
        "2 encrypting reference(s) where ENCRYPTING_MODULES lists 0 (`wrapKey` at line 1, `encrypt` at line 2)",
      ),
    ]);
  });

  it("fails a second encryption in a listed module", () => {
    const lists = {
      ...NO_LISTS,
      encryptingModules: [{ file: CORE_FILE, count: 1, reason: "transit" }],
    };
    expect(
      violations(
        {
          [CORE_FILE]:
            "await crypto.subtle.encrypt(a, k, p);\nawait crypto.subtle.encrypt(a, k, q);\n",
        },
        lists,
      ),
    ).toEqual([
      expect.stringContaining(
        "2 encrypting reference(s) where ENCRYPTING_MODULES lists 1",
      ),
    ]);
  });

  it("does not count a key-usage string or a decryption", () => {
    expect(
      violations({
        [CORE_FILE]:
          'await crypto.subtle.importKey("raw", b, "AES-GCM", false, ["encrypt", "decrypt"]);\nawait crypto.subtle.decrypt(a, k, c);\n',
      }),
    ).toEqual([]);
  });

  it("reports a listed module the scan did not read", () => {
    expect(
      violations(
        {},
        {
          ...NO_LISTS,
          encryptingModules: [{ file: CORE_FILE, count: 1, reason: "transit" }],
        },
      ),
    ).toEqual([
      expect.stringContaining(`ENCRYPTING_MODULES lists ${CORE_FILE}`),
    ]);
  });
});
