// One way to attach a fact to a failure and read it back: an annotation held
// beside the error object rather than on it, read off the nearest link of its
// cause chain that holds one.

/**
 * The most links a walk down an error's `cause` chain follows past the error
 * itself.
 */
export const MAX_ERROR_CAUSE_DEPTH = 8;

declare const annotationValue: unique symbol;

/**
 * The identity of one kind of annotation and the type of the value it holds,
 * made by {@link annotationKey}. Only code holding the key can write or read
 * that annotation, so a module keeps its key private to be the only writer.
 */
export interface AnnotationKey<T extends NonNullable<unknown>> {
  readonly description: string;
  readonly [annotationValue]?: T;
}

/** A new {@link AnnotationKey}, distinct from every other. */
export function annotationKey<T extends NonNullable<unknown>>(
  description: string,
): AnnotationKey<T> {
  return Object.freeze({ description });
}

// Held beside the error rather than as a property on it: the error is often
// raised by a library or a transport whose object is not the annotator's to
// mutate, a frozen one would refuse the write, and an own property would show
// up wherever the error is enumerated or serialized. An entry lives exactly as
// long as its error object does.
const annotations = new WeakMap<
  object,
  Map<AnnotationKey<NonNullable<unknown>>, unknown>
>();

/** `error`, annotated with `value` under `key`, replacing any earlier value. */
export function annotate<E extends object, T extends NonNullable<unknown>>(
  error: E,
  key: AnnotationKey<T>,
  value: T,
): E {
  let held = annotations.get(error);
  if (held === undefined) {
    held = new Map();
    annotations.set(error, held);
  }
  held.set(key, value);
  return error;
}

/** How {@link annotationOf} reads. */
export interface AnnotationReadOptions {
  /**
   * Read `error` itself only, for an annotation whose meaning does not pass
   * to a wrapper that holds the annotated error as its cause.
   */
  readonly ownOnly?: boolean;
}

/**
 * The first defined value `read` returns for `error` or a link of its `cause`
 * chain, nearest first, else `undefined`. The walk follows `cause` on any
 * non-null object link, stops at a link it has already visited, and follows at
 * most {@link MAX_ERROR_CAUSE_DEPTH} links past `error`: the bound every
 * cause-chain read in core shares, so a deep or adversarially built chain
 * cannot stall a read. `options.ownOnly` reads `error` itself only. A throwing
 * `cause` accessor propagates to the caller.
 */
export function findInCauseChain<T>(
  error: unknown,
  read: (link: object) => T | undefined,
  options: AnnotationReadOptions = {},
): T | undefined {
  const seen = new Set<object>();
  let link: unknown = error;
  for (
    let depth = 0;
    typeof link === "object" && link !== null && !seen.has(link);
    depth++
  ) {
    seen.add(link);
    const value = read(link);
    if (value !== undefined) return value;
    if (options.ownOnly === true || depth >= MAX_ERROR_CAUSE_DEPTH)
      return undefined;
    link = (link as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The value `key` annotates on `error` or on the nearest link of its `cause`
 * chain that holds one, else `undefined`, read by {@link findInCauseChain}.
 */
export function annotationOf<T extends NonNullable<unknown>>(
  error: unknown,
  key: AnnotationKey<T>,
  options: AnnotationReadOptions = {},
): T | undefined {
  return findInCauseChain(
    error,
    (link) => annotations.get(link)?.get(key) as T | undefined,
    options,
  );
}
