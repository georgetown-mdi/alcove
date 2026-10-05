import { useCallback, useEffect, useRef, useState } from "react";

import {
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  VisuallyHidden,
} from "@mantine/core";

import { sanitizeForDisplay } from "@alcove/core";

import { fetchMountEntries } from "@psi/jobClient/sftpAuthoringClient";

import styles from "@styles/app.module.css";

import {
  MountLoading,
  MountStateNotice,
  NoMountedFolderNotice,
  RefreshButton,
} from "./mountListing";
import { breadcrumbTrail, enterSubdir, fileSubPath } from "./mountNavigation";

import type {
  CredentialMount,
  MountBrowsePurpose,
  SecretsEntriesResult,
} from "@psi/jobClient/sftpAuthoringClient";
import type { ReactNode } from "react";

/** How each mount is named: the breadcrumb's root label, and the phrase the
 * picker's sentences use. */
const MOUNT_NAMES: Record<CredentialMount, { root: string; phrase: string }> = {
  secrets: { root: "secrets", phrase: "the secrets directory" },
  folder: { root: "your folder", phrase: "your folder" },
};

/** What the credential picker says above a browse of the working folder, which
 * it offers when no separate secrets directory is mounted. */
export const FOLDER_CREDENTIAL_NOTICE =
  "This console has no separate secrets directory, so choose the file from " +
  "your mounted folder. That works, and the console warns you once the " +
  "connection is saved: Alcove writes exchange files and results into this " +
  "folder. For better isolation, start the console with " +
  "-v <secrets folder>:/secrets:ro --env JOB_SECRETS_DIR=/secrets and choose " +
  "the file there.";

/** What the aria-live status region announces once a listing resolves. */
function secretsLiveMessage(
  listing: SecretsEntriesResult | "loading",
  mount: CredentialMount,
): string {
  if (listing === "loading") return "";
  if (listing.kind === "disabled")
    return "This console was started without a folder.";
  if (listing.kind === "error")
    return `${capitalized(MOUNT_NAMES[mount].phrase)} could not be read.`;
  if (!listing.configured)
    return "No secrets directory is configured on this console.";
  if (!listing.readable) return "This directory could not be read.";
  if (listing.entries.length === 0) return "This directory is empty.";
  return `Loaded ${listing.entries.length} ${listing.entries.length === 1 ? "entry" : "entries"}.`;
}

/**
 * The console's secrets-mount file picker: a navigable browse of the
 * operator-mounted secrets directory ({@link fetchMountEntries}), used to point
 * an SFTP connection at a credential file and to point the signing identity at
 * the file that holds it. It lists the directory's subdirectories and files,
 * descends into a `dir` entry (breadcrumb to go back), and yields the picked
 * file's subPath and mount when the operator picks a `file` -- the server
 * resolves that locator against its own mount, so no container-absolute path is
 * ever shown or sent. No file bytes are read; this is a name browse only (SSH
 * key material, password files, and the signing identity, none profiled).
 *
 * A missing secrets mount is a browse of the working folder for a caller passing
 * `folderFallback` (see that prop). For any other caller it is shown as a
 * named config gap (name `JOB_SECRETS_DIR`), not a dead end, reusing the shared
 * listing shell ({@link MountStateNotice}). The remedy differs by caller, so an
 * unconfigured mount's copy is the caller's ({@link unconfiguredNotice}). A polite status
 * region announces each resolved listing, and focus follows a navigation so a
 * screen-reader user is not stranded.
 */
export function SecretsFilePicker({
  onSelect,
  unconfiguredNotice,
  folderFallback = false,
  purpose = "credential",
}: {
  /** Commit a picked credential file's locator subPath (the directory segments
   * plus the file name) and the mount it is under. */
  onSelect: (subPath: Array<string>, mount: CredentialMount) => void;
  /** What the "no separate secrets directory" notice says, when the caller has
   * a different remedy from the credential field's typed `@`-file fallback. */
  unconfiguredNotice?: ReactNode;
  /** Browse the working folder instead when no secrets directory is mounted,
   * with {@link FOLDER_CREDENTIAL_NOTICE} above it. */
  folderFallback?: boolean;
  /** What the pick is for: a credential browse is not offered the console's
   * own files, a signing identity browse is. */
  purpose?: MountBrowsePurpose;
}) {
  const [mount, setMount] = useState<CredentialMount>("secrets");
  const [subPath, setSubPath] = useState<Array<string>>([]);
  const [listing, setListing] = useState<SecretsEntriesResult | "loading">(
    "loading",
  );

  // A monotonic id per fetch so a superseded resolution (a fast navigation or a
  // refresh spam) is discarded; `mounted` drops a resolution after unmount.
  const listingId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // An unmounted secrets directory is answered at its root, so the folder is
  // browsed from its root too.
  const load = useCallback(
    async (from: CredentialMount, path: Array<string>) => {
      const id = ++listingId.current;
      setListing("loading");
      const result = await fetchMountEntries(from, path, fetch, purpose);
      if (!mounted.current || id !== listingId.current) return;
      if (
        folderFallback &&
        from === "secrets" &&
        result.kind === "entries" &&
        !result.configured
      ) {
        setMount("folder");
        return;
      }
      setListing(result);
    },
    [folderFallback, purpose],
  );

  useEffect(() => {
    void load(mount, subPath);
  }, [mount, subPath, load]);

  // Focus the stage once a navigation resolves so a screen-reader user is not
  // stranded on a control that unmounted; skipped on mount so initial focus stays
  // put.
  const stageRef = useRef<HTMLDivElement>(null);
  const stageMounted = useRef(false);
  useEffect(() => {
    if (stageMounted.current) stageRef.current?.focus();
    stageMounted.current = true;
  }, [subPath]);

  const refresh = useCallback(
    () => void load(mount, subPath),
    [load, mount, subPath],
  );

  return (
    <Stack gap="sm" mt="sm">
      <VisuallyHidden role="status" aria-live="polite">
        {secretsLiveMessage(listing, mount)}
      </VisuallyHidden>
      {mount === "folder" && (
        <Text size="sm" c="dimmed">
          {FOLDER_CREDENTIAL_NOTICE}
        </Text>
      )}
      <div ref={stageRef} tabIndex={-1} style={{ outline: "none" }}>
        {renderListing(listing, mount, subPath, unconfiguredNotice, {
          onEnter: (name) => setSubPath(enterSubdir(subPath, name)),
          onNavigate: (next) => setSubPath(next),
          onSelect: (name) => onSelect(fileSubPath(subPath, name), mount),
          onRefresh: refresh,
        })}
      </div>
    </Stack>
  );
}

