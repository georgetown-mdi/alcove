/**
 * The pure model behind the managed exchange's command-line export panel: whether
 * a stored record can be exported at all, and the command and schedule lines
 * that run the composed invocation unattended. No React, no store, no download
 * -- the panel stays thin over this.
 *
 * The exportability decision is NOT re-derived here. The composer
 * ({@link composeManagedCronExport}) is the one place that decides which stored
 * documents may become an `alcove.yaml`, and it refuses by throwing; this model
 * calls it and presents the refusal, so a second copy of the rule cannot drift
 * from the one the export actually enforces.
 *
 * The schedule lines are composed from the record's agreed schedule, which does
 * not travel in the files: a cron entry or a Task Scheduler trigger is how a
 * command-line run repeats. A record with no schedule gets a daily example the
 * operator edits. The lines run Alcove's published image over the folder by
 * default, with an installed `alcove` as the alternative, as the console's
 * hand-off does ({@link ./scheduledRunCommand.ts}).
 */

import { sanitizeErrorForDisplay } from "@alcove/core";

import {
  buildImageReference,
  unmountableBindPaths,
} from "@psi/dockerRunCommand";
import {
  composeManagedCronExport,
  composeManagedCronExportConfig,
} from "@psi/managed/managedCronExport";

import {
  bindPathsCaveat,
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  installedCronLine,
  installedRunCommand,
  unmountableBindPathsNotice,
} from "./scheduledRunCommand";
import {
  runScheduleFor,
  scheduleDescription,
  scheduleNote,
} from "./scheduleTemplates";

import type {
  ManagedCommandLineConfig,
  ManagedCronExport,
} from "@psi/managed/managedCronExport";
import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

/**
 * The STUN server the exported invocation falls back to, disclosed on the panel
 * because a managed connection configures no ICE server of its own: every
 * scheduled run tells this server the scheduling host's public address. It is
 * werift's built-in default (`WERIFT_BUILT_IN_STUN_URI` in
 * apps/cli/src/connection/webrtc/weriftPeer.ts);
 * `npm run check:stun-default-claims` holds this copy to that one, since an app
 * may not import from another app. Not the web app's own ICE list
 * (`@psi/transport/rendezvous`), which is a different list for exchanges this browser runs
 * itself.
 */
export const CLI_BUILT_IN_STUN_URI = "stun:stun.l.google.com:19302";

/** The command and schedule lines running a composed export. */
export interface ScheduledRunLines {
  /** The command running the export once: the image over the folder, or an
   * installed `alcove` where a path cannot be mounted. Undefined where a path
   * holds a control or text-direction character. */
  runCommand: string | undefined;
  /** The cron line running the image, undefined where a path cannot be
   * mounted. */
  dockerCronLine: string | undefined;
  /** The Task Scheduler command running the image, undefined where a path
   * cannot be mounted. */
  dockerTaskSchedulerLine: string | undefined;
  /** The cron line running an installed `alcove` from the folder. Undefined
   * where a path holds a control or text-direction character, which withholds
   * every line. */
  installedCronLine: string | undefined;
  /** When the lines run, as a phrase ("daily at 2am"). */
  schedule: string;
  /** Whether the lines run on the record's agreed schedule, rather than a
   * daily example. */
  fromAgreedSchedule: boolean;
  /** What to check about the schedule's times, where the record has one. */
  scheduleNote: string | undefined;
  /** Why the image lines, or every line, are not shown, where a path cannot
   * be mounted. */
  unmountableNotice: string | undefined;
  /** The paths the image lines mount besides the folder, where there are
   * any and the lines are shown. */
  bindPathsCaveat: string | undefined;
}

/**
 * What a panel renders for a record: the composed export and the lines that
 * run it, or the composer's own reason for refusing it. `composed` holds the
 * two files on the hand-off panel and the configuration file alone for a
 * record that holds no secret, which is what each panel's own composer
 * decides.
 */
