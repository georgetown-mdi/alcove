import { useState } from "react";

import {
  Alert,
  Checkbox,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { MAX_PEER_ID_LENGTH } from "@jobContract/intentSchemas";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  EXCHANGE_FILES_HEADING,
  PEER_ID_LABEL,
  RETAIN_MODE_BILATERAL_NOTICE,
  WRITE_WITHOUT_RENAMING_NOTICE,
  exchangeFilesProblems,
} from "./exchangeFilesModel";

import type {
  ExchangeFilesCapabilities,
  ExchangeFilesDraft,
  FileSyncToggle,
  UnexpectedFilesChoice,
} from "./exchangeFilesModel";

const TOGGLE_CHOICES: ReadonlyArray<{ value: FileSyncToggle; label: string }> =
  [
    { value: "auto", label: "Automatic" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

const UNEXPECTED_FILES_CHOICES: ReadonlyArray<{
  value: UnexpectedFilesChoice;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  { value: "error", label: "Stop the exchange" },
  { value: "warn", label: "Warn and continue" },
  { value: "ignore", label: "Ignore" },
];

/** The collapsed summary, so a closed card is not a blind box: it names the
 * choices that change what the exchange leaves behind or how it writes. */
function draftSummary(draft: ExchangeFilesDraft): string {
  const named = [
    ...(draft.retainFiles ? ["Keeping every file"] : []),
    ...(draft.writeWithoutRenaming ? ["Writing without renaming"] : []),
  ];
  return named.length === 0 ? "Default" : named.join(", ");
}

/**
 * The console's "How files are handled" card: retain mode and the file-sync
 * toggles that travel with it, and writing without a rename for a server that
 * refuses renames, for an SFTP or shared-directory exchange. Offered
 * as a closed disclosure, since the defaults are right for a first run and these
 * are the settings an operator reaches for in a specific situation -- a durable
 * transcript, or a synced folder whose behaviour needs the lockless rendezvous.
 *
 * Two behaviors belong to {@link exchangeFilesModel}, not to this component:
 * retain mode's implications are resolved by core (so the card
 * states no rule of its own), and an inadmissible combination is reported in
 * core's own words as a form problem, before the run, rather than as a failed
 * job. The card renders the retain-mode bilateral notice the moment retain is
 * switched on, so the operator learns their partner must match while they can
 * still tell them.
 */
export function ExchangeFilesCard({
  draft,
  capabilities,
  onChange,
}: {
  draft: ExchangeFilesDraft;
  /** Which controls this flow supports; a flow that composes no configuration
   * document omits the unexpected-files control rather than accepting a value it
   * would drop. */
  capabilities: ExchangeFilesCapabilities;
  onChange: (draft: ExchangeFilesDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const problems = exchangeFilesProblems(draft, capabilities);
  const set = <TField extends keyof ExchangeFilesDraft>(
    key: TField,
    value: ExchangeFilesDraft[TField],
  ): void => onChange({ ...draft, [key]: value });

  return (
    <DisclosureSection
      label={EXCHANGE_FILES_HEADING}
      summary={draftSummary(draft)}
      open={open}
      onToggle={setOpen}
      headingOrder={2}
    >
      <Stack gap="md" mt="sm">
        <Text size="sm" c="dimmed">
          The defaults suit a first run. Change these when you need a permanent
          record of the exchange, or when the shared folder is kept in step by a
          sync tool.
        </Text>

        <Checkbox
          checked={draft.retainFiles}
          onChange={(event) => set("retainFiles", event.currentTarget.checked)}
          label="Keep every exchange file"
          description={
            "Leave the exchange's files in place as a permanent transcript " +
            "instead of deleting each one once it has been read. They stay " +
            "where the exchange runs: in the remote directory on the SFTP " +
            "server, which you may not administer, or in the shared folder, " +
            "which your partner keeps a synced copy of. Nothing clears them " +
            "afterwards. Also switches on timestamped filenames and " +
            "connecting with acknowledgement files (Lockless rendezvous " +
            "below), which keeping every file requires."
          }
        />

        {draft.retainFiles && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Both sides must set this"
          >
            {RETAIN_MODE_BILATERAL_NOTICE}
          </Alert>
        )}

        <NativeSelect
          label="Timestamped filenames"
          description={
            "Adds a timestamp and a counter to each file this side writes. " +
            "Required by keeping every file, and by naming this party below."
          }
          value={draft.timestampInFilename}
          data={TOGGLE_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
          }))}
          onChange={(event) =>
            set(
              "timestampInFilename",
              event.currentTarget.value as FileSyncToggle,
            )
          }
        />

        <NativeSelect
          label="Lockless rendezvous"
          description={
            "Connects to your partner using acknowledgement files instead of a " +
            "lock file. Needed on folders kept in step by a sync tool, which " +
            "may not create a file exclusively or pass a deletion on promptly."
          }
          value={draft.locklessRendezvous}
          data={TOGGLE_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
          }))}
          onChange={(event) =>
            set(
              "locklessRendezvous",
              event.currentTarget.value as FileSyncToggle,
            )
          }
        />

        <TextInput
          label={PEER_ID_LABEL}
          description={
            "A stable name for this party, used as the prefix of every file it " +
            "writes and in the logs. Leave it blank for a generated one. The " +
            "two sides must choose different names."
          }
          placeholder="clinic-a"
          maxLength={MAX_PEER_ID_LENGTH}
          value={draft.peerId}
          onChange={(event) => set("peerId", event.currentTarget.value)}
        />

        {capabilities.unexpectedFiles && (
          <NativeSelect
            label="If an unrecognised file appears"
            description={
              "What to do when a file that is not part of this exchange turns " +
              "up in the shared folder mid-run. Automatic stops the " +
              "exchange on a plain folder and warns when the settings above " +
              "mark it as kept in step by a sync tool."
            }
            value={draft.unexpectedFiles}
            data={UNEXPECTED_FILES_CHOICES.map((choice) => ({
              value: choice.value,
              label: choice.label,
            }))}
            onChange={(event) =>
              set(
                "unexpectedFiles",
                event.currentTarget.value as UnexpectedFilesChoice,
              )
            }
          />
        )}

        <Checkbox
          checked={draft.writeWithoutRenaming}
          onChange={(event) =>
            set("writeWithoutRenaming", event.currentTarget.checked)
          }
          label="Write files without renaming them"
          description={
            "Write each exchange file directly under its final name instead " +
            "of writing a temporary file and renaming it. Use it when the " +
            "server does not allow renames, such as an SFTP server in front " +
            "of a synced network share. This is your side's choice alone. " +
            "Your partner neither sees it nor has to match it."
          }
        />

        {draft.writeWithoutRenaming && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle aria-hidden />}
            title="Only safe on some shared folders"
          >
            {WRITE_WITHOUT_RENAMING_NOTICE}
          </Alert>
        )}

        {problems.length > 0 && (
          <Alert
            role="alert"
            color="red"
            icon={<IconAlertTriangle aria-hidden />}
            title="These settings cannot be used together"
          >
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Stack>
    </DisclosureSection>
  );
}
