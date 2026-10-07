// The vitest `globalSetup` for a suite that imports `@alcove/core` from its
// built dist but its own package from `src`: packages/cli-contract's. It guards
// core's dist alone, since the package's own dist is not what its tests read and
// requiring it fresh would demand a rebuild after every edit to `src`.

import { CORE_PACKAGE, requireFreshDists } from "./distFreshness.mjs";

export default function globalSetup() {
  requireFreshDists({ packages: [CORE_PACKAGE] });
}
