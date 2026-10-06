import {
  PREVIOUS_CONFIGURATION_FILE_NAME,
  isJobChannel,
} from "@jobs/intentSchemas";
import { retiredSettingNotice } from "@alcove/core";
import { workingFolderCommand } from "@psi/dockerRunCommand";

import {
  HELD_TERMS_SETTINGS,
  authoringStateFromDocument,
  termsSettingsWithNoControl,
} from "./loadedConfig";

import type {
  ConfigurationHandBackAnswer,
  MountedConfigurationAnswer,
} from "@psi/jobClient/mountedConfigClient";
import type { JobChannel, JobConfigurationHandBack } from "@jobs/intentSchemas";
import type { LoadedAuthoringState } from "./loadedConfig";
import type { ReceiptsSigningMode } from "@psi/receiptsModel";

/**
 * The console's offer to open the command-line configuration sitting in its
 * mounted working folder, as a value: what the control shows, what the operator
 * is told beside it, and the authoring state a successful load hands the
 * screen. No React and no I/O -- the fetch runs in the screen and reports its
 * answer here.
 *
 * Every notice names SETTINGS ONLY, as the file spells them. A setting's value
 * can be a credential, which is why the server names rather than sends the two
 * lists ({@link ../jobs/configLoad}), and nothing here reverses that.
 *
 * The two records whose absence turns an enforcement off have no control on
 * the invitation-authoring path this offer sits in. A document stating one is
 * opened with its value held: the record rides the authoring state into the
 * intent the run submits, so the configuration composed for that run states it
 * exactly as the file did (docs/spec/EXCHANGE_FILE.md, "The records that must
 * survive"). Having no control, each one is named in the carry-through notice.
 *
 * A configuration on a channel the console does not conduct opens all the same:
 * the steps below start from it and save back into its file, and the run is
 * withheld by the one derived field {@link runWithheldReason} reads, which
 * names the channel.
 */

/** The channel a configuration the console can open runs over. */
export type LoadedChannel = LoadedAuthoringState["channel"];

/** A channel the console opens a configuration on but does not conduct. */
type UnconductedChannel = Exclude<LoadedChannel, JobChannel>;

/** A conducted channel this console can be left with nothing to run over: a
 * shared folder needs its own mount, while SFTP is always offered, since
 * the operator authors its connection in the console. */
export type UnofferedChannel = Extract<JobChannel, "filedrop">;

/** What the load control shows. */
export type MountedConfigurationState =
  /** Nothing read yet: the control offers the load. */
  | { status: "unread" }
  /** A read is in flight. */
  | { status: "reading" }
  /** The mount holds no configuration, so authoring starts from an empty form. */
  | { status: "absent" }
  /** The read did not answer, and the offer stands so the operator can retry. */
  | { status: "unavailable" }
  /** The configuration is open, and these are the notices beside it.
   * `transportUnavailable` is the channel the file runs over where this console
   * has nothing to run it over, so the transport stays where the review step
   * had it; `notApplied` names the settings the operator's own input file could
   * not supply and `notCovered` the settings whose own column set does not
   * reach every column that file has, both settled once the held terms reach
   * it. `notConducted` is the file's channel where the console conducts no
   * exchange over it at all, derived once at the read: it withholds the run and
   * replaces every notice about the run with the one naming the channel.
   * `signingPaths` and `folderPaths` are the paths the file states that a
   * conversion replaces with the console's own, and `converted` is the
   * operator's choice to convert: until then the hand-off states those paths as
   * read, and a signed run is withheld while `signingPaths` names any
   * ({@link unconvertedSigningWithheldReason}). `relayEnrollment` is a file
   * naming `connection.relay_registrar` ({@link RELAY_ENROLLMENT_NOTICE}).
   * `keyFileFault` is why the `.alcove.key` beside the file would refuse its
   * run ({@link keyFileNotice}), `retiredSettings` the settings the file
   * states that Alcove no longer reads ({@link retiredSettingsNotices}), and
   * `newInvitation` the operator's choice to create a new invitation from the
   * file's settings instead ({@link withNewInvitation}). */
  | {
      status: "opened";
      carriedThrough: Array<string>;
      warnings: Array<string>;
      signingPaths?: Array<string>;
      folderPaths?: Array<string>;
      converted?: true;
      relayEnrollment?: true;
      keyFileFault?: "absent" | "invalid";
      retiredSettings?: Array<string>;
      newInvitation?: true;
      notConducted?: UnconductedChannel;
      transportUnavailable?: UnofferedChannel;
      notApplied?: Array<string>;
      notCovered?: Array<string>;
    }
  /** The console refused the file, in the words the read answered with. */
  | { status: "refused"; error: string };

