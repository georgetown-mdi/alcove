import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SKIP_WAITING_MESSAGE,
  WARM_ROUTES_MESSAGE,
  appShellUpdateApplying,
  appShellUpdateReady,
  applyAppShellUpdate,
  checkForAppShellUpdate,
  noteAutomaticAppShellUpdate,
  registerAppShell,
  resetAppShellUpdate,
  subscribeAppShellUpdate,
  takeAutomaticAppShellUpdateNotice,
  takeOverWaitingAppShell,
} from "@utils/appShellUpdate";

import {
  createServiceWorkerHarness,
  serviceWorkerString,
} from "../../utils/serviceWorkerHarness";

import type { ShellContainer, ShellWorker } from "@utils/appShellUpdate";

// The client half of the app-shell update path -- which worker states count as
// "update is ready", and what applying one does -- driven with a fabricated
// container. The worker's own half (install without skipWaiting, activate's
// cache purge, the skip-waiting message) is test/unit/utils/serviceWorker.test.ts.
// The apply tests use the shipped `apps/web/public/serviceWorker.js` behind
// the harness, so a pending update is measured by its own `skipWaiting()` call.

/** A worker whose state a test advances, firing `statechange` as a real one does. */
function fakeWorker(state = "installing") {
  const listeners: Array<() => void> = [];
  const messages: Array<unknown> = [];
  const worker = {
    state,
    postMessage: (message: unknown) => messages.push(message),
    addEventListener: (_type: "statechange", listener: () => void) =>
      listeners.push(listener),
  };
  return {
    worker: worker as ShellWorker,
    messages,
    advanceTo(next: string) {
      worker.state = next;
      for (const listener of listeners) listener();
    },
  };
}

/** A container and registration a test drives, standing in for
 * `navigator.serviceWorker`. */
function fakeContainer(options: {
  controller?: ShellWorker | null;
  waiting?: ShellWorker | null;
}) {
  const updateFound: Array<() => void> = [];
  const controllerChange: Array<() => void> = [];
  const checks = { count: 0, fail: false };
  const registration = {
    installing: null as ShellWorker | null,
    waiting: options.waiting ?? null,
    addEventListener: (_type: "updatefound", listener: () => void) =>
      updateFound.push(listener),
    update: () => {
      checks.count += 1;
      return checks.fail
        ? Promise.reject(new TypeError("Failed to update a ServiceWorker"))
        : Promise.resolve();
    },
  };
  const container = {
    controller: options.controller ?? null,
    register: () => Promise.resolve(registration),
    addEventListener: (_type: "controllerchange", listener: () => void) =>
      controllerChange.push(listener),
  };
  return {
    container: container as ShellContainer,
    registration,
    /** How many times the browser was asked to look for a new deployment, and
     * whether the next look fails as an offline one does. */
    checks,
    /** Announce a newly installing worker, as the browser does when it finds a
     * redeployed script. */
    findUpdate(worker: ShellWorker) {
      registration.installing = worker;
      for (const listener of updateFound) listener();
    },
    /** Finish the found worker's install: the browser makes it the waiting
     * worker before it reports the `installed` state. */
    install(installing: ReturnType<typeof fakeWorker>) {
      registration.installing = null;
      registration.waiting = installing.worker;
      installing.advanceTo("installed");
    },
    /** The waiting worker takes over and claims this page. */
    landTakeover() {
      container.controller = registration.waiting;
      registration.waiting = null;
      for (const listener of controllerChange) listener();
    },
    changeController() {
      for (const listener of controllerChange) listener();
    },
  };
}

/**
 * A waiting worker that is the shipped `public/serviceWorker.js`, running in the
 * harness: what the client posts is delivered to the file that deploys, and
 * whether the update was applied is read off that worker's `skipWaiting()`.
 */
