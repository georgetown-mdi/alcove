import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { PLACEHOLDER_SSH_USERNAME, decodeInvitation } from "@alcove/core";

import {
  INVITATION_FILE_ARGUMENT,
  acceptKitFileName,
  buildAcceptKit,
} from "@exchange/acceptKit";
import {
  generateInvitation,
  invitationDeclaresRetainedFiles,
} from "@psi/invitation";

import type { AcceptKitEndpoint } from "@exchange/acceptKit";
import type { InvitationLocation } from "@psi/invitation";

const FILEDROP: AcceptKitEndpoint = { channel: "filedrop", path: "alcove" };
const UNNAMED_FILEDROP: AcceptKitEndpoint = { channel: "filedrop" };
const FILEDROP_SPLIT: AcceptKitEndpoint = {
  channel: "filedrop",
  split: true,
  inboundPath: "to-clinic",
  outboundPath: "from-clinic",
};
const UNNAMED_FILEDROP_SPLIT: AcceptKitEndpoint = {
  channel: "filedrop",
  split: true,
};
const SFTP: AcceptKitEndpoint = {
  channel: "sftp",
  host: "sftp.example.gov",
  port: 2222,
  path: "/drops/alcove",
};
const SFTP_SPLIT: AcceptKitEndpoint = {
  channel: "sftp",
  host: "sftp.example.gov",
  port: 2222,
  inboundPath: "/exchange/from-partner",
  outboundPath: "/exchange/from-inviter",
};

/** The sheet for an exchange in the default file-handling mode: everything
 * outside the retain and lockless suites below reads this one. */
function sheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: false,
    locklessRendezvous: false,
    version,
  });
}

/** The sheet for an exchange the inviter turned retain mode on for, holding
 * the lockless rendezvous retain mode implies -- what the mint resolves. */
function retainSheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: true,
    locklessRendezvous: true,
    version,
  });
}

/** The sheet for an exchange running the lockless rendezvous on its own, which
 * is the operator stating it rather than retain mode implying it. */
function locklessSheet(endpoint: AcceptKitEndpoint, version = "1.4.2"): string {
  return buildAcceptKit({
    endpoint,
    retainFiles: false,
    locklessRendezvous: true,
    version,
  });
}

/** The launcher branch's tell: the release page the two files come from. */
const RELEASES_URL = "https://github.com/georgetown-mdi/alcove/releases";

/** The heading the filedrop sheet sends a network-drive reader to. */
const LAUNCHER_HEADING = "WINDOWS NETWORK DRIVE OR DFS PATH";

/** Every channel shape the console can mint a kit for. */
const ENDPOINTS = [
  FILEDROP,
  UNNAMED_FILEDROP,
  FILEDROP_SPLIT,
  UNNAMED_FILEDROP_SPLIT,
  SFTP,
  SFTP_SPLIT,
];

const FILEDROP_ENDPOINTS = ENDPOINTS.filter(
  (endpoint) => endpoint.channel === "filedrop",
);

/** The accept command every sheet gives, at version 1.4.2. */
const ACCEPT_COMMAND =
  'docker run --rm -it -v "${PWD}:/work" docker.io/gumdi/alcove:1.4.2 ' +
  'accept "@invitation.txt" your-file.csv';

/** The exchange command as it stands in the default file-handling mode, with
 * `flag` (a bilateral setting's, with its leading space) after the
 * subcommand: the one line a bilateral setting rewrites rather than adds. */
function exchangeCommand(endpoint: AcceptKitEndpoint, flag = ""): string {
  if (endpoint.channel !== "filedrop")
    return (
      '     docker run --rm -it -v "${PWD}:/work" -v "/your/secrets:' +
      `/run/secrets:ro" docker.io/gumdi/alcove:1.4.2 exchange${flag} ` +
      "--server-username REPLACE_WITH_SSH_USERNAME --server-password " +
      '"@/run/secrets/sftp-password.txt" your-file.csv ./results'
    );
  return endpoint.split === true
    ? '     docker run --rm -v "${PWD}:/work" -v "/path/to/the/folder/you/read:' +
        '/sync-in" -v "/path/to/the/folder/you/write:/sync-out" ' +
        `docker.io/gumdi/alcove:1.4.2 exchange${flag} your-file.csv ./results`
    : '     docker run --rm -v "${PWD}:/work" -v "/path/to/your/shared/folder:' +
        `/sync" docker.io/gumdi/alcove:1.4.2 exchange${flag} your-file.csv ` +
        "./results";
}

/** The lines `variant` has that `base` does not: one setting's whole
 * contribution to the sheet, blank lines excluded because both sheets have
 * them. */
function addedLines(base: string, variant: string): Array<string> {
  const known = new Set(base.split("\n"));
  return variant.split("\n").filter((line) => !known.has(line));
}

