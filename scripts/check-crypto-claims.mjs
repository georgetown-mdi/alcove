#!/usr/bin/env node
// Cryptographic-call guard: `npm run check:crypto-claims`.
// Holds two docs/COMPLIANCE.md claims against first-party drift: the parties'
// protocol code makes its cryptographic operations through `crypto.subtle`
// (the SC-13 row), and Alcove encrypts nothing on disk (the SC-28 row).
//
// Reads every JavaScript-family file under the egress check's shipped-source
// roots and files, and fails (exit 1) on any of:
//   - a module packages/core/src loads that is neither relative nor on
//     CORE_MODULES; no `node:` builtin is on it, and the PSI engine is its one
//     cryptographic entry;
//   - a `node:crypto` member used anywhere else that NODE_CRYPTO_USES does not
//     list for that file, or a use of the module the check cannot name a
//     member of (a re-export, a dynamic load, the binding passed as a value);
//   - an `encrypt` or `wrapKey` reference outside ENCRYPTING_MODULES, or a
//     count of them in a listed module other than the one it states;
//   - a load whose module is not a string literal;
//   - an entry on any of the three lists that nothing uses.
//
// Syntactic and single-file. It does not see a primitive written out in
// JavaScript, encryption a third-party library performs on an application's
// behalf (the SSH and WebRTC stacks do, in transit), or a call reached through
// a computed name. Those limits are published beside the claims it holds.
// Rationale: docs/notes/repo-check-scripts.md, Cryptographic-call claims.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  SCANNED_FILES,
  SCANNED_ROOTS,
  isJavaScriptFamily,
} from "./lib/shippedSources.mjs";
import { lineOf } from "./lib/text.mjs";
import {
  descendants,
  filesUnder,
  parseSource,
} from "./lib/typeScriptSources.mjs";

/** The tree holding the parties' protocol code, held to CORE_MODULES. */
export const CORE_ROOT = "packages/core/src";

/** The packages packages/core/src may load, each with why it is not a cryptographic library the claim would have to name. */
export const CORE_MODULES = [
  {
    module: "@openmined/psi.js",
    reason:
      "the PSI engine, whose masking runs in BoringSSL outside crypto.subtle; COMPLIANCE.md states that and keeps the PSI out of the claim",
  },
  { module: "canonicalize", reason: "JSON canonicalization (RFC 8785)" },
  { module: "eventemitter3", reason: "event dispatch" },
  { module: "loglevel", reason: "logging" },
  { module: "papaparse", reason: "CSV parsing" },
  {
    module: "peerjs-js-binarypack",
    reason: "binary serialization of WebRTC frames",
  },
  { module: "re2js", reason: "linear-time regular expressions" },
  {
    module: "uuid",
    reason:
      "file and marker names on a shared folder: identifiers, not a cryptographic operation",
  },
  { module: "yaml", reason: "YAML parsing" },
  { module: "zod", reason: "schema validation" },
];

/**
 * The `node:crypto` members shipped source outside core uses, per file, each
 * with why it is not one of the operations the claims are about.
 */
export const NODE_CRYPTO_USES = [
  {
    file: "apps/cli/src/connection/sftpKexCapability.ts",
    members: ["generateKeyPairSync"],
    reason:
      "probes whether the runtime offers X25519 before the SSH key exchange is narrowed; the key pair is discarded",
  },
  {
    file: "apps/cli/src/connection/webrtc/brokerClient.ts",
    members: ["randomBytes"],
    reason:
      "the broker registration token COMPLIANCE.md's inventory names in its note on random values",
  },
  {
    file: "apps/cli/src/doctor/probe.ts",
    members: ["randomBytes"],
    reason: "a unique name for the doctor's probe file",
  },
  {
    file: "apps/cli/src/exchangeDisclosure.ts",
    members: ["createHash"],
    reason:
      "a digest of the disclosure display, which names local state; the inventory's note on digests outside core",
  },
  {
    file: "apps/cli/src/keyFilePreflight.ts",
    members: ["randomUUID"],
    reason: "a unique name for a write probe file",
  },
  {
    file: "apps/cli/src/protocol.ts",
    members: ["getFips"],
    reason: "reads whether the runtime is in FIPS mode; no operation",
  },
  {
    file: "apps/cli/src/resultFile.ts",
    members: ["randomUUID"],
    reason: "a unique name for a write probe file",
  },
  {
    file: "apps/web/src/jobs/configHandBack.ts",
    members: ["randomUUID"],
    reason: "a unique temporary file name",
  },
  {
    file: "apps/web/src/jobs/relayCheck.ts",
    members: ["createHash"],
    reason: "a digest naming the configuration a relay check ran against",
  },
  {
    file: "apps/web/src/jobs/sftpScratch.ts",
    members: ["randomUUID"],
    reason: "a unique scratch file name",
  },
  {
    file: "apps/web/src/jobs/termsProposal.ts",
    members: ["createHash"],
    reason: "a digest naming the terms proposal file a run stated",
  },
  {
    file: "apps/web/src/jobs/workdir.ts",
    members: ["randomUUID"],
    reason: "a unique job directory name",
  },
  {
    file: "apps/web/src/jobs/workingFolderExchangeFiles.ts",
    members: ["createHash"],
    reason:
      "digests naming an invitation and a file's contents in the console's local state",
  },
  {
    file: "packages/peerjs-broker/src/contrib/models/realm.ts",
    members: ["randomUUID"],
    reason: "the broker's client ids",
  },
  {
    file: "support/fips-probe/engagement.mjs",
    members: ["createHash", "getFips"],
    reason:
      "the FIPS image's start-up probe: an MD5 digest it expects a FIPS provider to refuse, and the FIPS-mode reading it records",
  },
];

