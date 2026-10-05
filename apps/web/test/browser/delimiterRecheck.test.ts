/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";
import { getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import { MANAGED_INPUT_FILE_NAME } from "@psi/managed/managedInputHandle";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { useDelimiterRecheck } from "@recurring/useDelimiterRecheck";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type * as ManagedInputHandle from "@psi/managed/managedInputHandle";
import type { ExchangeSpec } from "@alcove/core";

const reads = vi.hoisted(() => ({
  count: 0,
  hold: undefined as Promise<void> | undefined,
}));

vi.mock("@psi/managed/managedInputHandle", async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedInputHandle>();
  return {
    ...actual,
    acquireManagedInput: async (
      ...args: Parameters<typeof actual.acquireManagedInput>
    ) => {
      reads.count += 1;
      await reads.hold;
      return await actual.acquireManagedInput(...args);
    },
  };
});

/** Renders the recheck's kind, and the `render` label a test waits on to know
 * a re-render has committed. */
function RecheckProbe({
  exchangeFile,
  directory,
  render = "first",
}: {
  exchangeFile: ExchangeSpec;
  directory: FileSystemDirectoryHandle;
  render?: string;
}) {
  const recheck = useDelimiterRecheck(exchangeFile, directory, ";");
  return createElement("output", null, `${recheck?.kind ?? "none"} ${render}`);
}

async function folder(
  name: string,
  input: string | undefined,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  const directory = await root.getDirectoryHandle(name, { create: true });
  if (input !== undefined) {
    const writable = await (
      await directory.getFileHandle(MANAGED_INPUT_FILE_NAME, { create: true })
    ).createWritable();
    await writable.write(input);
    await writable.close();
  }
  return directory;
}

function agreedExchangeFile(): ExchangeSpec {
  return composeManagedExchangeFile({
    connection: { channel: "webrtc", host: "signaling.example.org" },
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  reads.count = 0;
  reads.hold = undefined;
});

test("a result read from one folder is not shown for another", async () => {
  const withInput = await folder("recheck-with-input", "a;b;c\n1;2;3\n");
  const withoutInput = await folder("recheck-without-input", undefined);
  const terms = agreedExchangeFile();
  app.render(
    createElement(RecheckProbe, {
      exchangeFile: terms,
      directory: withInput,
    }),
  );
  await expect
    .element(page.getByText(/^(fits|short) first$/))
    .toBeInTheDocument();

  let release!: () => void;
  reads.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.render(
    createElement(RecheckProbe, {
      exchangeFile: terms,
      directory: withoutInput,
    }),
  );
  await expect.element(page.getByText("reading first")).toBeInTheDocument();
  release();
  await expect.element(page.getByText("unreadable first")).toBeInTheDocument();
});

test("new terms over the same folder and delimiter are graded without a read", async () => {
  const directory = await folder("recheck-same", "a;b;c\n1;2;3\n");
  app.render(
    createElement(RecheckProbe, {
      exchangeFile: agreedExchangeFile(),
      directory,
    }),
  );
  await expect
    .element(page.getByText(/^(fits|short) first$/))
    .toBeInTheDocument();
  expect(reads.count).toBe(1);

  app.render(
    createElement(RecheckProbe, {
      exchangeFile: agreedExchangeFile(),
      directory,
      render: "second",
    }),
  );
  await expect
    .element(page.getByText(/^(fits|short) second$/))
    .toBeInTheDocument();
  // The committed render's effects have run by the next task.
  await flushPendingUpdates();
  expect(reads.count).toBe(1);
});
