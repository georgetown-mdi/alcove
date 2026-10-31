// The retain-mode start-up ignore list: the protocol files an earlier exchange
// left in a reused directory, which a run treats as absent and never deletes.
// Specified in docs/spec/FILE_SYNC.md, "Reusing a retain-mode directory".

import type { FileInfo } from "./fileSyncConnection";
import { isMessageName, parseSizedControlName } from "./fileSyncNames";

const ACK_SUFFIX = "-ack.json";
const HELLO_STEM_END = /-hello-\d+$/;

/**
 * The stems (`<id>-hello-<n>`) of the hellos some ack in `names` answers. An
 * ack of a hello is `<writer>-<id>-hello-<n>-ack.json` and either id may hold
 * `-`, so every split leaving a non-empty writer and a non-empty id counts.
 *
 * @internal
 */
export function answeredHelloStems(names: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(ACK_SUFFIX)) continue;
    const acked = name.slice(0, -ACK_SUFFIX.length);
    if (!HELLO_STEM_END.test(acked)) continue;
    for (
      let dash = acked.indexOf("-", 1);
      dash !== -1;
      dash = acked.indexOf("-", dash + 1)
    ) {
      const stem = acked.slice(dash + 1);
      if (parseSizedControlName(`${stem}.json`)?.id) stems.add(stem);
    }
  }
  return stems;
}

/** A file the start-up scan ignores, and the directory it was listed in. */
export interface IgnoredLeftover {
  file: FileInfo;
  outbound: boolean;
}

/** What {@link classifyRetainLeftovers} decides for one start-up scan. */
export interface RetainLeftovers {
  /** Every file ignored for the run, in either directory. */
  ignored: IgnoredLeftover[];
  /**
   * The partner hellos among `ignored` that nobody answered and that are
   * older than the window.
   */
  unansweredHellos: FileInfo[];
  /**
   * A file showing an earlier exchange answered a hello under this run's own
   * hello name, or undefined. Its acks would answer this run's hello.
   */
  ownNameAnswered: string | undefined;
}

/**
 * Splits the protocol files a retain-mode start-up scan found into those
 * ignored for the run and the rest, which the entry guard judges as before.
 * Ignored: every message, ack and abort marker under a non-empty id, and every
 * hello some ack answers; a partner hello nobody answered is ignored only when
 * its age, measured from its modification time, exceeds `windowMs` (undefined
 * never ignores one). A hello under an id this party writes that nobody
 * answered is never ignored. `listed` holds every name in both directories,
 * where the acks that answer a hello may be.
 *
 * @internal
 */
export function classifyRetainLeftovers(input: {
  inbound: ReadonlyArray<FileInfo>;
  outbound: ReadonlyArray<FileInfo>;
  listed: ReadonlyArray<string>;
  ownHelloName: string;
  isOwnId: (id: string) => boolean;
  windowMs: number | undefined;
  now: number;
}): RetainLeftovers {
  const answered = answeredHelloStems(input.listed);
  const ignored: IgnoredLeftover[] = [];
  const unansweredHellos: FileInfo[] = [];
  const consider = (file: FileInfo, outbound: boolean): void => {
    const { name } = file;
    if (name.endsWith(ACK_SUFFIX) || isMessageName(name)) {
      ignored.push({ file, outbound });
      return;
    }
    const control = parseSizedControlName(name);
    if (control === undefined || control.id.length === 0) return;
    if (control.type === "abort") {
      ignored.push({ file, outbound });
      return;
    }
    if (control.type !== "hello") return;
    if (answered.has(name.slice(0, -".json".length))) {
      ignored.push({ file, outbound });
      return;
    }
    if (outbound || input.isOwnId(control.id)) return;
    if (
      input.windowMs !== undefined &&
      input.now - file.modifyTime > input.windowMs
    ) {
      ignored.push({ file, outbound });
      unansweredHellos.push(file);
    }
  };
  for (const file of input.inbound) consider(file, false);
  for (const file of input.outbound) consider(file, true);
  const ownAckSuffix = `-${input.ownHelloName.slice(0, -".json".length)}${ACK_SUFFIX}`;
  return {
    ignored,
    unansweredHellos,
    ownNameAnswered: input.listed.find(
      (name) =>
        name.endsWith(ownAckSuffix) && name.length > ownAckSuffix.length,
    ),
  };
}