/** The state the offer starts in, before any read. */
export const MOUNTED_CONFIGURATION_UNREAD: MountedConfigurationState = {
  status: "unread",
};

/** The control's label, naming the folder rather than a path: the browser is
 * never shown one inside the container. */
export const OPEN_CONFIGURATION_LABEL = "Open the configuration in my folder";

/** What the control says while nothing has been read. */
export const OPEN_CONFIGURATION_INVITATION =
  "If you already run this exchange with Alcove on the command line, open " +
  "its alcove.yaml from your working folder and every step below starts " +
  "from it.";

/** What the control says for a mount holding no configuration. Not a fault: a
 * console whose operator has authored nothing yet is the ordinary first run. */
export const NO_CONFIGURATION_IN_FOLDER =
  "There is no alcove.yaml in your working folder, so this exchange is " +
  "authored here from the start.";

/** What the control says for a read that did not answer. */
export const CONFIGURATION_READ_UNAVAILABLE =
  "The console could not read your working folder. Nothing below has " +
  "changed; try opening the configuration again.";

/** What the control says once an invitation is minted from terms the console
 * already holds: the load fills the steps below it, and those are sealed, so
 * the offer is withheld rather than shown as a read that would change nothing. */
export const CONFIGURATION_LOAD_SEALED =
  "This exchange's invitation is already created. Start a new exchange to " +
  "open a configuration.";

/** What the review and run steps say for a run of the opened configuration:
 * it uses the key file beside that configuration, so no invitation is sent. */
export const OPENED_EXCHANGE_CONTINUES =
  "This run continues the exchange your alcove.yaml set up, under the " +
  ".alcove.key beside it. No new invitation is made: your partner runs " +
  "their side as they usually do.";

/** The label of the control that turns an opened configuration whose key
 * file is missing into a new invitation built from its settings. */
export const CREATE_INVITATION_FROM_SETTINGS_LABEL =
  "Create an invitation from these settings";

/**
 * What the operator is told on opening a configuration whose `.alcove.key`
 * would refuse its run, or undefined where the key file is usable or a new
 * invitation was already chosen ({@link withNewInvitation}). Offers the two ways
 * on: put the key file back, or make a new invitation from the settings.
 */
export function keyFileNotice(
  state: MountedConfigurationState,
): { title: string; message: string } | undefined {
  if (
    state.status !== "opened" ||
    state.keyFileFault === undefined ||
    state.newInvitation === true
  )
    return undefined;
  const choice =
    `or choose ${CREATE_INVITATION_FROM_SETTINGS_LABEL}: the steps below keep ` +
    "this configuration's terms and connection, and your partner accepts the " +
    "new invitation to start a new exchange with you.";
  if (state.keyFileFault === "absent")
    return {
      title: "Your folder has no .alcove.key for this configuration",
      message:
        "A run of this configuration continues the exchange it set up, " +
        "under the .alcove.key beside alcove.yaml, and there is none in your " +
        "folder. Put that key file back beside alcove.yaml and open the " +
        `configuration again, ${choice}`,
    };
  return {
    title: "The .alcove.key in your folder cannot be read",
    message:
      "A run of this configuration continues the exchange it set up, under " +
      "the .alcove.key beside alcove.yaml, and that file is not a key file " +
      "Alcove can read. Check that it is a regular file with read " +
      "permission, holding the key Alcove wrote for this exchange, and open " +
      `the configuration again, ${choice}`,
  };
}

/** What the operator is told once they chose a new invitation from the opened
 * configuration's settings. */
export const NEW_INVITATION_FROM_SETTINGS =
  "This exchange creates a new invitation from your configuration's terms " +
  "and connection. Send it to your partner: they accept it to start a new " +
  "exchange with you.";

