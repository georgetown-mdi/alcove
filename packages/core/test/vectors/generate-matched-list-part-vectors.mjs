// Regenerates matched-list-part-vectors.json: the wire layout of the parts a
// cascade sends a list of matched records in. From the repo root:
//
//   node packages/core/test/vectors/generate-matched-list-part-vectors.mjs > \
//     packages/core/test/vectors/matched-list-part-vectors.json
//   npm run format                   # apply the repo's JSON layout
//
// Each part is a 16-byte header -- the part's index and the list's part
// count, each a big-endian uint32, then the list's entry count, a big-endian
// uint64 -- followed by the UTF-8 JSON of the part's slice of the list
// (docs/spec/PROTOCOL.md, "A list of matched records is sent in parts"). The
// headers and bodies are written here with Buffer and JSON.stringify rather
// than by the module under test, and
// packages/core/test/psi/matchedListPartVectors.test.ts replays the file
// against matchedListParts and the receivers. A list is cut where the next
// entry, with its separator, would take the part's body past
// partPayloadBytes.

const HEADER_BYTES = 16;

function cut(entries, payloadBytes) {
  const fixed = Buffer.byteLength(JSON.stringify([]));
  const starts = [];
  let used = 0;
  let inPart = 0;
  entries.forEach((entry, index) => {
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (inPart > 0 && used + bytes > payloadBytes - fixed) {
      starts.push(index);
      used = 0;
      inPart = 0;
    }
    used += bytes;
    inPart += 1;
  });
  return [0, ...starts];
}

function parts(entries, payloadBytes) {
  const starts = cut(entries, payloadBytes);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : entries.length;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(index, 0);
    header.writeUInt32BE(starts.length, 4);
    header.writeBigUInt64BE(BigInt(entries.length), 8);
    return Buffer.concat([
      header,
      Buffer.from(JSON.stringify(entries.slice(start, end))),
    ]);
  });
}

const mapped = (count) =>
  Array.from({ length: count }, (_unused, i) => ({
    theirIndex: i % 3 === 2 ? [i, i + 1] : i * 11,
    iteration: i % 2,
  }));

const lists = [
  {
    name: "an empty list is one part of an empty array",
    count: 0,
    payloadBytes: 64,
  },
  { name: "a list within one part", count: 2, payloadBytes: 128 },
  { name: "a list of four parts, the last short", count: 7, payloadBytes: 96 },
].map(({ name, count, payloadBytes }) => {
  const entries = mapped(count);
  return {
    name,
    entries,
    partPayloadBytes: payloadBytes,
    partsHex: parts(entries, payloadBytes).map((part) => part.toString("hex")),
  };
});

const [first, second, third, fourth] = parts(mapped(7), 96);

function withHeader(part, edit) {
  const header = Buffer.from(part.subarray(0, HEADER_BYTES));
  edit(header);
  return Buffer.concat([header, part.subarray(HEADER_BYTES)]);
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
    name: "a part whose body is not JSON",
    partsHex: [first, second.subarray(0, second.length - 1), third, fourth],
    maxEntries: 7,
    refusal: "part 1 is not a JSON message",
  },
].map((refusal) => ({
  ...refusal,
  partsHex: refusal.partsHex.map((part) => part.toString("hex")),
}));

const vectors = {
  description:
    "Known-answer vectors for the parts a cascade sends a list of matched " +
    "records in (each party's mapped-element list, the list returned with the " +
    "partner's rows, the payload rows). Each part is a 16-byte header -- the " +
    "part's index and the list's part count as big-endian uint32, then the " +
    "list's entry count as a big-endian uint64 -- followed by the UTF-8 JSON " +
    "of the part's slice, at most partPayloadBytes long. `refusals` are part " +
    "sequences a receiver refuses, from their headers before parsing any " +
    "body or, for a body that is not JSON, at that body, with the refusal's " +
    "whole fixed tail, which carries no body bytes. Replayed by " +
    "packages/core/test/psi/matchedListPartVectors.test.ts; regenerate with " +
    "generate-matched-list-part-vectors.mjs in this directory.",
  headerBytes: HEADER_BYTES,
  lists,
  refusals,
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
