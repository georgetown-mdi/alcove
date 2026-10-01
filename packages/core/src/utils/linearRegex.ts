import { MatcherInputBase, RE2JS } from "re2js";

// Linear-time regex engine for every partner-supplied transform pattern: the
// four `tier: "regex"` factories (replace_regex, extract_regex, filter_regex,
// split_on) and the regex `parse_date` builds from its format. Replaces
// `RegExp` on these paths because the pattern is unauthenticated and runs per
// row on the single JS thread, where a catastrophic-backtracking pattern
// would hang it; re2js (RE2 semantics: linear time, no backtracking) closes
// that class rather than screening for it. Pure JS, so the CLI and the
// browser run the identical engine build, which PSI's byte-identical keys
// require. The dialect is pinned in docs/spec/PROTOCOL.md ("Transform
// regular-expression dialect") and rejected at terms validation
// (config/transformRegexDialect.ts) before any per-row run; there is no
// fallback to `RegExp`, which would reopen the ReDoS hole.

/**
 * Upper bound on distinct compiled patterns held in {@link compileCache}. This
 * cache dedupes identical pattern sources across distinct steps arrays and
 * across exchanges in a long-lived process; it does not guard a per-row
 * recompile, which the key-building path already avoids on its own. On
 * overflow the oldest entry is evicted. The count bounds in
 * config/linkageTermsSchema.ts keep a single terms set well under this, so a
 * legitimate exchange never evicts mid-build.
 */
const COMPILE_CACHE_MAX = 1024;

/**
 * Memoized compiled patterns, keyed by the exact pattern source. Insertion-
 * ordered (a plain `Map`), so the oldest entry is `keys().next().value`. A
 * pattern that fails to compile is not cached (the `RE2JS.compile` throw
 * propagates), so the cache holds only valid handles.
 */
const compileCache = new Map<string, RE2JS>();

// The one definition of a pattern's weighted size, shared by the cap
// (patternWeightedSize) and the search charge multiplier.
function compiledWeightedSize(re: RE2JS): number {
  return re.programSize() * (1 + re.groupCount());
}

// The weight of a one-character pattern, the smallest a search runs under.
// Every step's read is already charged one unit per code unit, which stands for
// a first pass under such a pattern, so a first pass is charged only the weight
// above it.
const ONE_CHARACTER_PATTERN_WEIGHT = compiledWeightedSize(RE2JS.compile("a"));

function compileCached(pattern: string): RE2JS {
  const cached = compileCache.get(pattern);
  if (cached !== undefined) return cached;
  // Throws (RE2JSSyntaxException / RE2JSCompileException) on a pattern outside
  // the dialect; the caller decides whether that is a fail-closed reject
  // ({@link patternConformsToDialect}) or a propagated runtime error, mirroring
  // `new RegExp`'s throw for a factory built from an unvalidated pattern.
  const compiled = RE2JS.compile(pattern);
  if (compileCache.size >= COMPILE_CACHE_MAX) {
    const oldest = compileCache.keys().next().value;
    if (oldest !== undefined) compileCache.delete(oldest);
  }
  compileCache.set(pattern, compiled);
  return compiled;
}

/**
 * What one regex operation may spend searching a value, and where it reports
 * what it spent.
 *
 * A search's cost grows with the code units it reads times the pattern's
 * weighted size ({@link patternWeightedSize}). A find-all operation
 * ({@link CompiledLinearRegex.replaceAll}, {@link CompiledLinearRegex.split})
 * runs one search per match, each from where the last match ended, and a
 * pattern whose preferred alternative can stay live to the end of the value
 * scans the rest of it on every search, so its cost grows with the square of
 * the value length. What the searches span is charged in code units times the
 * weighted size, less, on the first pass over the value, the weight of a
 * one-character pattern, which the step's own read stands for. A replacement
 * also counts the text it copies out of the value against `remaining`, since a
 * `` $` `` or `$'` reference copies a prefix or suffix for every match; those
 * copies are charged only where they cross, as a returned replacement's output
 * is charged by its caller. The operation stops at the read or copy that would
 * take the charge past `remaining`.
 */