/** The opened configuration taken as the settings of a new invitation rather
 * than an exchange to continue. Any other state, and a configuration the
 * console does not conduct, is returned unchanged. */
export function withNewInvitation(
  state: MountedConfigurationState,
): MountedConfigurationState {
  if (state.status !== "opened" || state.notConducted !== undefined)
    return state;
  return { ...state, newInvitation: true };
}

/** Whether a run of this exchange continues the exchange the opened
 * configuration set up, under the key file beside it, rather than making a new
 * invitation. */
export function runsOpenedConfiguration(
  state: MountedConfigurationState,
): boolean {
  return state.status === "opened" && state.newInvitation !== true;
}

/** The review step's start action for a run of the opened configuration. */
export const START_OPENED_EXCHANGE_LABEL = "Start the exchange";

/** The label of the control that closes an open configuration. */
export const CLOSE_CONFIGURATION_LABEL = "Close this configuration";

/** What the control says once a configuration is open. */
export const CONFIGURATION_OPENED =
  "Opened the configuration in your folder. Every step below starts from it, " +
  "and you can change anything before you run the exchange.";

/** What the control says once a configuration the console cannot run is open. */
export const CONFIGURATION_OPENED_FOR_REVIEW =
  "Opened the configuration in your folder. Every step below starts from it, " +
  "and you can change anything before you save it back.";

/** The line under the open control for an opened state. */
export function configurationOpenedMessage(
  state: MountedConfigurationState,
): string {
  return state.status === "opened" && state.notConducted !== undefined
    ? CONFIGURATION_OPENED_FOR_REVIEW
    : CONFIGURATION_OPENED;
}

/** What the operator is told beside the load about a configuration on a channel
 * the console does not conduct, naming the channel as the file spells it. */
export function channelNotConductedNotice(channel: UnconductedChannel): string {
  return (
    `This configuration runs over ${channel}, and the console runs SFTP ` +
    "and shared-folder exchanges only. Change its settings in the steps below, " +
    `then save them to alcove.yaml on the review step: its ${channel} ` +
    "connection is kept exactly as your file states it. Run the saved file " +
    `with Alcove on the command line, which conducts ${channel} exchanges.`
  );
}

/** What the operator is told beside the load about a configuration naming
 * `connection.relay_registrar`. */
export const RELAY_ENROLLMENT_NOTICE =
  "If this exchange is not yet enrolled at your relay, enroll it before its " +
  "first run: after alcove invite or alcove accept has written its " +
  ".alcove.key, run alcove enroll-relay in the folder holding alcove.yaml " +
  "and that key file. The command asks for the relay-owner token, or reads " +
  "it from the first line of standard input when there is no terminal.";

/**
 * Why the review step withholds its run control, or undefined where nothing
 * open withholds it: a configuration on a channel the console does not
 * conduct. Read off the state the load derived once, so no run starts and then
 * fails on the channel.
 */
export function runWithheldReason(
  state: MountedConfigurationState,
): string | undefined {
  if (state.status !== "opened" || state.notConducted === undefined)
    return undefined;
  return (
    `The console cannot run this ${state.notConducted} configuration, ` +
    "because it runs SFTP and shared-folder exchanges only. Save your " +
    "changes to alcove.yaml, then run it with Alcove on the command line."
  );
}

/** The title of the warning an edit of an opened configuration's terms draws
 * ({@link editedTermsWarning}). */
export const EDITED_TERMS_TITLE = "Your partner holds the terms you opened";

/** The command making a terms update from the alcove.yaml in the operator's
 * working folder. Their partner's own command is named bare, since how the
 * partner runs Alcove is theirs. */
const TERMS_UPDATE_COMMAND = workingFolderCommand(["update"]);

/**
 * What the review step says when the terms the draft builds are not the terms
 * the opened configuration built (`termsEditedSinceOpened`): the partner holds
 * the file's terms and refuses an exchange wherever the two differ, and
 * `alcove update` with `alcove apply` is how both sides change them. The
 * operator can still start the run.
 *
 * Undefined where no edit reaches the partner that way: nothing is open, the
 * terms are unchanged, or the run makes a new invitation, which states the
 * edited terms itself. A configuration the console only saves back takes the
 * variant for the command-line run of the saved file.
 */
