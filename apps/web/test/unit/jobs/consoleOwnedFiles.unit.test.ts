import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

import ts from "typescript";

import { afterEach, describe, expect, test } from "vitest";

import {
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";
import {
  consoleOwnedCredentialField,
  isConsoleOwnedFolderName,
} from "@jobs/consoleOwnedFiles";
import { JobApiConfigError } from "@jobs/gate";
import { SIGNING_IDENTITY_FILE_NAME } from "@jobs/intentSchemas";
import { validateAuthoredSftpServer } from "@jobs/sftpServer";

import {
  TEST_HOST_KEY_FINGERPRINT,
  trackScratchDirs,
} from "../../utils/jobFixtures";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Every fixed name the console resolves a file at in its working folder, read
 * off the source rather than kept here: each call of `resolveWorkdirFile` whose
 * first argument is a data root, and of every function that forwards one of
 * its own parameters to such a call, names the file by its second argument,
 * whose string literal type the TypeScript checker reports. An argument whose
 * type is not a string literal and which is not a forwarded parameter fails the
 * walk by name, so a new writer cannot drop out of it unseen. The walk covers
 * `src/jobs`, checked to be the only part of the app that imports `fs`; a file
 * written under some other first-argument name is outside it, which
 * {@link joinedWriteSites} narrows for a write call that joins its own path.
 */
function dataRootFileNames(): Array<string> {
  const configPath = path.join(webRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (file) =>
    fs.readFileSync(file, "utf8"),
  );
  const options = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    webRoot,
  ).options;
  const appSourceDir = path.join(webRoot, "src");
  const appSources = fs
    .readdirSync(appSourceDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
    .map((file) => path.join(appSourceDir, file));
  const sourceDir = path.join(appSourceDir, "jobs");
  expect(
    appSources.filter(
      (file) =>
        !file.startsWith(sourceDir + path.sep) &&
        /from "(node:)?fs(\/promises)?"/.test(fs.readFileSync(file, "utf8")),
    ),
    "only the console server's own modules write files",
  ).toEqual([]);
  const roots = appSources.filter((file) =>
    file.startsWith(sourceDir + path.sep),
  );
  const program = ts.createProgram(roots, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const sources = program
    .getSourceFiles()
    .filter((source) => source.fileName.startsWith(sourceDir));

  const forwarders = new Map<string, number>([["resolveWorkdirFile", 1]]);
  const names = new Set<string>();
  const failures: Array<string> = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const source of sources) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          forwarders.has(node.expression.text) &&
          node.arguments.length > 1 &&
          /(^|\.)dataRoot$/.test(node.arguments[0].getText(source))
        ) {
          const nameArgument =
            node.arguments[forwarders.get(node.expression.text)!];
          const type = checker.getTypeAtLocation(nameArgument);
          const members = type.isUnion() ? type.types : [type];
          if (members.every((member) => member.isStringLiteral())) {
            for (const member of members) names.add(member.value);
          } else {
            const enclosing = enclosingFunctionParameter(nameArgument);
            if (enclosing === undefined)
              failures.push(
                `${path.relative(webRoot, source.fileName)}: ${node.getText(source)}`,
              );
            else if (!forwarders.has(enclosing.functionName)) {
              forwarders.set(enclosing.functionName, enclosing.index);
              grew = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  expect(failures).toEqual([]);
  return [...names].sort();
}

/** The named function `node` is a parameter of, and that parameter's index,
 * when `node` is a bare reference to one. */
function enclosingFunctionParameter(
  node: ts.Node,
): { functionName: string; index: number } | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  let scope = node.parent as ts.Node | undefined;
  while (scope !== undefined && !ts.isFunctionDeclaration(scope))
    scope = scope.parent;
  if (scope === undefined || scope.name === undefined) return undefined;
  const index = scope.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === node.text,
  );
  return index < 0 ? undefined : { functionName: scope.name.text, index };
}

/**
 * Each function in `src/jobs` that passes a `path.join(...)` straight to a file
 * write, bypassing `resolveWorkdirFile`. The one expected is the sample-input
 * writer: its two fixed CSV names land on the data root when no input directory
 * is set, and are inputs the operator picks, not console-owned files. The walk
 * matches only the listed write calls made as property accesses with a direct
 * path.join argument: a path joined into a variable first, a copy, symlink or
 * mkdir, and a write through a named import are not caught.
 */
function joinedWriteSites(): Array<string> {
  const sourceDir = path.join(webRoot, "src", "jobs");
  const sites: Array<string> = [];
  for (const file of fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(sourceDir, file), "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const isJoin = (node: ts.Node | undefined): boolean =>
      node !== undefined &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "path.join";
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(writeFile|appendFile|copyFile|rename|open|createWriteStream)(Sync)?$/.test(
          node.expression.name.text,
        ) &&
        (isJoin(node.arguments[0]) || isJoin(node.arguments[1]))
      ) {
        let scope = node.parent as ts.Node | undefined;
        while (scope !== undefined && !ts.isFunctionDeclaration(scope))
          scope = scope.parent;
        sites.push(`${file}:${scope?.name?.text ?? "<top level>"}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort();
}

describe("the console-owned name set", () => {
  test("has the sample-input writer as the only write that joins its own path", () => {
    expect(joinedWriteSites()).toEqual(["sampleInputs.ts:writeSampleInputs"]);
    for (const name of [SAMPLE_INVITER_FILE_NAME, SAMPLE_PARTNER_FILE_NAME])
      expect(isConsoleOwnedFolderName(name)).toBe(false);
  });

  test(
    "holds every fixed name the console resolves a file at in its working folder",
    { timeout: 120_000 },
    () => {
      const names = dataRootFileNames();
      expect(names).toContain(SIGNING_IDENTITY_FILE_NAME);
      expect(names.filter((name) => !isConsoleOwnedFolderName(name))).toEqual(
        [],
      );
    },
  );
});

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  removeScratchDirs();
});

/** A data root and a secrets mount, each holding a signing identity at its
 * top, and an ordinary credential file outside both. */
function layout(): {
  dir: string;
  dataRoot: string;
  secretsDir: string;
  outside: string;
} {
  const dir = scratchDir("console-owned");
  const dataRoot = path.join(dir, "data-root");
  const secretsDir = path.join(dir, "secrets");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME), "PRIVATE");
  fs.writeFileSync(
    path.join(secretsDir, SIGNING_IDENTITY_FILE_NAME),
    "PRIVATE",
  );
  const outside = path.join(dir, "server-password");
  fs.writeFileSync(outside, "pw");
  return { dir, dataRoot, secretsDir, outside };
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JobApiConfigError);
    return error as Error;
  }
  throw new Error("expected a refusal");
}

function body(credential: unknown, extra: Record<string, unknown> = {}) {
  return {
    host: "sftp.partner.example",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential,
    ...extra,
  };
}

describe("validateAuthoredSftpServer refuses the console's own files as credentials", () => {
  test.each([
    ["password", "password"],
    ["private_key", "private key"],
  ] as const)(
    "a typed @path to the signing identity in the working folder is refused as a %s, naming the file and the remedy",
    (credType, label) => {
      const { dir, dataRoot, secretsDir } = layout();
      const error = refusal(() =>
        validateAuthoredSftpServer(
          body({
            kind: "ref",
            ref: `@${path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME)}`,
            credType,
          }),
          dataRoot,
          [],
          secretsDir,
        ),
      );
      expect(error.message).toContain("your signing identity");
      expect(error.message).toContain(
        `Choose the file that holds your SFTP ${label} instead.`,
      );
      expect(error.message).not.toContain(dir);
    },
  );

  test("a typed @path to the signing identity at the top of the secrets directory is refused", () => {
    const { dataRoot, secretsDir } = layout();
    const error = refusal(() =>
      validateAuthoredSftpServer(
        body({
          kind: "ref",
          ref: `@${path.join(secretsDir, SIGNING_IDENTITY_FILE_NAME)}`,
          credType: "password",
        }),
        dataRoot,
        [],
        secretsDir,
      ),
    );
    expect(error.message).toContain("your signing identity");
  });

  test("a typed @path through a link outside the mounts to the signing identity is refused", () => {
    const { dir, dataRoot } = layout();
    const link = path.join(dir, "innocent.txt");
    fs.symlinkSync(path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME), link);
    const error = refusal(() =>
      validateAuthoredSftpServer(
        body({ kind: "ref", ref: `@${link}`, credType: "password" }),
        dataRoot,
        [],
      ),
    );
    expect(error.message).toContain("your signing identity");
  });

  test("a passphrase @path to the exchange's key file is refused", () => {
    const { dataRoot, outside } = layout();
    fs.writeFileSync(path.join(dataRoot, ".alcove.key"), "secret");
    const error = refusal(() =>
      validateAuthoredSftpServer(
        body(
          { kind: "ref", ref: `@${outside}`, credType: "private_key" },
          { privateKeyPassphrase: `@${path.join(dataRoot, ".alcove.key")}` },
        ),
        dataRoot,
        [],
      ),
    );
    expect(error.message).toContain("the exchange's key file");
    expect(error.message).toContain("SFTP private key passphrase");
  });

  test.each(["folder", "secrets"] as const)(
    "a %s locator naming the signing identity is refused",
    (mount) => {
      const { dir, dataRoot, secretsDir } = layout();
      const error = refusal(() =>
        validateAuthoredSftpServer(
          body({
            kind: "mountRef",
            mount,
            subPath: [SIGNING_IDENTITY_FILE_NAME],
            credType: "password",
          }),
          dataRoot,
          [],
          secretsDir,
        ),
      );
      expect(error.message).toContain("your signing identity");
      expect(error.message).not.toContain(dir);
    },
  );

  test("a file named like a console file below the top of the secrets directory is accepted", () => {
    const { dataRoot, secretsDir } = layout();
    fs.mkdirSync(path.join(secretsDir, "sftp"));
    fs.writeFileSync(path.join(secretsDir, "sftp", "alcove.yaml"), "pw");
    const { entry } = validateAuthoredSftpServer(
      body({
        kind: "mountRef",
        mount: "secrets",
        subPath: ["sftp", "alcove.yaml"],
        credType: "password",
      }),
      dataRoot,
      [],
      secretsDir,
    );
    expect(entry.password).toBe(
      `@${fs.realpathSync(path.join(secretsDir, "sftp", "alcove.yaml"))}`,
    );
  });

  test("a file at the top of the secrets directory named like a job folder is accepted", () => {
    const { dataRoot, secretsDir } = layout();
    const name = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
    fs.writeFileSync(path.join(secretsDir, name), "pw");
    const { entry } = validateAuthoredSftpServer(
      body({
        kind: "mountRef",
        mount: "secrets",
        subPath: [name],
        credType: "password",
      }),
      dataRoot,
      [],
      secretsDir,
    );
    expect(entry.password).toBe(
      `@${fs.realpathSync(path.join(secretsDir, name))}`,
    );
  });
});

/** A document with the signing identity's structure; the values are
 * placeholders, since only the keys are matched. */
const IDENTITY_SHAPED = JSON.stringify({
  version: "v",
  privateKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
  certificate: { identity: "Agency A" },
});

describe("validateAuthoredSftpServer refuses a file holding a signing identity by its content", () => {
  test.each(["password", "private_key"] as const)(
    "an identity under another name in the secrets directory is refused as a %s",
    (credType) => {
      const { dir, dataRoot, secretsDir } = layout();
      fs.mkdirSync(path.join(secretsDir, "keys"));
      fs.writeFileSync(
        path.join(secretsDir, "keys", "my-identity.json"),
        IDENTITY_SHAPED,
      );
      for (const credential of [
        {
          kind: "ref",
          ref: `@${path.join(secretsDir, "keys", "my-identity.json")}`,
          credType,
        },
        {
          kind: "mountRef",
          mount: "secrets",
          subPath: ["keys", "my-identity.json"],
          credType,
        },
      ]) {
        const error = refusal(() =>
          validateAuthoredSftpServer(
            body(credential),
            dataRoot,
            [],
            secretsDir,
          ),
        );
        expect(error.message).toContain("your signing identity");
        expect(error.message).not.toContain(dir);
        expect(error.message).not.toContain("Agency A");
      }
    },
  );

  test("a hard link to the default identity is refused", () => {
    const { dir, dataRoot } = layout();
    const identity = path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME);
    fs.writeFileSync(identity, IDENTITY_SHAPED);
    const hardLink = path.join(dir, "server-key");
    fs.linkSync(identity, hardLink);
    const error = refusal(() =>
      validateAuthoredSftpServer(
        body({ kind: "ref", ref: `@${hardLink}`, credType: "private_key" }),
        dataRoot,
        [],
      ),
    );
    expect(error.message).toContain("your signing identity");
  });

  test.each([
    [
      "an ordinary private key file",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
      "private_key",
    ],
    [
      "a password file whose text starts with a brace",
      '{"privateKey": {"d": 1}}',
      "password",
    ],
    ["a password file that is not JSON", "{not json", "password"],
  ] as const)("%s is accepted", (_label, content, credType) => {
    const { dir, dataRoot, secretsDir } = layout();
    const file = path.join(dir, "credential");
    fs.writeFileSync(file, content);
    const { entry } = validateAuthoredSftpServer(
      body({ kind: "ref", ref: `@${file}`, credType }),
      dataRoot,
      [],
      secretsDir,
    );
    expect(entry[credType === "password" ? "password" : "privateKey"]).toBe(
      `@${file}`,
    );
  });
});

describe("consoleOwnedCredentialField", () => {
  test("names the field whose file is a signing identity it is given, through a link", () => {
    const { dir, dataRoot } = layout();
    const picked = path.join(dir, "keys", "identity.json");
    fs.mkdirSync(path.dirname(picked));
    fs.writeFileSync(picked, "PRIVATE");
    const link = path.join(dir, "pw-link");
    fs.symlinkSync(picked, link);
    expect(
      consoleOwnedCredentialField(
        {
          password: `@${path.join(dir, "server-password")}`,
          privateKey: `@${link}`,
        },
        { folder: dataRoot },
        [picked],
      ),
    ).toEqual({ field: "privateKey", ownedName: SIGNING_IDENTITY_FILE_NAME });
  });

  test("does not match an ordinary credential file", () => {
    const { dataRoot, secretsDir, outside } = layout();
    expect(
      consoleOwnedCredentialField(
        { password: `@${outside}`, privateKeyPassphrase: "inline" },
        { folder: dataRoot, secrets: secretsDir },
        [path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME)],
      ),
    ).toBeUndefined();
  });
});
