/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assembleExchangeSpec,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  CLI_BUILT_IN_STUN_URI,
  RUN_IN_FLIGHT_EXPORT_NOTE,
  runElsewhereNotice,
} from "@recurring/managedCronExportModel";
import {
  CRONTAB_ACCOUNT_NOTE,
  CRON_PERCENT_NOTE,
  FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE,
  PASTED_TEXT_ESCAPING_NOTE,
} from "@recurring/scheduledRunCommand";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managed/managedLocalState";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { exportManagedCronFiles } from "@psi/managed/managedExchangeExport";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { disclosureToggle, openDisclosure } from "./collapsePanels";
import { captureDownloads } from "./captureDownloads";
import { holdRunLockElsewhere } from "./runLockReadings";

import type { DownloadCapture } from "./captureDownloads";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { managedCronExportPanelState } from "@recurring/managedCronExportModel";

// The command-line export panel on the run surface, against real Chromium: real
// IndexedDB stores, a real export, nothing stubbed. Pinned here: the two files
// the CLI opens land, the export writes nothing (the stored exchange stays
// runnable here and its backup marker is untouched), and the notice beside it
// says what running the exchange elsewhere means for this copy.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// A record built here names no bind path, so a test that needs the lines
// withheld sets this notice and the panel's state carries it in their place.
const withheldLines = vi.hoisted(() => ({
  notice: undefined as string | undefined,
}));

vi.mock("@recurring/managedCronExportModel", async (importOriginal) => {
  type PanelState = typeof managedCronExportPanelState;
  const actual = await importOriginal<{
    managedCronExportPanelState: PanelState;
  }>();
  return {
    ...actual,
    managedCronExportPanelState: (
      ...args: Parameters<PanelState>
    ): ReturnType<PanelState> => {
      const state = actual.managedCronExportPanelState(...args);
      if (withheldLines.notice === undefined || state.kind !== "exportable")
        return state;
      return {
        ...state,
        lines: { kind: "withheld", notice: withheldLines.notice },
      };
    },
  };
});

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const app = createAppMount();

const EXPORT_PANEL = "Run this from the command line";

// A pattern for the label, since a refused export's toggle also names its
// collapsed summary.
const exportToggle = () => disclosureToggle(new RegExp(`^${EXPORT_PANEL}`));

/** How many places show the run-in-progress note: one beside each export. */
const notesShown = () =>
  page.getByText(RUN_IN_FLIGHT_EXPORT_NOTE).elements().length;

/** Open the collapsed export panel on a freshly rendered run surface, through
 * the helper that waits out its open transition: the download button inside it
 * is moving until that transition ends. */
async function openExportPanel(): Promise<void> {
  await expect.element(exportToggle()).toBeInTheDocument();
  expect(exportToggle().element().getAttribute("aria-expanded")).toBe("false");
  await openDisclosure(EXPORT_PANEL);
  expect(exportToggle().element().getAttribute("aria-expanded")).toBe("true");
}

/** Click the panel's download action and wait for both files' bytes to be read
 * back off their object URLs. Neither phase takes a budget of its own: an
 * un-timed `expect.poll` polls for what is left of the test's own timeout, and
 * `settled()` awaits the capture's reads. */