/**
 * The modules that encrypt, each with how many `encrypt` and `wrapKey`
 * references it holds. Each encrypts for transit or in memory, never for a
 * file it writes.
 */
export const ENCRYPTING_MODULES = [
  {
    file: "packages/core/src/connection/encryptedMessageConnection.ts",
    count: 1,
    reason: "the application-layer AEAD over every frame sent to the partner",
  },
  {
    file: "packages/core/src/connection/chunkedAead.ts",
    count: 1,
    reason: "the same AEAD's chunked envelope, version 2",
  },
  {
    file: "packages/core/src/nextSecret.ts",
    count: 1,
    reason:
      "the AES-KW wrap of this party's rotation value, sent to the partner in a key-exchange or terms message",
  },
  {
    file: "support/fips-probe/engagement.mjs",
    count: 2,
    reason:
      "the FIPS image's start-up probe: an AES-GCM and an AES-KW round trip in memory, whose output is compared and dropped",
  },
];

const NODE_CRYPTO = new Set(["crypto", "node:crypto"]);
const ENCRYPTING_NAMES = new Set(["encrypt", "wrapKey"]);

/** The package a bare specifier names, or undefined for a relative one. */
export function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function stringArgument(call) {
  const [first] = call.arguments;
  return first !== undefined && ts.isStringLiteralLike(first)
    ? first.text
    : undefined;
}

function isRequireCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (ts.isPropertyAccessExpression(callee))
    return (
      callee.name.text === "getBuiltinModule" || callee.name.text === "require"
    );
  return (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "createRequire"
  );
}

/** The name `node` refers to an encrypting call by, if it does. */
function encryptingName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const named = node.propertyName ?? node.name;
    return ts.isIdentifier(named) || ts.isStringLiteralLike(named)
      ? named.text
      : undefined;
  }
  return undefined;
}

/**
 * What one file's source holds that the check reads: the modules it loads,
 * the `node:crypto` members it uses, the `node:crypto` uses no member can be
 * named for, and its encrypting references. Each item has its `line`.
 */
export function readFile(path, source) {
  const parsed = parseSource(path, source);
  const at = (node) => lineOf(source, node.getStart(parsed));
  const loads = [];
  const nodeCryptoMembers = [];
  const unreadable = [];
  const encrypting = [];
  const cryptoBindings = new Set();

  for (const node of descendants(parsed)) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      const specifier = node.moduleSpecifier.text;
      loads.push({ specifier, line: at(node) });
      if (!NODE_CRYPTO.has(specifier)) continue;
      const clause = ts.isImportDeclaration(node)
        ? node.importClause
        : undefined;
      if (ts.isExportDeclaration(node)) {
        unreadable.push({ line: at(node), what: "a re-export" });
        continue;
      }
      if (clause?.name) cryptoBindings.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        cryptoBindings.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          nodeCryptoMembers.push({
            member: (element.propertyName ?? element.name).text,
            line: at(element),
          });
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      const specifier = ts.isStringLiteralLike(expression)
        ? expression.text
        : undefined;
      loads.push({ specifier, line: at(node) });
      if (NODE_CRYPTO.has(specifier))
        unreadable.push({ line: at(node), what: "an import-equals load" });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isRequireCall(node))
    ) {
      const specifier = stringArgument(node);
      loads.push({ specifier, line: at(node) });
      if (NODE_CRYPTO.has(specifier))
        unreadable.push({ line: at(node), what: "a dynamic load" });
    }

    const name = encryptingName(node);
    if (name !== undefined && ENCRYPTING_NAMES.has(name))
      encrypting.push({ name, line: at(node) });
  }

  for (const node of descendants(parsed)) {
    if (!ts.isIdentifier(node) || !cryptoBindings.has(node.text)) continue;
    const parent = node.parent;
    if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      nodeCryptoMembers.push({ member: parent.name.text, line: at(node) });
      continue;
    }
    unreadable.push({
      line: at(node),
      what: `\`${node.text}\` used other than as \`${node.text}.<member>\``,
    });
  }

  return { loads, nodeCryptoMembers, unreadable, encrypting };
}

/** Whether `path` is under the core tree. */
export function isCore(path) {
  return path.startsWith(`${CORE_ROOT}/`);
}

/**
 * Every violation across `readings`, a map from repository-relative path to
 * what {@link readFile} returned for it, as strings naming file and line. The
 * lists default to this file's own; a test passes others.
 */
