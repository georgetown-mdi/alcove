/**
 * The CSP hash source of the inline color-scheme script every document's head
 * holds (`colorSchemeScriptSource` in `./colorSchemeScript.ts`). A unit test
 * recomputes it from that source, so an edit to the script fails there.
 */
export const COLOR_SCHEME_SCRIPT_HASH_SOURCE =
  "'sha256-8ORoeP7ZoOX1k3ePKBnNzdoHYjwUvC86o4oRkUWMb9Y='";

/**
 * The `script-src` the production build runs under, measured through a full
 * exchange (docs/SECURITY_DESIGN.md, The shipped script policy). The PSI
 * engine's Emscripten glue builds functions from strings, so `'unsafe-eval'`
 * stays until that glue is rebuilt without it; `'wasm-unsafe-eval'` keeps
 * WebAssembly compiling once it goes.
 */
const SCRIPT_SOURCES = [
  "'self'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  COLOR_SCHEME_SCRIPT_HASH_SOURCE,
];

const SCRIPT_SRC_DIRECTIVE = `script-src ${SCRIPT_SOURCES.join(" ")}`;

const POLICY_DIRECTIVES = [
  "frame-ancestors 'none'",
  SCRIPT_SRC_DIRECTIVE,
  "object-src 'none'",
  "base-uri 'none'",
];

/** The one `Content-Security-Policy` value {@link securityResponseHeaders} sends. */
export const contentSecurityPolicy = POLICY_DIRECTIVES.join("; ");

/**
 * Defense-in-depth response headers, stated once: the hosted build writes them to
 * `_headers` (`apps/web/hosted/headersFile.ts`) and the console server sets them
 * on every response (`apps/web/server/console/app.ts`). What each guards:
 * docs/DEPLOYMENT.md, Headers, caching, and the fallback document. Extend the one CSP value rather than
 * adding a second `Content-Security-Policy` header, since browsers enforce the
 * intersection; a worker-restricting directive must allow `worker-src 'self'` for
 * the bundled workers.
 */
export const securityResponseHeaders: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": contentSecurityPolicy,
  "X-Content-Type-Options": "nosniff",
};

/**
 * {@link securityResponseHeaders} without `script-src`, for the pages Vite's
 * development server serves under `npm run dev:console`: it injects inline
 * module scripts, the React refresh preamble among them, that no fixed hash
 * covers. No build serves these headers.
 */
export const developmentSecurityResponseHeaders: Readonly<
  Record<string, string>
> = {
  ...securityResponseHeaders,
  "Content-Security-Policy": POLICY_DIRECTIVES.filter(
    (directive) => directive !== SCRIPT_SRC_DIRECTIVE,
  ).join("; "),
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
