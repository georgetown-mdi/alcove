import { getHeapStatistics, setFlagsFromString } from "node:v8";

import {
  MAX_PSI_DECODE_ELEMENTS,
  RoundCapacityError,
  UsageError,
  formatCount,
} from "@alcove/core";

import { readRuntimeEnv, type RuntimeEnvSnapshot } from "./util/runtimeEnv";

// The memory budget a CLI party's PSI round runs under: a heap ceiling sized to
// the largest set the protocol admits, a check, before any network contact,
// that this party's own input fits the memory the process has, and the same
// check against the partner's round once the terms are exchanged. The
// figures, their measurement, and the limits of the checks:
// docs/spec/FILE_SYNC.md, "Memory a PSI round needs".

/**
 * Peak process memory a PSI round holds per element of a set, in bytes: the
 * joiner's full round (a setup of `n` elements and a response of `n`), the
 * costlier of the two roles, fitted over measured runs of the CLI's own
 * worker engine.
 */
export const PSI_ROUND_BYTES_PER_ELEMENT = 1_176;

/**
 * The fixed part of a PSI round's peak process memory, in bytes: the process
 * before it reads any frame (62 MB) plus the intercept of the per-element fit
 * (209 MB).
 */
export const PSI_ROUND_FIXED_BYTES = 271_000_000;

/**
 * The set size a side the heap ceiling is sized for: the protocol's per-set
 * maximum, 2^24 elements.
 */
export const PSI_TARGET_ELEMENTS = MAX_PSI_DECODE_ELEMENTS;

/**
 * The memory a PSI round over `elements` a side needs, in bytes, at the
 * measured per-element cost plus the fixed part.
 */
export function psiRoundMemoryNeedBytes(elements: number): number {
  return PSI_ROUND_FIXED_BYTES + elements * PSI_ROUND_BYTES_PER_ELEMENT;
}

/**
 * The heap ceiling the PSI engine runs under, in bytes: what a round over
 * {@link PSI_TARGET_ELEMENTS} a side needs.
 */
export const PSI_HEAP_CEILING_BYTES =
  psiRoundMemoryNeedBytes(PSI_TARGET_ELEMENTS);

/**
 * {@link PSI_HEAP_CEILING_BYTES} in the MiB `--max-old-space-size` takes,
 * rounded up. The container entrypoint states the same value, which a unit
 * test holds.
 */
export const PSI_HEAP_CEILING_MIB = Math.ceil(PSI_HEAP_CEILING_BYTES / 2 ** 20);

/** The V8 flag that sets a heap limit of {@link PSI_HEAP_CEILING_MIB}. */
export const PSI_HEAP_CEILING_FLAG = `--max-old-space-size=${PSI_HEAP_CEILING_MIB}`;

/**
 * Raise the V8 old-generation limit that PSI workers started after this call
 * get to {@link PSI_HEAP_CEILING_MIB}, unless this process already runs under
 * a larger one. A worker's `resourceLimits` and `execArgv` cannot do this on
 * Node 26.10; the flag set here is read when a worker's heap is
 * created, and leaves this thread's own limit as it is.
 */
export function raisePsiWorkerHeapLimit(): void {
  if (getHeapStatistics().heap_size_limit >= PSI_HEAP_CEILING_MIB * 2 ** 20)
    return;
  setFlagsFromString(PSI_HEAP_CEILING_FLAG);
}

/** The memory figures a run's budget is checked against, in bytes. */
export interface MemoryReadings {
  /** The heap limit of the thread the PSI engine runs in. */
  engineHeapLimitBytes: number;
  /** Whether the PSI engine runs in a worker rather than on the main thread. */
  engineInWorker: boolean;
  /** The heap limit of this process's main thread, as measured. */
  mainThreadHeapLimitBytes: number;
  /** The host's total memory. */
  hostBytes: number;
  /** The container's memory limit, or `undefined` when none is set. */
  containerLimitBytes: number | undefined;
}

/**
 * Read this process's {@link MemoryReadings} from the runtime snapshot the run
 * banner states. `engineInWorker` says whether the PSI engine runs in a
 * worker, which {@link raisePsiWorkerHeapLimit} raises, or on this thread,
 * which keeps the process's own limit. The container limit is Node's
 * `process.constrainedMemory()`, the cgroup memory limit, counted only when
 * it is below the host's memory.
 */
