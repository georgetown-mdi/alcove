/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { getDefaultLinkageTerms } from "@alcove/core";

import {
  RELAY_CHECK_OPEN_LABEL,
  RELAY_CHECK_START_LABEL,
} from "@console/relayCheckModel";
import { InviterScreen } from "@exchange/InviterScreen";
import { Lobby } from "@exchange/Lobby";
import { OPEN_CONFIGURATION_LABEL } from "@console/mountedConfiguration";
import { SAMPLE_FILES_ADDED } from "@console/ConsoleSampleData";
import { SWEEP_CONTROL_LABEL } from "@psi/runDiagnosticsModel";

import {
  AUTHORED_SFTP,
  AUTHORED_SFTP_WITH_CREDENTIAL_WARNING,
  CREATED_JOB_ID,
  stubConsoleJobApi,
} from "./consoleStates";
import {
  CONSOLE_JOURNEY_TIMEOUT_MS,
  activate,
  control,
  expectHeadingFocused,
  tabTo,
  toggle,
  typeInto,
} from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";
import { expectStepAccessible } from "./stepChecks";

import type { ConsoleJobApi } from "./consoleStates";
import type { JobHandoff } from "@jobContract/jobHandoff";

// The console's invite flow driven from the keyboard alone (keyboardOnly.ts):
// a file from the working folder, the console's cards on Review & create, the
// SFTP connection and coordination server it authors, the configuration in the
// working folder, and the run the console conducts through to its result or
// failure. Each step is held to the step checks (stepChecks.ts).

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).consoleClientConfigMock(
    importOriginal,
  ),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.setConfig({ testTimeout: CONSOLE_JOURNEY_TIMEOUT_MS });

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A transport stall the console relays: an `exchange` failure that offers
 * Try again. */
const STALL_MESSAGE =
  "the partner did not answer within 10m; confirm they started their half " +
  "and run the exchange again";

const TERMS_MISMATCH =
  "linkage terms do not match the partner's inferred terms";

/** The coordination server a `PUT /api/jobs/webrtc` sets. */
const SIGNALING_SERVER = {
  configured: true,
  host: "signal.example.org",
  port: 8443,
  path: "/api/",
  secure: true,
  webAppOrigin: "https://psi.data-bridge.org",
  warnings: [],
};

const COORDINATION_REFUSAL =
  "https://psi.data-bridge.org did not answer as an Alcove web app. Check " +
  "the address, then set it again.";

/** The hosts a relay check of the working folder contacts. */
const RELAY_CHECK_OFFER = {
  status: "available",
  configurationDigest: "a".repeat(64),
  statement: {
    contactedHeading: "The check contacts these hosts:",
    contacted: [
      {
        host: "turn.relay.county-health.example.gov:3478",
        explanation: ["The TURN relay your alcove.yaml names."],
      },
    ],
    notContacted: {
      heading: "It does not contact:",
      hosts: [
        {
          host: "signal.example.org:8443",
          explanation: ["The coordination server, which a run reaches first."],
        },
      ],
    },
    closing: "Nothing else is contacted.",
  },
};

/** A relay check's verdict with a failing line. */
const RELAY_CHECK_VERDICT = {
  status: "verdict",
  overall: "fix_and_retry",
  checks: [
    {
      id: "turn-reach",
      status: "fail",
      headline: "turn.relay.county-health.example.gov:3478 did not answer",
      meaning: "This container cannot reach the relay over UDP or TCP.",
      action:
        "Ask your network team to allow outbound traffic to the relay's " +
        "address and port, then check again.",
    },
    { id: "turn-auth", status: "skipped", headline: "Signing in to the relay" },
  ],
};

/** The recurring hand-off the console serves for the run the browser
 * created. */
const HANDOFF = {
  mode: "exchange",
  channel: "sftp",
  usedKeyFile: true,
  keyFileBesideConfiguration: false,
  credentialPasted: false,
  usedSigningIdentity: false,
  pathsAsRead: { credential: false, sharedDirectory: false, signing: false },
  bindPaths: [],
  template: {
    kind: "config",
    argv: ["alcove", "exchange", "input.csv", "./"],
    yaml:
      "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n" +
      "    password: '@/path/to/your/credential-file'\n",
  },
} satisfies JobHandoff;

const HANDOFF_HEADING = "Run this exchange on a schedule";

/** A run warning with a long unbroken token in it. */
const HOST_KEY_WARNING =
  "Your partner's console saw the server present the fingerprint " +
  `SHA256:${"B".repeat(43)}, not the one this console pinned. Ask whoever ` +
  "runs the SFTP server which key it presents now.";

const SAMPLE_FILES_CONTROL = "Add sample files to my folder";

/** Renders the invite screen and waits for the working folder's listing. */
async function renderFileStep(): Promise<void> {
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
}

