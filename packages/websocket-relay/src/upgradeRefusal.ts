import type { Duplex } from "node:stream";

/** The status lines a relay refuses an upgrade with. */
export type UpgradeRefusalStatus =
  "403 Forbidden" | "404 Not Found" | "503 Service Unavailable";

/** The path of a request target, without its query or fragment. */
export function requestPath(url: string | undefined): string {
  if (url === undefined) return "";
  const queryAt = url.search(/[?#]/);
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/** Answer an upgrade with `status` and an empty body, and close its socket. */
export function refuseUpgrade(
  socket: Duplex,
  status: UpgradeRefusalStatus,
): void {
  // The HTTP server detaches its own listeners from an upgrade's socket, so
  // an error here would otherwise be thrown.
  socket.on("error", () => socket.destroy());
  // Destroyed once the answer has flushed, so a client that never closes its
  // side cannot hold the socket half-open.
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}