async function downloadBothFiles(downloads: DownloadCapture): Promise<void> {
  await page
    .getByRole("button", { name: "Download alcove.yaml and .alcove.key" })
    .click();
  await expect.poll(() => downloads.captured.length).toBe(2);
  await downloads.settled();
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  // The run surface polls its record's run lock on an interval, so a store read
  // can be in flight at teardown; unmounting into one corrupts React's scheduler
  // for the rest of the file (see flushPendingUpdates).
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("the command-line export hands over two files", () => {
  test("the CLI's config and key land, with the secret in the key half only", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads);

      expect(downloads.captured.map((file) => file.fileName)).toEqual([
        "alcove.yaml",
        ".alcove.key",
      ]);
      const [config, key] = downloads.captured;
      expect(config.text).toContain("linkage_terms:");
      expect(config.text).not.toContain(created.sharedSecret);
      expect(key.text).toContain(created.sharedSecret);
      // The panel hands the secret to the operator's disk, never to the screen.
      expect(app.container.textContent).not.toContain(created.sharedSecret);
    } finally {
      downloads.restore();
    }
  });

  test("the panel names the secret, its custody, and the STUN disclosure", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(page.getByText("shared secret, in plain text", { exact: false }))
      .toBeInTheDocument();
    // The credential-at-rest posture is cited, not restated.
    await expect
      .element(page.getByRole("link", { name: "Key file security" }))
      .toHaveAttribute(
        "href",
        "https://data-bridge.org/docs/SECURITY_DESIGN#key-file-security",
      );
    // This invitation's relay names no STUN server, so a scheduled run falls back
    // to the CLI's built-in default and discloses the host's public address.
    await expect
      .element(page.getByText(CLI_BUILT_IN_STUN_URI, { exact: false }))
      .toBeInTheDocument();
    // The ready-to-run invocation, run from the image over the folder, and the
    // schedule lines are on the panel.
    await expect
      .element(
        page
          .getByText(
            'docker run --rm --user "$(id -u):$(id -g)" --mount ' +
              '"type=bind,src=/path/to/your/exchange-folder,dst=/work"',
            { exact: false },
          )
          .first(),
      )
      .toBeInTheDocument();
    // The run command is shown for Windows as well, with no account option.
    const runBlocks = Array.from(app.container.querySelectorAll("pre")).map(
      (block) => block.textContent,
    );
    const posixRun = runBlocks.find((code) => code.startsWith("docker run"));
    const windowsRun = runBlocks.find(
      (code) => code.startsWith("docker run") && code.includes("C:\\"),
    );
    expect(posixRun).toContain('--user "$(id -u):$(id -g)"');
    expect(windowsRun).toContain("docker run --rm --mount ");
    expect(windowsRun).not.toContain("--user");
    expect(windowsRun).not.toContain("$(");
    await expect
      .element(
        page
          .getByText("exchange --log-file=exchange.log input.csv ./", {
            exact: false,
          })
          .first(),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("0 2 * * * /usr/bin/docker", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Register-ScheduledTask", { exact: false }))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(CRONTAB_ACCOUNT_NOTE);
    expect(app.container.textContent).toContain(PASTED_TEXT_ESCAPING_NOTE);
    expect(app.container.textContent).toContain(CRON_PERCENT_NOTE);
    expect(app.container.textContent).toContain(
      FOLDER_OWNED_BY_IMAGE_ACCOUNT_NOTE,
    );
  });
});

describe("the registrar the invitation's relay names", () => {
  const REGISTRAR_LINE = "A command-line run of this exchange registers at";

  test("is named on the panel, saying a command-line run of the exported configuration enrolls there", async () => {
    const created = await createManagedExchange(
      newExchange({
        side: "acceptor",
        exchangeFile: composeManagedExchangeFile({
          connection: {
            channel: "webrtc",
            host: "signaling.example.org",
            relay: {
              turn: ["turns:relay.partner.example.org:443?transport=tcp"],
              registrar: "https://registrar.partner.example.org",
            },
          },
          linkageTerms,
        }),
      }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(
        page.getByText(
          `${REGISTRAR_LINE} https://registrar.partner.example.org before ` +
            "it connects, and whoever runs that registrar then learns the " +
            "network address of the machine it runs on.",
        ),
      )
      .toBeInTheDocument();
  });

  test("is absent where the invitation's relay names none", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(page.getByText(CLI_BUILT_IN_STUN_URI, { exact: false }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(REGISTRAR_LINE);
  });
});

describe("a panel whose lines are withheld", () => {
  afterEach(() => {
    withheldLines.notice = undefined;
  });

  test("shows the notice and no command, input step, or schedule", async () => {
    const notice = "No command to run or schedule this exchange is shown.";
    withheldLines.notice = notice;
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect.element(page.getByText(notice)).toBeInTheDocument();
    expect(
      page
        .getByText("change the name in the command", { exact: false })
        .query(),
    ).toBe(null);
    expect(
      page
        .getByText("Put your input file in that folder", { exact: true })
        .query(),
    ).toBe(null);
    expect(
      page
        .getByText("Schedule it (adjust the times and the folder)", {
          exact: true,
        })
        .query(),
    ).toBe(null);
    expect(
      page
        .getByText("exchange --log-file=exchange.log input.csv ./", {
          exact: false,
        })
        .query(),
    ).toBe(null);
    expect(page.getByText("lines above", { exact: false }).query()).toBe(null);
    expect(
      page
        .getByRole("button", { name: "Download alcove.yaml and .alcove.key" })
        .query(),
    ).not.toBe(null);
  });
});

describe("the export leaves this browser's copy as it was", () => {
  test("the stored record is unchanged and still runs here", async () => {
    const created = await createManagedExchange(newExchange());
    const before = await getManagedExchange(created.id);
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads);

      expect(await getManagedExchange(created.id)).toEqual(before);
      expect(await getManagedLocalState(created.id)).toBeUndefined();
      await expect
        .element(page.getByRole("button", { name: "Run exchange" }))
        .toBeInTheDocument();
      expect(app.container.textContent).not.toMatch(/handed off/i);
    } finally {
      downloads.restore();
    }
  });
});

describe("a run in flight in another context", () => {
  test("downloads both files beside the note, and the record is unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const before = await getManagedExchange(created.id);
    const release = await holdRunLockElsewhere(created.id);
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await expect.poll(notesShown).toBe(2);

      await page
        .getByRole("button", { name: "Download alcove.yaml and .alcove.key" })
        .click();

      await expect.poll(() => downloads.captured.length).toBe(2);
      await downloads.settled();
      expect(
        page.getByText("Could not export the command-line files").query(),
      ).toBe(null);
      expect(await getManagedExchange(created.id)).toEqual(before);
      expect(await getManagedLocalState(created.id)).toBeUndefined();
    } finally {
      downloads.restore();
      release();
    }
  });
});

