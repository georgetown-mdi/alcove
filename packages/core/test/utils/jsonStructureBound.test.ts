import { expect, test } from "vitest";

import { scanJsonStructure } from "../../src/utils/jsonStructureBound";

import type { JsonValueCounts } from "../../src/utils/jsonStructureBound";

// Each test isolates one bound by overriding it and leaving the others
// generous. The scan is bound-agnostic, so small values (4) generalize to
// the production budgets. `scan` runs both representations the scanner
// accepts -- UTF-8 bytes and string -- and asserts they agree (on an ASCII
// body every count, else whether a bound is exceeded), so every case below
// covers both paths.
function scan(
  json: string,
  { keys = 1_000, elements = 1_000, depth = 1_000 } = {},
): "structure" | JsonValueCounts {
  const fromBytes = scanJsonStructure(
    new TextEncoder().encode(json),
    keys,
    elements,
    depth,
  );
  const fromString = scanJsonStructure(json, keys, elements, depth);
  if (/^[\x00-\x7f]*$/.test(json)) expect(fromString).toEqual(fromBytes);
  else expect(fromString === "structure").toBe(fromBytes === "structure");
  return fromBytes;
}

function check(json: string, bounds: Parameters<typeof scan>[1] = {}): boolean {
  return scan(json, bounds) === "structure";
}

// --- Per-object key bound -----------------------------------------------------

test("an object at the key budget is accepted", () => {
  expect(check('{"a":1,"b":2,"c":3,"d":4}', { keys: 4 })).toBe(false);
});

test("an object one over the key budget is rejected", () => {
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5}', { keys: 4 })).toBe(true);
});

test("the key count is per-object: many small objects in an array stay under", () => {
  // The legitimate large-message shape (e.g. an IterationMap): one object per
  // element, each far below the key budget, however many there are.
  const pairs = Array.from(
    { length: 1000 },
    () => '{"theirIndex":1,"iteration":2}',
  );
  expect(check(`[${pairs.join(",")}]`, { keys: 4, elements: 2000 })).toBe(
    false,
  );
});

test("a wide object nested inside an array is still caught", () => {
  expect(check('[{"a":1,"b":2,"c":3,"d":4,"e":5}]', { keys: 4 })).toBe(true);
});

test("a wide object nested inside another object is caught at its own level", () => {
  // The outer object has 1 key; the inner has 5. The bound charges each object
  // its own members, so the inner trips it.
  expect(check('{"outer":{"a":1,"b":2,"c":3,"d":4,"e":5}}', { keys: 4 })).toBe(
    true,
  );
});

test("repeated keys over-count toward the budget (rejects sooner, never later)", () => {
  // The parse keeps one member per name, but the scan counts colons; the
  // over-count only ever rejects earlier, which is safe.
  expect(check('{"a":1,"a":2,"a":3,"a":4,"a":5}', { keys: 4 })).toBe(true);
});

// --- Per-array element bound --------------------------------------------------

test("an array at the element budget is accepted", () => {
  // 5 elements is 4 element-separating commas; the scan counts commas, so this
  // sits exactly at a budget of 4.
  expect(check("[0,0,0,0,0]", { elements: 4 })).toBe(false);
});

test("an array one past the element budget is rejected", () => {
  expect(check("[0,0,0,0,0,0]", { elements: 4 })).toBe(true);
});

test("the element count is per-array: sibling arrays are charged separately", () => {
  // Each inner array has 3 elements; the outer has 4. No single array exceeds a
  // budget of 4, even though the total element count across them does.
  expect(check("[[1,2,3],[1,2,3],[1,2,3],[1,2,3]]", { elements: 4 })).toBe(
    false,
  );
});

test("a wide array nested inside an object is still caught", () => {
  expect(check('{"a":[0,0,0,0,0,0]}', { elements: 4 })).toBe(true);
});

test("array elements and object keys do not collide on one frame", () => {
  // A wide object does not trip the (tiny) element budget, and a wide array does
  // not trip the (tiny) key budget -- a colon is charged only to objects, a
  // comma only to arrays.
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}', { elements: 1 })).toBe(
    false,
  );
  expect(check("[0,0,0,0,0,0]", { keys: 1 })).toBe(false);
});

test("object member separators are not counted as array elements", () => {
  // The commas here separate object members, not array elements, so the tiny
  // element budget is untouched.
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5}', { elements: 1 })).toBe(false);
});