export function editedTermsWarning(
  state: MountedConfigurationState,
  {
    termsEdited,
    continuesOpenedExchange,
  }: { termsEdited: boolean; continuesOpenedExchange: boolean },
): string | undefined {
  if (state.status !== "opened" || !termsEdited) return undefined;
  const changed =
    "You changed the matching terms of the configuration you opened, and " +
    "your partner still holds its terms as they were. ";
  if (state.notConducted !== undefined)
    return (
      changed +
      "An exchange run from the file you save is refused until they apply " +
      `yours: after you save, run ${TERMS_UPDATE_COMMAND} and send what it ` +
      "prints to your partner to apply with alcove apply."
    );
  if (!continuesOpenedExchange) return undefined;
  return (
    changed +
    "This run is refused wherever the two differ. To run the terms your " +
    "partner holds, undo the change, or close the configuration and open it " +
    "again. To change the terms, edit alcove.yaml, run " +
    `${TERMS_UPDATE_COMMAND}, and send what it prints to your partner to ` +
    "apply with alcove apply."
  );
}

/** The label of the control that converts an opened configuration to the
 * console's own paths. */
export const CONVERT_CONFIGURATION_LABEL = "Use the console's paths";

/** The paths a conversion of the open configuration replaces, as the file
 * spells them: none for a state that is not an open configuration the console
 * conducts. */
export function pathsConversionReplaces(
  state: MountedConfigurationState,
): Array<string> {
  if (state.status !== "opened" || state.notConducted !== undefined) return [];
  return [...(state.signingPaths ?? []), ...(state.folderPaths ?? [])];
}

/** Whether the conversion is offered: an open configuration the console
 * conducts, stating a path the conversion replaces, not converted yet, and no
 * invitation minted from it. */
export function conversionOffered(
  state: MountedConfigurationState,
  sealed: boolean,
): boolean {
  return (
    !sealed &&
    state.status === "opened" &&
    state.newInvitation !== true &&
    state.converted !== true &&
    pathsConversionReplaces(state).length > 0
  );
}

/**
 * What the operator is told before converting, naming every setting the
 * conversion replaces as the file spells them, or undefined where none is
 * offered. A run uses the working folder either way; converting releases a
 * signed run and changes what the hand-off states.
 */
export function conversionStatement(
  state: MountedConfigurationState,
): string | undefined {
  if (
    state.status !== "opened" ||
    state.newInvitation === true ||
    state.converted === true
  )
    return undefined;
  const replaced = pathsConversionReplaces(state);
  if (replaced.length === 0) return undefined;
  const signs = (state.signingPaths ?? []).length > 0;
  const folders = (state.folderPaths ?? []).length > 0;
  const placeholders = nameList(replaced);
  const sentences = [
    replaced.length === 1
      ? `Your alcove.yaml sets its own path in ${nameList(replaced)}.`
      : `Your alcove.yaml sets its own paths in ${nameList(replaced)}.`,
  ];
  if (signs)
    sentences.push(
      "A run with a signed receipt waits until you convert, and then uses " +
        "the console's own signing identity.",
      "With the signed receipt off, this exchange runs unsigned, and the " +
        "configuration for scheduled runs keeps your file's signing settings.",
    );
  if (folders) sentences.push("The run here uses your folder either way.");
  sentences.push(
    signs
      ? "Converting also changes the configuration for scheduled runs."
      : "Converting changes only the configuration for scheduled runs.",
  );
  sentences.push(
    `That configuration then states a placeholder for ${placeholders}, ` +
      "to set on the machine you schedule from.",
  );
  return sentences.join(" ");
}

