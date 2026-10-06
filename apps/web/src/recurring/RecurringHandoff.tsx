import { useEffect, useState } from "react";

import { Anchor } from "@mantine/core";

import {
  fetchRecurringHandoff,
  handoffCaveats,
} from "@psi/managed/recurringHandoff";

import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  EXCHANGE_FOLDER_PLACEHOLDER,
  bindPathsCaveat,
  buildImageReference,
  dockerCronLine,
  dockerRunCommand,
  dockerTaskSchedulerLine,
  handoffInputName,
  installedCronLine,
  installedRunCommand,
  unmountableBindPaths,
  unmountableBindPathsNotice,
} from "./scheduledRunCommand";

import type { JobHandoff } from "@jobs/handoff";
import type { ScheduledRunSource } from "./scheduledRunCommand";

/** The full CLI reference the panel points at for the recurring-run details. */
const RECURRING_EXCHANGE_DOC_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/CLI.md#recurring-exchange";

/**
 * The recurring-run hand-off panel, available on every console server-job seat
 * (invite, accept, Direct, and strand recovery) from job creation onward --
 * collapsed until the run completes, absent on a failed or stopped run. It
 * fetches the job's portable,
 * secret-free hand-off from `GET /api/jobs/:jobId/handoff` and lays out exactly
 * what the operator takes from this prototyped run to a scheduled `alcove`
 * command line: the config or command template (the portable values from this run
 * filled in, machine-specific paths shown as placeholders), the key-file copy step
 * for an invitation run, cron and Windows Task Scheduler examples, and the caveats.
 *
 * It is purely informational and never blocks anything: while the fetch is in
 * flight, or if the hand-off is unavailable (a browser run, a forgotten job, any
 * fetch failure), it renders nothing. `collapsible` renders the same body behind an
 * initially-collapsed disclosure whose toggle is the summary -- the null gate still
 * fires first, so an unavailable hand-off leaves no dangling toggle.
 */
