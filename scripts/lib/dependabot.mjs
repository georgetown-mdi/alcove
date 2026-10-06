// Reading .github/dependabot.yml, shared by the checks that hold its ignore
// and group entries against what the repository pins.

/**
 * Whether a Dependabot `dependency-name` pattern covers a dependency name. `*`
 * matches any run of characters including `/`; every other character is
 * literal.
 */
export function coversDependencyName(pattern, name) {
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
    character === "*" ? ".*" : `\\${character}`,
  );
  return new RegExp(`^${expression}$`).test(name);
}
