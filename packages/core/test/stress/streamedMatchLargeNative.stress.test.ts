import { streamedMatchLargeTest } from "./streamedMatchLarge.case";

// The joiner's streamed match on the native addon at the per-set maximum;
// streamedMatchLarge.case.ts has the round and its variables. The
// hosted-runner measurement and the limits derived from it are at this
// file's WEEKLY_MINUTES entry in .github/workflows/nightly_core_stress.yaml.

streamedMatchLargeTest({
  backend: "native",
  generateTimeoutMs: 50 * 60_000,
  matchTimeoutMs: 120 * 60_000,
});