export interface ScanBudget {
  /** The units the operation may spend before it crosses. */
  readonly remaining: number;
  /**
   * Record `units` spent. Throws where the total crosses the budget: an
   * operation that read past `remaining` never returns a result.
   */
  charge(units: number): void;
}

// Thrown at the read that takes a scan past its allowance, and caught by
// underScanBudget, which turns it into the budget's own crossing.
class ScanAllowanceExhausted extends Error {}

// The value as the engine reads it. A UTF-16 search reads it through
// `charCodeAt` and, for a literal prefix or a required literal, `indexOf`;
// `substring` only copies out a match, a group, or the text between matches. A
// search spans from the lowest code unit it read to the highest, and the spans
// add up across searches, so a rescan of text an earlier search already read
// counts again while the engine's own re-reads within one search do not.
class SpanCountingValue {
  readonly length: number;
  private spanned = 0;
  private copied = 0;
  private readonly value: string;
  private readonly weightedSize: number;
  private readonly countsCopies: boolean;
  private readonly allowance: number;
  private low = 0;
  private high = -1;

  constructor(
    value: string,
    weightedSize: number,
    countsCopies: boolean,
    allowance: number,
  ) {
    this.value = value;
    this.length = value.length;
    this.weightedSize = weightedSize;
    this.countsCopies = countsCopies;
    this.allowance = allowance;
  }

  // What the searches spanned, in units.
  searchCharged(): number {
    const firstPass = Math.min(this.spanned, this.length);
    return (
      (this.spanned - firstPass) * this.weightedSize +
      firstPass * Math.max(0, this.weightedSize - ONE_CHARACTER_PATTERN_WEIGHT)
    );
  }

  // The searches' charge and, where the operation counts it, what was copied
  // out of the value.
  charged(): number {
    return this.searchCharged() + this.copied;
  }

  startSearch(): void {
    this.low = 0;
    this.high = -1;
  }

  charCodeAt(index: number): number {
    this.cover(index, index);
    return this.value.charCodeAt(index);
  }

  indexOf(search: string, from: number): number {
    const start = Math.min(Math.max(from, 0), this.length);
    const found = this.value.indexOf(search, start);
    const end = found < 0 ? this.length : found + search.length;
    if (end > start) this.cover(start, end - 1);
    return found;
  }

  substring(start: number, end?: number): string {
    const copy = this.value.substring(start, end);
    if (this.countsCopies) {
      this.copied += copy.length;
      this.stopPastAllowance();
    }
    return copy;
  }

  toString(): string {
    return this.value;
  }

  private cover(first: number, last: number): void {
    if (this.high < this.low) {
      this.low = first;
      this.high = last;
      this.spanned += last - first + 1;
    } else {
      if (first < this.low) {
        this.spanned += this.low - first;
        this.low = first;
      }
      if (last > this.high) {
        this.spanned += last - this.high;
        this.high = last;
      }
    }
    this.stopPastAllowance();
  }

  private stopPastAllowance(): void {
    if (this.charged() > this.allowance) throw new ScanAllowanceExhausted();
  }
}

// The value handed to the engine. re2js asks for the text once at the start of
// every search (and once to copy out text, which reads nothing), which is where
// a search's span starts over; test/utils/linearRegex.test.ts holds the charge
// against searches whose span is known, so a release that asks less often fails
// there rather than undercounting.
class SpanCountingInput extends MatcherInputBase {
  readonly counted: SpanCountingValue;

  constructor(counted: SpanCountingValue) {
    super();
    this.counted = counted;
  }

  // The value itself, for an operation that hands the engine a string rather
  // than a matcher input. It is one search, read from a fresh span.
  asSingleSearchValue(): string {
    this.counted.startSearch();
    return this.counted as unknown as string;
  }

  override isUTF16Encoding(): boolean {
    return true;
  }

  override isUTF8Encoding(): boolean {
    return false;
  }

  override asCharSequence(): string {
    this.counted.startSearch();
    return this.counted as unknown as string;
  }

  override asBytes(): number[] {
    throw new Error("a counted search reads its value as UTF-16 only");
  }

  override length(): number {
    return this.counted.length;
  }
}