export function RecurringHandoff({
  jobId,
  collapsible = false,
}: {
  jobId: string;
  collapsible?: boolean;
}) {
  // undefined = still loading; null = unavailable (render nothing).
  const [handoff, setHandoff] = useState<JobHandoff | null | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchRecurringHandoff(jobId).then((data) => {
      if (!cancelled) setHandoff(data);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (handoff === undefined || handoff === null) return null;

  if (collapsible)
    return (
      <DisclosureSection
        label="Run this on a schedule"
        open={open}
        onToggle={setOpen}
      >
        <HandoffBody handoff={handoff} jobId={jobId} />
      </DisclosureSection>
    );

  return (
    <section
      className={styles.callout}
      aria-labelledby="recurring-handoff-title"
    >
      <h2 id="recurring-handoff-title">Run this exchange on a schedule</h2>
      <HandoffBody handoff={handoff} jobId={jobId} />
    </section>
  );
}

/** The hand-off's content -- template, schedule snippets, and caveats -- shared by
 * the default expanded panel (under its own heading) and the collapsible
 * disclosure (under the toggle summary). */
function HandoffBody({
  handoff,
  jobId,
}: {
  handoff: JobHandoff;
  jobId: string;
}) {
  const source: ScheduledRunSource = {
    argv: handoff.template.argv,
    bindPaths: handoff.bindPaths,
    image: buildImageReference(),
  };
  const dockerCommand = dockerRunCommand(source);
  const runCommand = dockerCommand ?? installedRunCommand(source);
  const cronCommand = dockerCronLine(source);
  const taskSchedulerCommand = dockerTaskSchedulerLine(source);
  const unmountable = unmountableBindPaths(handoff.bindPaths);
  const inputName = handoffInputName(handoff.template.argv);

  return (
    <>
      <p className={styles.small}>
        This exchange runs here as a prototype. To run the recurring production
        version, run it from the command line with cron (Linux/macOS) or Task
        Scheduler (Windows). The settings from this run are filled in below; set
        the file paths for the machine that will run the schedule.
      </p>
      {unmountable.length > 0 && (
        <p className={styles.small}>
          {unmountableBindPathsNotice(unmountable)}
        </p>
      )}

      {handoff.template.kind === "config" ? (
        <ConfigSteps
          yaml={handoff.template.yaml}
          command={runCommand}
          inputName={inputName}
          usedKeyFile={handoff.usedKeyFile}
          keyFileBesideConfiguration={handoff.keyFileBesideConfiguration}
          usedSigningIdentity={handoff.usedSigningIdentity}
          runFolder={jobId}
        />
      ) : (
        <CommandSteps command={runCommand} inputName={inputName} />
      )}

      <h3 className={styles.handoffHeading}>
        Schedule it (set the time you agreed with your partner)
      </h3>
      {cronCommand !== undefined && (
        <>
          <p className={styles.small}>
            cron (Linux/macOS), daily at 2am, running Alcove from its Docker
            image:
          </p>
          <CopyableCode code={cronCommand} ariaLabel="cron schedule line" />
        </>
      )}
      {taskSchedulerCommand !== undefined && (
        <>
          <p className={styles.small}>
            Windows Task Scheduler, daily at 2am, running Alcove from its Docker
            image:
          </p>
          <CopyableCode
            code={taskSchedulerCommand}
            ariaLabel="Windows Task Scheduler command"
          />
        </>
      )}
      <p className={styles.small}>
        {dockerCommand !== undefined
          ? "If Alcove is installed on the scheduling machine rather than run " +
            "from its image, cron runs it from the exchange folder:"
          : "cron (Linux/macOS), daily at 2am, running an installed Alcove " +
            "from the exchange folder:"}
      </p>
      <CopyableCode
        code={installedCronLine(source)}
        ariaLabel="cron schedule line for an installed Alcove"
      />
      <p className={styles.small}>
        Set {EXCHANGE_FOLDER_PLACEHOLDER} to the folder you saved the files in,
        and /path/to/alcove to where Alcove is installed. The ./ at the end of
        each command is the folder the result goes in: each run writes its
        result there as alcove-results-&lt;time&gt;.csv, with the same time as
        that run&apos;s exchange record alcove-record-&lt;time&gt;.json, and
        adds to exchange.log in that folder.
        {dockerCommand !== undefined &&
          " A scheduled job does not use your shell's PATH, so check that " +
            "/usr/bin/docker is where Docker is installed (command -v docker)."}
      </p>

      <Caveats
        handoff={handoff}
        dockerLinesShown={dockerCommand !== undefined}
      />

      <p className={styles.small}>
        See the{" "}
        <Anchor
          inherit
          href={RECURRING_EXCHANGE_DOC_URL}
          target="_blank"
          rel="noreferrer"
        >
          recurring exchange reference
        </Anchor>{" "}
        for the full command-line details.
      </p>
    </>
  );
}

/** The exchange-mode (invitation) steps: save the config, copy the key file, run
 * the exchange command. */
function ConfigSteps({
  yaml,
  command,
  inputName,
  usedKeyFile,
  keyFileBesideConfiguration,
  usedSigningIdentity,
  runFolder,
}: {
  yaml: string;
  command: string;
  inputName: string;
  usedKeyFile: boolean;
  keyFileBesideConfiguration: boolean;
  usedSigningIdentity: boolean;
  /** The name of this run's own folder in the console's working directory. */
  runFolder: string;
}) {
  return (
    <ol className={styles.handoffSteps}>
      <li>
        <p className={styles.handoffStepLabel}>
          Save this as alcove.yaml in a folder on the scheduling machine
        </p>
        <CopyableCode code={yaml} ariaLabel="alcove.yaml configuration" />
      </li>
      <InputStep inputName={inputName} />
      {usedKeyFile && (
        <li>
          <p className={styles.handoffStepLabel}>
            Copy the shared secret into that folder
          </p>
          <p className={styles.small}>
            {keyFileBesideConfiguration
              ? "This run used the .alcove.key beside alcove.yaml in your " +
                "working folder and wrote its new shared secret back to that " +
                "file."
              : "This run writes its shared secret to .alcove.key in the " +
                `folder ${runFolder} in the console's working directory, ` +
                "which discarding the run deletes."}{" "}
            Copy that file into the same folder as alcove.yaml, readable only by
            you (chmod 600 on Linux/macOS). The secret rotates at each run's
            handshake, before any data moves -- even a run that later failed has
            usually rotated it -- so take your copy from the file as it stands
            after your last run here, never from an earlier one.
          </p>
        </li>
      )}
      {usedSigningIdentity && (
        <li>
          <p className={styles.handoffStepLabel}>
            Copy your signing identity into that folder
          </p>
          <p className={styles.small}>
            This run signs its receipt with the signing identity at the location
            you chose on the console -- the folder you mounted, or the file you
            picked in your secrets folder. Copy that file to the scheduling
            machine, readable only by you (chmod 600 on Linux/macOS), and set
            signing.identity_file to where you put it -- the path in the
            configuration above is a placeholder. Copy it; do not run alcove
            fingerprint there to make a new one. That mints a different key with
            a different fingerprint, and your partner has pinned the old one.
          </p>
        </li>
      )}
      <li>
        <p className={styles.handoffStepLabel}>Run the exchange</p>
        <CopyableCode code={command} ariaLabel="recurring exchange command" />
        {usedSigningIdentity && (
          <p className={styles.small}>
            The configuration names no receipt file, so each scheduled run
            writes its own timestamped receipt into the folder it runs in, and
            the schedule accumulates a trail rather than overwriting one file.
          </p>
        )}
      </li>
    </ol>
  );
}

/** The step naming the input file the command reads from the folder. */
function InputStep({ inputName }: { inputName: string }) {
  return (
    <li>
      <p className={styles.handoffStepLabel}>
        Put your input file in that folder as {inputName}
      </p>
      <p className={styles.small}>
        Each run reads {inputName} from the folder, so replace it with the
        current data before the next scheduled run.
      </p>
    </li>
  );
}

/** The zero-setup (Direct) steps: put the input in place and run the single
 * command; no key file. */
function CommandSteps({
  command,
  inputName,
}: {
  command: string;
  inputName: string;
}) {
  return (
    <>
      <ol className={styles.handoffSteps}>
        <li>
          <p className={styles.handoffStepLabel}>
            Make a folder for this exchange on the scheduling machine
          </p>
        </li>
        <InputStep inputName={inputName} />
      </ol>
      <h3 className={styles.handoffHeading}>
        Run this command on the scheduling machine
      </h3>
      <CopyableCode
        code={command}
        ariaLabel="recurring Direct exchange command"
      />
      <p className={styles.small}>
        A Direct exchange has no shared secret -- trust rests on the transport
        -- and re-infers the linkage terms from your file each run, so there is
        no key file to copy. To persist a configuration and host-key pin for
        later plain alcove exchange runs, add --save the first time you run it.
      </p>
    </>
  );
}

/** The all-modes caveats ({@link handoffCaveats}), and the paths the Docker
 * lines mount when they are shown. */
function Caveats({
  handoff,
  dockerLinesShown,
}: {
  handoff: JobHandoff;
  dockerLinesShown: boolean;
}) {
  const caveats = handoffCaveats(handoff);
  if (dockerLinesShown && handoff.bindPaths.length > 0)
    caveats.push(bindPathsCaveat(handoff.bindPaths));
  return (
    <>
      <h3 className={styles.handoffHeading}>Before you schedule it</h3>
      <ul className={styles.small}>
        {caveats.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </>
  );
}