/** The text from `start` up to `end`, or to the end of the sheet. */
function section(text: string, start: string, end?: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const rest = text.slice(from);
  return end === undefined ? rest : rest.slice(0, rest.indexOf(end));
}

describe("accept kit, per-channel shape", () => {
  test("a filedrop sheet names the shared folder as the partner's name for it", () => {
    // The same folder can have a different name on each side -- a share root
    // mapped to a drive letter is the ordinary case -- so the sheet must not
    // tell the reader their own name for it will be this one.
    const text = sheet(FILEDROP);
    expect(text).toContain("HOW TO ACCEPT THIS EXCHANGE");
    expect(text).toContain("Shared folder:  alcove\n");
    expect(text).toContain(
      "That is your partner's name for it; yours can differ.",
    );
    // The SFTP-only material stays off it.
    expect(text).not.toContain("SFTP server:");
    expect(text).not.toContain("--server-username");
  });

  test("a filedrop sheet the console could not name the folder for prints no name", () => {
    // No name at all rather than a stand-in: the mount point the console binds
    // the folder at is not a name any partner could check against.
    const text = sheet(UNNAMED_FILEDROP);
    expect(text).not.toContain("Shared folder:");
    expect(text).not.toContain("your partner's name for it");
    expect(text).toContain("through a shared\nfolder you can both reach.");
    // The route to accepting is unchanged: only the name is missing.
    expect(text).toContain(LAUNCHER_HEADING);
    expect(text).toContain(ACCEPT_COMMAND);
  });

  test("the folder step directs one replacement whether or not the folder is named", () => {
    // Accepting writes the inviter's name for the folder, or the console's own
    // mount point where it had none; the step describes neither, so it never
    // calls a value a name neither side chose.
    const step = (endpoint: AcceptKitEndpoint): string =>
      section(sheet(endpoint), "4. In alcove.yaml", "5. Run the exchange");
    expect(step(FILEDROP)).toContain(
      "change path under\n   connection: to /sync\n",
    );
    expect(step(UNNAMED_FILEDROP)).toBe(step(FILEDROP));
    expect(step(UNNAMED_FILEDROP_SPLIT)).toBe(step(FILEDROP_SPLIT));
  });

  test("an sftp sheet names the server locator", () => {
    const text = sheet(SFTP);
    expect(text).toContain("through this SFTP\nserver:");
    expect(text).toContain("SFTP server:    sftp.example.gov:2222");
    expect(text).toContain("Directory:      /drops/alcove");
    expect(text).toContain("You need your own account on that server");
    // The filedrop-only routing stays off it.
    expect(text).not.toContain(LAUNCHER_HEADING);
    expect(text).not.toContain(RELEASES_URL);
    expect(text).not.toContain("In alcove.yaml");
  });

  test("an sftp locator without a port or directory prints neither", () => {
    const text = sheet({ channel: "sftp", host: "sftp.example.gov" });
    expect(text).toContain("SFTP server:    sftp.example.gov\n");
    expect(text).not.toContain("Directory:");
  });

  test("a split-directory sftp sheet states each folder from the READER's side", () => {
    // The invitation names the pair from the inviter's side: the inviter's
    // inbound is where its peer -- this sheet's reader -- writes.
    const text = sheet({
      channel: "sftp",
      host: "sftp.example.gov",
      inboundPath: "/exchange/from-partner",
      outboundPath: "/exchange/from-inviter",
    });
    expect(text).toContain("You write to:   /exchange/from-partner");
    expect(text).toContain("You read from:  /exchange/from-inviter");
    expect(text).not.toContain("Directory:");
  });

  test("the terms are referred to, never restated", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      expect(text).toContain(
        "then shows the terms. Read them, and answer y to\n   accept.",
      );
      expect(text).not.toContain("linkage key");
    }
  });
});

describe("accept kit, the steps", () => {
  test("every sheet saves the invitation as a file and names it in accept", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      expect(text).toContain("1. Save the invitation your partner sent");
      expect(text).toContain(ACCEPT_COMMAND);
      // The file form is the only one: no command takes the invitation itself.
      expect(text).not.toContain("PASTE_YOUR_INVITATION");
      expect(text.indexOf("1. Save the invitation")).toBeLessThan(
        text.indexOf("docker run"),
      );
    }
  });

  test("a filedrop partner keeps the invitation and key file out of the shared folder", () => {
    expect(sheet(FILEDROP)).toContain(
      "not the shared folder, and run every command from there.",
    );
    expect(sheet(FILEDROP_SPLIT)).toContain(
      "not either shared folder, and run every command from there.",
    );
    expect(sheet(SFTP)).not.toContain("shared folder");
  });

  test("no command has a pre-filled identity, since accepting asks for one", () => {
    // An unreplaced placeholder inside a command the reader pastes whole would
    // ship as this party's name; accepting at a terminal asks instead.
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      expect(text).not.toContain("--identity");
      expect(text).toContain(
        "It asks for your name, organization, and contact",
      );
    }
  });

  test("names the Docker Engine user flag only as a recovery step", () => {
    const USER_FLAG = '--user "$(id -u):$(id -g)"';
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      const recovery = section(text, "IF SOMETHING GOES WRONG", "REFERENCE");
      expect(recovery).toContain("Docker Engine for Linux");
      expect(recovery).toContain(USER_FLAG);
      expect(recovery).toContain(
        "On rootless Podman,\n    add --userns=keep-id:uid=1000,gid=1000 instead.",
      );
      expect(text.indexOf(USER_FLAG)).toBe(text.lastIndexOf(USER_FLAG));
      expect(text).not.toContain("chown");
    }
  });
});

