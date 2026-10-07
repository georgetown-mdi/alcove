import { UsageError } from "../errors.js";
import { fittedPathSegment } from "./describeDecodeError.js";
import { exceedsOwnKeyCount } from "./objectKeyCount.js";

/**
 * Maximum nesting depth {@link transformKeysDeep} descends before rejecting the
 * input: it recurses natively and runs ahead of Zod on partner input, so the
 * bound must fire before the call stack overflows (a few thousand levels). The
 * deepest schema path is under a dozen levels. Spec:
 * docs/spec/CHANNEL_SECURITY.md.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * Maximum total node count (object members plus array elements, one running
 * total across the walk) {@link transformKeysDeep} rewrites before rejecting
 * the input. Bounds partner CPU spent ahead of Zod, including on a subtree the
 * schema would strip. Far above a realistic `ExchangeSpec`, yet a pathological
 * schema-valid config can still trip it. Spec: docs/spec/CHANNEL_SECURITY.md.
 */
export const MAX_NODE_COUNT = 262144;

/**
 * Thrown when input nesting exceeds {@link MAX_NESTING_DEPTH}: a bounded
 * rejection (exit 64 at the CLI), with fixed text holding no input bytes so
 * `describeDecodeError` can show it verbatim.
 */
export class NestingDepthExceededError extends UsageError {
  constructor() {
    super(`input nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}`);
    this.name = "NestingDepthExceededError";
  }
}

/**
 * Thrown when the input's total node count exceeds {@link MAX_NODE_COUNT}; the
 * same contract as {@link NestingDepthExceededError}.
 */
export class NodeCountExceededError extends UsageError {
  constructor() {
    super(`input node count exceeds the maximum of ${MAX_NODE_COUNT}`);
    this.name = "NodeCountExceededError";
  }
}

/**
 * The longest path a {@link KeyFoldCollisionError} message shows in full; a
 * longer one shows its first and last segments only.
 */
const COLLISION_PATH_DISPLAY_LENGTH = 256;

function collisionPathText(path: ReadonlyArray<PropertyKey>): string {
  const fitted = path.map(fittedPathSegment);
  const whole = fitted.join(".");
  if (whole.length <= COLLISION_PATH_DISPLAY_LENGTH || fitted.length < 3)
    return whole;
  return `${fitted[0]} ... ${fitted[fitted.length - 1]}`;
}

/**
 * Thrown by {@link camelizeKeys} when one object holds two keys that fold to
 * one name (`my_param` beside `myParam`): keeping either would decide the
 * agreed-terms hash (docs/spec/CANONICAL_ENCODING.md, "Object member
 * ordering"). On the partner path every key and path segment is partner-chosen,
 * so each is fitted ({@link fittedPathSegment}) and composed raw for the
 * display sink to escape; the fields hold them unfitted.
 */
export class KeyFoldCollisionError extends UsageError {
  /** The path of the object holding both keys, each segment as folded. */
  readonly path: ReadonlyArray<PropertyKey>;
  /** The two keys as the document writes them, in document order. */
  readonly keys: readonly [string, string];
  /** The name both keys fold to. */
  readonly foldedKey: string;

  constructor(
    path: ReadonlyArray<PropertyKey>,
    keys: readonly [string, string],
    foldedKey: string,
  ) {
    const at = path.length > 0 ? `, at ${collisionPathText(path)}` : "";
    super(
      `keys "${fittedPathSegment(keys[0])}" and ` +
        `"${fittedPathSegment(keys[1])}" are read as the same key, ` +
        `"${fittedPathSegment(foldedKey)}"${at}`,
    );
    this.name = "KeyFoldCollisionError";
    this.path = [...path];
    this.keys = keys;
    this.foldedKey = foldedKey;
  }
}

/**
 * Key names whose value is passed verbatim to an external library, so its keys
 * are not case-transformed: `providerOptions`, the `ssh2-sftp-client` connect
 * options. A name match at any depth, decided in both directions by
 * {@link transformKeysDeep} so a write -> read round trip is byte-stable.
 * Exported for the structural-invariant test.
 *
 * @internal
 */
export const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set([
  "providerOptions",
]);

/**
 * Rewrite one snake_case key to camelCase; also the canonical form opacity is
 * decided on. Exported for the exchange file's colliding-key refusal
 * (`config/unreadKeys.ts`).
 *
 * @internal
 */
export function camelizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Rewrite one camelCase key to snake_case, for a schema-error render naming a
 * Zod path segment as the file spells it. Exact only for lowercase-word keys:
 * an acronym (`URL`) renders `u_r_l`, which an operator's free-form `params`
 * key may hit.
 *
 * @internal
 */
