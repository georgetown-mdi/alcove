#!/usr/bin/env node
// Init-template coverage check, run by static_checks.yaml.
//
// docs/CLI.md (Initialization) and the template's header claim that the file
// `alcove init` writes documents each configuration option inline. Both drift
// when a field is added to the exchange schema without a template line, so
// this check compares two sets of key paths: the schema core exports
// (ExchangeSpecSchema) and the keys of the two templates `renderConfigTemplate`
// writes without an input file (sftp default and filedrop directory), read from
// their rendered text, active or in a commented-out example. It fails naming
//
//   - a schema option no template documents, unless ALLOWED_OMISSIONS lists it
//     (or a path above it) with the reason it stays out,
//   - a template key the schema does not define, since an operator who
//     uncomments it gets a refused setting, and
//   - an ALLOWED_OMISSIONS entry the template documents or the schema lacks.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SPLIT_DIRECTORY =
  "A split-directory deployment, which also needs retain_files; alcove accept adopts the pair from the invitation.";

/**
 * Schema options the template leaves out, each with the reason. An entry
 * covers the paths under it.
 */
export const ALLOWED_OMISSIONS = new Map([
  [
    "authentication.shared_secret",
    "Read from the key file at run time; alcove.yaml never holds it.",
  ],
  [
    "authentication.expires",
    "Read from the key file at run time; alcove.yaml never holds it.",
  ],
  [
    "connection.server.certificate",
    "Refused when the configuration loads: SSH client certificates are not supported.",
  ],
  [
    "connection.server.known_hosts",
    "Refused when the configuration loads: a known_hosts file is not supported; host_key_fingerprint pins the host key.",
  ],
  [
    "connection.proxy",
    "No Alcove client reads it: the CLI opens the SFTP connection itself.",
  ],
  [
    "connection.provider_options",
    "An allowlisted map of SSH library settings for a server that needs one; the reference documents the keys it admits.",
  ],
  [
    "connection.server.provision",
    "On-demand provisioning against a deployment's own endpoint, set up from that deployment's instructions and the reference.",
  ],
  [
    "connection.ice_provision",
    "A commercial ICE credential service, set up from that service's details and the reference.",
  ],
  [
    "connection.relay_registrar",
    "Only for a relay running the reference registrar; infra/relay/README.md sets it up.",
  ],
  [
    "connection.invitation_relay",
    "Written by alcove accept from the invitation; not authored by hand.",
  ],
  ["connection.inbound_path", SPLIT_DIRECTORY],
  ["connection.outbound_path", SPLIT_DIRECTORY],
  ["connection.server.inbound_path", SPLIT_DIRECTORY],
  ["connection.server.outbound_path", SPLIT_DIRECTORY],
  [
    "connection.options.connection_per_poll",
    "A remedy for an SFTP server that caps session length; the failure that calls for it names the setting.",
  ],
  [
    "linkage_terms.linkage_keys.elements.name",
    "A key-element option the built-in keys the template writes do not use.",
  ],
  [
    "linkage_terms.linkage_keys.elements.generate_fuzzy_comparisons",
    "A key-element option the built-in keys the template writes do not use.",
  ],
  [
    "linkage_terms.payload",
    "Derived from the metadata block's is_payload columns when init reads an input file, and the receive list is set by the first exchange, which the template states.",
  ],
]);

/** camelCase schema key -> the snake_case key an operator writes. */
export function snakeKey(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "nonoptional",
  "catch",
  "success",
]);

const LEAVES = new Set([
  "string",
  "number",
  "int",
  "bigint",
  "boolean",
  "date",
  "enum",
  "literal",
  "unknown",
  "any",
  "never",
  "transform",
  "custom",
  "null",
  "undefined",
]);

/**
 * Every key path a zod (v4) schema defines, and the paths under which a record
 * admits free keys. A key path is the dotted snake_case path of a mapping key
 * with array levels dropped: `linkage_terms.linkage_keys.elements.field` names
 * the `field` of any element of any key. A path under a record (a map with free
 * keys, such as a transform step's `params`) ends at the record, and a template
 * key under one is accepted as it stands. Walks the schema's own definitions (`_zod.def`), both sides
 * of a pipe, so a bounded or transformed array still yields its element's keys.
 *
 * @throws {Error} on a schema node of a type this walk does not know, so a new
 *   zod construct cannot hide a subtree.
 */
