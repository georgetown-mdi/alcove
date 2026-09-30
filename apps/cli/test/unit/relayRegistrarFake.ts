/** One request a {@link fakeRegistrar} was sent. */
export interface RecordedRegistrarRequest {
  url: string;
  method: string;
  redirect: string | undefined;
  authorization: string | null;
  body: string;
}

/** A JSON answer with `status`. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fetch standing in for a relay registrar: answers each request with the
 * next of `answers` and records what was sent. A request past the last answer
 * fails the way an unreachable host does.
 *
 * @internal test-only
 */
export function fakeRegistrar(answers: Response[]): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRegistrarRequest[];
} {
  const requests: RecordedRegistrarRequest[] = [];
  const queue = [...answers];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = queue.shift();
    if (next === undefined) throw new TypeError("fetch failed");
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
