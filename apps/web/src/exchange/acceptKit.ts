/**
 * The partner's accept kit: one plaintext, printable, ASCII instruction sheet
 * the inviter downloads at mint time and sends alongside the invitation, for a
 * partner who accepts through the command-line tool (the `sftp` and `filedrop`
 * channels). Assumes the partner has Docker -- Desktop or Engine -- or can get
 * it, and nothing else.
 *
 * Pure: explicit inputs in, one string out -- no React, no I/O, no clock. Its
 * partner-facing invariants are specified in `docs/spec/SERVER_JOB_API.md`
 * ("The partner accept kit").
 *
 * The sheet is a DISCLOSURE SURFACE: whatever it interpolates is written to
 * disk and handed to the partner. Three kinds of dynamic value are representable
 * here: the rendezvous locator the invitation already holds (free text held
 * to the sheet's ASCII contract by {@link printable}), this build's public
 * release version (interpolated only in the shape `releaseVersion` in
 * `@utils/alcoveImage` admits), and the public digest of the image the console
 * runs (interpolated only in the shape `imageDigest` there admits). Everything
 * else is fixed text: {@link AcceptKitInput} declares only
 * those three kinds and two selector booleans, so no secret, no invitation
 * token, and no path from the inviter's machine or container has a field to
 * arrive in.
 *
 * The exchange's own settings contribute only a SELECTOR, never a value:
 * {@link AcceptKitInput.retainFiles} and
 * {@link AcceptKitInput.locklessRendezvous} pick between fixed lines and
 * fixed command flags, as the channel discriminant already picks between
 * fixed bodies. A future setting the partner must be told about is disclosed
 * the same way.
 */

/**
 * The rendezvous locator the sheet prints back, in the shapes the console
 * mints: an sftp locator (host, optional port, and either the single shared
 * remote directory or the split inbound/outbound pair) or a filedrop locator
 * (the shared folder's NAME, or the split pair's two names, never the
 * console's absolute path). Credential-free by construction, as the
 * invitation endpoint it is copied from is.
 *
 * Every filedrop name is optional: where the rendezvous mount point was
 * chosen by a launcher rather than by the operator, the mount point is not
 * the folder's name, and the sheet omits the name rather than telling the
 * partner to match one that is not. `split` states the SHAPE independently
 * of the names: a split rendezvous the console cannot name is still
 * described as two folders.
 */
import { PROJECT_SITE_URL } from "@components/projectLinks";

import { OPERATOR_USER_FLAG } from "@psi/containerAccount";

import {
  cosignVerifyCommand,
  digestReference,
  imageDigest,
  imageReference,
  releaseVersion,
} from "@utils/alcoveImage";

import type { ImageRegistry } from "@utils/alcoveImage";

export type AcceptKitEndpoint =
  | {
      channel: "sftp";
      host: string;
      port?: number;
      path?: string;
      inboundPath?: string;
      outboundPath?: string;
    }
  | {
      channel: "filedrop";
      split?: boolean;
      path?: string;
      inboundPath?: string;
      outboundPath?: string;
    };

/**
 * The minted exchange the sheet describes, as the mint fixed it: where the two
 * parties meet, and which bilateral file-handling settings the run contains. Held
 * together so a caller composing the sheet cannot pair one exchange's locator
 * with another's settings.
 */
export interface AcceptKitExchange {
  /** The rendezvous locator minted into the invitation. */
  endpoint: AcceptKitEndpoint;
  /**
   * The retain declaration the minted token carries, derived from the
   * inviter's toggle and the endpoint's shape, so it can be true with the
   * toggle off. Bilateral and non-negotiated: the partner's own run must
   * hold it or the two sides stop at rendezvous, and it leaves every
   * protocol file in place afterwards. Selects fixed text and contributes no
   * value of its own.
   */
  retainFiles: boolean;
  /**
   * Whether the run resolved the lockless rendezvous on, with retain mode's
   * implication of it already folded in. Bilateral and non-negotiated like
   * retain mode; unlike it, leaves nothing behind. Selects fixed text and
   * contributes no value of its own.
   */
  locklessRendezvous: boolean;
}

