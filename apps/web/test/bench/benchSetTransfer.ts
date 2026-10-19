// The page side of the bench server's set store (browserRoundMemory.ts,
// startBenchServer), bundled into each bench page: set bytes move between a
// page and the bench over local HTTP, never through a page call's argument or
// return value.

/** Fetches the set the bench holds under `name`. */
export async function download(name: string): Promise<Uint8Array> {
  const response = await fetch(`/set/${name}`);
  if (!response.ok)
    throw new Error(`the bench has no ${name} set (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

// Chromium hands the DevTools client every request body it sends, and a
// body past a few hundred MB overflows the string Playwright decodes it into,
// so a set goes up in pieces the bench server joins.
const UPLOAD_PIECE_BYTES = 8 * 1024 * 1024;

/** Stores `bytes` with the bench under `name`, returning their length. */
export async function upload(name: string, bytes: Uint8Array): Promise<number> {
  const count = Math.max(1, Math.ceil(bytes.byteLength / UPLOAD_PIECE_BYTES));
  for (let piece = 0; piece < count; piece++) {
    const last = piece === count - 1 ? "&last" : "";
    const response = await fetch(`/set/${name}?piece=${piece}${last}`, {
      method: "POST",
      body: bytes.subarray(
        piece * UPLOAD_PIECE_BYTES,
        (piece + 1) * UPLOAD_PIECE_BYTES,
      ) as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok)
      throw new Error(`the bench refused the ${name} set (${response.status})`);
  }
  return bytes.byteLength;
}