function shippedWaitingWorker() {
  const harness = createServiceWorkerHarness();
  const delivered: Array<Promise<void>> = [];
  const worker: ShellWorker = {
    state: "installed",
    postMessage: (message: unknown) => {
      delivered.push(harness.postMessage(message));
    },
    addEventListener: () => undefined,
  };
  return {
    worker,
    /** How many times the shipped worker has been made to take over. */
    async takeovers(): Promise<number> {
      await Promise.all(delivered);
      return harness.skipWaitingCalls;
    },
  };
}

/** The page-unload boundary, which is where a test decides the fate of the reload
 * the operator pressed: `unloadPage` is the page going away, and never calling
 * it is the operator declining the browser's confirmation and staying. */
function fakePageUnloading() {
  const listeners: Array<() => void> = [];
  return {
    onPageUnloading: (listener: () => void) => {
      listeners.push(listener);
    },
    /** How many listeners the module has armed. */
    get armed(): number {
      return listeners.length;
    },
    unloadPage(): void {
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  resetAppShellUpdate();
  vi.unstubAllGlobals();
});

describe("the first install", () => {
  test("is not announced as an update, since it activates by itself", async () => {
    const fake = fakeContainer({ controller: null });
    await registerAppShell(fake.container);
    const installed = fakeWorker();

    fake.findUpdate(installed.worker);
    fake.install(installed);

    expect(appShellUpdateReady()).toBe(false);
  });

  test("claiming the page does not reload it", async () => {
    let reloads = 0;
    const fake = fakeContainer({ controller: null });
    await registerAppShell(fake.container, { reload: () => (reloads += 1) });

    fake.changeController();

    expect(reloads).toBe(0);
  });
});

describe("a redeployment", () => {
  test("is announced once the new worker reaches installed", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    const notified: Array<boolean> = [];
    subscribeAppShellUpdate(() => notified.push(appShellUpdateReady()));
    await registerAppShell(fake.container);
    const installing = fakeWorker();

    fake.findUpdate(installing.worker);
    expect(appShellUpdateReady()).toBe(false);

    fake.install(installing);

    expect(appShellUpdateReady()).toBe(true);
    expect(notified).toEqual([true]);
  });

  test("installed on an earlier visit is announced at registration", async () => {
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: waiting.worker,
    });

    await registerAppShell(fake.container);

    expect(appShellUpdateReady()).toBe(true);
  });
});