// --- String handling (applies to both bounds) ---------------------------------

test("colons inside string values are not counted as keys", () => {
  expect(check('{"url":"a:b:c:d:e:f:g:h:i:j"}', { keys: 4 })).toBe(false);
});

test("commas inside string values are not counted as elements", () => {
  expect(check('["a,b,c,d,e,f,g,h,i,j"]', { elements: 4 })).toBe(false);
});

test("braces and brackets inside string values do not open frames", () => {
  expect(check('{"s":"{[{[{[{[{["}', { keys: 4, depth: 4 })).toBe(false);
});

test("an escaped quote inside a string does not end the string early", () => {
  // The \" keeps the scan inside the string, so the colons after it are not
  // counted as keys of the object.
  expect(check('{"a":"he said \\"x:y:z:w:v\\""}', { keys: 4 })).toBe(false);
});

test("multi-byte characters inside strings are handled on both paths", () => {
  // A non-ASCII value with structural-looking bytes inside the string: in UTF-8
  // its bytes are all >= 0x80, in UTF-16 its code units are non-ASCII or a
  // surrogate pair, so neither path mistakes them for a marker. `check` asserts
  // the byte and string scans agree on this.
  expect(check('{"name":"éèê 😀 a:b,c:d"}', { keys: 4 })).toBe(false);
});

// --- Nesting depth bound ------------------------------------------------------

test("nesting at the depth budget is accepted", () => {
  expect(check("[[[[1]]]]", { depth: 4 })).toBe(false);
});

test("nesting one past the depth budget is rejected", () => {
  expect(check("[[[[[1]]]]]", { depth: 4 })).toBe(true);
});

test("a degenerate all-open-bracket body is rejected by the depth cap", () => {
  // The real DoS the depth cap guards against: an unbounded run of `[` would
  // grow the scan's own stack without it.
  expect(check("[".repeat(100000), { depth: 4 })).toBe(true);
});

// --- Malformed and edge inputs ------------------------------------------------

test("a malformed body does not throw and returns a boolean", () => {
  expect(check('{"a":1,')).toBe(false);
  expect(check("}{][:,")).toBe(false);
  expect(check("")).toBe(false);
});

test("a top-level non-object value is accepted", () => {
  expect(check("12345")).toBe(false);
  expect(check('"a string with : colons"')).toBe(false);
});

// --- Values by kind -----------------------------------------------------------

const NONE: JsonValueCounts = {
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

function counts(json: string): JsonValueCounts {
  const result = scan(json);
  if (result === "structure") throw new Error("unexpected structure bound");
  return result;
}

// The containers, elements, members and strings JSON.parse creates for a
// body whose objects repeat no earlier object's keys.
function parsedKinds(json: string): Partial<JsonValueCounts> {
  const kinds = {
    objects: 0,
    arrays: 0,
    elements: 0,
    newMembers: 0,
    strings: 0,
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      kinds.arrays++;
      kinds.elements += value.length;
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      kinds.objects++;
      for (const member of Object.values(value)) {
        kinds.newMembers++;
        kinds.strings++;
        walk(member);
      }
    } else if (typeof value === "string") kinds.strings++;
  };
  walk(JSON.parse(json));
  return kinds;
}

test.each([
  "0",
  "[]",
  "{}",
  "[[],[],[]]",
  "[{},{},{}]",
  '{"a":[1,{"b":null}],"c":"x"}',
  ' [ 1 ,\n\t[ ] , [ 2 ] ,\r{ "k" : [ ] } ] ',
  '["[1,2]", "{\\"a\\":[3]}", "\\\\"]',
])(
  "the containers, elements, members and strings of %j are counted exactly",
  (json) => {
    expect(counts(json)).toMatchObject(parsedKinds(json));
  },
);

test("a string's characters are counted from its raw form", () => {
  expect(counts('["abc","de"]')).toMatchObject({
    strings: 2,
    oneByteStringUnits: 5,
    twoByteStringUnits: 0,
  });
  // An escape is counted at its raw length, at least what it decodes to.
  expect(counts('["a\\nb"]')).toMatchObject({ oneByteStringUnits: 4 });
});