type ManagedCronExportPanelState<TComposed extends ManagedCommandLineConfig> =
  | ({
      kind: "exportable";
      /** What the composer produced. */
      composed: TComposed;
    } & ScheduledRunLines)
  | {
      kind: "refused";
      /** The composer's reason, escaped for display: it names the stored fields
       * that put the record outside what the app composes, and a stored document
       * can hold names this app did not author (an imported artifact's). */
      reason: string;
    };

/** The command running `composed` once, and why lines are withheld where a
 * path it names cannot be mounted. */
export interface ExportRun {
  /** `image` over the folder, or an installed `alcove` where a path cannot be
   * mounted; undefined where a path holds a control or text-direction
   * character. */
  runCommand: string | undefined;
  unmountableNotice: string | undefined;
}

/** The command running `composed` once from `image`, and why lines are
 * withheld where a path it names cannot be mounted. */
export function exportRun(
  composed: ManagedCommandLineConfig,
  image: string = buildImageReference(),
): ExportRun {
  const source = { argv: composed.argv, bindPaths: composed.bindPaths, image };
  const unmountable = unmountableBindPaths(composed.bindPaths);
  return {
    runCommand: dockerRunCommand(source) ?? installedRunCommand(source),
    unmountableNotice:
      unmountable.length > 0
        ? unmountableBindPathsNotice(unmountable)
        : undefined,
  };
}

/** The lines running `composed` on `record`'s agreed schedule, from `image`. */
function scheduledRunLines(
  composed: ManagedCommandLineConfig,
  record: ManagedExchangeRecord,
  image: string,
): ScheduledRunLines {
  const source = {
    argv: composed.argv,
    bindPaths: composed.bindPaths,
    image,
  };
  const schedule =
    record.schedule === undefined ? undefined : runScheduleFor(record.schedule);
  const unmountable = unmountableBindPaths(composed.bindPaths);
  return {
    ...exportRun(composed, image),
    dockerCronLine: dockerCronLine(source, schedule),
    dockerTaskSchedulerLine: dockerTaskSchedulerLine(source, schedule),
    installedCronLine: installedCronLine(source, schedule),
    schedule: scheduleDescription(schedule),
    fromAgreedSchedule: schedule !== undefined,
    scheduleNote: scheduleNote(schedule),
    bindPathsCaveat:
      unmountable.length === 0 && composed.bindPaths.length > 0
        ? bindPathsCaveat(composed.bindPaths)
        : undefined,
  };
}

/** Compose through `compose`, presenting its refusal rather than re-deriving the
 * rule, and add the lines the composed command runs under. */
function exportPanelState<TComposed extends ManagedCommandLineConfig>(
  record: ManagedExchangeRecord,
  compose: () => TComposed,
  image: string,
): ManagedCronExportPanelState<TComposed> {
  let composed: TComposed;
  try {
    composed = compose();
  } catch (error) {
    return { kind: "refused", reason: sanitizeErrorForDisplay(error) };
  }
  return {
    kind: "exportable",
    composed,
    ...scheduledRunLines(composed, record, image),
  };
}

/**
 * Derive the hand-off panel's state for `record`, composed against `readOwn`,
 * the relay settings read the panel's download composes against too. A record
 * the composer refuses -- a stored connection on another channel, or a
 * document holding anything the app could not have composed -- yields the
 * refusal and its reason; anything else yields the composed export and the
 * lines that run it, naming `image`.
 */
export function managedCronExportPanelState(
  record: RunnableManagedExchangeRecord,
  readOwn: () => OwnRelayRead,
  image: string = buildImageReference(),
): ManagedCronExportPanelState<ManagedCronExport> {
  return exportPanelState(
    record,
    () => composeManagedCronExport(record, readOwn),
    image,
  );
}

/**
 * The same for a configuration-only record: the `alcove.yaml` half alone, the
 * key file it runs under having stayed on the machine that holds it.
 */
export function managedConfigurationExportState(
  record: ManagedExchangeRecord,
  image: string = buildImageReference(),
): ManagedCronExportPanelState<ManagedCommandLineConfig> {
  return exportPanelState(
    record,
    () => composeManagedCronExportConfig(record),
    image,
  );
}
