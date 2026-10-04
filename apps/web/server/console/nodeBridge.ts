import { Readable } from "node:stream";

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The origin every bridged request URL is built on. Handlers read only the
 * path and query of `request.url`; the `Host` a client sent stays in the
 * headers, where the job gate's Host and Origin checks read it.
 */
const REQUEST_URL_ORIGIN = "http://127.0.0.1";

/** The methods the bridge turns into a web `Request`. Any other method --
 * among them `TRACE` and `CONNECT`, which the `Request` constructor refuses --
 * is answered without one. */
const BRIDGED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
]);

/** The bridged methods whose request body is not read. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether `req` can be handed to the app as a web `Request`: a bridged method
 * and an origin-form target (`/path?query`). An absolute-form target
 * (`GET http://host/path`) and the asterisk form (`OPTIONS *`) are not.
 */
export function isBridgeableRequest(req: IncomingMessage): boolean {
  return (
    req.method !== undefined &&
    BRIDGED_METHODS.has(req.method) &&
    req.url !== undefined &&
    req.url.startsWith("/")
  );
}

/**
 * The web `Request` for `req`. Its URL is the target appended to a fixed
 * origin, so a target beginning `//` stays a path rather than naming a host.
 * Its `signal` aborts when `res` closes before the response has finished --
 * the client went away -- and its body streams from `req` unread until a
 * handler reads it, so a handler's byte cap still bounds the read.
 */
export function toWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Request {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  return new Request(`${REQUEST_URL_ORIGIN}${req.url ?? "/"}`, {
    method,
    headers,
    signal: controller.signal,
    ...(BODYLESS_METHODS.has(method)
      ? {}
      : {
          body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
          duplex: "half",
        }),
  });
}

/** Whether the connection under `res` is gone. A function rather than an
 * inline test, since the value changes across the awaits that follow it. */
function clientGone(res: ServerResponse): boolean {
  return res.destroyed || res.closed;
}

/** Resolve once `res` can take more data or has closed. */
function drainedOrClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Write `response` to `res`. The status and headers are sent before the first
 * body chunk, so a stream that has nothing to send yet (an event stream
 * waiting on its first event) still reaches the client as a response. The body
 * is written as it is read, pausing while the socket's buffer is full; when the
 * client goes away the body is cancelled, which releases whatever the stream
 * holds. A `HEAD` request gets the headers and no body.
 */
export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
  method: string | undefined,
): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers)
    if (name !== "set-cookie") res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  if (response.body === null || method === "HEAD") {
    await response.body?.cancel();
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const cancelOnClose = (): void => {
    reader.cancel().catch(() => undefined);
  };
  // The client may have gone while the handler ran, its `close` already
  // emitted. A cancel settles a read parked on an idle stream.
  if (clientGone(res)) {
    cancelOnClose();
    return;
  }
  res.once("close", cancelOnClose);
  res.flushHeaders();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || clientGone(res)) break;
      if (!res.write(value)) await drainedOrClosed(res);
    }
    if (!clientGone(res)) res.end();
  } catch {
    res.destroy();
  } finally {
    res.off("close", cancelOnClose);
  }
}