/** What the operator is told once the open configuration is converted. */
export function convertedStatement(
  state: MountedConfigurationState,
): string | undefined {
  if (
    state.status !== "opened" ||
    state.newInvitation === true ||
    state.converted !== true
  )
    return undefined;
  const replaced = nameList(pathsConversionReplaces(state));
  const signs = (state.signingPaths ?? []).length > 0;
  const sentences = [
    "Converted.",
    signs
      ? "The configuration for scheduled runs states the console's own " +
        `paths in place of ${replaced}, and a run with a signed receipt ` +
        "uses the console's signing identity."
      : "The configuration for scheduled runs states the console's own " +
        `paths in place of ${replaced}.`,
  ];
  if (signs)
    sentences.push(
      "With the signed receipt off, that configuration states no signing " +
        "settings at all.",
    );
  sentences.push(
    "To keep your file's own paths, close this configuration and open it " +
      "again.",
  );
  return sentences.join(" ");
}

/** The open configuration converted to the console's own paths. Any other
 * state is returned unchanged. */
export function withConversion(
  state: MountedConfigurationState,
): MountedConfigurationState {
  if (state.status !== "opened" || pathsConversionReplaces(state).length === 0)
    return state;
  return { ...state, converted: true };
}

/**
 * Why a signed run of the open configuration is withheld, or undefined where it
 * is not: the operator chose a signed receipt, and the file names signing paths
 * of its own they have not converted. The console signs only with its own
 * identity, so the run waits for the conversion rather than replacing the
 * file's paths without a word.
 */
export function unconvertedSigningWithheldReason(
  state: MountedConfigurationState,
  receiptsMode: ReceiptsSigningMode,
): string | undefined {
  if (
    receiptsMode !== "certificate" ||
    state.status !== "opened" ||
    state.notConducted !== undefined ||
    state.newInvitation === true ||
    state.converted === true
  )
    return undefined;
  const signingPaths = state.signingPaths ?? [];
  if (signingPaths.length === 0) return undefined;
  const paths = nameList(signingPaths);
  return [
    signingPaths.length === 1
      ? `This configuration sets its own signing path in ${paths}, and the ` +
        "console signs only with its own signing identity."
      : `This configuration sets its own signing paths in ${paths}, and the ` +
        "console signs only with its own signing identity.",
    `Choose ${CONVERT_CONFIGURATION_LABEL} to sign with the console's ` +
      "identity. The configuration for scheduled runs then states the " +
      "console's paths in place of yours.",
    "Or turn the signed receipt off. This exchange then runs unsigned, and " +
      "the configuration for scheduled runs keeps your file's signing " +
      "settings.",
    "Or run the file with Alcove on the command line.",
  ].join(" ");
}

/**
 * The sentence standing in for the cards that edit an opened configuration's
 * connection block -- connection tuning and file handling -- where the console
 * keeps that block exactly as the file states it, so an edit there would reach
 * nothing. Undefined where the cards edit the run's connection.
 */
export function connectionSettingsHeldNotice(
  state: MountedConfigurationState,
): string | undefined {
  if (state.status !== "opened" || state.notConducted === undefined)
    return undefined;
  return (
    `This configuration's ${state.notConducted} connection, its tuning and ` +
    "file handling included, is saved exactly as your file states it. Edit " +
    "it in alcove.yaml on the command line."
  );
}

/** Where saving the opened configuration back to the folder stands. A save
 * that was written holds the hand-back it sent, as JSON, so whether the steps
 * still hold what was saved is derived by comparison
 * ({@link configurationSaveShown}). */
export type ConfigurationSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; handBack: string }
  | { status: "failed"; message: string };

/** What the review step says once the settings are written to the folder. */
export const CONFIGURATION_SAVED =
  "Saved your changes to alcove.yaml in your working folder, with its " +
  "connection as your file stated it. The file as it was before this save " +
  `is kept beside it as ${PREVIOUS_CONFIGURATION_FILE_NAME}. Run it with ` +
  "Alcove on the command line.";

/** What the review step says when the save did not answer. */
export const CONFIGURATION_SAVE_UNAVAILABLE =
  "The console did not answer, so your changes were not saved to " +
  "alcove.yaml. Save again.";

/** The save state one answer from the console leaves for `sent`, the hand-back
 * the save sent. */
export function configurationSaveState(
  answer: ConfigurationHandBackAnswer,
  sent: JobConfigurationHandBack,
): ConfigurationSaveState {
  switch (answer.kind) {
    case "written":
      return { status: "saved", handBack: JSON.stringify(sent) };
    case "refused":
      return { status: "failed", message: answer.error };
    case "unavailable":
      return { status: "failed", message: CONFIGURATION_SAVE_UNAVAILABLE };
  }
}