export function schemaKeyPaths(schema) {
  const paths = new Set();
  const records = new Set();
  const visit = (node, prefix, active) => {
    const def = node._zod.def;
    if (WRAPPERS.has(def.type)) return visit(def.innerType, prefix, active);
    if (LEAVES.has(def.type)) return;
    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries(def.shape)) {
          const path =
            prefix === "" ? snakeKey(key) : `${prefix}.${snakeKey(key)}`;
          paths.add(path);
          if (!active.has(child))
            visit(child, path, new Set([...active, child]));
        }
        if (
          def.catchall !== undefined &&
          def.catchall._zod.def.type !== "never"
        )
          records.add(prefix);
        return;
      case "record":
        records.add(prefix);
        return;
      case "array":
        return visit(def.element, prefix, active);
      case "tuple":
        for (const item of def.items) visit(item, prefix, active);
        if (def.rest) visit(def.rest, prefix, active);
        return;
      case "union":
        for (const option of def.options) visit(option, prefix, active);
        return;
      case "intersection":
        visit(def.left, prefix, active);
        visit(def.right, prefix, active);
        return;
      case "pipe":
        visit(def.in, prefix, active);
        visit(def.out, prefix, active);
        return;
      case "lazy": {
        const inner = def.getter();
        if (!active.has(inner))
          visit(inner, prefix, new Set([...active, inner]));
        return;
      }
      default:
        throw new Error(
          `schema node of type "${def.type}" at "${prefix || "(root)"}" is not one this check walks; add it to schemaKeyPaths`,
        );
    }
  };
  visit(schema, "", new Set());
  return { paths, records };
}

const KEY_LINE = /^(\s*)(?:- )?([a-z_][a-z0-9_]*):(?:\s+(.*))?$/;
const COMMENT_LINE = /^\s*#/;

