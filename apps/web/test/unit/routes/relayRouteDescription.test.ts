import { describe, expect, test, vi } from "vitest";

import { Route as RelayRoute } from "../../../src/routes/relay.tsx";

// The relay settings page is the hosted build's alone (a console build
// redirects its route), and it sets the coordination server, so the page's
// description names it.
vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
  ),
);

async function description(): Promise<unknown> {
  const head = RelayRoute.options.head;
  if (head === undefined) throw new Error("the relay route declares no head");
  const { meta } = await head({} as Parameters<typeof head>[0]);
  return meta?.find(
    (entry) =>
      entry !== undefined && "name" in entry && entry.name === "description",
  )?.content;
}

describe("the relay settings route's description", () => {
  test("names the relays and the coordination server", async () => {
    expect(await description()).toBe(
      "Set the relays and the coordination server your side of an exchange uses.",
    );
  });
});