export function snakeizeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Width bounds keyed by camelCase key name. A number is the most keys that
 * name's object value may hold before it is left verbatim, at any depth. A
 * nested map is a scope: it applies only to a member of the object the
 * enclosing map applies to (the root, for the caller's map), replacing the
 * enclosing bounds.
 */
export type WidthBounds = ReadonlyMap<string, number | WidthBounds>;

/**
 * One walk's inputs and threaded state; `path` holds rewritten keys and array
 * indices.
 */
interface KeyWalk {
  readonly transformKey: (key: string) => string;
  readonly widthBoundedKeys: WidthBounds | undefined;
  readonly atBoundsRoot: boolean;
  readonly refuseCollisions: boolean;
  readonly budget: { nodes: number };
  readonly path: Array<PropertyKey>;
}

/**
 * The walker behind {@link camelizeKeys} and {@link snakeizeKeys}: rewrites
 * every object key, never a string value. An opaque key's value is not entered;
 * opacity is decided on `camelizeKey` of the input key in both directions, so
 * both skip the same subtrees (unit-tested from `OPAQUE_VALUE_KEYS`).
 *
 * `depth` and `budget` bound recursion and total width against partner input;
 * an over-wide array or object is refused before it is materialized. A skipped
 * subtree counts toward neither. A numeric `widthBoundedKeys` entry leaves an
 * over-count value verbatim, as an opaque one is, so a huge partner
 * `transform.params` is not rewritten before the schema's count bound rejects
 * it; the result is version-deterministic, so canonical encodings within a
 * version cannot diverge. A map entry scopes bounds by path, so terms embedded
 * at an exchange file's root fold as a parse of the terms alone does.
 *
 * With `refuseCollisions`, two keys of one object rewriting to one key throw
 * {@link KeyFoldCollisionError}.
 */
function transformKeysDeep(
  value: unknown,
  depth: number,
  walk: KeyWalk,
): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  const { budget, path } = walk;
  if (Array.isArray(value)) {
    // Refused before `.map` allocates.
    if (budget.nodes + value.length > MAX_NODE_COUNT)
      throw new NodeCountExceededError();
    budget.nodes += value.length;
    const elementWalk = { ...walk, atBoundsRoot: false };
    return value.map((v, index) => {
      path.push(index);
      const rewritten = transformKeysDeep(v, depth + 1, elementWalk);
      path.pop();
      return rewritten;
    });
  }
  if (value !== null && typeof value === "object") {
    // Refused by a streaming key count before `Object.entries` materializes it.
    if (exceedsOwnKeyCount(value, MAX_NODE_COUNT - budget.nodes))
      throw new NodeCountExceededError();
    const writtenAs = walk.refuseCollisions
      ? new Map<string, string>()
      : undefined;
    const memberWalk = { ...walk, atBoundsRoot: false };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        // Also catches the budget spent by an earlier member's descendants.
        if (++budget.nodes > MAX_NODE_COUNT) throw new NodeCountExceededError();
        const rewrittenKey = walk.transformKey(k);
        if (writtenAs !== undefined) {
          const earlier = writtenAs.get(rewrittenKey);
          if (earlier !== undefined)
            throw new KeyFoldCollisionError(path, [earlier, k], rewrittenKey);
          writtenAs.set(rewrittenKey, k);
        }
        const camel = camelizeKey(k);
        if (OPAQUE_VALUE_KEYS.has(camel)) return [rewrittenKey, v];
        const widthBound = walk.widthBoundedKeys?.get(camel);
        if (typeof widthBound === "object" && walk.atBoundsRoot) {
          path.push(rewrittenKey);
          const rewritten = transformKeysDeep(v, depth + 1, {
            ...walk,
            widthBoundedKeys: widthBound,
            atBoundsRoot: true,
          });
          path.pop();
          return [rewrittenKey, rewritten];
        }
        if (
          typeof widthBound === "number" &&
          v !== null &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          exceedsOwnKeyCount(v, widthBound)
        )
          return [rewrittenKey, v];
        path.push(rewrittenKey);
        const rewritten = transformKeysDeep(v, depth + 1, memberWalk);
        path.pop();
        return [rewrittenKey, rewritten];
      }),
    );
  }
  return value;
}

/**
 * Recursively rewrite object keys from snake_case to camelCase ahead of Zod. A
 * `safeParseX` helper turns its throw into `{ success: false }` through
 * `safeParseCamelized`. A caller parsing partner input with a bounded record
 * passes `widthBoundedKeys` (`parseLinkageTerms` for `transform.params`;
 * `parseExchangeSpec` scopes them to root `linkage_terms`).
 *
 * @throws {NestingDepthExceededError} at {@link MAX_NESTING_DEPTH} levels.
 * @throws {NodeCountExceededError} past {@link MAX_NODE_COUNT} nodes.
 * @throws {KeyFoldCollisionError} if two keys of one object fold to one name.
 */
export function camelizeKeys(
  value: unknown,
  widthBoundedKeys?: WidthBounds,
): unknown {
  return transformKeysDeep(value, 0, {
    transformKey: camelizeKey,
    widthBoundedKeys,
    atBoundsRoot: true,
    refuseCollisions: true,
    budget: { nodes: 0 },
    path: [],
  });
}

/**
 * Recursively rewrite object keys from camelCase to snake_case, the inverse of
 * {@link camelizeKeys} for schema keys, for the CLI config writer
 * (`saveConfig`).
 *
 * @throws {NestingDepthExceededError} at {@link MAX_NESTING_DEPTH} levels.
 * @throws {NodeCountExceededError} past {@link MAX_NODE_COUNT} nodes.
 * @internal
 */
export function snakeizeKeys(value: unknown): unknown {
  return transformKeysDeep(value, 0, {
    transformKey: snakeizeKey,
    widthBoundedKeys: undefined,
    atBoundsRoot: true,
    refuseCollisions: false,
    budget: { nodes: 0 },
    path: [],
  });
}
