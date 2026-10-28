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

import {
  runEnrollsAtInvitationRegistrar,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  composeManagedCronExport,
  composeManagedCronExportConfig,
} from "@psi/managed/managedCronExport";
import { buildImageReference } from "@psi/dockerRunCommand";

import { bindPathsCaveat, runLines } from "./scheduledRunCommand";
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
import type {
  RunLines,
  ShownRunLines,
  WithheldRunLines,
} from "./scheduledRunCommand";
import type { ConnectionConfig } from "@alcove/core";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";
import type { RunSchedule } from "./scheduleTemplates";

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

/**
 * Which STUN servers a command-line run of `connection`, the connection the
 * export writes, contacts and what they learn: the ones its `invitation_relay`
 * names, which the partner chose and so are escaped, or the built-in default
 * where it names none. The export writes no `stun` entry of its own.
 */
export function stunExportLine(
  connection: ConnectionConfig,
  configFileName: string,
): string {
  const named =
    connection.channel === "webrtc"
      ? (connection.invitationRelay?.stun ?? [])
      : [];
  if (named.length > 0)
    return (
      "A command-line run of this exchange uses the STUN servers the " +
      `invitation names (${named.map((url) => sanitizeForDisplay(url)).join(", ")}) to ` +
      "discover the public address of the machine it runs on. Each learns " +
      "that address and that a session is happening; none learns exchange " +
      "content."
    );
  return (
    "This exchange names no STUN server, so a command-line run uses the " +
    `built-in default (${CLI_BUILT_IN_STUN_URI}) to discover the public ` +
    "address of the machine it runs on. That server learns the address and " +
    "that a session is happening; it learns no exchange content. Add a " +
    `stun entry to the connection in ${configFileName} to use your own ` +
    "server instead."
  );
}

/**
 * The line an export shows where `connection`, the connection the export
 * writes, has an `invitation_relay` naming a registrar: whether a
 * command-line run of it enrolls there, as the CLI decides it
 * ({@link runEnrollsAtInvitationRegistrar}); `undefined` where it names none.
 * The registrar is the partner's choice, so it is escaped.
 */
export function invitationRegistrarExportLine(
  connection: ConnectionConfig,
): string | undefined {
  if (connection.channel !== "webrtc") return undefined;
  const registrar = connection.invitationRelay?.registrar;
  if (registrar === undefined) return undefined;
  if (runEnrollsAtInvitationRegistrar(connection))
    return (
      "A command-line run of this exchange registers at " +
      `${sanitizeForDisplay(registrar)} before it connects, and whoever ` +
      "runs that registrar then learns the network address of the machine " +
      "it runs on."
    );
  return (
    "A command-line run of this exchange does not contact the registrar at " +
    `${sanitizeForDisplay(registrar)}: it uses your own relay, which comes ` +
    "first in the file."
  );
}

/** The command and schedule lines running a composed export, or why none is
 * shown ({@link RunLines}). */
export type ScheduledRunLines = WithheldRunLines | ShownScheduledRunLines;

/** The lines of a composed export where they are shown, and their schedule. */
export interface ShownScheduledRunLines extends ShownRunLines {
  /** When the lines run, as a phrase ("daily at 2am"). */
  schedule: string;
  /** What to check about the schedule's times, where the record has one. */
  scheduleNote: string | undefined;
  /** The paths the image lines mount besides the folder, where there are
   * any and the image lines are shown. */
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
  | {
      kind: "exportable";
      /** What the composer produced. */
      composed: TComposed;
      /** Whether the lines run on the record's agreed schedule, rather than a
       * daily example. */
      fromAgreedSchedule: boolean;
      lines: ScheduledRunLines;
    }
  | {
      kind: "refused";
      /** The composer's reason, escaped for display: it names the stored fields
       * that put the record outside what the app composes, and a stored document
       * can hold names this app did not author (an imported artifact's). */
      reason: string;
    };

/**
 * The notice beside each export, the backup and the command-line files:
 * running the exchange elsewhere rotates its secret, so this browser's copy
 * runs again only once the newer files are imported. Where this copy has a
 * schedule on, its runs would rotate the secret too, so the notice also says
 * to turn the schedule off here.
 */
export function runElsewhereNotice(scheduleOn: boolean): string {
  return scheduleOn
    ? "If you run this exchange elsewhere, turn off its schedule here; to " +
        "use it here later, import it again."
    : "If you run this exchange elsewhere, import it again to use it here " +
        "later.";
}

/** The note beside both downloads while a run of this exchange is in flight:
 * the run replaces the secret a download then holds. Names every context a run
 * can be in, since the operator reading it may not have started it. */
export const RUN_IN_FLIGHT_EXPORT_NOTE =
  "This exchange is running right now - in this browser, in another tab, or " +
  "on its schedule. A download now holds the shared secret that run " +
  "replaces, so download it again once the run ends.";

/** What neither export takes with it, shown beside both: the accounting of
 * disclosures is kept in this browser and is in no exported file. */
export const EXPORT_LEAVES_ACCOUNTING_NOTE =
  "This exchange's accounting of disclosures stays in this browser and is " +
  "not included in this download. To keep a copy of it, export the " +
  "accounting as CSV.";

/** The lines running `composed` on `schedule`, from `image`. */
function scheduledRunLines(
  composed: ManagedCommandLineConfig,
  schedule: RunSchedule | undefined,
  image: string,
): ScheduledRunLines {
  const lines = runLines(
    { argv: composed.argv, bindPaths: composed.bindPaths, image },
    schedule,
  );
  if (lines.kind === "withheld") return lines;
  return {
    ...lines,
    schedule: scheduleDescription(schedule),
    scheduleNote: scheduleNote(schedule),
    bindPathsCaveat:
      lines.dockerLinesNotice === undefined && composed.bindPaths.length > 0
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
  const schedule =
    record.schedule === undefined ? undefined : runScheduleFor(record.schedule);
  return {
    kind: "exportable",
    composed,
    fromAgreedSchedule: schedule !== undefined,
    lines: scheduledRunLines(composed, schedule, image),
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
