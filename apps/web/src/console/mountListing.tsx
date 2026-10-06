import {
  Alert,
  Anchor,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

import { alertRoleFor } from "@theme";

import type { ReactNode } from "react";

/**
 * The shared listing shell for the console's mounted-directory surfaces (the
 * work-input picker and the secrets-credential picker): the loading,
 * informational config-gap, transient-fault, and refresh presentation, in one
 * place so the two pickers cannot drift. Each caller supplies its own copy -- the
 * mount and the env var differ -- but the state shapes, colors, and the refresh
 * control live here once.
 */

/** A small refresh control shared by the mount listing surfaces. */
export function RefreshButton({
  onRefresh,
  label = "Refresh",
}: {
  onRefresh: () => void;
  label?: string;
}) {
  return (
    <Button
      size="xs"
      variant="default"
      leftSection={<IconRefresh size={14} aria-hidden />}
      onClick={onRefresh}
    >
      {label}
    </Button>
  );
}

/**
 * A mount listing state notice: an informational (`blue`, a stable config state)
 * or fault (`red`, a transient error to retry) alert with a title and body, plus
 * an optional action row (typically a {@link RefreshButton}). Blue names what to
 * set; red says to check the mount and retry -- the wording both pickers share.
 */
export function MountStateNotice({
  color,
  title,
  children,
  action,
}: {
  color: "blue" | "red";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Alert
        color={color}
        role={alertRoleFor(color)}
        icon={<IconAlertCircle />}
        title={title}
      >
        {children}
      </Alert>
      {action}
    </Stack>
  );
}

/** The mount listing loading state: a spinner and a dimmed message. */
export function MountLoading({ message }: { message: string }) {
  return (
    <Group gap="xs">
      <Loader size="sm" />
      <Text size="sm" c="dimmed">
        {message}
      </Text>
    </Group>
  );
}

/** The console guide's section on starting the container with a folder
 * mounted. */
export const RUNNING_THE_CONTAINER_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/docs/CONSOLE.md#running-the-container";

/** The one-folder start command the notice below shows, with the folder left
 * for the operator to fill in. */
export const SINGLE_FOLDER_RUN_COMMAND =
  "docker run --rm -p 127.0.0.1:3000:3000 -v <your folder>:/work " +
  "--env JOB_DATA_ROOT=/work ghcr.io/georgetown-mdi/alcove serve";

/**
 * The state both pickers show when the console was started without a working
 * folder (its job routes answer 404): what it cannot do, and the command that
 * starts it with one.
 */
export function NoMountedFolderNotice({
  cannot,
  action,
}: {
  /** What the console cannot do without the folder, as a verb phrase. */
  cannot: string;
  action?: ReactNode;
}) {
  return (
    <MountStateNotice
      color="blue"
      title="This console was started without a folder"
      action={action}
    >
      <Stack gap="xs">
        <Text size="sm">
          The console has no working folder, so it cannot {cannot}. Stop it and
          start it again with your folder mounted:
        </Text>
        <Code block>{SINGLE_FOLDER_RUN_COMMAND}</Code>
        <Text size="sm">
          Replace {"<your folder>"} with the folder holding your files. Other
          layouts are in{" "}
          <Anchor
            inherit
            href={RUNNING_THE_CONTAINER_URL}
            target="_blank"
            rel="noreferrer"
          >
            Running the container
          </Anchor>
          .
        </Text>
      </Stack>
    </MountStateNotice>
  );
}