/**
 * The bilateral settings alone, as every composing helper below takes them: one
 * argument rather than a run of booleans a caller could transpose.
 */
type BilateralSettings = Pick<
  AcceptKitExchange,
  "retainFiles" | "locklessRendezvous"
>;

/** The inputs the sheet is built from. */
interface AcceptKitInput extends AcceptKitExchange {
  /** The release version this build holds, which decides both the image tag
   * the sheet's commands name and the release page it links; see
   * `releaseVersion` (`@utils/alcoveImage`). Absent, or in any shape but a
   * release version, the sheet names the floating image tag and the releases
   * index. */
  version?: string;
  /** The digest of the image the minting console runs, which the sheet prints
   * on each registry under its reference heading; see `imageDigest`
   * (`@utils/alcoveImage`). Absent, or in any other shape, the sheet names no
   * digest. */
  digest?: string;
}

/** The registry every command on the sheet names, and the one it offers in
 * place of it: the partner's network is unknown to the inviter, so the sheet
 * names both, Docker Hub first, rather than taking the inviter's. */
const COMMAND_REGISTRY: ImageRegistry = "docker.io";
const ALTERNATIVE_REGISTRY: ImageRegistry = "ghcr.io";

/** The image every command on the sheet runs. */
function commandImage(version: string | undefined): string {
  return imageReference(version, COMMAND_REGISTRY);
}

/** The release page the launcher files are downloaded from; the same URL the
 * launchers themselves hold. */
const ALCOVE_RELEASES_URL = "https://github.com/georgetown-mdi/alcove/releases";

/** The command-line reference the sheet closes on. */
const ALCOVE_CLI_DOC_URL = `${PROJECT_SITE_URL}/docs/CLI`;

/** The file the partner saves the invitation in. */
const INVITATION_FILE_NAME = "invitation.txt";

/** The accept command's argument naming {@link INVITATION_FILE_NAME}. The
 * sheet holds this and never a token: the invitation travels separately, so a
 * mislaid sheet discloses nothing. The `@` form keeps the invitation off the
 * command line, and the double quotes are required because Windows PowerShell
 * parses a bare `@name` as splatting. */
export const INVITATION_FILE_ARGUMENT = `"@${INVITATION_FILE_NAME}"`;

/** The container mount point the sheet's commands bind the partner's own
 * working folder to. It is the image's own working directory, part of the
 * published `docker run` form -- a fixed string in the partner's future
 * command, not a path from the inviter's machine. */
const WORK_MOUNT = "/work";

/** The container mount point the filedrop commands bind the partner's own
 * shared folder to. Fixed, like {@link WORK_MOUNT}. */
const SYNC_MOUNT = "/sync";

/** The container mount points a split filedrop's commands bind the partner's own
 * two folders to -- the one they read the inviter's files out of, and the one they
 * write their own into. Fixed, like {@link SYNC_MOUNT}, and named for the direction
 * they have on the PARTNER's side, which is the side the sheet is written for. */
const INBOUND_SYNC_MOUNT = "/sync-in";
const OUTBOUND_SYNC_MOUNT = "/sync-out";

/** The container mount point and file name the sftp exchange command reads
 * the partner's password from. Fixed, like {@link WORK_MOUNT}. */
const SECRETS_MOUNT = "/run/secrets";
const PASSWORD_FILE_NAME = "sftp-password";

/** The account placeholder on the sftp exchange command, shouted so an
 * unreplaced one is unmistakable; the server refuses it at sign-in. */
const ACCOUNT_PLACEHOLDER = "YOUR_ACCOUNT";

const RULE = "=".repeat(66);

function heading(title: string): Array<string> {
  return [title, "-".repeat(title.length), ""];
}

/** Interpolated operator-authored text, held to the sheet's printable-ASCII
 * contract: any byte outside printable ASCII renders as '?', so the stated
 * invariant is enforced here rather than assumed of the console's inputs. */
function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

