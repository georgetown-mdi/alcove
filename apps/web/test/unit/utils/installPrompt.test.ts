import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  captureInstallPrompt,
  holdInstallOffer,
  resetInstallPromptForTest,
  showInstallPrompt,
} from "@utils/installPrompt";

// The held install offer, driven by events dispatched on a plain target: the
// browser fires `beforeinstallprompt` only where the page is installable, which
// no test page is.

function installOfferEvent(
  outcome: "accepted" | "dismissed",
  prompt: () => Promise<unknown> = () => Promise.resolve(),
) {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  return Object.assign(event, {
    prompt: vi.fn(prompt),
    userChoice: Promise.resolve({ outcome }),
  });
}

let releaseButtonPage: (() => void) | undefined;

function mountButtonPage() {
  releaseButtonPage = holdInstallOffer();
}

afterEach(() => {
  releaseButtonPage?.();
  releaseButtonPage = undefined;
  resetInstallPromptForTest();
});

describe("installPrompt", () => {
  test("no offer held shows nothing", async () => {
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
  });

  test("with no page showing the install button, the offer is left to the browser and not held", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    const event = installOfferEvent("accepted");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
    expect(event.prompt).not.toHaveBeenCalled();
  });

  test("an offer left to the browser drops one held earlier", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    mountButtonPage();
    target.dispatchEvent(installOfferEvent("accepted"));
    releaseButtonPage?.();
    releaseButtonPage = undefined;
    target.dispatchEvent(installOfferEvent("accepted"));
    await expect(showInstallPrompt()).resolves.toBe("unavailable");
  });

  describe("with a page showing the install button", () => {
    beforeEach(mountButtonPage);

    test("an offer is held back from the browser, shown once, and spent", async () => {
      const target = new EventTarget();
      captureInstallPrompt(target);
      const event = installOfferEvent("accepted");
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);

      await expect(showInstallPrompt()).resolves.toBe("accepted");
      expect(event.prompt).toHaveBeenCalledTimes(1);
      await expect(showInstallPrompt()).resolves.toBe("unavailable");
    });

    test("a dismissed prompt reports it", async () => {
      const target = new EventTarget();
      captureInstallPrompt(target);
      target.dispatchEvent(installOfferEvent("dismissed"));
      await expect(showInstallPrompt()).resolves.toBe("dismissed");
    });

    test("a prompt the browser refuses reports the offer unavailable", async () => {
      const target = new EventTarget();
      captureInstallPrompt(target);
      target.dispatchEvent(
        installOfferEvent("accepted", () =>
          Promise.reject(
            new DOMException("already shown", "InvalidStateError"),
          ),
        ),
      );
      await expect(showInstallPrompt()).resolves.toBe("unavailable");
      await expect(showInstallPrompt()).resolves.toBe("unavailable");
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
});
