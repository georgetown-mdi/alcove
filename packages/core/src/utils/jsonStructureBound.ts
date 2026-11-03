// Code-unit values of the JSON structural characters and the string escape.
// Every one is ASCII (<= 0x7F). The scan reads either the raw UTF-8 bytes or the
// UTF-16 code units of an already-decoded string, and an ASCII value cannot
// misfire in either: in well-formed UTF-8 no lead or continuation byte of a
// multi-byte code point falls in the ASCII range (lead bytes >= 0xC0,
// continuation bytes 0x80-0xBF), and in UTF-16 an ASCII code point is a single
// unit that is never a surrogate half (0xD800-0xDFFF). So a 0x3A is always a
// real colon and a 0x22 always a real quote. On the byte path the scan needs no
// prior decode -- it runs ahead of it, so a pathological frame is rejected
// without first allocating the decoded string.
const QUOTE = 0x22; // "
const COLON = 0x3a; // :
const COMMA = 0x2c; // ,
const BACKSLASH = 0x5c; // \
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]
const MINUS = 0x2d; // -
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const FULL_STOP = 0x2e; // .
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const LOWER_U = 0x75;
// JSON's four whitespace characters, skipped when finding the first character
// of a value.
const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
// The first code unit of a character outside Latin-1, which makes the string
// holding it two bytes a character: U+0100 is UTF-8 lead byte 0xC4, and a
// UTF-16 code unit above 0xFF.
const FIRST_TWO_BYTE_LEAD = 0xc4;
const FIRST_TWO_BYTE_UNIT = 0x100;
// The most digits of an integer counted as a small integer, which the engine
// holds in its slot: nine digits stay below 2^30.
const SMALL_INTEGER_MAX_DIGITS = 9;

/**
 * The values a parse of a JSON document creates, by the kinds that retain
 * different amounts of memory.
 */
export interface JsonValueCounts {
  /** Objects. */
  objects: number;
  /** Arrays. */
  arrays: number;
  /** Array elements, one per value an array holds. */
  elements: number;
  /**
   * Object members whose key, and every key before it in the object, repeat
   * the keys of the previous object closed at the same depth. The key's
   * string is not counted in {@link strings}.
   */
  repeatedMembers: number;
  /**
   * Object members whose key is all digits or holds an escape, whether or not
   * it repeats.
   */
  integerKeyMembers: number;
  /** Every other object member. */
  newMembers: number;
  /** String values, and the keys of members not counted as repeated. */
  strings: number;
  /**
   * Characters of the counted strings that hold only Latin-1 characters, one
   * per code unit or byte of the input.
   */
  oneByteStringUnits: number;
  /** Characters of the other counted strings, counted the same way. */
  twoByteStringUnits: number;
  /** Numbers other than an integer of at most nine digits. */
  numbers: number;
}

/**
 * Scans a JSON document -- its UTF-8 bytes, or the UTF-16 code units of an
 * already-decoded string -- and returns `"structure"` if it has a structure
 * that must be rejected BEFORE `JSON.parse` runs, or else the values a parse
 * of it creates, by kind ({@link JsonValueCounts}):
 *
 * - any single object with more than `maxObjectKeys` members,
 * - any single array with more than `maxArrayElements` elements, or
 * - structural nesting (objects and arrays) deeper than `maxDepth`.
 *
 * Each is a structural pathology a partner-controlled frame can reach
 * within the frame-size cap, one `JSON.parse` cannot be allowed to meet:
 * a single object wide enough, or a single array long enough, drives the
 * engine into an internal limit (a per-object property ceiling, or its array
 * backing-store length limit) and terminates the process -- not a thrown
 * exception a surrounding `try`/`catch` could intercept, but an uncatchable
 * abort. The bound must fire ahead of the parse, since it cannot catch the
 * parse's failure. The depth cap also bounds THIS scan's own per-container
 * stack, so a degenerate body that is all `{`/`[` is rejected here rather
 * than exhausting memory in the pre-pass. See docs/spec/PARSED_INPUT_BOUNDS.md.
 *
 * Counting is structural. An object's members are counted by their colons;
 * an array's elements by their separating commas (the element count is the
 * comma count plus one for a non-empty array, so this undercounts by one --
 * immaterial against a budget far above any legitimate array and far below
 * the engine limit). On well-formed JSON every colon and every element-comma
 * falls directly inside the innermost open container and is charged to it.
 *
 * Values are classified by their first character. A string's characters are
 * counted from its raw form, at least the code units it decodes to, and a
 * string holding a character past Latin-1 or a `\u` escape is counted as two
 * bytes a character. Keys are compared as raw input, so two spellings of one
 * key never count as a repeat. On malformed JSON the counts cover the
 * well-formed prefix a parse builds before it fails.
 *
 * Two approximations are intentional and safe. The colon count over-counts
 * an object that repeats a key (the parse keeps one member per name), which
 * only rejects sooner, and no legitimate message repeats keys. On malformed
 * JSON a colon or comma can be mischarged: one outside any container is
 * charged to nothing, and a mismatched close pops without checking the
 * bracket type, so a later marker may land on an outer frame. Neither
 * approximation can hide a crash: a malformed body never reaches an engine
 * limit (`JSON.parse` rejects it as invalid first), and the bound errs only
 * toward an earlier rejection, never toward letting a too-wide object or
 * too-long array through. The scan is a single O(n) pass with early exit,
 * ahead of the parse's own pass, plus one comparison of each key with the
 * key it may repeat.
 */
