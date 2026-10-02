import { Alert, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { CopyableCode } from "@components/CopyableCode";
import styles from "@styles/app.module.css";

import {
  SHARED_FOLDER_EXPOSURE_NOTICE,
  SHARED_FOLDER_MOUNT_FLAGS,
  SHARED_FOLDER_MOUNT_HINT,
  sharedFolderExposure,
} from "./filedropRendezvousChoice";

import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";

/**
 * The warning shown beside the shared-directory transport on a console whose
 * shared folder is also its working folder ({@link sharedFolderExposure}): what
 * the partner's sync copies out, and the docker flags for a separate mount.
 * Where this seat mints an invitation it also states the folder name that
 * invitation gives the partner. Nothing renders on any other layout.
 */
export function SharedFolderExposureNotice({
  rendezvous,
  mintsInvitation,
}: {
  rendezvous: JobRendezvousConfig | undefined;
  mintsInvitation: boolean;
}) {
  const exposure = sharedFolderExposure(rendezvous);
  if (exposure === undefined) return null;
  return (
    <Alert
      role="note"
      color="yellow"
      icon={<IconAlertTriangle aria-hidden />}
      title="The shared folder holds your own files"
      mt="md"
    >
      <Stack gap="xs">
        <Text size="sm">{SHARED_FOLDER_EXPOSURE_NOTICE}</Text>
        <CopyableCode
          code={SHARED_FOLDER_MOUNT_FLAGS}
          ariaLabel="the shared-folder mount flags"
        />
        <Text size="sm">{SHARED_FOLDER_MOUNT_HINT}</Text>
        {mintsInvitation && exposure.folderName !== undefined && (
          <Text size="sm">
            As this console is started now, it calls the shared folder{" "}
            <span className={styles.mono}>{exposure.folderName}</span>, and that
            is the name an invitation from it gives your partner.
          </Text>
        )}
      </Stack>
    </Alert>
  );
}