// Run one regex operation over `value` under `budget`, charging what its
// searches span, as ScanBudget states. A crossing stops the engine at the read
// or copy past the allowance and is raised by the budget's own charge, so the
// caller sees the budget's crossing and never a partial result. A copy charged
// on the way is the operation's output, which the caller charges once it
// returns, so on a return only the searches are charged here.
function underScanBudget<T>(
  value: string,
  weightedSize: number,
  budget: ScanBudget,
  countsCopies: boolean,
  operation: (input: SpanCountingInput) => T,
): T {
  const counted = new SpanCountingValue(
    value,
    weightedSize,
    countsCopies,
    budget.remaining,
  );
  let result: T;
  try {
    result = operation(new SpanCountingInput(counted));
  } catch (err) {
    if (!(err instanceof ScanAllowanceExhausted)) throw err;
    budget.charge(counted.charged());
    throw new Error(
      "a regex search read past its allowance but its budget did not refuse it",
    );
  }
  budget.charge(counted.searchCharged());
  return result;
}

/**
 * A compiled transform pattern, exposing exactly the operations the
 * standardization factories need, each matching the `RegExp` operation it
 * replaced for every in-dialect pattern (enforced by the cross-engine
 * equivalence tests). The equivalence covers the PATTERN dialect only;
 * {@link CompiledLinearRegex.replaceAll}'s replacement string resolves under
 * the engine's own rules, which diverge -- see there. Compile once via
 * {@link compileLinearRegex}; call per row.
 */
export interface CompiledLinearRegex {
  /**
   * Replace every match with `replacement`. The `$n`/`$nn`, `$<name>`, `$&`,
   * `` $` ``, `$'`, and `$$` sequences have their usual meanings; an
   * unrecognized sequence is emitted literally. The engine, not
   * `String.prototype.replace`, decides what is recognized, and differs on
   * two cases: a leading-zero reference (`$01`) and an unknown `$<name>` are
   * emitted literally here, where JavaScript resolves the first to group 1
   * and substitutes empty for the second. Normative in docs/spec/PROTOCOL.md
   * (Transform regular-expression dialect); both divergences are checks in
   * test/utils/linearRegex.test.ts. With a `budget`, the search is charged to
   * it ({@link ScanBudget}).
   */
  replaceAll(input: string, replacement: string, budget?: ScanBudget): string;
  /**
   * The first capture group of the first match, or the whole match when the
   * pattern has no group, or `null` on no match or an empty result. Mirrors
   * `(m[1] ?? m[0]) || null` for `m = input.match(new RegExp(pattern))`.
   * With a `budget`, the search is charged to it ({@link ScanBudget}).
   */
  extractFirst(input: string, budget?: ScanBudget): string | null;
  /**
   * Whether the pattern matches anywhere in `input` (unanchored). Mirrors
   * `new RegExp(pattern).test(input)`. With a `budget`, the search is charged
   * to it ({@link ScanBudget}).
   */
  test(input: string, budget?: ScanBudget): boolean;
  /**
   * Whether the pattern matches the ENTIRE `input` (anchored at both ends), as
   * RE2JS `Matcher.matches`. Unlike {@link test} (an unanchored find), a
   * zero-width or leading-substring match does not satisfy it. Mirrors
   * `new RegExp(`^(?:${pattern})$`).test(input)` for an in-dialect pattern.
   * Used where the pattern's own `^`/`$` anchors could be defeated by an
   * alternation breakout (see `withinAllowedCharacters`).
   */
  matches(input: string): boolean;
  /**
   * Split `input` around matches of the pattern. Uses RE2 split semantics:
   * unlike `String.prototype.split`, capture groups in the pattern are NOT
   * emitted as output elements (see the dialect spec). Trailing empty strings
   * are retained (limit < 0), so a caller filtering empties gets the same
   * non-empty parts as `input.split(new RegExp(pattern))` would. With a
   * `budget`, the search is charged to it ({@link ScanBudget}).
   */
  split(input: string, budget?: ScanBudget): string[];
  /**
   * The capture groups of the first match as `[group0, group1, ...]` (index 0
   * is the whole match; an unmatched optional group is `null`), or `null` on
   * no match. Used by `parse_date`, whose source anchors with `^...$`, so the
   * first match is the whole-string match. Mirrors reading `m[i]` off
   * `input.match(new RegExp(source))`. With a `budget`, the search is charged
   * to it ({@link ScanBudget}).
   */
  matchGroups(input: string, budget?: ScanBudget): (string | null)[] | null;
}