export function scanJsonStructure(
  input: Uint8Array | string,
  maxObjectKeys: number,
  maxArrayElements: number,
  maxDepth: number,
): "structure" | JsonValueCounts {
  // One entry per open container. An OBJECT frame holds its running key count,
  // always `>= 0`. An ARRAY frame holds a running tally that starts at the
  // sentinel `-1` (empty) and drops by one per element-separating comma, so it
  // is always `<= -1`. The sign therefore both distinguishes the two container
  // kinds and keeps a colon (charged only to objects) and a comma (charged only
  // to arrays) from ever colliding on one frame. The innermost container is the
  // top of the stack.
  const counts: number[] = [];
  // Per depth: the raw key spans (start, end pairs) of the object open there,
  // those of the last object closed there, and whether every key of the open
  // object so far repeats the closed one's. Reused across objects. At most
  // two widest objects' spans are held at once, so the scan's own memory
  // stays bounded; a key past that is not recorded, and one compared past
  // a record's end is not a repeat.
  const openKeys: number[][] = [];
  const closedKeys: number[][] = [];
  const repeating: boolean[] = [];
  const maxRecordedSpans = 2 * maxObjectKeys;
  let recordedSpans = 0;
  // Read a UTF-8 byte or a UTF-16 code unit per position; both yield the ASCII
  // structural values identically. The kind is hoisted into two narrowed locals
  // so the per-position cost is a single null check, not a `typeof` on every
  // unit -- the loop walks a ~512 MB transport string on the large-frame path.
  const str = typeof input === "string" ? input : null;
  const bytes = str === null ? (input as Uint8Array) : null;
  const at = (i: number): number =>
    str !== null ? str.charCodeAt(i) : bytes![i];
  const twoByteFrom = str !== null ? FIRST_TWO_BYTE_UNIT : FIRST_TWO_BYTE_LEAD;
  const length = input.length;
  const result: JsonValueCounts = {
    objects: 0,
    arrays: 0,
    elements: 0,
    repeatedMembers: 0,
    integerKeyMembers: 0,
    newMembers: 0,
    strings: 0,
    oneByteStringUnits: 0,
    twoByteStringUnits: 0,
    numbers: 0,
  };
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let stringTwoByte = false;
  let stringIsKey = false;
  // Set where a value starts at the next non-whitespace character: at the
  // start, after `[`, after an array's comma, and after a colon.
  let valuePending = true;
  // Whether that value is an array element (else the document or a member's).
  let pendingElement = false;
  // Set where an object's next string is a key: after `{` and its commas.
  let keyPending = false;

  const countString = (units: number): void => {
    result.strings++;
    if (stringTwoByte) result.twoByteStringUnits += units;
    else result.oneByteStringUnits += units;
  };

  const sameKey = (
    a: number,
    aEnd: number,
    b: number,
    bEnd: number,
  ): boolean => {
    if (aEnd - a !== bEnd - b) return false;
    for (; a < aEnd; a++, b++) if (at(a) !== at(b)) return false;
    return true;
  };

  // A key of digits may name an array index, which the engine stores apart
  // from the object's named keys; an escape may decode to digits.
  const integerLikeKey = (start: number, end: number): boolean => {
    if (start === end) return false;
    for (let k = start; k < end; k++) {
      const unit = at(k);
      if (unit === BACKSLASH) return true;
      if (unit < DIGIT_ZERO || unit > DIGIT_NINE) return false;
    }
    return true;
  };

  const countKey = (end: number): void => {
    const depth = counts.length - 1;
    if (depth < 0 || counts[depth] < 0) {
      countString(end - stringStart);
      return;
    }
    const keys = openKeys[depth];
    const index = keys.length / 2;
    if (recordedSpans < maxRecordedSpans) {
      keys.push(stringStart, end);
      recordedSpans++;
    } else repeating[depth] = false;
    const previous = closedKeys[depth];
    const repeated =
      repeating[depth] &&
      previous !== undefined &&
      index * 2 < previous.length &&
      sameKey(stringStart, end, previous[index * 2], previous[index * 2 + 1]);
    if (!repeated) repeating[depth] = false;
    if (integerLikeKey(stringStart, end)) {
      result.integerKeyMembers++;
      countString(end - stringStart);
    } else if (repeated) {
      result.repeatedMembers++;
    } else {
      result.newMembers++;
      countString(end - stringStart);
    }
  };

  for (let i = 0; i < length; i++) {
    const b = str !== null ? str.charCodeAt(i) : bytes![i];
    if (inString) {
      if (escaped) {
        escaped = false;
        if (b === LOWER_U) stringTwoByte = true;
      } else if (b === BACKSLASH) escaped = true;
      else if (b === QUOTE) {
        inString = false;
        if (stringIsKey) countKey(i);
        else countString(i - stringStart);
      } else if (b >= twoByteFrom) stringTwoByte = true;
      continue;
    }
    if (valuePending) {
      if (b === SPACE || b === TAB || b === LINE_FEED || b === CARRIAGE_RETURN)
        continue;
      valuePending = false;
      if (b !== CLOSE_BRACKET && pendingElement) result.elements++;
      if (b === OPEN_BRACE) result.objects++;
      else if (b === OPEN_BRACKET) result.arrays++;
      else if (b === MINUS) result.numbers++;
      else if (b >= DIGIT_ZERO && b <= DIGIT_NINE) {
        let end = i + 1;
        while (end < length && at(end) >= DIGIT_ZERO && at(end) <= DIGIT_NINE)
          end++;
        const next = end < length ? at(end) : SPACE;
        if (
          end - i > SMALL_INTEGER_MAX_DIGITS ||
          next === FULL_STOP ||
          next === LOWER_E ||
          next === UPPER_E
        )
          result.numbers++;
        i = end - 1;
        continue;
      }
    }
    switch (b) {
      case QUOTE:
        inString = true;
        stringStart = i + 1;
        stringTwoByte = false;
        stringIsKey = keyPending;
        keyPending = false;
        break;
      case OPEN_BRACE:
      case OPEN_BRACKET: {
        if (counts.length >= maxDepth) return "structure";
        counts.push(b === OPEN_BRACE ? 0 : -1);
        keyPending = b === OPEN_BRACE;
        if (b === OPEN_BRACE) {
          const depth = counts.length - 1;
          if (openKeys[depth] === undefined) openKeys[depth] = [];
          recordedSpans -= openKeys[depth].length / 2;
          openKeys[depth].length = 0;
          repeating[depth] = true;
        } else {
          valuePending = true;
          pendingElement = true;
        }
        break;
      }
      case CLOSE_BRACE:
      case CLOSE_BRACKET: {
        const depth = counts.length - 1;
        if (depth >= 0 && counts[depth] >= 0) {
          const dropped = closedKeys[depth] ?? [];
          recordedSpans -= dropped.length / 2;
          dropped.length = 0;
          closedKeys[depth] = openKeys[depth];
          openKeys[depth] = dropped;
        }
        counts.pop();
        keyPending = false;
        break;
      }
      case COLON: {
        const top = counts.length - 1;
        if (top >= 0 && counts[top] >= 0) {
          if (++counts[top] > maxObjectKeys) return "structure";
          valuePending = true;
          pendingElement = false;
        }
        break;
      }
      case COMMA: {
        const top = counts.length - 1;
        // A comma at array top-of-stack separates two elements. The frame's
        // tally is negative, so element count = -counts[top] - 1 after this
        // decrement; reject once that passes the budget.
        if (top >= 0 && counts[top] < 0) {
          if (-(--counts[top]) - 1 > maxArrayElements) return "structure";
          valuePending = true;
          pendingElement = true;
        } else if (top >= 0) keyPending = true;
        break;
      }
    }
  }
  return result;
}