describe("accept kit, filedrop routing", () => {
  test("points a network-drive reader at the launcher section", () => {
    for (const endpoint of FILEDROP_ENDPOINTS) {
      const text = sheet(endpoint);
      expect(text).toContain("Windows network drive or DFS path");
      expect(text.indexOf("skip")).toBeLessThan(text.indexOf("1. Save"));
      const launcher = section(
        text,
        `${LAUNCHER_HEADING}\n`,
        "IF SOMETHING GOES WRONG",
      );
      expect(launcher).toContain(RELEASES_URL);
      expect(launcher).toContain("Start-Alcove.ps1");
      expect(launcher).toContain("Setup-AlcoveFileDrop.ps1");
      expect(launcher).toContain("from this release page and nowhere else");
      expect(launcher).toContain('"Run as administrator"');
      expect(launcher).toContain("paste the invitation");
      // The launcher branch is Windows-only: the shell launcher does no share
      // resolution.
      expect(text).not.toContain("start-alcove.sh");
    }
  });

  test("gives the Docker-visible route both commands", () => {
    const text = sheet(FILEDROP);
    expect(text).toContain(ACCEPT_COMMAND);
    expect(text).toContain(exchangeCommand(FILEDROP));
  });
});

describe("accept kit, sftp credential", () => {
  test("names the account and password file as flags, never a value", () => {
    const text = sheet(SFTP);
    expect(text).toContain(exchangeCommand(SFTP));
    expect(text).toContain(
      "in a text file named\n   sftp-password.txt, in a folder outside this one.",
    );
    expect(text).toContain("--server-private-key in place of");
    expect(text).toContain("Leave alcove.yaml as it is");
    expect(text).not.toContain("connection:");
  });

  test("the account placeholder is the one the CLI refuses unreplaced", () => {
    // The CLI refuses any connection value starting with REPLACE_WITH_
    // (`configPlaceholderFields` in apps/cli/src/config.ts, whose unit test
    // pins core's SSH username placeholder as caught).
    expect(PLACEHOLDER_SSH_USERNAME.startsWith("REPLACE_WITH_")).toBe(true);
    expect(sheet(SFTP)).toContain(
      `--server-username ${PLACEHOLDER_SSH_USERNAME} `,
    );
  });

  test("tells the reader to check the server's key fingerprint", () => {
    expect(sheet(SFTP)).toContain("The first run shows the server's key");
  });
});

describe("accept kit, release version", () => {
  /** Every image reference the sheet names on either registry, in order. */
  function imageReferences(text: string): Array<string> {
    return (
      text.match(/(ghcr\.io\/georgetown-mdi|docker\.io\/gumdi)\/alcove\S*/g) ??
      []
    );
  }

  /** The reference as the given registry names it at `tag`. */
  const onBoth = (tag: string): Array<string> => [
    `docker.io/gumdi/alcove:${tag}`,
    `ghcr.io/georgetown-mdi/alcove:${tag}`,
  ];

  test("a build with a version names it in every image reference", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const text = sheet(endpoint, "0.9.1");
      // Every reference has the version; none is left bare or floating.
      const references = imageReferences(text);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(onBoth("0.9.1")).toContain(reference);
    }
  });

  test("a build with no version names the floating tag", () => {
    for (const endpoint of [FILEDROP, SFTP]) {
      const references = imageReferences(
        buildAcceptKit({
          endpoint,
          retainFiles: false,
          locklessRendezvous: false,
        }),
      );
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(onBoth("latest")).toContain(reference);
    }
  });

  test("a version in any shape but a release version falls back to the floating tag", () => {
    // An empty, partial, placeholder, or malformed value names the floating
    // tag rather than reaching the sheet: no image reference is left empty,
    // truncated, or naming a tag no release published.
    for (const version of [
      "",
      "undefined",
      "0.0.0",
      "0.0.0-rc.1",
      "1.4",
      "v1.4.2",
      "X.Y.Z",
      "1.4.2 ",
      "1.4.2/../evil",
    ]) {
      const references = imageReferences(sheet(FILEDROP, version));
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references)
        expect(onBoth("latest")).toContain(reference);
    }
  });

  test("the release link follows the same value the tag does", () => {
    // The launcher branch sends the partner to a release page: this build's own
    // release when it has a version, so the launchers they download match
    // the image the sheet names, and the index otherwise.
    expect(sheet(FILEDROP, "0.9.1")).toContain(`${RELEASES_URL}/tag/v0.9.1\n`);
    const unversioned = buildAcceptKit({
      endpoint: FILEDROP,
      retainFiles: false,
      locklessRendezvous: false,
    });
    expect(unversioned).toContain(`${RELEASES_URL}\n`);
    expect(unversioned).not.toContain(`${RELEASES_URL}/tag/`);
    expect(sheet(FILEDROP, "X.Y.Z")).not.toContain(`${RELEASES_URL}/tag/`);
  });
});