/**
 * The save state the review step shows: a written save is shown as saved only
 * while `current`, the hand-back the steps hold now, is the one it sent, and
 * as idle once the steps hold anything else.
 */
export function configurationSaveShown(
  save: ConfigurationSaveState,
  current: JobConfigurationHandBack | undefined,
): ConfigurationSaveState {
  if (
    save.status === "saved" &&
    (current === undefined || JSON.stringify(current) !== save.handBack)
  )
    return { status: "idle" };
  return save;
}

/**
 * The records this flow holds without an editor, as the file spells them beside
 * the field the load reads them into. An invitation authored here states none of
 * its own, so each rides the run unchanged and the command line is where a value
 * is edited.
 */
const RECORDS_WITH_NO_CONTROL: ReadonlyArray<
  [keyof LoadedAuthoringState["records"], string]
> = [["expectedPartnerDeduplicate", "expected_partner_deduplicate"]];

/** What the operator is told about a configuration whose channel this console
 * has nothing to run it over: the review step keeps the transport it already
 * had, and the notice names what would make the file's own channel runnable
 * here. */
const TRANSPORT_UNAVAILABLE_NOTICE: Record<UnofferedChannel, string> = {
  filedrop:
    "This configuration runs over a shared folder, and this console has " +
    "none mounted. Mount one and set JOB_RENDEZVOUS_DIR to run it here, or " +
    "choose how this exchange runs on the review step below.",
};

/** A list of setting names as a sentence fragment, in the file's own spelling. */
function nameList(fields: ReadonlyArray<string>): string {
  return fields.join(", ");
}

/**
 * The records a loaded document states that this flow has no control for, named
 * as the file spells them, for the carry-through notice. Each is composed back
 * into the run's own configuration all the same.
 */
export function recordsWithNoControl(
  loaded: LoadedAuthoringState,
): Array<string> {
  return RECORDS_WITH_NO_CONTROL.filter(
    ([key]) => loaded.records[key] !== undefined,
  ).map(([, field]) => field);
}

/**
 * The held settings a run here states from the authoring state, as the file
 * spells them: the records above and the terms settings the draft holds
 * ({@link termsSettingsWithNoControl}). Every other held setting sits outside
 * the blocks a run here composes, so the export keeps it and the run does not
 * apply it.
 */
function heldSettingTheRunStates(field: string): boolean {
  return (
    RECORDS_WITH_NO_CONTROL.some(([, record]) => record === field) ||
    Object.values<string>(HELD_TERMS_SETTINGS).includes(field)
  );
}

/**
 * The held settings the notice names: the load's own list, less each terms
 * setting the draft's terms no longer state once the loaded terms reached the
 * input file ({@link RunDisclosure.termsSettingsStated}).
 */
function carriedThroughStated(
  fields: ReadonlyArray<string>,
  run: RunDisclosure | undefined,
): ReadonlyArray<string> {
  const stated = run?.termsSettingsStated;
  if (stated === undefined) return fields;
  const termsSettings: ReadonlyArray<string> =
    Object.values(HELD_TERMS_SETTINGS);
  return fields.filter(
    (field) => !termsSettings.includes(field) || stated.includes(field),
  );
}

/**
 * What the operator is told about the settings the console holds without an
 * editor, or undefined when the document states none. The console writes each
 * back unchanged, and the command line is where they are edited. A held setting
 * the run itself does not apply is named again with that said, so the notice
 * promises nothing about the run keeping it in force.
 */
