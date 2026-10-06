// Reading the agent harness's hooks: the registrations .claude/settings.json
// makes, and the "Enforced by `<hook>.mjs`" claims the rule ledgers make about
// them. Shared by check-enforcement-claims.mjs, check-rule-ledgers.mjs and
// check-expiry-dates.mjs, so the three agree on what a claim and a registration
// are.

/** The every-spawn rule ledger, the default source of a claim. */
export const CLAUDE_MD = "CLAUDE.md";

/**
 * Enforcement claims in a rule ledger's prose: each `Enforced by \`<file>.mjs\``
 * with the line that holds it, so the tool-naming rule can read the surrounding
 * sentence, and the file it came from, so a violation names it.
 */
export function enforcementClaims(source, file = CLAUDE_MD) {
  const claims = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/[Ee]nforced by `([^`]+\.mjs)`/g)) {
      claims.push({ hook: match[1], file, line, lineNumber: index + 1 });
    }
  });
  return claims;
}

/** Hook registrations in settings.json as `{file, event, matcher}` triples. */
export function registeredHooks(settings) {
  const registrations = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const file = /hooks\/([\w.-]+\.mjs)/.exec(hook.command ?? "")?.[1];
        if (file) {
          registrations.push({ file, event, matcher: entry.matcher ?? "*" });
        }
      }
    }
  }
  return registrations;
}
