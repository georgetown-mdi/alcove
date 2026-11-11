/**
 * SFTP version 3 bytes written by hand, apart from the codec under test, for
 * a scripted server and for the requests the client is expected to send.
 */

export function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

export function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

export function str(value: string | Uint8Array): Uint8Array {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(u32(bytes.length), bytes);
}

export function concat(...parts: Array<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** A packet: the length, the type byte, then the fields. */
export function packet(type: number, ...fields: Array<Uint8Array>): Uint8Array {
  const body = concat(Uint8Array.of(type), ...fields);
  return concat(u32(body.length), body);
}

export const T = {
  init: 1,
  version: 2,
  open: 3,
  close: 4,
  read: 5,
  write: 6,
  opendir: 11,
  readdir: 12,
  remove: 13,
  realpath: 16,
  stat: 17,
  rename: 18,
  status: 101,
  handle: 102,
  data: 103,
  name: 104,
  attrs: 105,
} as const;

export function versionPacket(
  version: number,
  extensions: Array<[string, string]> = [],
): Uint8Array {
  return packet(
    T.version,
    u32(version),
    ...extensions.flatMap(([name, data]) => [str(name), str(data)]),
  );
}

export function statusPacket(
  id: number,
  code: number,
  message = "",
): Uint8Array {
  return packet(T.status, u32(id), u32(code), str(message), str(""));
}

export function handlePacket(id: number, handle: Uint8Array): Uint8Array {
  return packet(T.handle, u32(id), str(handle));
}

export function dataPacket(id: number, data: Uint8Array): Uint8Array {
  return packet(T.data, u32(id), str(data));
}

/** Attributes with no field present. */
export const NO_ATTRS = u32(0);