export function carriedThroughNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const one = fields.length === 1;
  const notApplied = fields.filter((field) => !heldSettingTheRunStates(field));
  const sentences = [
    one
      ? "This configuration states a setting the console has no control " +
        `for, and keeps it unchanged: ${nameList(fields)}.`
      : "This configuration states settings the console has no control " +
        `for, and keeps each unchanged: ${nameList(fields)}.`,
  ];
  if (notApplied.length === fields.length)
    sentences.push(
      one
        ? "The run started here does not apply it, and the configuration " +
            "the console hands back states it as your file does."
        : "The run started here does not apply them, and the configuration " +
            "the console hands back states them as your file does.",
    );
  else if (notApplied.length > 0)
    sentences.push(
      `The run started here does not apply ${nameList(notApplied)}, and ` +
        "the configuration the console hands back states each setting as " +
        "your file does.",
    );
  sentences.push(
    one
      ? "Edit it with Alcove on the command line."
      : "Edit them with Alcove on the command line.",
  );
  return sentences.join(" ");
}

/**
 * What the operator is told about the credential fields the load could not
 * pre-fill, or undefined when there are none. The credential's value never
 * leaves the server, so the connection step asks for it again -- the exchange
 * still runs, and this is the one thing the operator has to supply.
 */
export function credentialWarningNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  return fields.length === 1
    ? "The console cannot fill in the credential this configuration " +
        `states: ${nameList(fields)}. Supply it again in the connection ` +
        "step, from your folder."
    : "The console cannot fill in the credentials this configuration " +
        `states: ${nameList(fields)}. Supply each again in the connection ` +
        "step, from your folder.";
}

/**
 * What the operator is told about the settings a loaded document states that
 * their own input file cannot supply, or undefined where there are none. The
 * settings are named as the file spells them and the columns they describe are
 * not, the rule every notice here holds to. The steps below the control hold
 * what the file's own columns support; the command line runs the configuration
 * as it stands.
 */
export function termsNotAppliedNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  const shortfall =
    "Your input file cannot supply everything this configuration states " +
    `under ${nameList(fields)}, so the steps below hold what your own ` +
    "columns support.";
  return fields.length === 1
    ? `${shortfall} To keep that setting as your file states it, run this ` +
        "exchange with Alcove on the command line."
    : `${shortfall} To keep those settings as your file states them, run ` +
        "this exchange with Alcove on the command line.";
}

/**
 * What the operator is told about the columns their input file has that a
 * loaded document's own column set does not state: the console holds each one
 * back, as the command line running that configuration would, and the columns
 * step is where the operator decides otherwise. The setting is named as the
 * file spells it and the columns are not, the rule every notice here holds to.
 */
export function columnsNotCoveredNotice(
  fields: ReadonlyArray<string>,
): string | undefined {
  if (fields.length === 0) return undefined;
  return (
    "Your input file has columns this configuration does not state under " +
    `${nameList(fields)}, so the steps below keep those columns back ` +
    "instead of sending them to your partner. To send one, change how it " +
    "is used on the next step."
  );
}

/** What the run the console holds states, read by the notices beside an opened
 * configuration. Absent until an input file is read. */
export interface RunDisclosure {
  /** The terms settings with no control that the terms this draft builds
   * state (`termsSettingsStatedBy`), once the open configuration's terms have
   * reached the input file. Absent before then, where the load's own list is
   * named, since the terms hold each setting once they reach it. */
  termsSettingsStated?: ReadonlyArray<string>;
}

/**
 * Whether the control offers a read. A configuration is an input to every step
 * below it, so the offer stands only while nothing is open (or a read did not
 * answer) and the draft those steps hold is still editable: once an invitation
 * is minted the terms are sealed, and a load that filled the cards around them
 * would report a configuration the run's terms do not state.
 */
export function mountedConfigurationOfferable(
  state: MountedConfigurationState,
  sealed: boolean,
): boolean {
  if (sealed) return false;
  return state.status === "unread" || state.status === "unavailable";
}

/** What the operator is told about each retired setting the opened file
 * states: core's own warning, the one the command line prints, so both name
 * the setting and where the receipt goes in the same words. */
export function retiredSettingsNotices(
  settings: ReadonlyArray<string>,
): Array<string> {
  return settings.map(
    (setting) => `In your alcove.yaml, ${retiredSettingNotice(setting)}`,
  );
}

/** The whole of what an opened configuration puts beside the control, in the
 * order it renders: what this console cannot run at all, then the carry-through
 * notice, since it is about the run itself, then the credential the operator
 * has to supply, then the relay enrollment step, then what their input file
 * could not supply, and last the retired settings the file states to delete.
 * `run` is what the carry-through notice is narrowed by, absent until a file
 * is read. A configuration the console does not conduct
 * puts the notice naming its channel in place of every one about a run here. */
