#!/usr/bin/env node
// Applies the dev container's tracked Claude settings template to the user
// settings.json on the ~/.claude volume without discarding what the operator
// changed in the container; post-create.sh runs it.
//
//   node scripts/merge-claude-settings.mjs <template.json> <config-dir>
//
// A three-way merge over three versions: the template as last applied (the
// base, kept beside settings.json), the existing settings.json, and the tracked
// template. A key the operator did not change follows the template; a key the
// operator changed, added or deleted stays as the operator left it. With no
// settings.json, or no base to tell the operator's changes from the template's,
// the template is written whole.
//
// An unparsable settings.json or base is renamed aside rather than failing:
// a failed postCreateCommand skips postStartCommand, which starts the egress
// firewall. An unparsable template is a repository bug and throws.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "post-create";
export const SETTINGS_FILE = "settings.json";
export const APPLIED_TEMPLATE_FILE = ".settings-template-applied.json";
const UNREADABLE_SUFFIX = ".unreadable";

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality that ignores object key order and compares arrays in order. */
export function deepEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return a === b;
}

/**
 * Three-way merge of plain JSON objects. `base` is the template as last
 * applied, `current` the operator's settings, `template` the tracked template.
 */
export function mergeSettings(base, current, template) {
  const merged = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(current),
    ...Object.keys(template),
  ]);
  for (const key of keys) {
    const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
    const currentValue = Object.hasOwn(current, key) ? current[key] : undefined;
    const templateValue = Object.hasOwn(template, key)
      ? template[key]
      : undefined;
    let value;
    if (isPlainObject(currentValue) && isPlainObject(templateValue)) {
      value = mergeSettings(
        isPlainObject(baseValue) ? baseValue : {},
        currentValue,
        templateValue,
      );
    } else if (deepEqual(currentValue, baseValue)) {
      value = templateValue;
    } else {
      value = currentValue;
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Dotted paths at which `merged` differs from `template`. */
export function differingPaths(merged, template, prefix = "") {
  const paths = [];
  for (const key of new Set([
    ...Object.keys(merged),
    ...Object.keys(template),
  ])) {
    const mergedValue = Object.hasOwn(merged, key) ? merged[key] : undefined;
    const templateValue = Object.hasOwn(template, key)
      ? template[key]
      : undefined;
    const path = `${prefix}${key}`;
    if (isPlainObject(mergedValue) && isPlainObject(templateValue)) {
      paths.push(...differingPaths(mergedValue, templateValue, `${path}.`));
    } else if (!deepEqual(mergedValue, templateValue)) {
      paths.push(path);
    }
  }
  return paths;
}

function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * Reads a JSON object from `path`: undefined when the file is absent, and
 * undefined after renaming it aside when it is not a parsable JSON object.
 */
function readObjectOrSetAside(path, warn) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  let reason;
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) return parsed;
    reason = "it is not a JSON object";
  } catch (error) {
    reason = error.message;
  }
  const aside = `${path}${UNREADABLE_SUFFIX}`;
  renameSync(path, aside);
  warn(
    `${NAME}: warning - ${path} is unreadable (${reason}); moved to ${aside}.`,
  );
  return undefined;
}

/**
 * Applies the template at `templatePath` to the settings in `configDir`.
 * Returns the dotted paths kept from the container that differ from the
 * template.
 */
export function applyTemplate({
  templatePath,
  configDir,
  warn = console.error,
}) {
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  if (!isPlainObject(template)) {
    throw new Error(`${templatePath} is not a JSON object.`);
  }
  mkdirSync(configDir, { recursive: true });
  const settingsPath = join(configDir, SETTINGS_FILE);
  const basePath = join(configDir, APPLIED_TEMPLATE_FILE);

  const current = readObjectOrSetAside(settingsPath, warn);
  const base = readObjectOrSetAside(basePath, warn);
  const merged =
    current === undefined || base === undefined
      ? template
      : mergeSettings(base, current, template);

  writeJsonAtomically(settingsPath, merged);
  writeJsonAtomically(basePath, template);
  return differingPaths(merged, template);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [templatePath, configDir] = process.argv.slice(2);
  if (templatePath === undefined || configDir === undefined) {
    console.error(
      `usage: merge-claude-settings.mjs <template.json> <config-dir>`,
    );
    process.exit(2);
  }
  const kept = applyTemplate({ templatePath, configDir });
  if (kept.length > 0) {
    console.log(`${NAME}: kept container settings: ${kept.join(", ")}`);
  }
}