describe("accept kit, the two registries", () => {
  test("every command runs the image from Docker Hub", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint, "0.9.1");
      const commands = text.slice(0, text.indexOf("IF SOMETHING GOES WRONG"));
      expect(commands).toContain("docker.io/gumdi/alcove:0.9.1");
      expect(commands).not.toContain("ghcr.io");
      expect(commands).not.toContain("@sha256:");
    }
  });

  test("the recovery note swaps the Docker Hub image for the ghcr.io one", () => {
    const recovery = section(
      sheet(SFTP, "0.9.1"),
      "IF SOMETHING GOES WRONG",
      "REFERENCE",
    );
    expect(recovery).toContain(
      "      ghcr.io/georgetown-mdi/alcove:0.9.1\n    in place of\n" +
        "      docker.io/gumdi/alcove:0.9.1\n",
    );
  });

  test("the reference names only the command-line reference", () => {
    expect(section(sheet(FILEDROP), "REFERENCE\n")).toBe(
      "REFERENCE\n---------\n\n  Command-line reference:\n" +
        "    https://data-bridge.org/docs/CLI\n\n",
    );
  });
});

describe("accept kit, checking the image", () => {
  /** The release's own `cosign verify` command on Docker Hub by tag, from
   * docs/RELEASES.md's Container image section, joined onto one line. */
  function publishedVerifyCommand(): string {
    const releases = readFileSync(
      fileURLToPath(
        new URL("../../../../../docs/RELEASES.md", import.meta.url),
      ),
      "utf8",
    );
    const block =
      /cosign verify \\\n(?:.*\\\n)*?\s*docker\.io\/gumdi\/alcove:X\.Y\.Z\n/.exec(
        releases.slice(releases.indexOf("### Container image")),
      );
    expect(block).not.toBeNull();
    return (block?.[0] ?? "").trim().replace(/\s*\\\n\s*/g, " ");
  }

  /** The sheet's verify line, trimmed. */
  function verifyLine(text: string): string | undefined {
    return text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("cosign verify "));
  }

  test("every sheet gives the release's verify command against the image it runs", () => {
    const expected = publishedVerifyCommand().replace("X.Y.Z", "1.4.2");
    for (const endpoint of ENDPOINTS)
      for (const text of [
        sheet(endpoint),
        retainSheet(endpoint),
        locklessSheet(endpoint),
      ]) {
        expect(verifyLine(text)).toBe(expected);
        expect(text.indexOf("cosign verify ")).toBeLessThan(
          text.indexOf("docker run"),
        );
      }
  });

  test("a build with no version verifies the floating tag", () => {
    const text = buildAcceptKit({
      endpoint: SFTP,
      retainFiles: false,
      locklessRendezvous: false,
    });
    expect(verifyLine(text)).toBe(
      publishedVerifyCommand().replace("X.Y.Z", "latest"),
    );
  });

  test.each(["bash", "sh"])(
    "%s hands cosign the identity pattern unchanged",
    (shell) => {
      const line = verifyLine(sheet(SFTP)) ?? "";
      const script =
        "cosign() { for argument in \"$@\"; do printf '[%s]\\n' " +
        `"$argument"; done; }; ${line}`;
      const run = spawnSync(shell, ["-c", script], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(
        run.stdout
          .split("\n")
          .filter((output) => output.length > 0)
          .map((output) => output.replace(/^\[(.*)\]$/, "$1")),
      ).toEqual([
        "verify",
        "--certificate-identity-regexp",
        "^https://github\\.com/georgetown-mdi/alcove/\\.github/workflows/" +
          "release\\.yaml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$",
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "docker.io/gumdi/alcove:1.4.2",
      ]);
    },
  );
});