/** Picks the working folder's file from the keyboard, through its confirm
 * stage, and walks to Review & create. */
async function reachReviewByKeyboard(): Promise<void> {
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await typeInto(control("textbox", "Your name or agency"), "Dana Okafor");
  await activate(control("button", "Select clients.csv"));
  await expect
    .element(page.getByRole("heading", { level: 2, name: "Confirm this file" }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Use this file"));
  await expect
    .element(page.getByText("Selected", { exact: true }))
    .toBeInTheDocument();
  await activate(control("button", "Continue to matching & sharing"));

  await expectHeadingFocused("Matching & sharing");
  await expectStepAccessible(app.container);
  await activate(control("button", "Continue to review & create"));
  await expectHeadingFocused(/Review/);
}

/** Moves the Review & create transport choice to WebRTC from the keyboard:
 * Tab enters the transport radios at the checked one, and the arrow keys move
 * the choice within them, past the ones this console cannot run. */
async function chooseWebrtcByKeyboard(): Promise<void> {
  await tabTo(
    (focused) =>
      focused instanceof HTMLInputElement &&
      focused.type === "radio" &&
      focused.checked,
  );
  const webrtc = page.getByLabelText("Over WebRTC, run here");
  for (
    let press = 0;
    press < 4 && !(webrtc.element() as HTMLInputElement).checked;
    press += 1
  )
    await userEvent.keyboard("{ArrowDown}");
  await expect.element(webrtc).toBeChecked();
}

/** Types the web app's address into the coordination server card and sets
 * it, from the keyboard. */
async function setCoordinationServerByKeyboard(): Promise<void> {
  await typeInto(
    control("textbox", "Coordination server or web app address"),
    "https://psi.data-bridge.org",
  );
  await activate(control("button", "Set address and relay"));
}

/** Creates the invitation over the authored SFTP connection from the keyboard
 * and advances the console's run past the wait for the partner. */
async function runByKeyboard(api: ConsoleJobApi): Promise<void> {
  await reachReviewByKeyboard();
  await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Create the invitation"));

  await expectHeadingFocused("Your invitation is ready");
  await vi.waitFor(() => expect(api.createdJobStreaming()).toBe(true));
  await expectStepAccessible(app.container);

  api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange in progress");
  await expectStepAccessible(app.container);
}

test("console invite: working-folder file, review, invitation, run and result, from the keyboard", async () => {
  const api = stubConsoleJobApi({
    sftp: AUTHORED_SFTP,
    routes: { [`GET /api/jobs/${CREATED_JOB_ID}/handoff`]: { body: HANDOFF } },
  });
  await runByKeyboard(api);

  api.emitEvent({
    v: 1,
    type: "warning",
    source: "hostKeyDivergence",
    message: HOST_KEY_WARNING,
  });
  await expect.element(page.getByText(HOST_KEY_WARNING)).toBeInTheDocument();
  await expectStepAccessible(app.container);

  api.emitEvent({ v: 1, type: "result", resultWritten: true });
  api.closeEvents();
  await expectHeadingFocused("Exchange complete");
  await expect
    .element(page.getByRole("heading", { name: HANDOFF_HEADING }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the sample files added on the file step, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: {
      "POST /api/jobs/inputs/samples": {
        body: { files: ["sample-inviter.csv", "sample-partner.csv"] },
      },
    },
  });
  await renderFileStep();
  await activate(control("button", SAMPLE_FILES_CONTROL));
  await expect.element(page.getByText(SAMPLE_FILES_ADDED)).toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the sample files refused on the file step, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: { "POST /api/jobs/inputs/samples": { status: 409 } },
  });
  await renderFileStep();
  await activate(control("button", SAMPLE_FILES_CONTROL));
  await expect
    .element(page.getByText(/could not write the sample files/))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the sample files refused on the start page, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: { "POST /api/jobs/inputs/samples": { status: 409 } },
  });
  app.render(createElement(Lobby));
  const sample = "See how it works with example data";
  await expect
    .element(page.getByRole("button", { name: sample }))
    .toBeInTheDocument();
  await activate(control("button", sample));
  await expect
    .element(page.getByText(/could not write the sample files/))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a failed run and its retry, from the keyboard", async () => {
  expectConsole("error", `RelayedSelfExplainingError: ${STALL_MESSAGE}`);
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await runByKeyboard(api);

  api.setJobStatus("failed");
  api.emitEvent({
    v: 1,
    type: "error",
    category: "exchange",
    message: STALL_MESSAGE,
    recoveryHint: true,
  });
  api.closeEvents();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect.element(retry).toBeInTheDocument();
  await expect.element(retry).not.toHaveAttribute("aria-haspopup");
  await expectStepAccessible(app.container);
  await tabTo(control("button", "Try again"));
});