describe("applying an update", () => {
  /** A registered page with the shipped worker waiting behind its banner, and
   * the boundaries that decide what pressing Reload comes to. */
  async function readyToApply() {
    const shipped = shippedWaitingWorker();
    const unloading = fakePageUnloading();
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: shipped.worker,
    });
    const reloads = { count: 0 };
    await registerAppShell(fake.container, {
      reload: () => (reloads.count += 1),
      onPageUnloading: unloading.onPageUnloading,
    });
    return { shipped, unloading, fake, reloads };
  }

  test("reloads the page and has the worker take over as it goes", async () => {
    const { shipped, unloading, reloads } = await readyToApply();

    applyAppShellUpdate();

    expect(reloads.count).toBe(1);
    expect(await shipped.takeovers()).toBe(0);

    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(1);
  });

  test("declined, leaves the update pending and applies it on a later confirmation", async () => {
    const { shipped, unloading, reloads } = await readyToApply();

    applyAppShellUpdate();

    // The operator answers the browser's confirmation with Stay, so the page
    // never unloads: its code, its worker, and the pending update are untouched.
    expect(await shipped.takeovers()).toBe(0);
    expect(appShellUpdateReady()).toBe(true);

    applyAppShellUpdate();

    expect(reloads.count).toBe(2);
    expect(unloading.armed).toBe(1);
    expect(await shipped.takeovers()).toBe(0);

    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(1);
  });

  test("applies the newest waiting worker, not the one the operator first pressed", async () => {
    const { shipped, unloading, fake } = await readyToApply();
    applyAppShellUpdate();

    const superseding = shippedWaitingWorker();
    fake.registration.waiting = superseding.worker;
    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(0);
    expect(await superseding.takeovers()).toBe(1);
  });

  test("does nothing when nothing is waiting and nothing was announced", async () => {
    const unloading = fakePageUnloading();
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    let reloads = 0;
    await registerAppShell(fake.container, {
      reload: () => (reloads += 1),
      onPageUnloading: unloading.onPageUnloading,
    });

    applyAppShellUpdate();

    expect(reloads).toBe(0);
    expect(unloading.armed).toBe(0);
  });

  test("applied from another tab this page never asked, ends the announcement here and reloads nothing", async () => {
    const controller = fakeWorker("activated");
    const shipped = shippedWaitingWorker();
    const unloading = fakePageUnloading();
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: shipped.worker,
    });
    let reloads = 0;
    await registerAppShell(fake.container, {
      reload: () => (reloads += 1),
      onPageUnloading: unloading.onPageUnloading,
    });
    expect(appShellUpdateReady()).toBe(true);

    // The other tab applies: the worker takes over origin-wide, so this tab's
    // registration has nothing waiting left.
    fake.registration.waiting = null;
    fake.changeController();
    expect(appShellUpdateReady()).toBe(false);

    applyAppShellUpdate();
    unloading.unloadPage();

    expect(reloads).toBe(0);
    expect(unloading.armed).toBe(0);
    // Found waiting at registration, so only the claim asked for a warm.
    expect(controller.messages).toEqual([WARM_ROUTES_MESSAGE]);
    expect(await shipped.takeovers()).toBe(0);
  });

  test("declined and then applied from another tab, still reloads and posts nothing", async () => {
    const { shipped, unloading, fake, reloads } = await readyToApply();
    applyAppShellUpdate();

    // The operator answers the confirmation with Stay, and the other tab applies
    // while this page is still on the old code with its takeover armed.
    fake.registration.waiting = null;
    fake.changeController();
    expect(appShellUpdateReady()).toBe(true);

    applyAppShellUpdate();
    unloading.unloadPage();

    expect(reloads.count).toBe(2);
    expect(unloading.armed).toBe(1);
    expect(await shipped.takeovers()).toBe(0);
  });

  test("waits, by default, for the page's own pagehide -- and not for a freeze", async () => {
    const shipped = shippedWaitingWorker();
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: shipped.worker,
    });
    const pageHidden: Array<(event: { persisted: boolean }) => void> = [];
    vi.stubGlobal("window", {
      addEventListener: (
        type: string,
        listener: (event: { persisted: boolean }) => void,
      ) => {
        if (type === "pagehide") pageHidden.push(listener);
      },
    });
    await registerAppShell(fake.container, { reload: () => undefined });

    applyAppShellUpdate();
    for (const listener of pageHidden) listener({ persisted: true });

    // A persisted pagehide is the back/forward cache freezing the page, which
    // can be restored still running this code -- not the page going away.
    expect(pageHidden).toHaveLength(1);
    expect(await shipped.takeovers()).toBe(0);

    for (const listener of pageHidden) listener({ persisted: false });

    expect(await shipped.takeovers()).toBe(1);
  });
});

describe("warming every route's code", () => {
  test("is asked for at registration and on a claim", async () => {
    const controller = fakeWorker("activated");
    const fake = fakeContainer({ controller: controller.worker });

    await registerAppShell(fake.container);
    expect(controller.messages).toEqual([WARM_ROUTES_MESSAGE]);

    fake.changeController();

    expect(controller.messages).toEqual([
      WARM_ROUTES_MESSAGE,
      WARM_ROUTES_MESSAGE,
    ]);
  });

  test("is not asked for once this page has asked for a takeover", async () => {
    const controller = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: waiting.worker,
    });
    await registerAppShell(fake.container, {
      reload: () => undefined,
      onPageUnloading: fakePageUnloading().onPageUnloading,
    });
    controller.messages.length = 0;

    applyAppShellUpdate();
    fake.changeController();

    expect(controller.messages).toEqual([]);
  });
});