/**
 * Where the two parties meet, printed back as the invitation holds it. On
 * filedrop it is the inviter's name for the folder, which can differ from the
 * reader's own (a share root mapped to a drive letter is the ordinary case),
 * so the sheet says so rather than asking for a match; where the console
 * could not name a folder, the sheet prints no name at all.
 *
 * A split rendezvous names both folders from the INVITER's side, which the
 * partner's own tool mirrors: the inviter's inbound is where the partner
 * writes, its outbound where the partner reads. Labelled by what the READER
 * does with them, not "inbound"/"outbound".
 */
function introLines(endpoint: AcceptKitEndpoint): Array<string> {
  if (endpoint.channel === "sftp") {
    const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
    return [
      "Your partner has invited you to an Alcove exchange through this SFTP",
      "server:",
      "",
      `  SFTP server:    ${printable(endpoint.host)}${port}`,
      ...(endpoint.inboundPath === undefined ||
      endpoint.outboundPath === undefined
        ? endpoint.path === undefined
          ? []
          : [`  Directory:      ${printable(endpoint.path)}`]
        : [
            `  You write to:   ${printable(endpoint.inboundPath)}`,
            `  You read from:  ${printable(endpoint.outboundPath)}`,
          ]),
    ];
  }
  if (endpoint.split === true)
    return endpoint.inboundPath === undefined ||
      endpoint.outboundPath === undefined
      ? [
          "Your partner has invited you to an Alcove exchange through two",
          "shared folders you can both reach: you write into one and read",
          "your partner's files from the other.",
        ]
      : [
          "Your partner has invited you to an Alcove exchange through two",
          "shared folders you can both reach:",
          "",
          `  You write to:   ${printable(endpoint.inboundPath)}`,
          `  You read from:  ${printable(endpoint.outboundPath)}`,
          "",
          "Those are your partner's names for them; yours can differ.",
        ];
  return endpoint.path === undefined
    ? [
        "Your partner has invited you to an Alcove exchange through a shared",
        "folder you can both reach.",
      ]
    : [
        "Your partner has invited you to an Alcove exchange through a shared",
        "folder you can both reach:",
        "",
        `  Shared folder:  ${printable(endpoint.path)}`,
        "",
        "That is your partner's name for it; yours can differ.",
      ];
}

/** The release page the launcher files are downloaded from: this build's own
 * release when it holds a version, so the partner takes the launchers from
 * the release that mints their invitation, else the index whose newest entry is
 * what the floating tag resolves to. Release tags are `vX.Y.Z`
 * (`docs/RELEASES.md`). */
function releasePageUrl(version: string | undefined): string {
  return version === undefined
    ? ALCOVE_RELEASES_URL
    : `${ALCOVE_RELEASES_URL}/tag/v${version}`;
}

/** The working-folder mount every `docker run` line opens with. The whole
 * value sits inside one pair of double quotes, braces included: Windows
 * PowerShell 5.1 splits `"$PWD":/work` into two arguments and refuses
 * `"$PWD:/work"` as a variable reference, while this form reaches docker as
 * one argument there and in bash and POSIX sh. Every line runs under those
 * shells in `.github/workflows/windows_resolution.yaml` and the unit tests. */
const WORK_FOLDER_MOUNT = `-v "\${PWD}:${WORK_MOUNT}"`;

// The one rule for which bilateral agreement the sheet names: retain mode
// already implies the lockless rendezvous, so its text wins; otherwise the
// lockless setting speaks only where it is on.
function chooseBilateral<T>(
  { retainFiles, locklessRendezvous }: BilateralSettings,
  forRetain: T,
  forLockless: T,
  forNeither: T,
): T {
  if (retainFiles) return forRetain;
  return locklessRendezvous ? forLockless : forNeither;
}

/**
 * The one flag on the partner's `exchange` command standing for the bilateral
 * settings their side must match, placed straight after the subcommand.
 * Retain mode travels as the single flag whose implications the CLI resolves
 * for them (`withRetainModeImplications`); the lockless rendezvous flag
 * travels only where retain mode is not already holding it.
 */