test("console invite: a run stopped on the partner's changed terms, from the keyboard", async () => {
  expectConsole("error", `RelayedTerminalError: ${TERMS_MISMATCH}`);
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await runByKeyboard(api);

  api.setJobStatus("failed");
  api.emitEvent({
    v: 1,
    type: "error",
    category: "config",
    message: TERMS_MISMATCH,
    termsChange: {
      proposalWritten: true,
      received: {
        added: ["program_enrollment_start_date_county_reported"],
        removed: [],
      },
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["legal agreement"],
    },
  });
  api.closeEvents();
  await expect
    .element(page.getByText(/program_enrollment_start_date_county_reported/))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the cards on Review & create open, and show their errors and a credential warning, from the keyboard", async () => {
  stubConsoleJobApi({ sftp: AUTHORED_SFTP_WITH_CREDENTIAL_WARNING });
  await reachReviewByKeyboard();
  await expect
    .element(page.getByText(/credential file is inside your folder/))
    .toBeInTheDocument();

  await activate(control("button", /^How files are handled/));
  await activate(control("button", /^Connection tuning/));
  await typeInto(
    control("textbox", "How many times to retry a failed connection"),
    "x",
  );
  await activate(control("button", /^Diagnostics and recovery/));
  await toggle(control("checkbox", SWEEP_CONTROL_LABEL));
  await activate(control("button", /^Receipts and record keeping/));
  await expect
    .element(page.getByText("These settings cannot be used").first())
    .toBeInTheDocument();
  await expect
    .element(page.getByText("This run cannot start yet").first())
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the SFTP connection form, its field error and a refused save, from the keyboard", async () => {
  stubConsoleJobApi({ sftpPutStatus: 500 });
  await reachReviewByKeyboard();
  await expect
    .element(page.getByText("No SFTP connection set up for this exchange yet"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await activate(
    control("button", "Run it in my own command-line tool instead"),
  );
  await expect
    .element(page.getByText(/in your own Alcove command-line tool/))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(
    control("button", "Set up a connection to run it here instead"),
  );
  await expect
    .element(page.getByLabelText("SFTP server address"))
    .toHaveFocus();
  await activate(control("button", "Cancel"));
  await expect
    .element(page.getByText("No SFTP connection set up for this exchange yet"))
    .toBeInTheDocument();

  await activate(control("button", "Add connection"));
  await expect
    .element(page.getByLabelText("SFTP server address"))
    .toHaveFocus();
  await expectStepAccessible(app.container);

  await activate(control("button", "Save connection"));
  await expect
    .element(page.getByText("Enter the SFTP server address."))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await tabTo(control("textbox", "SFTP server address"), { backward: true });
  await userEvent.keyboard("sftp.partner.example");
  await typeInto(control("textbox", "Username"), "linkage");
  await typeInto(
    control("textbox", "Server identity fingerprint"),
    FINGERPRINT,
  );
  await typeInto(control("textbox", "File reference"), "@/run/secrets/key");
  await activate(control("button", "Save connection"));
  await expect
    .element(page.getByText("Could not save the connection"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

/** Opens the SFTP connection form on Review & create from the keyboard and
 * types the server address. */
async function openSftpFormByKeyboard(): Promise<void> {
  await reachReviewByKeyboard();
  await activate(control("button", "Add connection"));
  await expect
    .element(page.getByLabelText("SFTP server address"))
    .toHaveFocus();
  await userEvent.keyboard("sftp.partner.example");
}

test("console invite: the SFTP form's host-key probe presents a fingerprint, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: {
      "POST /api/jobs/sftp/probe": {
        body: {
          status: "ok",
          fingerprint: FINGERPRINT,
          keyType: "ssh-ed25519",
        },
      },
    },
  });
  await openSftpFormByKeyboard();
  await activate(control("button", "Read the fingerprint from the server"));
  await expect
    .element(page.getByText("The server presented this fingerprint:"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Use this fingerprint"));
  await expect
    .element(page.getByLabelText("Server identity fingerprint"))
    .toHaveValue(FINGERPRINT);
  await expectStepAccessible(app.container);
});

test("console invite: the SFTP form's host-key probe fails on a server that is not SSH, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: {
      "POST /api/jobs/sftp/probe": {
        body: {
          status: "unreachable",
          peerAnswer: "nonSsh",
          peerAnswerShape: "http",
          peerAnswerExcerpt:
            "HTTP/1.1 400 Bad Request\\r\\nServer: nginx/1.27.0\\r\\nContent-Type: text/html\\r\\n",
        },
      },
    },
  });
  await openSftpFormByKeyboard();
  await activate(control("button", "Read the fingerprint from the server"));
  await expect
    .element(page.getByText("Could not read the fingerprint"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: browsing the secrets folder for the credential file, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: {
      "GET /api/jobs/mounts/secrets/entries": {
        body: {
          configured: true,
          entries: [
            { name: "ssh", kind: "dir" },
            { name: "sftp-password.txt", kind: "file" },
          ],
        },
      },
      "GET /api/jobs/mounts/secrets/entries?subPath=ssh": {
        body: {
          configured: true,
          entries: [
            { name: "id_ed25519_county_partner_exchange", kind: "file" },
          ],
        },
      },
    },
  });
  await openSftpFormByKeyboard();
  await activate(control("button", "Choose the credential file"));
  await expect
    .element(page.getByRole("button", { name: "Open ssh" }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Open ssh"));
  await activate(control("button", "Use id_ed25519_county_partner_exchange"));
  await expect
    .element(page.getByText("Selected:", { exact: true }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the coordination server card, empty and then set, from the keyboard", async () => {
  stubConsoleJobApi({ webrtcSet: SIGNALING_SERVER });
  await reachReviewByKeyboard();
  await chooseWebrtcByKeyboard();
  await expect
    .element(page.getByLabelText("Coordination server or web app address"))
    .toHaveValue("");
  await expectStepAccessible(app.container);

  await setCoordinationServerByKeyboard();
  await expect
    .element(page.getByText("wss://signal.example.org:8443/api/"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a coordination server address the console refuses, from the keyboard", async () => {
  stubConsoleJobApi({
    routes: {
      "PUT /api/jobs/webrtc": {
        status: 400,
        body: { error: COORDINATION_REFUSAL },
      },
    },
  });
  await reachReviewByKeyboard();
  await chooseWebrtcByKeyboard();
  await setCoordinationServerByKeyboard();
  await expect
    .element(page.getByText(COORDINATION_REFUSAL))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a failed WebRTC run and the relay check, from the keyboard", async () => {
  expectConsole("error", `RelayedSelfExplainingError: ${STALL_MESSAGE}`);
  const api = stubConsoleJobApi({
    webrtcSet: SIGNALING_SERVER,
    routes: {
      "GET /api/jobs/relay-check": { body: RELAY_CHECK_OFFER },
      "POST /api/jobs/relay-check": { body: RELAY_CHECK_VERDICT },
    },
  });
  await reachReviewByKeyboard();
  await chooseWebrtcByKeyboard();
  await setCoordinationServerByKeyboard();
  await expect
    .element(page.getByText("wss://signal.example.org:8443/api/"))
    .toBeInTheDocument();
  await activate(control("button", "Create the invitation"));
  await expectHeadingFocused("Your invitation is ready");
  await vi.waitFor(() => expect(api.createdJobStreaming()).toBe(true));
  api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange in progress");

  api.setJobStatus("failed");
  api.emitEvent({
    v: 1,
    type: "error",
    category: "exchange",
    message: STALL_MESSAGE,
    recoveryHint: true,
  });
  api.closeEvents();
  await expect
    .element(page.getByRole("button", { name: RELAY_CHECK_OPEN_LABEL }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await activate(control("button", RELAY_CHECK_OPEN_LABEL));
  await expect
    .element(page.getByRole("button", { name: RELAY_CHECK_START_LABEL }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await activate(control("button", RELAY_CHECK_START_LABEL));
  await expect.element(page.getByText(/What to do:/)).toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a signed receipt's setup and its command lines, from the keyboard", async () => {
  stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await reachReviewByKeyboard();
  await activate(control("button", /^Receipts and record keeping/));
  await typeInto(control("combobox", "What this exchange produces"), "Signed");
  await expect
    .element(page.getByText("About your signing identity"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the working folder's configuration, opened with its notices, from the keyboard", async () => {
  stubConsoleJobApi({
    config: {
      configured: true,
      present: true,
      document: {
        channel: "sftp",
        server: { host: "sftp.partner.example", username: "county" },
        linkageTerms: getDefaultLinkageTerms("County Health"),
      },
      carriedThrough: ["added_setting"],
      warnings: ["connection.server.password"],
      signingPathSettings: [],
      folderPathSettings: [],
    },
  });
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();

  await activate(control("button", OPEN_CONFIGURATION_LABEL));
  await expect
    .element(page.getByText("Configuration opened").first())
    .toBeInTheDocument();
  await expect.element(page.getByText(/added_setting/)).toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a configuration the console refuses, from the keyboard", async () => {
  stubConsoleJobApi({
    config: {
      error:
        "The alcove.yaml in your working folder is not an Alcove exchange " +
        "configuration. Check the file, then open it again.",
    },
    configStatus: 400,
  });
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();

  await activate(control("button", OPEN_CONFIGURATION_LABEL));
  await expect
    .element(page.getByText("This configuration cannot be opened").first())
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});