describe("a takeover ahead of the reload", () => {
  const BOUND_MS = 10_000;

  async function waitingBehindController() {
    const controller = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: waiting.worker,
    });
    const reloads = { count: 0 };
    await registerAppShell(fake.container, {
      reload: () => (reloads.count += 1),
      onPageUnloading: fakePageUnloading().onPageUnloading,
    });
    return { controller, waiting, fake, reloads };
  }

  test("posts the skip-waiting message and resolves once the takeover lands, warming nothing", async () => {
    const { controller, waiting, fake } = await waitingBehindController();

    const takeover = takeOverWaitingAppShell(BOUND_MS);
    expect(waiting.messages).toEqual([SKIP_WAITING_MESSAGE]);
    fake.landTakeover();

    await expect(takeover).resolves.toBe(true);
    // The page's code is now older than its controller: still ready, so the
    // apply reloads onto the new version.
    expect(appShellUpdateReady()).toBe(true);
    expect(controller.messages).toEqual([]);
    expect(waiting.messages).toEqual([SKIP_WAITING_MESSAGE]);
  });

  test("that has not landed within the bound resolves false, and a later ask resolves true once it lands", async () => {
    vi.useFakeTimers();
    try {
      const { fake, reloads } = await waitingBehindController();

      const takeover = takeOverWaitingAppShell(BOUND_MS);
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await expect(takeover).resolves.toBe(false);
      expect(reloads.count).toBe(0);

      fake.landTakeover();
      await expect(takeOverWaitingAppShell(BOUND_MS)).resolves.toBe(true);
      applyAppShellUpdate();
      expect(reloads.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("is announced as applying while it waits, and not once it lands or the wait runs out", async () => {
    vi.useFakeTimers();
    try {
      const { fake } = await waitingBehindController();
      let notified = 0;
      subscribeAppShellUpdate(() => (notified += 1));

      expect(appShellUpdateApplying()).toBe(false);
      const timedOut = takeOverWaitingAppShell(BOUND_MS);
      expect(appShellUpdateApplying()).toBe(true);
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await timedOut;
      expect(appShellUpdateApplying()).toBe(false);

      const landing = takeOverWaitingAppShell(BOUND_MS);
      expect(appShellUpdateApplying()).toBe(true);
      fake.landTakeover();
      await landing;
      expect(appShellUpdateApplying()).toBe(false);
      expect(notified).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("with nothing waiting posts nothing and resolves false", async () => {
    const controller = fakeWorker("activated");
    const fake = fakeContainer({ controller: controller.worker });
    await registerAppShell(fake.container);

    await expect(takeOverWaitingAppShell(BOUND_MS)).resolves.toBe(false);
    expect(controller.messages).toEqual([WARM_ROUTES_MESSAGE]);
  });

  test("leaves the page it reloads into, loaded under the new worker, with nothing ready", async () => {
    const { fake } = await waitingBehindController();
    const takeover = takeOverWaitingAppShell(BOUND_MS);
    fake.landTakeover();
    await takeover;
    const newController = fake.container.controller;

    resetAppShellUpdate();
    const reloaded = fakeContainer({ controller: newController });
    await registerAppShell(reloaded.container);

    expect(appShellUpdateReady()).toBe(false);
    await expect(takeOverWaitingAppShell(BOUND_MS)).resolves.toBe(false);
  });
});

describe("registration", () => {
  test("that finds a worker waiting does not ask the outgoing worker to warm", async () => {
    const controller = fakeWorker("activated");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: fakeWorker("installed").worker,
    });

    await registerAppShell(fake.container);

    expect(controller.messages).toEqual([]);
  });

  test("takes the origin root as its scope and keeps the HTTP cache out of the update check", async () => {
    const calls: Array<[string, unknown]> = [];
    const fake = fakeContainer({ controller: null });
    const container: ShellContainer = {
      ...fake.container,
      register: (scriptUrl, options) => {
        calls.push([scriptUrl, options]);
        return Promise.resolve(fake.registration);
      },
    };

    await registerAppShell(container);

    expect(calls).toEqual([
      ["/serviceWorker.js", { scope: "/", updateViaCache: "none" }],
    ]);
  });

  test("that the browser refuses leaves the app running from the network", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    let reloads = 0;
    const container: ShellContainer = {
      ...fake.container,
      register: () =>
        Promise.reject(new TypeError("Failed to register a ServiceWorker")),
    };

    // register() rejects on the offline first load this feature is for, and the
    // call site fires this without awaiting it: a rejection here would be an
    // unhandled one.
    await expect(
      registerAppShell(container, { reload: () => (reloads += 1) }),
    ).resolves.toBeUndefined();

    expect(appShellUpdateReady()).toBe(false);
    applyAppShellUpdate();
    fake.changeController();
    expect(reloads).toBe(0);
  });
});

describe("a look for a new deployment", () => {
  test("asks the registration to fetch the worker script, and does nothing before there is one", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });

    await checkForAppShellUpdate();
    expect(fake.checks.count).toBe(0);

    await registerAppShell(fake.container);
    await checkForAppShellUpdate();
    expect(fake.checks.count).toBe(1);
  });

  test("that fails, as an offline one does, resolves and leaves nothing announced", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    await registerAppShell(fake.container);
    fake.checks.fail = true;

    await expect(checkForAppShellUpdate()).resolves.toBeUndefined();
    expect(fake.checks.count).toBe(1);
    expect(appShellUpdateReady()).toBe(false);
  });

  test("that finds a redeployed worker announces it as an update", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    await registerAppShell(fake.container);
    const found = fakeWorker();
    fake.registration.update = () => {
      fake.findUpdate(found.worker);
      return Promise.resolve();
    };

    await checkForAppShellUpdate();
    fake.install(found);

    expect(appShellUpdateReady()).toBe(true);
  });
});