function bilateralFlag(settings: BilateralSettings): string {
  return chooseBilateral(
    settings,
    " --retain-files",
    " --lockless-rendezvous",
    "",
  );
}

/** The flag explained where the reader meets it, so a partner who edits the
 * command down keeps their half of the agreement. What retain mode leaves
 * behind is stated by the terms accepting shows, not here. */
function bilateralFlagLines(settings: BilateralSettings): Array<string> {
  return chooseBilateral(
    settings,
    [
      "   Leave --retain-files on: your partner keeps every exchange file,",
      "   and the exchange stops with an error unless both sides do.",
      "",
    ],
    [
      "   Leave --lockless-rendezvous on: the exchange stops with an error",
      "   unless both sides use it.",
      "",
    ],
    [],
  );
}

/** The same agreement, named as the console control that sets it, for the
 * filedrop launcher route, which never runs the sheet's commands. */
function consoleControlLines(settings: BilateralSettings): Array<string> {
  return chooseBilateral(
    settings,
    [
      'Before you start the exchange there, open "How files are handled"',
      "and choose to keep every exchange file. Both sides must.",
      "",
    ],
    [
      'Before you start the exchange there, open "How files are handled"',
      'and set "Lockless rendezvous" to On. Both sides must.',
      "",
    ],
    [],
  );
}

/** The first step on every route: where the invitation goes, and the folder
 * every command runs from. A filedrop partner keeps that folder out of the
 * shared ones, since accepting writes the key file into it. */
function saveStep(endpoint: AcceptKitEndpoint): Array<string> {
  const lead = [
    "1. Save the invitation your partner sent as a file named",
    endpoint.channel === "sftp"
      ? `   ${INVITATION_FILE_NAME} in the folder that holds your CSV file, and run`
      : `   ${INVITATION_FILE_NAME} in a folder of your own that holds your CSV file,`,
  ];
  if (endpoint.channel === "sftp")
    return [...lead, "   every command from there.", ""];
  return [
    ...lead,
    endpoint.split === true
      ? "   not either shared folder, and run every command from there."
      : "   not the shared folder, and run every command from there.",
    "",
  ];
}

/** How the partner checks the image's signature before running it: one
 * `cosign verify` line against the image every command names. It needs no
 * digest, so a sheet from a console started without a launcher has it too. */
function imageCheckStep(version: string | undefined): Array<string> {
  return [
    "2. Optional, with Cosign installed: check the Alcove image's",
    "   signature. If this reports an error, do not run the image; tell",
    "   your partner.",
    "",
    `     ${cosignVerifyCommand(commandImage(version))}`,
    "",
  ];
}

/** The accept step every route shares. Accepting at a terminal asks for the
 * party's identity before it shows the terms, so the sheet names no flag for
 * it and no command carries a pre-filled one. */
function acceptStep(version: string | undefined): Array<string> {
  return [
    "3. Accept, with your-file.csv replaced by your CSV file's name:",
    "",
    `     docker run --rm -it ${WORK_FOLDER_MOUNT} ` +
      `${commandImage(version)} accept ${INVITATION_FILE_ARGUMENT} your-file.csv`,
    "",
    "   It asks for your name and organization, which your partner sees,",
    "   then shows the terms. Read them, and answer y to accept.",
    "",
  ];
}

/** The SFTP steps after accepting: the credential travels as flags on the
 * exchange command, its password as an `@` path into a read-only mount, so
 * nothing in alcove.yaml needs editing and no secret is typed. */
