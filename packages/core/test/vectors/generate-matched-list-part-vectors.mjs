// Regenerates matched-list-part-vectors.json: the wire layout of the parts a
// matched-record list is sent in, for a mapped-element list and for each
// other word-list layout. From the repo root:
//
//   node packages/core/test/vectors/generate-matched-list-part-vectors.mjs > \
//     packages/core/test/vectors/matched-list-part-vectors.json
//   npm run format                   # apply the repo's JSON layout
//
// Each part is a 16-byte header -- the part's index and the list's part
// count, each a big-endian uint32, then the list's entry count, a big-endian
// uint64 -- followed by a body of little-endian uint32 words: the layout tag
// (5 for a mapped-element list), the part's entry count n, each entry's round,
// each entry's position count, then every entry's positions in turn; the
// other layouts follow the same rule with their own columns
// (docs/spec/PROTOCOL.md, "The part body"). The parts are written here with
// Buffer rather than by the module under test, and
// packages/core/test/psi/matchedListPartVectors.test.ts replays the file
// against matchedListParts and the receivers. A list is cut where the next
// entry would take the part's body past partPayloadBytes.

const HEADER_BYTES = 16;
const BODY_PREFIX_BYTES = 8;
const MAPPED_ELEMENT_TAG = 5;

const positionsOf = (entry) =>
  Array.isArray(entry.theirIndex) ? entry.theirIndex : [entry.theirIndex];
const entryBytes = (entry) => 8 + 4 * positionsOf(entry).length;

function cut(entries, payloadBytes) {
  const room = payloadBytes - BODY_PREFIX_BYTES;
  const starts = [];
  let used = 0;
  let inPart = 0;
  entries.forEach((entry, index) => {
    const bytes = entryBytes(entry);
    if (inPart > 0 && used + bytes > room) {
      starts.push(index);
      used = 0;
      inPart = 0;
    }
    used += bytes;
    inPart += 1;
  });
  return [0, ...starts];
}

function body(slice) {
  const words = [
    MAPPED_ELEMENT_TAG,
    slice.length,
    ...slice.map((entry) => entry.iteration),
    ...slice.map((entry) => positionsOf(entry).length),
    ...slice.flatMap(positionsOf),
  ];
  const bytes = Buffer.alloc(4 * words.length);
  words.forEach((word, k) => bytes.writeUInt32LE(word, 4 * k));
  return bytes;
}

function parts(entries, payloadBytes) {
  const starts = cut(entries, payloadBytes);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : entries.length;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(index, 0);
    header.writeUInt32BE(starts.length, 4);
    header.writeBigUInt64BE(BigInt(entries.length), 8);
    return Buffer.concat([header, body(entries.slice(start, end))]);
  });
}

const mapped = (count) =>
  Array.from({ length: count }, (_unused, i) => ({
    theirIndex: i % 3 === 2 ? [i, i + 1] : i * 11,
    iteration: i % 2,
  }));

const lists = [
  {
    name: "an empty list is one part of no entries",
    count: 0,
    payloadBytes: 64,
  },
  { name: "a list within one part", count: 2, payloadBytes: 128 },
  { name: "a list of four parts, the last short", count: 7, payloadBytes: 40 },
].map(({ name, count, payloadBytes }) => {
  const entries = mapped(count);
  return {
    name,
    entries,
    partPayloadBytes: payloadBytes,
    partsHex: parts(entries, payloadBytes).map((part) => part.toString("hex")),
  };
});

// Every other layout, each list given as its fixed columns (one array of n
// values per column) and, for a layout with a list per entry, each entry's
// values. Cut as above, an entry taking 4 bytes per column word and, with a
// list per entry, 4 for its count and 4 per value.
const LAYOUTS = {
  1: { columns: 1, ragged: false },
  2: { columns: 0, ragged: false },
  3: { columns: 1, ragged: false },
  4: { columns: 0, ragged: true },
  6: { columns: 1, ragged: false },
  7: { columns: 2, ragged: false },
};

function layoutParts(tag, columns, lists, entries, payloadBytes) {
  const { ragged } = LAYOUTS[tag];
  const entryBytesOf = (index) =>
    4 * columns.length + (ragged ? 4 + 4 * lists[index].length : 0);
  const room = payloadBytes - BODY_PREFIX_BYTES;
  const starts = [0];
  let used = 0;
  for (let index = 0; index < entries; index++) {
    const bytes = entryBytesOf(index);
    if (used > 0 && used + bytes > room) {
      starts.push(index);
      used = 0;
    }
    used += bytes;
  }
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : entries;
    const words = [
      tag,
      end - start,
      ...columns.flatMap((column) => column.slice(start, end)),
    ];
    if (ragged) {
      const slice = lists.slice(start, end);
      words.push(...slice.map((values) => values.length), ...slice.flat());
    }
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(index, 0);
    header.writeUInt32BE(starts.length, 4);
    header.writeBigUInt64BE(BigInt(entries), 8);
    const body = Buffer.alloc(4 * words.length);
    words.forEach((word, k) => body.writeUInt32LE(word, 4 * k));
    return Buffer.concat([header, body]);
  });
}

