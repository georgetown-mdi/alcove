import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";

import "@mantine/core/styles.css";

import {
  PEER_TIMEOUT_LABEL,
  SFTP_CONNECTION_TUNING,
  connectionTuningOptions,
} from "@console/connectionTuningModel";
import { ConnectionTuningCard } from "@console/ConnectionTuningCard";
import { connectionTuningFromOptions } from "@console/loadedConfig";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { openDisclosure } from "./collapsePanels";

import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { ReactElement } from "react";

const POLL_LABEL = "How often to check for your partner's files";
const CONNECT_LABEL = "How long to wait for each connection attempt";

let latestDraft: ConnectionTuningDraft | undefined;

function TuningHarness({
  initial,
}: {
  initial: ConnectionTuningDraft;
}): ReactElement {
  const [draft, setDraft] = useState(initial);
  return createElement(ConnectionTuningCard, {
    draft,
    capabilities: SFTP_CONNECTION_TUNING,
    onChange: (next: ConnectionTuningDraft) => {
      latestDraft = next;
      setDraft(next);
    },
  });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  latestDraft = undefined;
});

async function renderLoaded(
  options: Parameters<typeof connectionTuningFromOptions>[0],
): Promise<void> {
  app.render(
    createElement(TuningHarness, {
      initial: connectionTuningFromOptions(options),
    }),
  );
  await openDisclosure(/Connection tuning/);
  await expect.element(magnitudeInput(POLL_LABEL)).toBeInTheDocument();
}

const magnitudeInput = (label: string) =>
  page.getByLabelText(label, { exact: true });
const unitSelect = (label: string) => page.getByLabelText(`${label}: unit`);

describe("ConnectionTuningCard: a loaded duration shows as the file states it", () => {
  test("an hour-long check interval shows as 60 minutes", async () => {
    await renderLoaded({ pollIntervalMs: 3_600_000 });

    await expect.element(magnitudeInput(POLL_LABEL)).toHaveValue("60");
    await expect.element(unitSelect(POLL_LABEL)).toHaveValue("m");
  });

  test("a millisecond timeout shows in milliseconds, not seconds", async () => {
    await renderLoaded({ serverConnectTimeoutMs: 2_500 });

    await expect.element(magnitudeInput(CONNECT_LABEL)).toHaveValue("2500");
    await expect.element(unitSelect(CONNECT_LABEL)).toHaveValue("ms");
  });

  test("a loaded millisecond unit stays listed after switching to seconds", async () => {
    await renderLoaded({ serverConnectTimeoutMs: 2_500 });

    await userEvent.selectOptions(unitSelect(CONNECT_LABEL), "s");
    await expect.element(unitSelect(CONNECT_LABEL)).toHaveValue("s");

    await userEvent.selectOptions(unitSelect(CONNECT_LABEL), "ms");
    await expect.element(unitSelect(CONNECT_LABEL)).toHaveValue("ms");
    await expect.element(magnitudeInput(CONNECT_LABEL)).toHaveValue("2500");
  });

  test("editing another field leaves the loaded durations unchanged", async () => {
    const stated = {
      pollIntervalMs: 3_600_000,
      serverConnectTimeoutMs: 2_500,
    };
    await renderLoaded(stated);

    await userEvent.fill(magnitudeInput(PEER_TIMEOUT_LABEL), "5");

    if (latestDraft === undefined) throw new Error("the card never changed");
    expect(connectionTuningOptions(latestDraft)).toEqual({
      ...stated,
      peerTimeoutMs: 300_000,
    });
  });
});