export function violationsOf(
  readings,
  {
    coreModules = CORE_MODULES,
    nodeCryptoUses = NODE_CRYPTO_USES,
    encryptingModules = ENCRYPTING_MODULES,
  } = {},
) {
  const violations = [];
  const coreAllowed = new Set(coreModules.map((entry) => entry.module));
  const coreUsed = new Set();
  const usesByFile = new Map(
    nodeCryptoUses.map((entry) => [entry.file, new Set(entry.members)]),
  );
  const membersUsed = new Map();
  const countsByFile = new Map(
    encryptingModules.map((entry) => [entry.file, entry.count]),
  );

  for (const [path, reading] of readings) {
    for (const { specifier, line } of reading.loads) {
      if (specifier === undefined) {
        violations.push(
          `${path}:${line}: a module load whose module is not a string literal, which this check cannot read`,
        );
        continue;
      }
      if (!isCore(path)) continue;
      const name = packageOf(specifier);
      if (name === undefined) continue;
      if (coreAllowed.has(name)) {
        coreUsed.add(name);
        continue;
      }
      violations.push(
        `${path}:${line}: packages/core/src loads \`${specifier}\`, which is not on CORE_MODULES -- COMPLIANCE.md states every cryptographic operation of the protocol is a crypto.subtle call`,
      );
    }

    for (const { line, what } of reading.unreadable) {
      violations.push(
        `${path}:${line}: ${what} of node:crypto, whose members this check cannot name`,
      );
    }

    for (const { member, line } of reading.nodeCryptoMembers) {
      const allowed = usesByFile.get(path);
      if (isCore(path) || allowed === undefined || !allowed.has(member)) {
        violations.push(
          `${path}:${line}: node:crypto \`${member}\` is not on NODE_CRYPTO_USES for this file -- COMPLIANCE.md states the protocol's cryptography is crypto.subtle and that Alcove encrypts nothing on disk`,
        );
        continue;
      }
      if (!membersUsed.has(path)) membersUsed.set(path, new Set());
      membersUsed.get(path).add(member);
    }

    const expected = countsByFile.get(path) ?? 0;
    if (reading.encrypting.length !== expected) {
      const where = reading.encrypting.map(
        ({ name, line }) => `\`${name}\` at line ${line}`,
      );
      violations.push(
        `${path}: ${reading.encrypting.length} encrypting reference(s) where ENCRYPTING_MODULES lists ${expected}${where.length > 0 ? ` (${where.join(", ")})` : ""} -- COMPLIANCE.md states Alcove encrypts nothing on disk`,
      );
    }
  }

  for (const entry of coreModules) {
    if (!coreUsed.has(entry.module))
      violations.push(
        `CORE_MODULES lists \`${entry.module}\`, which packages/core/src does not load; delete the entry`,
      );
  }
  for (const entry of nodeCryptoUses) {
    for (const member of entry.members) {
      if (!membersUsed.get(entry.file)?.has(member))
        violations.push(
          `NODE_CRYPTO_USES lists \`${member}\` for ${entry.file}, which that file does not use; delete it`,
        );
    }
  }
  for (const entry of encryptingModules) {
    if (!readings.has(entry.file))
      violations.push(
        `ENCRYPTING_MODULES lists ${entry.file}, which is not among the files read; point the entry at the module that encrypts`,
      );
  }
  return violations;
}

/** The repository-relative files the check reads, sorted. */
export function scannedFiles() {
  const files = new Set();
  for (const root of SCANNED_ROOTS) {
    for (const file of filesUnder(root)) files.add(file);
  }
  for (const file of SCANNED_FILES) files.add(file);
  return [...files].filter(isJavaScriptFamily).sort();
}

/** Read the repository's shipped source and return the files read and what failed. */
export function scanRepo(root) {
  const files = scannedFiles();
  const readings = new Map(
    files.map((file) => [
      file,
      readFile(file, readFileSync(resolve(root, file), "utf8")),
    ]),
  );
  return { files, violations: violationsOf(readings) };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, violations } = scanRepo(root);
  if (violations.length > 0) {
    console.error(
      `Cryptographic-call claim check failed (${violations.length}):\n`,
    );
    for (const v of violations) console.error("  " + v);
    console.error(
      "\nCOMPLIANCE.md tells agency reviewers that the protocol's cryptography is made of crypto.subtle calls and that Alcove encrypts nothing on disk. If the change makes either false, the document has to change with it. If it does not -- a load that is no cryptographic library, a node:crypto use that names or identifies rather than protects, an encryption for transit -- add the entry with its reason to the list in scripts/check-crypto-claims.mjs the message names.",
    );
    process.exit(1);
  }
  console.log(
    `Cryptographic-call claim check passed: ${files.length} shipped-source files; core loads only the ${CORE_MODULES.length} listed packages, node:crypto is used only as the ${NODE_CRYPTO_USES.length} listed files state, and only the ${ENCRYPTING_MODULES.length} listed modules encrypt.`,
  );
}
