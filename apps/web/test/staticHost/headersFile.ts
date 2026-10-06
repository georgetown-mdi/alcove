// The subset of Cloudflare Pages' `_headers` format this harness serves: a URL
// path pattern on an unindented line, its headers indented beneath it as
// `Name: value`, blank lines and `#` comments between rules. A pattern's `*`
// matches any run of characters. Every rule whose pattern matches the request
// path applies. Anything outside that subset -- a `:placeholder` segment, an
// absolute-URL pattern, a `! Name` removal -- is refused rather than guessed
// at, so a `_headers` the harness serves is one whose meaning was measured.

/** One `_headers` rule: a path pattern and the headers it sets. */
export interface HeaderRule {
  readonly pattern: string;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
}

/** Parses `source` into its rules, throwing on syntax outside the subset. */
export function parseHeadersFile(source: string): Array<HeaderRule> {
  const rules: Array<{
    pattern: string;
    headers: Array<readonly [string, string]>;
  }> = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const where = `_headers line ${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (!/^\s/.test(line)) {
      if (!trimmed.startsWith("/"))
        throw new Error(`${where}: only a path pattern is supported`);
      if (trimmed.includes(":"))
        throw new Error(`${where}: placeholders are not supported`);
      rules.push({ pattern: trimmed, headers: [] });
      return;
    }
    const rule = rules.at(-1);
    if (rule === undefined)
      throw new Error(`${where}: a header comes before any path pattern`);
    if (trimmed.startsWith("!"))
      throw new Error(`${where}: header removal is not supported`);
    const separator = trimmed.indexOf(":");
    if (separator <= 0) throw new Error(`${where}: expected "Name: value"`);
    rule.headers.push([
      trimmed.slice(0, separator).trim(),
      trimmed.slice(separator + 1).trim(),
    ]);
  });
  for (const rule of rules)
    if (rule.headers.length === 0)
      throw new Error(`_headers: ${rule.pattern} sets no header`);
  return rules;
}

function patternMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/** The headers `rules` set on a response to `path`, in rule order. Throws when
 * two matching rules set one header, a case whose served result the harness
 * has not measured. */
export function headersForPath(
  rules: ReadonlyArray<HeaderRule>,
  path: string,
): Map<string, string> {
  const headers = new Map<string, string>();
  const setBy = new Map<string, string>();
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      const earlier = setBy.get(key);
      if (earlier !== undefined)
        throw new Error(
          `_headers: ${earlier} and ${rule.pattern} both set ${name} on ${path}`,
        );
      setBy.set(key, rule.pattern);
      headers.set(name, value);
    }
  }
  return headers;
}
