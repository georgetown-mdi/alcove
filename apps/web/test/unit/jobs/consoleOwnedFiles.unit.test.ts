import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

import ts from "typescript";

import { afterEach, describe, expect, test } from "vitest";

import {
  isConsoleFileCredential,
  isConsoleOwnedFolderName,
} from "@jobs/consoleOwnedFiles";
import { JobApiConfigError } from "@jobs/gate";
import { SIGNING_IDENTITY_FILE_NAME } from "@jobs/signingIdentity";
import { validateAuthoredSftpServer } from "@jobs/sftpServer";

import {
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
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
 * written under some other first-argument name is outside it.
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
            for (const member of members)
              names.add((member as ts.StringLiteralType).value);
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
  let scope: ts.Node | undefined = node.parent;
  while (scope !== undefined && !ts.isFunctionDeclaration(scope))
    scope = scope.parent;
  if (scope === undefined || scope.name === undefined) return undefined;
  const index = scope.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === node.text,
  );
  return index < 0 ? undefined : { functionName: scope.name.text, index };
}

describe("the console-owned name set", () => {
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

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A data root and a secrets mount, each holding a signing identity at its
 * top, and an ordinary credential file outside both. */
function layout(): {
  dir: string;
  dataRoot: string;
  secretsDir: string;
  outside: string;
} {
  const dir = tempDataRoot("console-owned");
  dirs.push(dir);
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
});

describe("isConsoleFileCredential", () => {
  test("matches a signing identity it is given, through a link", () => {
    const { dir, dataRoot } = layout();
    const picked = path.join(dir, "keys", "identity.json");
    fs.mkdirSync(path.dirname(picked));
    fs.writeFileSync(picked, "PRIVATE");
    const link = path.join(dir, "pw-link");
    fs.symlinkSync(picked, link);
    expect(isConsoleFileCredential(link, { folder: dataRoot }, [picked])).toBe(
      true,
    );
  });

  test("does not match an ordinary credential file", () => {
    const { dataRoot, secretsDir, outside } = layout();
    expect(
      isConsoleFileCredential(
        outside,
        { folder: dataRoot, secrets: secretsDir },
        [path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME)],
      ),
    ).toBe(false);
  });
});