/**
 * Compile `pattern` under the linear-time engine and return the per-row
 * operations. Throws (an `RE2JS` exception) if the pattern is outside the
 * dialect; already-validated terms never hit that throw, since the dialect
 * gate rejected such a pattern at parse time. The operator-local `runPipeline`
 * path does expose it, including for a JavaScript-valid pattern the dialect
 * drops (a backreference or lookaround) -- safe there since the pattern is
 * operator-authored, so the echoed error leaks nothing partner-controlled.
 */
export function compileLinearRegex(pattern: string): CompiledLinearRegex {
  const re = compileCached(pattern);
  const weightedSize = compiledWeightedSize(re);
  const extractFirst = (input: string | MatcherInputBase): string | null => {
    const m = re.matcher(input);
    if (!m.find()) return null;
    // groupCount() is the pattern's static capturing-group count, so this
    // asks "does the pattern have a group 1?" exactly as `m[1] !==
    // undefined` does; group(1) is null for a group that did not
    // participate, matching m[1]'s undefined, and "" for one that matched
    // empty, matching m[1]'s "".
    const group1 = m.groupCount() >= 1 ? m.group(1) : null;
    return (group1 ?? m.group(0)) || null;
  };
  const matchGroups = (
    input: string | MatcherInputBase,
  ): (string | null)[] | null => {
    const m = re.matcher(input);
    if (!m.find()) return null;
    const count = m.groupCount();
    const groups: (string | null)[] = [m.group(0)];
    for (let i = 1; i <= count; i++) groups.push(m.group(i));
    return groups;
  };
  return {
    replaceAll: (input, replacement, budget) =>
      budget === undefined
        ? re.matcher(input).replaceAll(replacement)
        : underScanBudget(input, weightedSize, budget, true, (counted) =>
            re.matcher(counted).replaceAll(replacement),
          ),
    extractFirst: (input, budget) =>
      budget === undefined
        ? extractFirst(input)
        : underScanBudget(input, weightedSize, budget, false, extractFirst),
    test: (input, budget) =>
      budget === undefined
        ? re.test(input)
        : underScanBudget(input, weightedSize, budget, false, (counted) =>
            re.test(counted.asSingleSearchValue()),
          ),
    matches: (input) => re.matcher(input).matches(),
    split: (input, budget) =>
      budget === undefined
        ? re.split(input, -1)
        : underScanBudget(input, weightedSize, budget, false, (counted) =>
            re.split(counted as unknown as string, -1),
          ),
    matchGroups: (input, budget) =>
      budget === undefined
        ? matchGroups(input)
        : underScanBudget(input, weightedSize, budget, false, matchGroups),
  };
}

/**
 * The weighted size of `pattern`: the compiled program's instruction count
 * times one plus its capture-group count, both as the engine reports them.
 * Per-row matching time grows with the input length times this size, so it is
 * the measure the terms-validation gate caps
 * ({@link findTransformRegexRefusal}). Throws, as {@link compileLinearRegex}
 * does, on a pattern outside the dialect.
 */
export function patternWeightedSize(pattern: string): number {
  return compiledWeightedSize(compileCached(pattern));
}

/**
 * Whether `pattern` is in the linear-time dialect: it compiles under the
 * engine. The single conformance oracle for both the terms-validation gate
 * ({@link findTransformRegexRefusal}) and the editor-facing
 * `regexPatternSchema`, so the editor accepts exactly what an exchange will
 * run. Returns `false` on any compile failure, including a feature RE2 drops
 * (backreference, lookaround) -- exactly the patterns that could otherwise
 * backtrack catastrophically.
 */
export function patternConformsToDialect(pattern: string): boolean {
  try {
    compileCached(pattern);
    return true;
  } catch {
    return false;
  }
}
