/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  captureInstallPrompt,
  resetInstallPromptForTest,
} from "@utils/installPrompt";
import { KeepRunningSection } from "@recurring/KeepRunningSection";
import { checkWorkingFolder } from "@recurring/readinessCheck";

import { createAppMount } from "./renderApp";
import { expectNoAccessibilityViolations } from "./accessibilityRules";

import type {
  FolderReadiness,
  SignalingReadiness,
} from "@recurring/keepRunningModel";
import type { ReadinessCheckDependencies } from "@recurring/readinessCheck";

// The keep-running section of a scheduled exchange's page: the install button
// shown only where the browser offered to install, the checklist, and the
// readiness check's result states, with the platform readings injected. The
// folder check runs against real origin-private directory handles.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const app = createAppMount();

const FOLDERS: Array<string> = [];

afterEach(async () => {
  app.unmount();
  resetInstallPromptForTest();
  const root = await navigator.storage.getDirectory();
  for (const name of FOLDERS.splice(0))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
});

function scheduledRecord(workingDirectoryHandle?: FileSystemDirectoryHandle) {
  const anchor = new Date(Date.now() + 3_600_000).toISOString();
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: "A".repeat(43),
    schedule: {
      anchor,
      intervalDays: 1,
      windowSeconds: 10_800,
      nextWindow: anchor,
      consecutiveMisses: 0,
    },
    ...(workingDirectoryHandle !== undefined ? { workingDirectoryHandle } : {}),
  });
}

function readings(
  folder: FolderReadiness,
  signaling: SignalingReadiness,
  installed: boolean,
): ReadinessCheckDependencies {
  return {
    isInstalledRuntime: () => installed,
    isOnline: () => signaling !== "offline",
    probeSignalingServer: () => Promise.resolve(signaling === "answered"),
    checkWorkingFolder: () => Promise.resolve(folder),
  };
}

async function folderNamed(name: string, withInput: boolean) {
  FOLDERS.push(name);
  const folder = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(name, { create: true });
  if (withInput) await folder.getFileHandle("input.csv", { create: true });
  return folder;
}

const installButton = () =>
  page.getByRole("button", { name: "Install Alcove" });

describe("the install offer", () => {
  test("is a button once the browser offers to install, and prompts on press", async () => {
    captureInstallPrompt(window);
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => false,
      }),
    );
    expect(installButton().query()).toBeNull();
    await expect
      .element(page.getByText("open your browser's menu", { exact: false }))
      .toBeInTheDocument();

    const prompt = vi.fn(() => Promise.resolve());
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      { prompt, userChoice: Promise.resolve({ outcome: "dismissed" }) },
    );
    window.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(true);
    await expect.element(installButton()).toBeInTheDocument();
    expectNoAccessibilityViolations(app.container);

    await installButton().click();
    expect(prompt).toHaveBeenCalledTimes(1);
    await expect
      .element(
        page.getByText("You closed the install prompt", { exact: false }),
      )
      .toBeInTheDocument();
    expect(installButton().query()).toBeNull();
  });

  test("leaves the browser's banner to show on a page without the button, and holds the offer for one shown later", async () => {
    captureInstallPrompt(window);
    app.render(createElement("p", null, "Another page"));
    const prompt = vi.fn(() => Promise.resolve());
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) },
    );
    window.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(false);

    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => false,
      }),
    );
    await installButton().click();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test("is withheld in the installed app", async () => {
    captureInstallPrompt(window);
    window.dispatchEvent(
      Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
        prompt: () => Promise.resolve(),
        userChoice: Promise.resolve({ outcome: "accepted" }),
      }),
    );
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => true,
      }),
    );
    await expect
      .element(
        page.getByText("This page is the installed Alcove app", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(installButton().query()).toBeNull();
  });

  test("points at the installed app once installed from this page", async () => {
    captureInstallPrompt(window);
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => false,
      }),
    );
    window.dispatchEvent(new Event("appinstalled"));
    await expect
      .element(page.getByText("Alcove is installed.", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("the keep-running checklist", () => {
  test("lists what an unattended run needs, marking what this page can see", async () => {
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => false,
      }),
    );
    const items = page.getByRole("listitem");
    await expect.element(items.first()).toBeInTheDocument();
    const texts = items.elements().map((item) => item.textContent);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain("Install Alcove as an app");
    expect(texts[0]).toContain("Not yet.");
    expect(texts[1]).toContain("start at sign-in");
    expect(texts[2]).toContain("awake and online");
    expect(texts[3]).toContain("not an Incognito or Guest window");
    expect(texts[4]).toContain("input.csv");
    expect(texts[4]).toContain("Not yet.");
    expectNoAccessibilityViolations(app.container);
  });
});

describe("the readiness check", () => {
  test("a ready browser reads as ready, and names what it did not check", async () => {
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => true,
        readinessCheck: readings("ready", "answered", true),
      }),
    );
    await page
      .getByRole("button", { name: "Check readiness for the next window" })
      .click();
    await expect
      .element(page.getByRole("status"))
      .toMatchTextContent(/^Ready for the next window/);
    await expect
      .element(
        page.getByText("This browser connected to the signaling server."),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("does not contact your partner", { exact: false }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("alert").query()).toBeNull();
    expectNoAccessibilityViolations(app.container);
  });

  test("each failing reading names its remedy", async () => {
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => false,
        readinessCheck: readings("inputMissing", "noAnswer", false),
      }),
    );
    await page
      .getByRole("button", { name: "Check readiness for the next window" })
      .click();
    await expect
      .element(page.getByRole("status"))
      .toMatchTextContent(/^Not ready for the next window/);
    await expect
      .element(page.getByText("This page is a browser tab", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("The folder has no file named input.csv", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "This browser could not connect to the signaling server",
          {
            exact: false,
          },
        ),
      )
      .toBeInTheDocument();
    expectNoAccessibilityViolations(app.container);
  });

  test("an offline browser is told to connect", async () => {
    app.render(
      createElement(KeepRunningSection, {
        record: scheduledRecord(),
        isInstalledRuntime: () => true,
        readinessCheck: readings("ready", "offline", true),
      }),
    );
    await page
      .getByRole("button", { name: "Check readiness for the next window" })
      .click();
    await expect
      .element(page.getByText("This computer is offline", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("the folder check", () => {
  test("a held folder holding input.csv is ready", async () => {
    const folder = await folderNamed("keep-running-ready", true);
    await expect(checkWorkingFolder(folder)).resolves.toBe("ready");
  });

  test("a held folder without input.csv is missing its input", async () => {
    const folder = await folderNamed("keep-running-empty", false);
    await expect(checkWorkingFolder(folder)).resolves.toBe("inputMissing");
  });

  test("no held folder is none", async () => {
    await expect(checkWorkingFolder(undefined)).resolves.toBe("none");
  });

  test("a permission no longer granted is reported without a prompt", async () => {
    const folder = await folderNamed("keep-running-revoked", true);
    const request = vi.fn();
    await expect(
      checkWorkingFolder(folder, {
        query: () => Promise.resolve("prompt"),
        request,
      }),
    ).resolves.toBe("notGranted");
    expect(request).not.toHaveBeenCalled();
  });

  test("a denied permission is reported without a prompt", async () => {
    const folder = await folderNamed("keep-running-denied", true);
    const request = vi.fn();
    await expect(
      checkWorkingFolder(folder, {
        query: () => Promise.resolve("denied"),
        request,
      }),
    ).resolves.toBe("notGranted");
    expect(request).not.toHaveBeenCalled();
  });
});
