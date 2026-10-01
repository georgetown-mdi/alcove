// Regenerates psi-set-part-vectors.json: the wire layout of the parts a
// cascade or count-only round sends a PSI set in. From the repo root:
//
//   node packages/core/test/vectors/generate-psi-set-part-vectors.mjs > \
//     packages/core/test/vectors/psi-set-part-vectors.json
//   npm run format                   # apply the repo's JSON layout
//
// Each part is a 16-byte header -- the part's index and the set's part count,
// each a big-endian uint32, then the set's byte length, a big-endian uint64 --
// followed by the next slice of the set (docs/spec/PROTOCOL.md, "A PSI set is
// sent in parts"). The headers are written here with Buffer's own integer
// writers rather than by the module under test, and
// packages/core/test/psi/psiSetPartVectors.test.ts replays the file against
// psiSetParts and receivePsiSet. The set bytes are synthetic: the engine's own
// serialization is pinned by psi-engine-wire-vectors.json, and what is pinned
// here is how a set is cut and framed.

const HEADER_BYTES = 16;

function setOf(length) {
  return Buffer.from(
    Array.from({ length }, (_unused, i) => (i * 37 + 11) % 256),
  );
}

function parts(set, payloadBytes) {
  const count = Math.max(1, Math.ceil(set.length / payloadBytes));
  return Array.from({ length: count }, (_unused, index) => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(index, 0);
    header.writeUInt32BE(count, 4);
    header.writeBigUInt64BE(BigInt(set.length), 8);
    const slice = set.subarray(
      index * payloadBytes,
      (index + 1) * payloadBytes,
    );
    return Buffer.concat([header, slice]);
  });
}

const sets = [
  {
    name: "an empty set is one part of header alone",
    length: 0,
    payloadBytes: 8,
  },
  { name: "a set within one part", length: 5, payloadBytes: 8 },
  { name: "a set filling one part exactly", length: 8, payloadBytes: 8 },
  { name: "a set one byte over one part", length: 9, payloadBytes: 8 },
  { name: "a set of three parts, the last short", length: 21, payloadBytes: 8 },
].map(({ name, length, payloadBytes }) => {
  const set = setOf(length);
  return {
    name,
    setHex: set.toString("hex"),
    partPayloadBytes: payloadBytes,
    partsHex: parts(set, payloadBytes).map((part) => part.toString("hex")),
  };
});

const [first, second, third] = parts(setOf(21), 8);
const refusals = [
  {
    name: "a missing part",
    partsHex: [first, third],
    maxSetBytes: 21,
    refusal: "is missing part 1",
  },
  {
    name: "a repeated part",
    partsHex: [first, first],
    maxSetBytes: 21,
    refusal: "repeats part 0",
  },
  {
    name: "a set longer than the receiver's bound",
    partsHex: [first],
    maxSetBytes: 20,
    refusal: "declares 21 bytes, over the 20 the agreed record counts admit",
  },
  {
    name: "a last part short of the declared length",
    partsHex: [first, second, third.subarray(0, third.length - 1)],
    maxSetBytes: 21,
    refusal: "ends short of the set's declared length",
  },
].map((refusal) => ({
  ...refusal,
  partsHex: refusal.partsHex.map((part) => part.toString("hex")),
}));

const vectors = {
  description:
    "Known-answer vectors for the parts a cascade or count-only round sends a " +
    "PSI set (the setup, the request, the response) in. Each part is a 16-byte " +
    "header -- the part's index and the set's part count as big-endian uint32, " +
    "then the set's byte length as a big-endian uint64 -- followed by the next " +
    "slice of the set, at most partPayloadBytes long. The set bytes are " +
    "synthetic; the engine's serialization is pinned by " +
    "psi-engine-wire-vectors.json. `refusals` are part sequences a receiver " +
    "refuses before joining them, with the refusal's fixed tail. Replayed by " +
    "packages/core/test/psi/psiSetPartVectors.test.ts; regenerate with " +
    "generate-psi-set-part-vectors.mjs in this directory.",
  headerBytes: HEADER_BYTES,
  sets,
  refusals,
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
