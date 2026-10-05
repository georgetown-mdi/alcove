import { afterEach, describe, expect, test, vi } from "vitest";

import {
  captureInstallPrompt,
  resetInstallPromptForTest,
  showInstallPrompt,
} from "@utils/installPrompt";

// The held install offer, driven by events dispatched on a plain target: the
// browser fires `beforeinstallprompt` only where the page is installable, which
// no test page is.

function installOfferEvent(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  return Object.assign(event, {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome }),
  });
}

afterEach(() => {
  resetInstallPromptForTest();
});

describe("installPrompt", () => {
  test("no offer held shows nothing", async () => {
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
  });

  test("an offer is held, shown once, and spent", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    const event = installOfferEvent("accepted");
    target.dispatchEvent(event);

    await expect(showInstallPrompt()).resolves.toBe("accepted");
    expect(event.prompt).toHaveBeenCalledTimes(1);
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
  });

  test("with no page showing the install button, the browser's banner is left to show", () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    const event = installOfferEvent("accepted");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("a dismissed prompt reports it", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(installOfferEvent("dismissed"));
    await expect(showInstallPrompt()).resolves.toBe("dismissed");
  });

  test("capturing twice holds one listener", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    captureInstallPrompt(target);
    const event = installOfferEvent("accepted");
    target.dispatchEvent(event);
    await showInstallPrompt();
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  test("an install drops the held offer", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(installOfferEvent("accepted"));
    target.dispatchEvent(new Event("appinstalled"));
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
  });
});
