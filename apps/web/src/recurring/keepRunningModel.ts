import { MANAGED_INPUT_FILE_NAME } from "@psi/managed/managedInputHandle";

/**
 * The pure model behind the keep-running section of a scheduled exchange's
 * page: how the page offers installing, the checklist of what an unattended
 * run needs (docs/notes/managed-exchange-design.md, "The automation goal and
 * its platform envelope", and docs/MANAGED_EXCHANGE.md, "Installing the app"),
 * and the copy for the readiness check's
 * result. No React, no I/O.
 */

/** How the page offers installing: `installedRuntime` where this page already
 * is the installed app, `installedFromThisPage` where it was installed while
 * this page was open, `button` where the browser offered to install, and
 * `instructions` everywhere else. */
export type InstallOffer =
  "installedRuntime" | "installedFromThisPage" | "button" | "instructions";

/** Choose how the page offers installing. */
export function installOffer(options: {
  installedRuntime: boolean;
  installedFromThisPage: boolean;
  promptAvailable: boolean;
}): InstallOffer {
  if (options.installedRuntime) return "installedRuntime";
  if (options.installedFromThisPage) return "installedFromThisPage";
  return options.promptAvailable ? "button" : "instructions";
}

/** The sentence beside each install offer. */
export const INSTALL_OFFER_COPY: Record<InstallOffer, string> = {
  installedRuntime:
    "This page is the installed Alcove app, so it runs this exchange at each window while it is open.",
  installedFromThisPage:
    "Alcove is installed. Open it from your computer's apps and open this exchange there: this browser tab does not run it on its own.",
  button:
    "Install Alcove as an app on this computer. The installed app runs this exchange at each window while it is open; this browser tab does not.",
  instructions:
    "To install Alcove, open your browser's menu and choose to install it; scheduled runs need a desktop browser such as Chrome or Edge.",
};

/** One line of the keep-running checklist. `done` is present only for an item
 * this page can see; the others are the operator's to keep. */
export interface KeepRunningItem {
  id: "install" | "startAtSignIn" | "stayAwake" | "browserProfile" | "folder";
  instruction: string;
  done?: boolean;
}

/**
 * The keep-running checklist for this browser. `folderGrantSupported` is
 * whether this browser can hold a folder at all; `hasWorkingFolder` is whether
 * it holds one for this exchange.
 */
export function keepRunningChecklist(options: {
  installedRuntime: boolean;
  folderGrantSupported: boolean;
  hasWorkingFolder: boolean;
}): Array<KeepRunningItem> {
  return [
    {
      id: "install",
      instruction: "Install Alcove as an app and open this exchange in it.",
      done: options.installedRuntime,
    },
    {
      id: "startAtSignIn",
      instruction:
        "Turn on start at sign-in from the installed app's menu, or open the app before each window.",
    },
    {
      id: "stayAwake",
      instruction:
        "Keep this computer awake and online while each window is open.",
    },
    {
      id: "browserProfile",
      instruction:
        "Use this same browser profile in an ordinary window, not an Incognito or Guest window.",
    },
    options.folderGrantSupported
      ? {
          id: "folder",
          instruction: `Choose this exchange's folder under Local settings and put each period's file in it as ${MANAGED_INPUT_FILE_NAME}.`,
          done: options.hasWorkingFolder,
        }
      : {
          id: "folder",
          instruction:
            "This browser cannot give a site a folder, so each run needs you to choose the file. Use Chrome or Edge to have runs happen with nobody present.",
          done: false,
        },
  ];
}

/** What the readiness check found about the exchange's folder. */
export type FolderReadiness =
  | "unsupported"
  | "none"
  | "notGranted"
  | "inputMissing"
  | "unreadable"
  | "ready";

/** What the readiness check found about the signaling server: `offline` where
 * the browser reports no network at all, so no answer was sought. */
export type SignalingReadiness = "answered" | "noAnswer" | "offline";

/** Everything the readiness check found. */
export interface ReadinessReport {
  installedRuntime: boolean;
  folder: FolderReadiness;
  signaling: SignalingReadiness;
}

/** One line of the readiness result. */
export interface ReadinessLine {
  id: "installedRuntime" | "folder" | "signaling";
  ok: boolean;
  message: string;
}

const FOLDER_LINES: Record<FolderReadiness, Omit<ReadinessLine, "id">> = {
  ready: {
    ok: true,
    message: `The folder can be read and holds ${MANAGED_INPUT_FILE_NAME}.`,
  },
  none: {
    ok: false,
    message:
      "No folder is chosen for this exchange. Choose one under Local settings below.",
  },
  notGranted: {
    ok: false,
    message:
      "This browser no longer has permission to read the folder. Choose the folder again under Local settings below.",
  },
  inputMissing: {
    ok: false,
    message: `The folder has no file named ${MANAGED_INPUT_FILE_NAME}. Put this period's file there under that name.`,
  },
  unreadable: {
    ok: false,
    message:
      "The folder could not be read. Choose the folder again under Local settings below.",
  },
  unsupported: {
    ok: false,
    message:
      "This browser cannot give a site a folder, so a run cannot read your file with nobody present.",
  },
};

const SIGNALING_LINES: Record<SignalingReadiness, Omit<ReadinessLine, "id">> = {
  answered: {
    ok: true,
    message: "This browser connected to the signaling server.",
  },
  noAnswer: {
    ok: false,
    message:
      "This browser could not connect to the signaling server. Check your network connection and try again; if it still cannot connect, ask your IT team whether this network blocks it.",
  },
  offline: {
    ok: false,
    message:
      "This computer is offline. Connect it to a network before the window opens.",
  },
};

/** The result lines, in checklist order. */
export function readinessLines(report: ReadinessReport): Array<ReadinessLine> {
  return [
    report.installedRuntime
      ? {
          id: "installedRuntime",
          ok: true,
          message: "This page is the installed app.",
        }
      : {
          id: "installedRuntime",
          ok: false,
          message:
            "This page is a browser tab, which does not run this exchange on its own. Open this exchange in the installed app.",
        },
    { id: "folder", ...FOLDER_LINES[report.folder] },
    { id: "signaling", ...SIGNALING_LINES[report.signaling] },
  ];
}

/** Whether every check passed. */
export function readinessReady(report: ReadinessReport): boolean {
  return readinessLines(report).every((line) => line.ok);
}

/** The title over the result. */
export function readinessTitle(report: ReadinessReport): string {
  return readinessReady(report)
    ? "Ready for the next window"
    : "Not ready for the next window";
}

/** What the check does not cover, shown under every result. */
export const READINESS_LIMIT_NOTE =
  "This check does not contact your partner or test the relay server, and sends no data.";