export function readMemory(
  engineInWorker: boolean,
  snapshot: RuntimeEnvSnapshot = readRuntimeEnv(),
): MemoryReadings {
  const { heapLimitBytes, hostMemBytes, constrainedMemBytes } = snapshot;
  return {
    engineHeapLimitBytes: engineInWorker
      ? Math.max(heapLimitBytes, PSI_HEAP_CEILING_MIB * 2 ** 20)
      : heapLimitBytes,
    engineInWorker,
    mainThreadHeapLimitBytes: heapLimitBytes,
    hostBytes: hostMemBytes,
    containerLimitBytes:
      constrainedMemBytes > 0 && constrainedMemBytes < hostMemBytes
        ? constrainedMemBytes
        : undefined,
  };
}

/** What a run needs against what it has, from {@link assessPsiMemory}. */
export interface PsiMemoryAssessment {
  /** The records this party's input holds, the element count the need is for. */
  records: number;
  /** {@link psiRoundMemoryNeedBytes} of {@link records}. */
  needBytes: number;
  /** The least of the engine's heap limit, host memory and container limit. */
  availableBytes: number;
  /** Which figure {@link availableBytes} is. */
  limitedBy: "heap" | "host" | "container";
  /** The readings the assessment was made from. */
  readings: MemoryReadings;
}