describe("accept kit, printable-ASCII enforcement", () => {
  test("a locator with control and non-ASCII bytes renders as printable ASCII", () => {
    // The invariant is enforced at the interpolation point, not assumed of
    // the console's inputs: the only free-text fields the sheet interpolates
    // are the operator-authored host and path.
    const text = sheet({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops\u0007/psi–link",
    });
    expect(text).toContain("SFTP server:    h?llo?example.gov");
    expect(text).toContain("Directory:      /drops?/psi?link");
    // The build's version is the other representable input; it is interpolated
    // only in the release shape, so a value with non-ASCII bytes reaches
    // neither the image reference nor the release link, and the sheet it
    // produces is printable ASCII like any other.
    const hostileVersion = sheet(
      { channel: "filedrop", path: "alcove" },
      "1.0.0-é\nX",
    );
    expect(hostileVersion).toContain("docker.io/gumdi/alcove:latest");
    expect(hostileVersion).toMatch(/^[\x20-\x7e\n]*$/);
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }

    // The split-directory pair interpolates two more free-text fields, held to
    // the same contract.
    const splitText = sheet({
      channel: "sftp",
      host: "sftp.example.gov",
      inboundPath: "héllo\nfrom-partner",
      outboundPath: "/exchange/psi–link",
    });
    expect(splitText).toContain("You write to:   h?llo?from-partner");
    expect(splitText).toContain("You read from:  /exchange/psi?link");
    for (const ch of splitText) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }
  });
});

describe("accept kit, a split filedrop rendezvous", () => {
  test("names both folders by what the READER does with each", () => {
    // The endpoint states the pair from the INVITER's side, which is the direction
    // the partner's own tool mirrors: the inviter's inbound is where the reader
    // WRITES, and the inviter's outbound is where the reader READS.
    const text = sheet(FILEDROP_SPLIT);
    expect(text).toContain("You write to:   to-clinic");
    expect(text).toContain("You read from:  from-clinic");
    expect(text).toContain("Those are your partner's names for them");
    // The single-shared-folder wording never crosses onto it.
    expect(text).not.toContain("Shared folder:");
  });

  test("describes two folders even where it can name neither", () => {
    // The SHAPE is not the names: a split rendezvous the console cannot name still
    // has to be set up as two folders, so the sheet must not fall back to the
    // single-shared-folder body.
    const text = sheet(UNNAMED_FILEDROP_SPLIT);
    expect(text).toContain("you write into one and read");
    expect(text).not.toContain("Shared folder:");
    expect(text).not.toContain("your partner's names for them");
    expect(text).not.toContain("change path under");
    expect(text).toContain("change inbound_path to");
  });

  test("directs a two-mount run, and sends the launcher route to a pair", () => {
    const text = retainSheet(FILEDROP_SPLIT);
    expect(text).toContain(
      "change inbound_path to\n   /sync-in and outbound_path to /sync-out\n",
    );
    expect(text).toContain('-v "/path/to/the/folder/you/read:/sync-in"');
    expect(text).toContain('-v "/path/to/the/folder/you/write:/sync-out"');
    // The launcher provisions a pair, so its route tells the reader which
    // folder is which.
    const launcher = section(text, `${LAUNCHER_HEADING}\n`);
    expect(launcher).toContain("Start-Alcove.ps1");
    expect(launcher).toContain("answer yes");
    expect(launcher).toContain("the folder you read from first");
    expect(launcher).toContain("inside one exchange folder");
    // The single-folder route's own mount never appears.
    expect(text).not.toContain('":/sync ');
  });

  test("holds both folder names to the printable-ASCII contract", () => {
    const text = sheet({
      channel: "filedrop",
      split: true,
      inboundPath: "héllo\nto-clinic",
      outboundPath: "from–clinic",
    });
    expect(text).toContain("You write to:   h?llo?to-clinic");
    expect(text).toContain("You read from:  from?clinic");
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code <= 126)).toBe(true);
    }
  });
});