/** `phrase` with its first letter in upper case. */
function capitalized(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function renderListing(
  listing: SecretsEntriesResult | "loading",
  mount: CredentialMount,
  subPath: Array<string>,
  unconfiguredNotice: ReactNode,
  actions: {
    onEnter: (name: string) => void;
    onNavigate: (subPath: Array<string>) => void;
    onSelect: (name: string) => void;
    onRefresh: () => void;
  },
) {
  const refresh = <RefreshButton onRefresh={actions.onRefresh} />;
  const names = MOUNT_NAMES[mount];

  if (listing === "loading")
    return <MountLoading message={`Loading ${names.phrase}...`} />;

  if (listing.kind === "disabled")
    return (
      <NoMountedFolderNotice
        cannot="browse for a credential file"
        action={refresh}
      />
    );

  if (listing.kind === "error")
    return (
      <MountStateNotice
        color="red"
        title={`Could not read ${names.phrase}`}
        action={refresh}
      >
        The console did not return a listing. Check that the job API is
        reachable, then try again.
      </MountStateNotice>
    );

  // An unset JOB_SECRETS_DIR means there is no separate secrets mount to browse.
  // It is not a dead end -- each caller has its own remedy, which is why the
  // body is theirs. A separate read-only secrets directory is recommended
  // hardening, not a requirement.
  if (!listing.configured)
    return (
      <MountStateNotice
        color="blue"
        title="No separate secrets directory"
        action={refresh}
      >
        {unconfiguredNotice ?? (
          <>
            This console has no separate secrets directory to browse, so type a
            file reference below to a credential file (a password file or an SSH
            private key) in your mounted folder. For better isolation, mount a
            separate read-only directory as JOB_SECRETS_DIR and reference the
            file there instead, then restart the console.
          </>
        )}
      </MountStateNotice>
    );

  const trail = breadcrumbTrail(names.root, subPath);
  const breadcrumb = (
    <nav aria-label={`Path in ${names.phrase}`}>
      <Group gap={4} align="center">
        {trail.map((crumb, index) => {
          const isCurrent = index === trail.length - 1;
          const label =
            index === 0 ? crumb.label : sanitizeForDisplay(crumb.label);
          return (
            <Group gap={4} key={index} align="center">
              {index > 0 && (
                <Text size="sm" c="dimmed" aria-hidden>
                  /
                </Text>
              )}
              {isCurrent ? (
                <Text size="sm" fw={600} className={styles.mono}>
                  {label}
                </Text>
              ) : (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  className={styles.mono}
                  onClick={() => actions.onNavigate(crumb.subPath)}
                >
                  {label}
                </Button>
              )}
            </Group>
          );
        })}
      </Group>
    </nav>
  );

  // A configured-but-unreadable subdirectory: the breadcrumb still lets the
  // operator step back out, so it is not a dead end.
  if (!listing.readable)
    return (
      <Stack gap="sm">
        {breadcrumb}
        <MountStateNotice
          color="red"
          title="Could not read this directory"
          action={refresh}
        >
          This directory in {names.phrase} could not be read. It may have been
          removed since the listing. Step back with the path above, or refresh.
        </MountStateNotice>
      </Stack>
    );

  if (listing.entries.length === 0)
    return (
      <Stack gap="sm">
        {breadcrumb}
        <MountStateNotice
          color="blue"
          title="This folder is empty"
          action={refresh}
        >
          This folder has no files or subdirectories. Step back with the path
          above and pick another, or place your credential file in{" "}
          {names.phrase} and refresh.
        </MountStateNotice>
      </Stack>
    );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        {breadcrumb}
        {refresh}
      </Group>
      <Table
        highlightOnHover
        withRowBorders={false}
        aria-label={`Entries in ${names.phrase}`}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Name</Table.Th>
            <Table.Th scope="col" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {listing.entries.map((entry) => {
            const displayName = sanitizeForDisplay(entry.name);
            return (
              <Table.Tr key={entry.name}>
                <Table.Td className={styles.mono}>
                  {displayName}{" "}
                  {entry.kind === "dir" && (
                    <Badge size="xs" color="gray" variant="light">
                      Folder
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {entry.kind === "dir" ? (
                    <Button
                      size="xs"
                      variant="default"
                      aria-label={`Open ${displayName}`}
                      onClick={() => actions.onEnter(entry.name)}
                    >
                      Open
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      aria-label={`Use ${displayName}`}
                      onClick={() => actions.onSelect(entry.name)}
                    >
                      Use this file
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