describe("the messages the client and the worker exchange", () => {
  test("are the same strings on both sides", () => {
    expect(SKIP_WAITING_MESSAGE).toBe(
      serviceWorkerString("SKIP_WAITING_MESSAGE"),
    );
    expect(WARM_ROUTES_MESSAGE).toBe(
      serviceWorkerString("WARM_ROUTES_MESSAGE"),
    );
  });
});

describe("the line after the scheduled runner applied an update", () => {
  /** A tab's session storage, which outlives a reload of the tab. */
  function stubTabStorage(): void {
    const items = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    });
  }

  test("is shown once per automatic apply", () => {
    stubTabStorage();
    expect(takeAutomaticAppShellUpdateNotice()).toBe(false);

    noteAutomaticAppShellUpdate();
    expect(takeAutomaticAppShellUpdateNotice()).toBe(true);
    expect(takeAutomaticAppShellUpdateNotice()).toBe(false);

    noteAutomaticAppShellUpdate();
    expect(takeAutomaticAppShellUpdateNotice()).toBe(true);
    expect(takeAutomaticAppShellUpdateNotice()).toBe(false);
  });

  test("is not left by the operator's own Reload", async () => {
    stubTabStorage();
    const controller = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: waiting.worker,
    });
    await registerAppShell(fake.container, {
      reload: () => undefined,
      onPageUnloading: fakePageUnloading().onPageUnloading,
    });

    applyAppShellUpdate();

    expect(takeAutomaticAppShellUpdateNotice()).toBe(false);
  });

  test("is not shown where the tab has no session storage", () => {
    vi.stubGlobal("sessionStorage", undefined);
    noteAutomaticAppShellUpdate();
    expect(takeAutomaticAppShellUpdateNotice()).toBe(false);
  });
});
