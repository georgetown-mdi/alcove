import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, test } from "vitest";

import {
  PartnerProtocolRefusalError,
  ProtocolRefusalError,
} from "../src/errors";
import { isPartnerProtocolRefusal } from "../src/failureClass";
import { TermsChangeRefusedError } from "../src/protocolSetup";

// Every construction of a ProtocolRefusalError or a subclass, keyed by file and
// enclosing function, with the class each one raises. The class is the
// classification: only a PartnerProtocolRefusalError reads as this party's
// refusal of what the partner sent. A site added later fails this test until it
// is entered here with the class it chose.
//
// What the scan reaches: the source trees below, parsed syntactically. A member
// class is ProtocolRefusalError or a class written `extends <member>`, matched
// by name; a site is a `new <member>(...)` written with that name. A member
// declared elsewhere, or constructed through an alias, is not seen.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_TREES = ["packages/core/src", "apps/cli/src", "apps/web/src"];

const PARTNER = "PartnerProtocolRefusalError";
const PLAIN = "ProtocolRefusalError";
const TERMS_CHANGE = "TermsChangeRefusedError";

// Constructions under one anchor are listed in source order.
const RECORDED_SITES: Readonly<Record<string, readonly string[]>> = {
  // The partner's envelope version byte is not this build's.
  "packages/core/src/connection/fileSyncMessageLoop.ts :: FileSyncMessageLoop.poll > parseMessage":
    [PARTNER],
  // The partner's payload frame: not arrays, wrong cell shape, lengths that
  // disagree, repeated indices, rows missing.
  "packages/core/src/payloadExchange.ts :: buildOutputTable": [
    PARTNER,
    PARTNER,
    PARTNER,
    PARTNER,
    PARTNER,
    PARTNER,
    PARTNER,
    PARTNER,
  ],
  // The partner's terms frame omits the record count, then the receive
  // ceiling; then the partner's terms fail to parse, on the initiator and the
  // responder path. A parse failure can be a newer build's terms read by an
  // older one, so it is not marked as the partner's.
  "packages/core/src/protocolSetup.ts :: exchangeTerms": [
    PARTNER,
    PARTNER,
    PLAIN,
    PLAIN,
  ],
  // The partner's own abort at the terms exchange.
  "packages/core/src/protocolSetup.ts :: partnerAbortError": [PLAIN, PLAIN],
  // The partner advertises another protocol version.
  "packages/core/src/protocolSetup.ts :: reconcileProtocolVersion": [PARTNER],
  // This party does not take on the partner's changed terms.
  "packages/core/src/protocolSetup.ts :: settleTermsChange > refuse": [
    TERMS_CHANGE,
  ],
  "apps/web/src/psi/managed/managedTermsProposal.ts :: managedTermsChangeHandler":
    [TERMS_CHANGE, TERMS_CHANGE],
  // The partner's single-pass reply frame cannot be read.
  "packages/core/src/psi/link.ts :: decodeInt32LE": [PARTNER],
  "packages/core/src/psi/link.ts :: decodeSinglePassReply": [PARTNER, PARTNER],
  "packages/core/src/psi/link.ts :: decodeSinglePassReply > readSlice": [
    PARTNER,
    PARTNER,
  ],
  // The partner's PSI frames: unreadable, over the ceiling, a response with no
  // request, or larger than the request.
  "packages/core/src/psi/participant.ts :: PSIParticipant.assertResponseWithinRequest":
    [PARTNER],
  "packages/core/src/psi/participant.ts :: PSIParticipant.assertScanWithinCeiling":
    [PARTNER, PARTNER],
  "packages/core/src/psi/participant.ts :: PSIParticipant.requestAnswered": [
    PARTNER,
  ],
  "packages/core/src/psi/psiEngine.ts :: InProcessPsiEngine.matchStreamed": [
    PARTNER,
  ],
  // The partner's PSI setup is not Raw, or not in ascending order.
  "packages/core/src/psi/psiWasmBudget.ts :: setupNotRawError": [PARTNER],
  "packages/core/src/psi/psiWasmBudget.ts :: setupNotStrictlyAscendingError": [
    PARTNER,
  ],
  // A part of the partner's PSI set breaks the part sequence.
  "packages/core/src/psi/psiSetParts.ts :: receivePsiSetInPieces > refuse": [
    PARTNER,
  ],
  // A worker's refusal rebuilt as the class it was.
  "packages/core/src/psi/psiWorkerEngine.ts :: rebuildWorkerFailure": [
    PARTNER,
    PLAIN,
  ],
};

// Each member class the scan finds, constructed bare, so the predicate is read
// off the class itself.
const MEMBER_CLASSES: Readonly<Record<string, { prototype: object }>> = {
  [PLAIN]: ProtocolRefusalError,
  [PARTNER]: PartnerProtocolRefusalError,
  [TERMS_CHANGE]: TermsChangeRefusedError,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

const parsed = SOURCE_TREES.flatMap((tree) =>
  sourceFiles(join(ROOT, tree)),
).map((path) => ({
  file: relative(ROOT, path).split(/[\\/]/).join(posix.sep),
  source: ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  ),
}));

function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    forEachNode(child, visit);
  });
}

function memberClasses(): Set<string> {
  const extendsOf = new Map<string, string[]>();
  for (const { file, source } of parsed)
    forEachNode(source, (node) => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) return;
      const base = node.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types[0]?.expression;
      if (base === undefined || !ts.isIdentifier(base)) return;
      const name = node.name.text;
      extendsOf.set(name, [
        ...(extendsOf.get(name) ?? []),
        `${base.text} in ${file}`,
      ]);
    });
  const members = new Set([PLAIN]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, bases] of extendsOf)
      if (
        !members.has(name) &&
        bases.some((base) => members.has(base.split(" in ")[0]))
      ) {
        expect(bases, `${name} is declared more than once`).toHaveLength(1);
        members.add(name);
        grew = true;
      }
  }
  return members;
}

function anchorOf(node: ts.Node): string {
  const names: string[] = [];
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name !== undefined)
      names.unshift(at.name.text);
    else if (
      (ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at)) &&
      ts.isClassLike(at.parent)
    )
      names.unshift(
        `${at.parent.name?.text ?? "class"}.${
          ts.isConstructorDeclaration(at)
            ? "constructor"
            : at.name.getText(at.getSourceFile())
        }`,
      );
    else if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      (ts.isArrowFunction(at.initializer) ||
        ts.isFunctionExpression(at.initializer))
    )
      names.unshift(at.name.text);
  }
  return names.join(" > ") || "(module)";
}

function scannedSites(members: Set<string>): Record<string, string[]> {
  const sites: Record<string, string[]> = {};
  for (const { file, source } of parsed)
    forEachNode(source, (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        members.has(node.expression.text)
      )
        (sites[`${file} :: ${anchorOf(node)}`] ??= []).push(
          node.expression.text,
        );
    });
  return sites;
}

test("every protocol refusal site is recorded with the class it raises", () => {
  const members = memberClasses();
  expect([...members].sort()).toEqual(Object.keys(MEMBER_CLASSES).sort());
  expect(scannedSites(members)).toEqual(RECORDED_SITES);
});

test("only a partner protocol refusal reads as one", () => {
  for (const [name, memberClass] of Object.entries(MEMBER_CLASSES))
    expect(
      isPartnerProtocolRefusal(Object.create(memberClass.prototype)),
      name,
    ).toBe(name === PARTNER);
});