const layouts = [
  {
    name: "a round's index list in two parts",
    tag: 1,
    columns: [[3, 0, 9, 4, 1]],
    partPayloadBytes: 20,
  },
  {
    name: "an omitted grouping is one part of no entries",
    tag: 2,
    columns: [],
    entries: 0,
    partPayloadBytes: 64,
  },
  {
    name: "a grouping's run lengths",
    tag: 3,
    columns: [[1, 2, 1, 3]],
    partPayloadBytes: 64,
  },
  {
    name: "a grouping's owner lists in three parts",
    tag: 4,
    columns: [],
    lists: [[0], [0, 1], [2]],
    partPayloadBytes: 24,
  },
  {
    name: "the returned list, one row per entry",
    tag: 6,
    columns: [[7, 2, 5]],
    partPayloadBytes: 64,
  },
  {
    name: "single-pass message 3 in two parts, sender rows then receiver rows",
    tag: 7,
    columns: [
      [0, 2, 5],
      [1, 1, 3],
    ],
    partPayloadBytes: 24,
  },
].map((vector) => {
  const lists = vector.lists ?? [];
  const entries = vector.entries ?? vector.columns[0]?.length ?? lists.length;
  return {
    name: vector.name,
    tag: vector.tag,
    entries,
    columns: vector.columns,
    lists,
    partPayloadBytes: vector.partPayloadBytes,
    partsHex: layoutParts(
      vector.tag,
      vector.columns,
      lists,
      entries,
      vector.partPayloadBytes,
    ).map((part) => part.toString("hex")),
  };
});

const [first, second, third, fourth] = parts(mapped(7), 40);

function withHeader(part, edit) {
  const header = Buffer.from(part.subarray(0, HEADER_BYTES));
  edit(header);
  return Buffer.concat([header, part.subarray(HEADER_BYTES)]);
}
function withWord(part, word, value) {
  const edited = Buffer.from(part);
  edited.writeUInt32LE(value, HEADER_BYTES + 4 * word);
  return edited;
}
const refusals = [
  {
    name: "a missing part",
    partsHex: [first, third],
    maxEntries: 7,
    refusal: "is missing part 1",
  },
  {
    name: "a repeated part",
    partsHex: [first, first],
    maxEntries: 7,
    refusal: "repeats part 0",
  },
  {
    name: "a list declaring more entries than the receiver admits",
    partsHex: [first],
    maxEntries: 6,
    refusal: "declares 7 entries, over the 6 this party admits",
  },
  {
    name: "a later part declaring another list",
    partsHex: [
      first,
      withHeader(second, (header) => header.writeBigUInt64BE(8n, 8)),
    ],
    maxEntries: 8,
    refusal: "part 1 declares a different list than part 0",
  },
  {
    name: "two parts out of order",
    partsHex: [second, first, third, fourth],
    maxEntries: 7,
    refusal: "is missing part 0",
  },
  {
    name: "a later part declaring another part count",
    partsHex: [
      first,
      withHeader(second, (header) => header.writeUInt32BE(5, 4)),
    ],
    maxEntries: 7,
    refusal: "part 1 declares a different list than part 0",
  },
  {
    name: "a part one word short of its counts",
    partsHex: [first, second.subarray(0, second.length - 4), third, fourth],
    maxEntries: 7,
    refusal: "part 1 is not the length its entry counts state",
  },
  {
    name: "a part whose position count runs past its words",
    partsHex: [withWord(first, 4, 0xffff_ffff), second, third, fourth],
    maxEntries: 7,
    refusal: "part 0 is not the length its entry counts state",
  },
  {
    name: "a part of another layout",
    partsHex: [first, withWord(second, 0, 6), third, fourth],
    maxEntries: 7,
    refusal: "part 1 is not a list of the kind awaited",
  },
  {
    name: "a part stating more entries than the list has left",
    partsHex: [first, second, third, withWord(fourth, 1, 2)],
    maxEntries: 7,
    refusal: "part 3 runs past the list's declared entries",
  },
].map((refusal) => ({
  ...refusal,
  partsHex: refusal.partsHex.map((part) => part.toString("hex")),
}));

const vectors = {
  description:
    "Known-answer vectors for the parts a cascade sends a mapped-element " +
    "list in. Each part is a 16-byte header -- the part's index and the " +
    "list's part count as big-endian uint32, then the list's entry count as " +
    "a big-endian uint64 -- followed by a body of little-endian uint32 " +
    "words: the layout tag 5, the part's entry count n, n rounds, n position " +
    "counts, then the positions, the body at most partPayloadBytes long. " +
    "`layouts` covers every other layout by its tag: the fixed columns, each " +
    "n words in turn, then for a layout with a list per entry n count words " +
    "and the values. " +
    "`refusals` are part sequences a receiver refuses, from their headers " +
    "or from a body whose words are not the ones its counts state, before " +
    "the body is read into arrays, with the refusal's whole fixed tail, " +
    "which holds no body bytes. Replayed by " +
    "packages/core/test/psi/matchedListPartVectors.test.ts; regenerate with " +
    "generate-matched-list-part-vectors.mjs in this directory.",
  headerBytes: HEADER_BYTES,
  lists,
  layouts,
  refusals,
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