describe("accept kit, retain mode", () => {
  const RETAIN_FLAG = "--retain-files";
  const RETAIN_FLAG_LINES = [
    "   Keep --retain-files in the command: your partner keeps every",
    "   exchange file, and the exchange stops with an error unless both",
    "   sides use it.",
  ];
  const RETAIN_CONTROL_LINES = [
    'Before you start the exchange there, open "How files are handled"',
    "and choose to keep every exchange file. Both sides must.",
  ];

  /** The lines the retain-on sheet has that the retain-off sheet does
   * not: the whole retain contribution. */
  function retainDelta(
    endpoint: AcceptKitEndpoint,
    version = "1.4.2",
  ): Array<string> {
    return addedLines(sheet(endpoint, version), retainSheet(endpoint, version));
  }

  test("adds the flag, its note, and on filedrop the console control, and nothing else", () => {
    // What retain mode leaves behind is stated by the terms accepting shows,
    // before the reader confirms; the sheet adds only the reader's half of
    // the agreement, on each route off it.
    for (const endpoint of ENDPOINTS)
      expect(retainDelta(endpoint)).toEqual([
        exchangeCommand(endpoint, ` ${RETAIN_FLAG}`),
        ...RETAIN_FLAG_LINES,
        ...(endpoint.channel === "filedrop" ? RETAIN_CONTROL_LINES : []),
      ]);
  });

  test("has the flag on the exchange command, never on accept", () => {
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      // One flag, not three: the CLI resolves what retain mode implies, so the
      // sheet cannot drift from it by re-deriving the trio.
      expect(text).toContain(`exchange ${RETAIN_FLAG} `);
      expect(text).not.toContain("--timestamp-in-filename");
      expect(text).not.toContain("--lockless-rendezvous");
      expect(text).not.toContain(`accept ${RETAIN_FLAG}`);
      expect(text).toContain(ACCEPT_COMMAND);
    }
  });

  test("routes the launcher branch to the console control", () => {
    // The launcher route never runs the commands on the sheet: it hands the
    // partner to the console's accept flow, so the same agreement has to be
    // named there or that route rendezvouses into a mismatch.
    const launcher = section(
      retainSheet(FILEDROP),
      `${LAUNCHER_HEADING}\n`,
      "IF SOMETHING GOES WRONG",
    );
    expect(launcher).toContain('open "How files are handled"');
    expect(launcher).toContain("choose to keep every exchange file");
    expect(retainSheet(SFTP)).not.toContain("How files are handled");
  });

  test("leaves the sheet untouched when retain mode is off", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      for (const marker of [
        RETAIN_FLAG,
        "retain mode",
        "keep every exchange file",
        "keeps every exchange file",
      ])
        expect(text).not.toContain(marker);
    }
  });

  test("the retain addition is fixed text, not another dynamic value", () => {
    // The sheet admits two dynamic values (the locator and the release
    // version). Retain mode selects fixed lines, so a hostile
    // locator changes nothing about what it contributes -- the delta is
    // identical.
    const benign = retainDelta(SFTP);
    const hostile = retainDelta({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops/psi–link",
    });
    expect(hostile).toEqual(benign);
    expect(retainDelta(UNNAMED_FILEDROP)).toEqual(retainDelta(FILEDROP));

    // The version reaches the delta only where it already reached the sheet:
    // the image reference on the rewritten command line, and nowhere else.
    const other = retainDelta(SFTP, "0.9.1");
    const withoutImage = (lines: Array<string>): Array<string> =>
      lines.filter((line) => !line.includes("docker.io/gumdi/alcove"));
    expect(withoutImage(other)).toEqual(withoutImage(benign));
    expect(benign.filter((line) => line.includes("1.4.2"))).toHaveLength(1);
  });

  test("a retain sheet is printable ASCII with a trailing newline", () => {
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit, lockless rendezvous", () => {
  const LOCKLESS_FLAG = "--lockless-rendezvous";
  const LOCKLESS_FLAG_LINES = [
    "   Keep --lockless-rendezvous in the command: the exchange stops with",
    "   an error unless both sides use it.",
  ];
  const LOCKLESS_CONTROL_LINES = [
    'Before you start the exchange there, open "How files are handled"',
    'and set "Lockless rendezvous" to On. Both sides must.',
  ];

  /** The lines the lockless sheet has that the default sheet does not:
   * the whole contribution of the setting. */
  function locklessDelta(
    endpoint: AcceptKitEndpoint,
    version = "1.4.2",
  ): Array<string> {
    return addedLines(
      sheet(endpoint, version),
      locklessSheet(endpoint, version),
    );
  }

  test("adds the flag, its note, and on filedrop the console control, and nothing else", () => {
    for (const endpoint of ENDPOINTS)
      expect(locklessDelta(endpoint)).toEqual([
        exchangeCommand(endpoint, ` ${LOCKLESS_FLAG}`),
        ...LOCKLESS_FLAG_LINES,
        ...(endpoint.channel === "filedrop" ? LOCKLESS_CONTROL_LINES : []),
      ]);
  });

  test("has the flag on the exchange command, never on accept", () => {
    for (const endpoint of ENDPOINTS) {
      const text = locklessSheet(endpoint);
      expect(text).toContain(`exchange ${LOCKLESS_FLAG} `);
      // The setting stands alone here: it is the operator's own, not retain
      // mode's implication, so none of retain's material reaches the sheet.
      expect(text).not.toContain("--retain-files");
      expect(text).not.toContain("--timestamp-in-filename");
      expect(text).not.toContain(`accept ${LOCKLESS_FLAG}`);
      expect(text).toContain(ACCEPT_COMMAND);
    }
  });

  test("routes the launcher branch to the console control", () => {
    const launcher = section(
      locklessSheet(FILEDROP),
      `${LAUNCHER_HEADING}\n`,
      "IF SOMETHING GOES WRONG",
    );
    expect(launcher).toContain('open "How files are handled"');
    expect(launcher).toContain('set "Lockless rendezvous" to On');
    expect(locklessSheet(SFTP)).not.toContain("Lockless rendezvous");
  });

  test("retain mode includes it, so the flag never doubles up", () => {
    // Retain mode implies the lockless rendezvous and the CLI resolves that
    // implication: the sheet states the one operator-visible flag, and a retain
    // sheet is byte-identical however the rendezvous setting resolved.
    for (const endpoint of ENDPOINTS) {
      const text = retainSheet(endpoint);
      expect(text).toBe(
        buildAcceptKit({
          endpoint,
          retainFiles: true,
          locklessRendezvous: false,
          version: "1.4.2",
        }),
      );
      expect(text).not.toContain(LOCKLESS_FLAG);
    }
  });

  test("leaves the sheet untouched when the rendezvous is left at its default", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      for (const marker of [LOCKLESS_FLAG, "Lockless rendezvous", "lock file"])
        expect(text).not.toContain(marker);
    }
  });

  test("the addition is fixed text, not another dynamic value", () => {
    const benign = locklessDelta(SFTP);
    const hostile = locklessDelta({
      channel: "sftp",
      host: "héllo\nexample.gov",
      path: "/drops/psi–link",
    });
    expect(hostile).toEqual(benign);
    expect(locklessDelta(UNNAMED_FILEDROP)).toEqual(locklessDelta(FILEDROP));

    const other = locklessDelta(SFTP, "0.9.1");
    const withoutImage = (lines: Array<string>): Array<string> =>
      lines.filter((line) => !line.includes("docker.io/gumdi/alcove"));
    expect(withoutImage(other)).toEqual(withoutImage(benign));
    expect(benign.filter((line) => line.includes("1.4.2"))).toHaveLength(1);
  });

  test("a lockless sheet is printable ASCII with a trailing newline", () => {
    for (const endpoint of ENDPOINTS) {
      const text = locklessSheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit invariants", () => {
  test.each(ENDPOINTS)(
    "closes on the command-line reference on the project site (%o)",
    (endpoint) => {
      expect(sheet(endpoint)).toContain(
        "  Command-line reference:\n    https://data-bridge.org/docs/CLI\n",
      );
    },
  );

  const location: InvitationLocation = {
    origin: "https://example.org:8443",
    signaling: {
      host: "example.org",
      port: 8443,
      path: "/api/",
      secure: true,
    },
  };
  const CSV =
    "ssn,ssn4,first_name,last_name,dob\n123456789,6789,Alice,Smith,1990-01-02\n";

  test("names the invitation file and has no invitation token or secret", async () => {
    // Mint through the real invitation flow, then build the kit from the same
    // locator that mint held, exactly as the screen does.
    const endpoint = { channel: "filedrop" as const, path: "alcove" };
    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: "County Health Dept",
      file: Readable.from(CSV),
      location,
      connectionEndpoint: endpoint,
    });
    const text = buildAcceptKit({
      endpoint,
      retainFiles: false,
      locklessRendezvous: false,
      version: "1.4.2",
    });

    expect(text).toContain(INVITATION_FILE_ARGUMENT);
    expect(text).not.toContain(minted.sharedSecret);
    expect(text).not.toContain(minted.encoded);
    expect(text).not.toContain(minted.deepLink);
    // Nor the inviter's own identity, which is the token's to disclose.
    expect(text).not.toContain("County Health Dept");
  });

  test("states one retention mode on the token and on the sheet", async () => {
    // Both partner-facing statements of retain mode come from one derived
    // value, the rule the mint applies: a split rendezvous composed while the
    // run's own retain flag is off declares the retention on the token, and
    // the sheet beside it gives the retain flag rather than none.
    const retainFiles = invitationDeclaresRetainedFiles({
      connectionEndpoint: SFTP_SPLIT,
      retainsFiles: false,
    });
    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: "County Health Dept",
      file: Readable.from(CSV),
      location,
      connectionEndpoint: SFTP_SPLIT,
      retainsFiles: retainFiles,
    });
    const token = await decodeInvitation(minted.encoded);
    expect(token.inviterRetainsFiles).toBe(true);
    const text = buildAcceptKit({
      endpoint: SFTP_SPLIT,
      retainFiles,
      locklessRendezvous: true,
      version: "1.4.2",
    });
    expect(text).toContain("exchange --retain-files ");
  });

  test("has the shared folder's name, never the console path behind it", () => {
    // The name the console minted into the token, standing for the mount
    // /data/exchanges/agency-a-agency-b behind it.
    const text = sheet({ channel: "filedrop", path: "agency-a-agency-b" });
    expect(text).toContain("Shared folder:  agency-a-agency-b");
    expect(text).not.toContain("/data/exchanges/agency-a-agency-b");
    expect(text).not.toContain("/data/exchanges");
  });

  test("has no container path from the inviter's console", () => {
    // The only container paths the sheet names are the partner's own future
    // mount points in the commands it gives them.
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      // A web address is not a container path: the project site's host name
      // begins "data-".
      const withoutAddresses = text.replace(/https?:\/\/\S+/g, "");
      expect(withoutAddresses).not.toContain("/data");
      expect(withoutAddresses).not.toContain("/app");
      expect(text).not.toContain("alcove.yaml.tmp");
      // The mount points the partner types are present and fixed.
      expect(text).toContain('-v "${PWD}:/work"');
    }
  });

  test("is printable ASCII with a trailing newline", () => {
    for (const endpoint of ENDPOINTS) {
      const text = sheet(endpoint);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });
});

