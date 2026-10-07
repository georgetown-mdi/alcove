/**
 * Defense-in-depth response headers, stated once: the hosted build writes them to
 * `_headers` (`apps/web/hosted/headersFile.ts`) and the console server sets them
 * on every response (`apps/web/server/console/app.ts`). What each guards:
 * docs/SECURITY_DESIGN.md, Channel security. Extend the one CSP value rather than
 * adding a second `Content-Security-Policy` header, since browsers enforce the
 * intersection; a worker-restricting directive must allow `worker-src 'self'` for
 * the bundled CSV-parse worker.
 */
export const securityResponseHeaders: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Applies {@link securityResponseHeaders} to a rebuilt copy of `response`, since a
 * redirect or `fetch`-derived response has immutable headers. This consumes the
 * original's body. A status the Response constructor refuses (0, or 1xx) is
 * returned unchanged.
 */
export function withSecurityHeaders(response: Response): Response {
  if (response.status < 200 || response.status > 599) return response;
  const hardened = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityResponseHeaders)) {
    hardened.headers.set(name, value);
  }
  return hardened;
}
