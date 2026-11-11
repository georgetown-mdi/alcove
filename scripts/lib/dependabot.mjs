// Reading .github/dependabot.yml, for the checks that hold its entries against
// what the repository pins.

/**
 * Whether a Dependabot `dependency-name` or group pattern covers a dependency
 * name. `*` matches any run of characters including `/`; every other character
 * is literal.
 */
export function coversDependencyName(pattern, name) {
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
    character === "*" ? ".*" : `\\${character}`,
  );
  return new RegExp(`^${expression}$`).test(name);
}