function sftpSteps(
  version: string | undefined,
  settings: BilateralSettings,
): Array<string> {
  return [
    "4. Run the exchange, replacing your-file.csv as before, YOUR_ACCOUNT",
    "   with your account on the server, and /your/secrets with the folder",
    `   that holds your password in a file named ${PASSWORD_FILE_NAME}:`,
    "",
    `     docker run --rm -it ${WORK_FOLDER_MOUNT} ` +
      `-v "/your/secrets:${SECRETS_MOUNT}:ro" ` +
      `${commandImage(version)} exchange${bilateralFlag(settings)} ` +
      `--server-username ${ACCOUNT_PLACEHOLDER} ` +
      `--server-password "@${SECRETS_MOUNT}/${PASSWORD_FILE_NAME}" ` +
      "your-file.csv ./results",
    "",
    "   With an SSH key instead, write --server-private-key in place of",
    "   --server-password, and your key file's name in place of",
    `   ${PASSWORD_FILE_NAME}.`,
    "",
    "   The first run shows the server's key fingerprint: check it with the",
    "   server's administrator before you answer. It then waits for your",
    "   partner and writes the matched records into ./results.",
    "",
    ...bilateralFlagLines(settings),
  ];
}

/** The filedrop steps after accepting, one shared folder or a split pair:
 * point alcove.yaml at the container mount points, then mount the partner's
 * own folders there. What accepting wrote in their place is not described, so
 * the sheet never calls a value a name neither side chose. */
function filedropSteps(
  version: string | undefined,
  split: boolean,
  settings: BilateralSettings,
): Array<string> {
  return [
    split
      ? "4. In alcove.yaml, which accepting wrote, set the two folders:"
      : "4. In alcove.yaml, which accepting wrote, set the shared folder:",
    "",
    "     connection:",
    "       channel: filedrop",
    ...(split
      ? [
          `       inbound_path: ${INBOUND_SYNC_MOUNT}`,
          `       outbound_path: ${OUTBOUND_SYNC_MOUNT}`,
        ]
      : [`       path: ${SYNC_MOUNT}`]),
    "",
    ...(split
      ? [
          "5. Run the exchange, replacing your-file.csv as before and each",
          "   /path/to/... with where that folder is on your machine:",
          "",
          `     docker run --rm ${WORK_FOLDER_MOUNT} ` +
            `-v "/path/to/the/folder/you/read:${INBOUND_SYNC_MOUNT}" ` +
            `-v "/path/to/the/folder/you/write:${OUTBOUND_SYNC_MOUNT}" ` +
            `${commandImage(version)} exchange${bilateralFlag(settings)} ` +
            "your-file.csv ./results",
        ]
      : [
          "5. Run the exchange, replacing your-file.csv as before and",
          "   /path/to/your/shared/folder with where that folder is on your",
          "   machine:",
          "",
          `     docker run --rm ${WORK_FOLDER_MOUNT} ` +
            `-v "/path/to/your/shared/folder:${SYNC_MOUNT}" ` +
            `${commandImage(version)} exchange${bilateralFlag(settings)} ` +
            "your-file.csv ./results",
        ]),
    "",
    "   It waits for your partner, then writes the matched records into",
    "   ./results.",
    "",
    ...bilateralFlagLines(settings),
  ];
}

/** The heading the filedrop sheet routes a Windows network-drive reader to. */
const LAUNCHER_HEADING = "WINDOWS NETWORK DRIVE OR DFS PATH";

/** The filedrop routing line ahead of the steps: Docker cannot open a drive
 * letter or network path, so that reader takes the launcher instead. */
function launcherPointerLines(split: boolean): Array<string> {
  return split
    ? [
        "If the folders are on a Windows network drive or DFS path, such as",
        "Z:\\Exchange or \\\\fileserver\\exchange, Docker cannot open them:",
        `skip to ${LAUNCHER_HEADING} below.`,
        "",
      ]
    : [
        "If the folder is on a Windows network drive or DFS path, such as",
        "Z:\\Exchange or \\\\fileserver\\exchange, Docker cannot open it: skip",
        `to ${LAUNCHER_HEADING} below.`,
        "",
      ];
}

/** The Windows launcher route, for a shared folder or a pair: the launcher
 * resolves the share, mounts it, and opens the console's accept flow. */