describe("the notice beside each export", () => {
  const SCHEDULE_CLAUSE = "turn off its schedule here";

  /** How many places show `notice`: the backup panel and the command-line
   * panel each show it once. */
  const noticesShown = (notice: string) =>
    page.getByText(notice, { exact: true }).elements().length;

  test("says to import it again, with no schedule clause where no schedule is on", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect.poll(() => noticesShown(runElsewhereNotice(false))).toBe(2);
    expect(app.container.textContent).not.toContain(SCHEDULE_CLAUSE);
  });

  test("adds the schedule clause where this copy has a schedule on", async () => {
    const created = await createManagedExchange(
      newExchange({
        schedule: {
          anchor: "2026-10-06T14:30:00.000Z",
          intervalDays: 1,
          windowSeconds: 3600,
          nextWindow: "2026-10-06T14:30:00.000Z",
          consecutiveMisses: 0,
        },
      }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect.poll(() => noticesShown(runElsewhereNotice(true))).toBe(2);
    expect(runElsewhereNotice(true)).toContain(SCHEDULE_CLAUSE);
  });
});

describe("the export leaves the backup indicator exactly where it was", () => {
  // The indicator answers one question -- is there a file this browser can restore
  // from -- and these two files are not one: this app's import does not accept them.
  // So no step of this export may mark the record, whichever way the operator goes.

  test("an export marks nothing, and the exchange is still backup-needed", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads);

      expect(await getManagedLocalState(created.id)).toBeUndefined();
      // Not just the stored marker: the panel above still asks for the backup this
      // operator does not have.
      await expect
        .element(page.getByText("Back up this exchange."))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("an earlier backup's date stays untouched", async () => {
    // The other direction: a record that IS backed up must not lose or re-date its
    // marker for an export that has nothing to do with it.
    const created = await createManagedExchange(newExchange());
    await markManagedExchangeBackedUp(created.id, "2026-07-14T12:00:00.000Z");
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await openExportPanel();
      await downloadBothFiles(downloads);

      expect((await getManagedLocalState(created.id))?.backup).toEqual({
        backedUpAt: "2026-07-14T12:00:00.000Z",
      });
      await expect
        .element(page.getByText("Backed up as of", { exact: false }))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("the panel names these files as the command line's, not a browser backup", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openExportPanel();

    await expect
      .element(
        page.getByText("Downloading them does not change the backup state", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // And the backup panel above says which file that is.
    await expect
      .element(
        page.getByText(
          "The backup file is the one this browser restores from",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
  });
});

describe("a record this app could not have composed", () => {
  /** A stored exchange the command-line composition refuses. Reachable only by
   * importing a hand-crafted artifact: the browser composes a credential-free
   * connection alone. */
  const refusedExchange = () =>
    newExchange({
      exchangeFile: assembleExchangeSpec({
        connection: {
          channel: "webrtc",
          server: { host: "signaling.example.org" },
          turn: [
            {
              url: "turn:relay.example.org:3478",
              username: "operator",
              credential: "@/home/other/turn-credential",
            },
          ],
        },
        linkageTerms,
      }),
    });

  test("is refused rather than exported, and the panel says why", async () => {
    // The panel presents the composer's refusal.
    const created = await createManagedExchange(refusedExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect.element(exportToggle()).toBeInTheDocument();
    // The collapsed toggle already says there is nothing here to open into.
    await expect
      .element(page.getByText("Not available for this exchange"))
      .toBeInTheDocument();
    await exportToggle().click();

    await expect
      .element(
        page.getByText("cannot run from the command line", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("to the command line: turn.", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", {
          name: "Download alcove.yaml and .alcove.key",
        }),
      )
      .not.toBeInTheDocument();
  });

  test("an export past the panel's gate writes nothing in the real store", async () => {
    // The panel gates on the same refusal, but the gate and the click can diverge
    // (a concurrent import or rotation in another tab). The composition refuses the
    // record the store handed back, before anything is downloaded: against real
    // IndexedDB that leaves no sibling entry and no record change.
    const created = await createManagedExchange(refusedExchange());
    const downloaded: Array<string> = [];
    const before = await getManagedExchange(created.id);

    await expect(
      exportManagedCronFiles(created.id, {
        readRecord: getManagedExchange,
        download: (fileName) => downloaded.push(fileName),
        readOwn: () => ({ kind: "none" }),
      }),
    ).rejects.toThrow(/to the command line: turn\./);

    expect(downloaded).toEqual([]);
    expect(await getManagedLocalState(created.id)).toBeUndefined();
    expect(await getManagedExchange(created.id)).toEqual(before);
  });
});