test("a string holding a character past Latin-1 or a \\u escape is counted as two-byte", () => {
  expect(counts('["\\u0041bc"]')).toMatchObject({
    oneByteStringUnits: 0,
    twoByteStringUnits: 8,
  });
  expect(scanJsonStructure('["éa","Āa"]', 10, 10, 10)).toMatchObject({
    oneByteStringUnits: 2,
    twoByteStringUnits: 2,
  });
  expect(
    scanJsonStructure(new TextEncoder().encode('["éa","Āa"]'), 10, 10, 10),
  ).toMatchObject({ oneByteStringUnits: 3, twoByteStringUnits: 3 });
});

test("numbers other than an integer of at most nine digits are counted", () => {
  expect(counts("[0,7,123456789,true,false,null]").numbers).toBe(0);
  expect(counts("[1234567890,1.5,2e3,4E1,-1,-0]").numbers).toBe(6);
  expect(counts('{"a":12,"b":1.25}').numbers).toBe(1);
});

test("an object repeating the keys of the previous object at its depth counts them as repeated", () => {
  expect(counts('[{"a":1,"b":2},{"a":3,"b":4}]')).toMatchObject({
    newMembers: 2,
    repeatedMembers: 2,
    strings: 2,
  });
  // The previous object at the depth may sit under a different parent.
  expect(counts('[[{"a":1}],[{"a":2}]]')).toMatchObject({
    newMembers: 1,
    repeatedMembers: 1,
  });
});

test("a key repeats only while every key before it does", () => {
  expect(counts('[{"a":1,"b":2},{"b":3,"a":4}]')).toMatchObject({
    newMembers: 4,
    repeatedMembers: 0,
  });
  expect(counts('[{"a":1,"b":2,"c":3},{"a":1,"x":2,"c":3}]')).toMatchObject({
    newMembers: 5,
    repeatedMembers: 1,
  });
  // A longer object repeats the shorter one's keys and adds new ones.
  expect(counts('[{"a":1},{"a":1,"b":2}]')).toMatchObject({
    newMembers: 2,
    repeatedMembers: 1,
  });
});

test("alternating key sets never count as repeated", () => {
  const body = `[${Array.from({ length: 6 }, (_, i) =>
    i % 2 ? '{"a":0,"b":0}' : '{"c":0,"d":0}',
  ).join(",")}]`;
  expect(counts(body)).toMatchObject({ newMembers: 12, repeatedMembers: 0 });
});

test("objects at different depths do not repeat each other", () => {
  expect(counts('{"a":{"a":1}}')).toMatchObject({
    newMembers: 2,
    repeatedMembers: 0,
  });
});

test("the scan records at most two widest objects' keys, and a key it cannot record is new", () => {
  const nested = '{"a":0,"b":{"c":0,"d":{"e":0,"f":0}}}';
  const body = `[${nested},${nested}]`;
  expect(counts(body)).toMatchObject({ newMembers: 6, repeatedMembers: 6 });
  // A key ceiling of 2 lets four keys be recorded, all held by the first
  // copy's records when the second opens.
  expect(scan(body, { keys: 2 })).toMatchObject({
    newMembers: 12,
    repeatedMembers: 0,
  });
});

test("a key repeats only on the same raw spelling", () => {
  expect(counts('[{"a":1},{"\\u0061":1}]')).toMatchObject({
    repeatedMembers: 0,
  });
});

test("a key of digits, or holding an escape, counts as an integer key, repeated or not", () => {
  expect(counts('[{"1":0,"23":0},{"1":0,"23":0}]')).toMatchObject({
    integerKeyMembers: 4,
    newMembers: 0,
    repeatedMembers: 0,
    strings: 4,
  });
  expect(counts('{"\\u0031":0,"1a":0,"":0}')).toMatchObject({
    integerKeyMembers: 1,
    newMembers: 2,
  });
});

test("the counts of a malformed body cover its well-formed prefix", () => {
  expect(counts("[[],[],[]")).toEqual({ ...NONE, arrays: 4, elements: 3 });
  expect(counts("}{][:,")).toMatchObject({ objects: 0, arrays: 0 });
});

test("a per-container bound is reported in place of the counts", () => {
  expect(scan("[1,2,3]", { elements: 2 })).toMatchObject({ elements: 3 });
  expect(scan("[1,2,3]", { elements: 1 })).toBe("structure");
  expect(scan('{"a":1,"b":2}', { keys: 1 })).toBe("structure");
  expect(scan("[[1]]", { depth: 1 })).toBe("structure");
});