function launcherLines(
  version: string | undefined,
  settings: BilateralSettings,
  split: boolean,
): Array<string> {
  return [
    ...heading(LAUNCHER_HEADING),
    "Download Start-Alcove.ps1 and Setup-AlcoveFileDrop.ps1 into one",
    "folder, from this release page and nowhere else:",
    "",
    `  ${releasePageUrl(version)}`,
    "",
    "In that folder, in an ordinary PowerShell window (one opened with",
    '"Run as administrator" cannot see your mapped drives), run:',
    "",
    "  powershell -ExecutionPolicy Bypass -File .\\Start-Alcove.ps1",
    "",
    ...(split
      ? [
          "When it asks whether your partner named two folders, answer yes,",
          "then give it the folder you read from first and the folder you",
          "write to second. Keep both inside one exchange folder on the",
          "share: the launcher reaches everything in the folder holding them.",
          "It opens the Alcove console in your browser: paste the invitation",
          "into its accept flow.",
        ]
      : [
          "Give it your shared folder when it asks. It opens the Alcove",
          "console in your browser: paste the invitation into its accept flow.",
        ]),
    "",
    ...consoleControlLines(settings),
  ];
}

/** The image by its digest on each registry, Docker Hub first, under
 * REFERENCE; nothing where the sheet has no digest. */
function digestLines(digest: string | undefined): Array<string> {
  return digest === undefined
    ? []
    : [
        "  The exact image your partner runs, which works in place of the",
        "  image in any command above:",
        `    ${digestReference(digest, COMMAND_REGISTRY)}`,
        `    ${digestReference(digest, ALTERNATIVE_REGISTRY)}`,
      ];
}

/** The shared closing: recovery, then the reference links. */
function closing(
  version: string | undefined,
  digest: string | undefined,
): Array<string> {
  return [
    ...heading("IF SOMETHING GOES WRONG"),
    "  * The invitation has expired: ask your partner for a new one.",
    "  * Docker cannot download the image: in every command, put",
    `      ${imageReference(version, ALTERNATIVE_REGISTRY)}`,
    "    in place of",
    `      ${commandImage(version)}`,
    "  * 'Permission denied' on Docker Engine for Linux: add",
    `      ${OPERATOR_USER_FLAG}`,
    "    straight after docker run in every command.",
    "",
    ...heading("REFERENCE"),
    "  Command-line reference:",
    `    ${ALCOVE_CLI_DOC_URL}`,
    ...digestLines(digest),
    "",
  ];
}

/**
 * Build the accept kit for one minted invitation. The output is printable
 * ASCII with a trailing newline, addressed to the partner.
 */
export function buildAcceptKit({
  endpoint,
  version: buildVersion,
  digest: consoleDigest,
  ...settings
}: AcceptKitInput): string {
  const version = releaseVersion(buildVersion);
  const digest = imageDigest(consoleDigest);
  const filedrop = endpoint.channel === "filedrop";
  const split = endpoint.channel === "filedrop" && endpoint.split === true;
  const lines = [
    RULE,
    "ALCOVE - HOW TO ACCEPT THIS EXCHANGE",
    RULE,
    "",
    ...introLines(endpoint),
    "",
    ...(filedrop
      ? [
          "You need Docker, installed and running (Docker Desktop, from",
          "docker.com). On Windows, use PowerShell. Each command is one line.",
        ]
      : [
          "You need your own account on that server, and Docker, installed",
          "and running (Docker Desktop, from docker.com). On Windows, use",
          "PowerShell. Each command is one line.",
        ]),
    "",
    ...(filedrop ? launcherPointerLines(split) : []),
    ...saveStep(endpoint),
    ...imageCheckStep(version),
    ...acceptStep(version),
    ...(filedrop
      ? filedropSteps(version, split, settings)
      : sftpSteps(version, settings)),
    ...(filedrop ? launcherLines(version, settings, split) : []),
    ...closing(version, digest),
  ];
  return `${lines.join("\n")}\n`;
}

/** The download filename `alcove-accept-instructions-<date>.txt`, the date the
 * local calendar day of `at` -- the moment the operator clicks download, which
 * can be any time the share screen is open, not the mint moment. */
export function acceptKitFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `alcove-accept-instructions-${year}-${month}-${day}.txt`;
}
