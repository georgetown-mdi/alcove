import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { parseSensitiveYaml, safeParseExchangeSpec } from "@alcove/core";

import { JOB_FILE_NAMES } from "./intentSchemas";
import { resolveWorkdirFile } from "./workdir";
import { runCapturedCliChild } from "./capturedCliChild";

import type { LinkageTerms } from "@alcove/core";

/**
 * The proposal a run refused on a partner terms change writes beside its
 * configuration: the CLI names it after the configuration file
 * (`termsProposalPath`, `apps/cli/src/termsChange.ts`), so a job's composed
 * `alcove.yaml` puts it at this name in the job's workdir.
 */
export const TERMS_PROPOSAL_FILE_NAME = "alcove.proposed-terms";

/**
 * How applying a run's terms proposal to the mounted configuration ended:
 * - `applied`: `alcove apply` rewrote the mounted `alcove.yaml`.
 * - `refused`: it exited 64 and changed nothing -- the proposal failed the
 *   partnership check against the key file beside the configuration, or the
 *   configuration would not load with it.
 * - `run-terms-differ`: nothing ran, because the run's configuration states
 *   linkage terms other than the mounted file's -- the operator changed them
 *   in the console before running -- so the change shown is against terms
 *   the file does not hold.
 * - `timeout`: the watchdog killed it.
 * - `error`: anything else, a run that exited 0 without rewriting the file
 *   included.
 */
export type TermsProposalApplyResult =
  | { kind: "applied" }
  | { kind: "refused" }
  | { kind: "run-terms-differ" }
  | { kind: "timeout" }
  | { kind: "error" };

/**
 * The watchdog for an apply child: a local decode and one file write, with no
 * network leg, so the budget only keeps a wedged child from holding the
 * endpoint open.
 */
const APPLY_SIGTERM_MS = 15_000;
/** The grace before the watchdog escalates SIGTERM to SIGKILL. */
const APPLY_SIGKILL_GRACE_MS = 5_000;

/**
 * The argv an apply drives: a fixed template plus three server-composed
 * absolute paths. Each flag is a single `--flag=value` token so a path cannot
 * be misparsed as a flag of its own, and the update is the `@path` form the
 * CLI reads the file through.
 *
 * @internal exported for testing
 */
export function termsApplyArgv(args: {
  binaryPath: string;
  configPath: string;
  keyPath: string;
  proposalPath: string;
}): Array<string> {
  return [
    args.binaryPath,
    "apply",
    `--config-file=${args.configPath}`,
    `--key-file=${args.keyPath}`,
    `@${args.proposalPath}`,
  ];
}

function readOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** The linkage terms a configuration's source states, read through the
 * sensitive-parse chokepoint and the shared exchange-file schema; undefined
 * where either refuses it. */
function statedLinkageTerms(source: string): LinkageTerms | undefined {
  let raw: unknown;
  try {
    raw = parseSensitiveYaml(source, "exchange configuration");
  } catch {
    return undefined;
  }
  const parsed = safeParseExchangeSpec(raw);
  return parsed.success ? parsed.data.linkageTerms : undefined;
}

/**
 * Run `alcove apply` on the proposal a refused run left in `workdir`, against
 * the configuration and key file in the mounted data root, through the shared
 * spawn boundary ({@link runCapturedCliChild}). The CLI shows the change and
 * asks before it writes; the operator gave that answer on the console, so it
 * is written to the child's stdin. The CLI writes the configuration; this
 * driver writes nothing. The child's cwd is the data root, the directory a
 * command-line apply of the same files runs in.
 *
 * The CLI showed the change against the run's configuration in `workdir`,
 * so nothing runs unless that configuration's linkage terms are the mounted
 * file's. The CLI exits 0 whether it applied or was declined, so an exit 0
 * counts as applied only where the configuration's bytes changed.
 */
export async function runTermsProposalApply(args: {
  binaryPath: string;
  dataRoot: string;
  workdir: string;
  keyPath: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs?: number;
  sigkillGraceMs?: number;
}): Promise<TermsProposalApplyResult> {
  const configPath = resolveWorkdirFile(args.dataRoot, JOB_FILE_NAMES.config);
  const runConfigPath = resolveWorkdirFile(args.workdir, JOB_FILE_NAMES.config);
  const proposalPath = resolveWorkdirFile(
    args.workdir,
    TERMS_PROPOSAL_FILE_NAME,
  );
  if (configPath === null || runConfigPath === null || proposalPath === null)
    return { kind: "error" };
  const before = readOrNull(configPath);
  const runSource = readOrNull(runConfigPath);
  if (before === null || runSource === null) return { kind: "error" };
  const mountedTerms = statedLinkageTerms(before);
  const runTerms = statedLinkageTerms(runSource);
  if (mountedTerms === undefined || runTerms === undefined)
    return { kind: "error" };
  if (!isDeepStrictEqual(mountedTerms, runTerms))
    return { kind: "run-terms-differ" };
  const outcome = await runCapturedCliChild({
    argv: termsApplyArgv({
      binaryPath: args.binaryPath,
      configPath,
      keyPath: args.keyPath,
      proposalPath,
    }),
    cwd: args.dataRoot,
    stdin: "y\n",
    ...(args.childEnv !== undefined ? { childEnv: args.childEnv } : {}),
    sigtermMs: args.sigtermMs ?? APPLY_SIGTERM_MS,
    sigkillGraceMs: args.sigkillGraceMs ?? APPLY_SIGKILL_GRACE_MS,
  });
  if (outcome.kind === "timedOut") return { kind: "timeout" };
  if (outcome.kind === "spawnFailed") return { kind: "error" };
  if (outcome.code === 64) return { kind: "refused" };
  if (outcome.code !== 0) return { kind: "error" };
  const after = readOrNull(configPath);
  return after !== null && after !== before
    ? { kind: "applied" }
    : { kind: "error" };
}