/** Compare a round over `records` elements with the memory `readings` report. */
export function assessPsiMemory(
  records: number,
  readings: MemoryReadings,
): PsiMemoryAssessment {
  const candidates: Array<[PsiMemoryAssessment["limitedBy"], number]> = [
    ["heap", readings.engineHeapLimitBytes],
    ["host", readings.hostBytes],
  ];
  if (readings.containerLimitBytes !== undefined)
    candidates.push(["container", readings.containerLimitBytes]);
  const [limitedBy, availableBytes] = candidates.reduce((least, next) =>
    next[1] < least[1] ? next : least,
  );
  return {
    records,
    needBytes: psiRoundMemoryNeedBytes(records),
    availableBytes,
    limitedBy,
    readings,
  };
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

const LIMIT_NAMES: Record<PsiMemoryAssessment["limitedBy"], string> = {
  heap: "the PSI engine's heap limit",
  host: "this host's memory",
  container: "its container's memory limit",
};

/** The line every exchange logs once, before any network contact. */
export function psiMemoryStatement(assessment: PsiMemoryAssessment): string {
  const { readings } = assessment;
  const container =
    readings.containerLimitBytes === undefined
      ? "no container memory limit"
      : `container memory limit ${gigabytes(readings.containerLimitBytes)}`;
  const mainThread = gigabytes(readings.mainThreadHeapLimitBytes);
  const limits = readings.engineInWorker
    ? `the PSI engine runs in a worker thread under a heap limit of ` +
      `${gigabytes(readings.engineHeapLimitBytes)}, and this process's main ` +
      `thread, which reads the input, under ${mainThread}`
    : `the PSI engine runs on this process's main thread under a heap ` +
      `limit of ${mainThread}`;
  return (
    `memory: ${limits}; a round over this run's ` +
    `${formatCount(assessment.records)} records needs about ` +
    `${gigabytes(assessment.needBytes)}, and this process has ` +
    `${gigabytes(assessment.availableBytes)} (host memory ` +
    `${gigabytes(readings.hostBytes)}, ${container})`
  );
}

function shortfallSentence(assessment: PsiMemoryAssessment): string {
  return (
    `this run needs about ${gigabytes(assessment.needBytes)} of memory for a ` +
    `PSI round over its ${formatCount(assessment.records)} ` +
    `records, and this process has ${gigabytes(assessment.availableBytes)} ` +
    `(${LIMIT_NAMES[assessment.limitedBy]})`
  );
}

/** The refusal for a run whose need is over what the process has. */
export function psiMemoryShortfallMessage(
  assessment: PsiMemoryAssessment,
): string {
  return (
    `${shortfallSentence(assessment)}. Give the run more memory -- a larger ` +
    `host, or a larger docker run --memory -- or split the input into ` +
    `smaller files and run one exchange for each. Pass ` +
    `--allow-memory-shortfall to run anyway; the exchange may then run out ` +
    `of memory partway through, which fails it for both parties.`
  );
}

/** The warning for a run {@link psiMemoryShortfallMessage} would refuse, run under the override. */
export function psiMemoryShortfallOverrideWarning(
  assessment: PsiMemoryAssessment,
): string {
  return (
    `running with --allow-memory-shortfall: ${shortfallSentence(assessment)}. ` +
    `The exchange may run out of memory partway through, which fails it for ` +
    `both parties.`
  );
}

/**
 * Log this run's memory statement -- at debug when the process has what the
 * round needs, at info when it does not -- and hold its need to what the
 * process has: a need over it is a {@link UsageError} naming both figures and
 * the override, or, with `allowShortfall`, a warning passed to
 * `onShortfallWarning` and the run continues. Returns the assessment.
 */
export function checkPsiMemoryBudget(params: {
  records: number;
  allowShortfall: boolean;
  readings: MemoryReadings;
  log: {
    debug: (message: string) => void;
    info: (message: string) => void;
  };
  onShortfallWarning: (message: string) => void;
}): PsiMemoryAssessment {
  const assessment = assessPsiMemory(params.records, params.readings);
  if (assessment.needBytes <= assessment.availableBytes) {
    params.log.debug(psiMemoryStatement(assessment));
    return assessment;
  }
  params.log.info(psiMemoryStatement(assessment));
  if (!params.allowShortfall)
    throw new UsageError(psiMemoryShortfallMessage(assessment));
  params.onShortfallWarning(psiMemoryShortfallOverrideWarning(assessment));
  return assessment;
}

function partnerShortfallSentence(assessment: PsiMemoryAssessment): string {
  return (
    `your partner's set for one linkage key can hold up to ` +
    `${formatCount(assessment.records)} values, a PSI round over ` +
    `that many needs about ${gigabytes(assessment.needBytes)} of memory, and ` +
    `this process has ${gigabytes(assessment.availableBytes)} ` +
    `(${LIMIT_NAMES[assessment.limitedBy]})`
  );
}

/** The refusal for a partner round whose need is over what the process has. */
export function partnerRoundMemoryShortfallMessage(
  assessment: PsiMemoryAssessment,
): string {
  return (
    `${partnerShortfallSentence(assessment)}, so the exchange stopped before ` +
    `any linkage key was sent and told your partner. Run the exchange on a ` +
    `host with more memory, or with a larger docker run --memory, or ask ` +
    `your partner to split their input into smaller files and run one ` +
    `exchange for each. Pass --allow-memory-shortfall to run anyway; the ` +
    `exchange may then run out of memory partway through, which fails it ` +
    `for both parties.`
  );
}

/**
 * The warning for a run {@link partnerRoundMemoryShortfallMessage} would
 * refuse, run under the override.
 */
export function partnerRoundMemoryShortfallOverrideWarning(
  assessment: PsiMemoryAssessment,
): string {
  return (
    `running with --allow-memory-shortfall: ` +
    `${partnerShortfallSentence(assessment)}. The exchange may run out of ` +
    `memory partway through, which fails it for both parties.`
  );
}

/**
 * Hold the partner's round to what the process has, once the terms are
 * exchanged: `partnerRoundValues` is an upper bound on the values a
 * conforming partner's set for one linkage key holds, weighed at
 * {@link psiRoundMemoryNeedBytes} as the pre-contact check weighs this party's
 * own records. A need over it is a {@link RoundCapacityError} naming both
 * figures and the override, or, with `allowShortfall`, a warning passed to
 * `onShortfallWarning` and the run continues.
 */
export function checkPartnerRoundMemory(params: {
  partnerRoundValues: number;
  allowShortfall: boolean;
  readings: MemoryReadings;
  onShortfallWarning: (message: string) => void;
}): PsiMemoryAssessment {
  const assessment = assessPsiMemory(
    params.partnerRoundValues,
    params.readings,
  );
  if (assessment.needBytes <= assessment.availableBytes) return assessment;
  if (!params.allowShortfall)
    throw new RoundCapacityError(
      partnerRoundMemoryShortfallMessage(assessment),
      "terms-exchange",
    );
  params.onShortfallWarning(
    partnerRoundMemoryShortfallOverrideWarning(assessment),
  );
  return assessment;
}