export function mountedConfigurationNotices(
  state: MountedConfigurationState,
  run?: RunDisclosure,
): Array<string> {
  if (state.status !== "opened") return [];
  const aboutTheRun =
    state.notConducted !== undefined
      ? [channelNotConductedNotice(state.notConducted)]
      : [
          state.transportUnavailable === undefined
            ? undefined
            : TRANSPORT_UNAVAILABLE_NOTICE[state.transportUnavailable],
          carriedThroughNotice(carriedThroughStated(state.carriedThrough, run)),
          credentialWarningNotice(state.warnings),
        ];
  return [
    ...aboutTheRun,
    state.relayEnrollment === true ? RELAY_ENROLLMENT_NOTICE : undefined,
    termsNotAppliedNotice(state.notApplied ?? []),
    columnsNotCoveredNotice(state.notCovered ?? []),
    ...retiredSettingsNotices(state.retiredSettings ?? []),
  ].filter((notice): notice is string => notice !== undefined);
}

/** The opened state with the channel this console cannot run named on it, so
 * the notice stands beside the control that opened the configuration. Any other
 * state is returned unchanged: a load that does not proceed selects no
 * transport and so withholds none. */
export function withUnavailableTransport(
  state: MountedConfigurationState,
  channel: UnofferedChannel,
): MountedConfigurationState {
  if (state.status !== "opened") return state;
  return { ...state, transportUnavailable: channel };
}

/** The opened state with the settings the operator's input file could not
 * supply, and those whose columns do not reach every column it has, named on it
 * as the file spells them beside the same control. Both are read off the file
 * the terms reached last, so a state that names none clears what an earlier one
 * named; a state that is not an opened configuration is left as it is. */
export function withTermsNotApplied(
  state: MountedConfigurationState,
  names: ReadonlyArray<string>,
  notCovered: ReadonlyArray<string> = [],
): MountedConfigurationState {
  if (state.status !== "opened") return state;
  return {
    ...state,
    notApplied: names.length === 0 ? undefined : [...names],
    notCovered: notCovered.length === 0 ? undefined : [...notCovered],
  };
}

/**
 * The state and, for a load that proceeds, the authoring state it hands the
 * screen. A refusal yields no authoring state at all, so no step is partly
 * filled from a document the console would not run.
 */
export function mountedConfigurationRead(answer: MountedConfigurationAnswer): {
  state: MountedConfigurationState;
  loaded?: LoadedAuthoringState;
} {
  switch (answer.kind) {
    case "absent":
      return { state: { status: "absent" } };
    case "unavailable":
      return { state: { status: "unavailable" } };
    case "refused":
      return { state: { status: "refused", error: answer.error } };
    case "opened": {
      const loaded = authoringStateFromDocument(answer.document);
      return {
        state: {
          status: "opened",
          carriedThrough: [
            ...new Set([
              ...answer.carriedThrough,
              ...recordsWithNoControl(loaded),
              ...termsSettingsWithNoControl(loaded.linkageTerms),
            ]),
          ].sort(),
          warnings: answer.warnings,
          ...(answer.signingPathSettings !== undefined &&
          answer.signingPathSettings.length > 0
            ? { signingPaths: answer.signingPathSettings }
            : {}),
          ...(answer.folderPathSettings !== undefined &&
          answer.folderPathSettings.length > 0
            ? { folderPaths: answer.folderPathSettings }
            : {}),
          ...(answer.retiredSettings !== undefined &&
          answer.retiredSettings.length > 0
            ? { retiredSettings: answer.retiredSettings }
            : {}),
          ...(answer.relayRegistrarNamed === true
            ? { relayEnrollment: true as const }
            : {}),
          ...(answer.keyFileFault !== undefined && isJobChannel(loaded.channel)
            ? { keyFileFault: answer.keyFileFault }
            : {}),
          ...(isJobChannel(loaded.channel)
            ? {}
            : { notConducted: loaded.channel }),
        },
        loaded,
      };
    }
  }
}