// A value that is YAML rather than prose: empty (a block follows), quoted, a
// flow collection, a <placeholder>, or one token, each with an optional
// trailing comment.
function isExampleValue(value) {
  if (value === undefined || value === "") return true;
  const bare = value.replace(/\s+#.*$/, "").trim();
  if (/^["'[{]/.test(bare)) return true;
  if (/^<[^>]*>$/.test(bare)) return true;
  return !/\s/.test(bare);
}

// One level of comment marker off a line, keeping the text's column.
function uncommentLine(line) {
  const match = /^(\s*)# ?(.*)$/.exec(line);
  return match === null ? line : match[1] + match[2];
}

// Every level of comment marker off a line: `#   # key: v` -> `  key: v`.
function uncommentFully(line) {
  let current = line;
  while (COMMENT_LINE.test(current)) current = uncommentLine(current);
  return current;
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

/**
 * The YAML examples in one block of comment text (`lines`, one comment level
 * already removed), each as `{indent, text}`: a run that opens on a `key:` or
 * `- key:` line with an example value and holds every following line that is
 * deeper-indented or another such entry at the same indent. A line still
 * commented joins the run when it is itself a key line and is skipped as prose
 * otherwise.
 */
export function exampleRuns(lines) {
  const runs = [];
  let i = 0;
  while (i < lines.length) {
    const first = uncommentFully(lines[i]);
    const head = KEY_LINE.exec(first);
    if (head === null || !isExampleValue(head[3])) {
      i += 1;
      continue;
    }
    const indent = head[1].length;
    const body = [first];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const nestedComment = COMMENT_LINE.test(lines[j]);
      const next = uncommentFully(lines[j]);
      if (next.trim() === "") break;
      const keyLine = KEY_LINE.exec(next);
      if (nestedComment && keyLine === null) continue;
      const nextIndent = indentOf(next);
      const sameLevelEntry =
        nextIndent === indent &&
        ((keyLine !== null && isExampleValue(keyLine[3])) ||
          next.trimStart().startsWith("- "));
      if (nextIndent <= indent && !sameLevelEntry) break;
      body.push(next);
    }
    runs.push({
      indent,
      text: body.map((line) => line.slice(indent)).join("\n"),
    });
    i = j;
  }
  return runs;
}

function collectKeys(value, prefix, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, prefix, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    into.add(path);
    collectKeys(child, path, into);
  }
}

function parentPath(path) {
  const cut = path.lastIndexOf(".");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Every key path a rendered template documents: every key of the active YAML
 * document, and every key of a commented-out example (a run of comment lines
 * that opens on `key:` or `- key:` with a block, a quoted value, or one token
 * after it, and parses as YAML once the `#` is removed, nested `#` levels
 * too). An example in a comment block directly above an active key is placed
 * under that key when indented past the block, beside it when not; any other
 * example goes under the innermost active key whose indentation encloses it,
 * or at the top. A prose line that opens `name: a sentence`, or a key named
 * only inside a sentence, is not read as a key. `YAML` is the `yaml`
 * package, passed in so the tests and the CLI entry share one parser.
 */
export function templateKeyPaths(text, YAML) {
  const documented = new Set();
  collectKeys(YAML.parse(text), "", documented);

  // Each active key line's column and path, and the keys open above every
  // line, so a commented example is placed by its indentation.
  const lines = text.split("\n");
  const open = [];
  const activeKeyAt = new Map();
  const openBefore = [];
  lines.forEach((line, index) => {
    openBefore.push([...open]);
    if (COMMENT_LINE.test(line) || line.trim() === "") return;
    const match = KEY_LINE.exec(line);
    if (match === null) return;
    const column = line.indexOf(match[2]);
    while (open.length > 0 && open[open.length - 1].column >= column)
      open.pop();
    const path =
      open.length === 0
        ? match[2]
        : `${open[open.length - 1].path}.${match[2]}`;
    open.push({ column, path });
    activeKeyAt.set(index, { column, path });
  });

  // A comment block is a run of comment lines at one column.
  let i = 0;
  while (i < lines.length) {
    if (!COMMENT_LINE.test(lines[i])) {
      i += 1;
      continue;
    }
    const column = indentOf(lines[i]);
    let end = i;
    while (
      end < lines.length &&
      COMMENT_LINE.test(lines[end]) &&
      indentOf(lines[end]) === column
    )
      end += 1;
    const below = activeKeyAt.get(end);
    const owner = below?.column === column ? below : undefined;
    for (const run of exampleRuns(lines.slice(i, end).map(uncommentLine))) {
      let parsed;
      try {
        parsed = YAML.parse(run.text);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      let base;
      if (owner !== undefined)
        base = run.indent > column ? owner.path : parentPath(owner.path);
      else {
        const enclosing = openBefore[i].filter(
          (key) => key.column < run.indent,
        );
        base =
          enclosing.length === 0 ? "" : enclosing[enclosing.length - 1].path;
      }
      collectKeys(parsed, base, documented);
    }
    i = end;
  }
  return documented;
}

function coveredBy(path, prefixes) {
  for (const prefix of prefixes)
    if (prefix !== "" && (path === prefix || path.startsWith(`${prefix}.`)))
      return true;
  return false;
}

function strictlyUnder(path, prefixes) {
  for (const prefix of prefixes)
    if (prefix !== "" && path.startsWith(`${prefix}.`)) return true;
  return false;
}

/**
 * The comparison the check reports: `omitted` (schema paths no template
 * documents and no ALLOWED_OMISSIONS entry covers), `unknown` (template paths
 * the schema does not define), and `staleAllowances` (entries the template
 * documents, at or under the entry, or the schema does not define).
 */
export function compareKeyPaths({
  schema,
  documented,
  allowed = ALLOWED_OMISSIONS,
}) {
  const allowedPaths = [...allowed.keys()];
  const omitted = [...schema.paths]
    .filter(
      (path) =>
        !documented.has(path) &&
        !coveredBy(path, allowedPaths) &&
        !strictlyUnder(path, schema.records),
    )
    .sort();
  const unknown = [...documented]
    .filter(
      (path) => !schema.paths.has(path) && !strictlyUnder(path, schema.records),
    )
    .sort();
  const staleAllowances = allowedPaths
    .filter(
      (entry) =>
        !schema.paths.has(entry) ||
        [...documented].some((path) => coveredBy(path, [entry])),
    )
    .sort();
  return { omitted, unknown, staleAllowances };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The templates the check compares, rendered by the CLI's own renderer over
 * the built-in linkage terms: the sftp default and a filedrop block. Returns
 * them with the core module whose schema they are held to.
 */
export async function renderTemplates() {
  const core = await import("@alcove/core");
  const { renderConfigTemplate } = await import(
    pathToFileURL(resolve(root, "apps/cli/src/configTemplate.ts")).href
  );
  const data = { linkageTerms: core.getDefaultLinkageTerms("Org") };
  return {
    core,
    templates: [
      renderConfigTemplate(data),
      renderConfigTemplate(data, {
        channel: "filedrop",
        path: "/REPLACE_WITH_SHARED_DIRECTORY",
      }),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: YAML } = await import("yaml");
  const { core, templates } = await renderTemplates();
  const schema = schemaKeyPaths(core.ExchangeSpecSchema);
  const documented = new Set();
  for (const template of templates)
    for (const path of templateKeyPaths(template, YAML)) documented.add(path);
  const { omitted, unknown, staleAllowances } = compareKeyPaths({
    schema,
    documented,
  });

  const failures = [
    ...omitted.map(
      (path) =>
        `${path}: no init template documents this schema option. Document it in apps/cli/src/configTemplate.ts, or list it in ALLOWED_OMISSIONS with the reason it stays out.`,
    ),
    ...unknown.map(
      (path) =>
        `${path}: an init template documents a key the configuration schema does not define. Correct the key in apps/cli/src/configTemplate.ts.`,
    ),
    ...staleAllowances.map(
      (path) =>
        `${path}: listed in ALLOWED_OMISSIONS, but the template documents it or the schema does not define it. Remove the entry.`,
    ),
  ];
  if (failures.length > 0) {
    console.error("Init-template coverage check failed:\n");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    `Init-template coverage check passed: of ${schema.paths.size} schema key paths, every one is documented by an init template or covered by one of ${ALLOWED_OMISSIONS.size} listed omissions, and no template key falls outside the schema.`,
  );
}