describe("accept kit, the commands as each shell runs them", () => {
  /** The file the Windows PowerShell 5.1 suite runs line by line
   * (`support/maintainer-notes/AcceptSheet.Tests.ps1`); `npx vitest run -u`
   * rewrites it from the generator. */
  const COMMANDS_FILE =
    "../../../../../support/maintainer-notes/accept-sheet-commands.txt";

  function dockerRunLines(text: string): Array<string> {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("docker run "));
  }

  /** Every `docker run` line any sheet gives, across every channel shape and
   * every file-handling mode, each once. */
  function everyDockerRunLine(): Array<string> {
    const sheets = ENDPOINTS.flatMap((endpoint) => [
      sheet(endpoint),
      retainSheet(endpoint),
      locklessSheet(endpoint),
    ]);
    return [...new Set(sheets.flatMap(dockerRunLines))];
  }

  /** The words of a command after `docker`, each with one pair of surrounding
   * quotes removed and `${PWD}` replaced by `folder`: what the reader means
   * docker to receive. A quoted value holding a space splits here and fails
   * the comparison rather than passing it. */
  function intendedArguments(line: string, folder: string): Array<string> {
    const [program, ...words] = line.split(" ");
    expect(program).toBe("docker");
    return words.map((word) =>
      word.replace(/^"(.*)"$|^'(.*)'$/, "$1$2").replace("${PWD}", folder),
    );
  }

  test("every sheet's commands mount the working folder in the one form", () => {
    const lines = everyDockerRunLine();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(' -v "${PWD}:/work" ');
      // Every mount value sits inside one pair of double quotes.
      const words = line.split(" ");
      words.forEach((word, index) => {
        if (word === "-v") expect(words[index + 1]).toMatch(/^"[^"]+"$/);
      });
    }
  });

  test("double-quotes every @ file argument", () => {
    // Windows PowerShell parses a bare `@name` as splatting.
    for (const line of everyDockerRunLine())
      for (const word of line.split(" "))
        if (word.includes("@") && !word.includes("alcove@"))
          expect(word).toMatch(/^"@[^"]+"$/);
  });

  test("matches the lines the Windows CI suite runs", async () => {
    await expect(`${everyDockerRunLine().join("\n")}\n`).toMatchFileSnapshot(
      COMMANDS_FILE,
    );
  });

  test.each(["bash", "sh"])(
    "%s hands docker each word as one argument, from a folder with a space",
    (shell) => {
      const folder = realpathSync(
        mkdtempSync(join(tmpdir(), "alcove accept sheet ")),
      );
      try {
        const lines = everyDockerRunLine();
        expect(
          lines.some((line) =>
            line.includes(` accept ${INVITATION_FILE_ARGUMENT} `),
          ),
        ).toBe(true);
        for (const command of lines) {
          // A docker stand-in printing each argument it receives in brackets,
          // so an empty or space-edged one stays visible.
          const script =
            "docker() { for argument in \"$@\"; do printf '[%s]\\n' " +
            `"$argument"; done; }; ${command}`;
          const run = spawnSync(shell, ["-c", script], {
            cwd: folder,
            env: { ...process.env, PWD: folder },
            encoding: "utf8",
          });
          expect(run.status, run.stderr).toBe(0);
          const received = run.stdout
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => line.replace(/^\[(.*)\]$/, "$1"));
          expect(received).toEqual(intendedArguments(command, folder));
          expect(received).toContain(`${folder}:/work`);
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
});

describe("accept kit filename", () => {
  test("stamps the local calendar day of the download click", () => {
    expect(acceptKitFileName(new Date(2026, 1, 3, 9, 30))).toBe(
      "alcove-accept-instructions-2026-02-03.txt",
    );
  });
});
