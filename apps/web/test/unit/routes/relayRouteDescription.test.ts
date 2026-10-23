import { describe, expect, test, vi } from "vitest";

import { Route as RelayRoute } from "../../../src/routes/relay.tsx";

// The relay settings page sets the coordination server on the hosted build
// only, so the page's description names it there and not on a console build.
const clientConfig = vi.hoisted(() => ({ consoleBuild: false }));
vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    { isConsoleBuild: () => clientConfig.consoleBuild },
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
  test("names the coordination server on the hosted build", async () => {
    clientConfig.consoleBuild = false;
    expect(await description()).toBe(
      "Set the relays and the coordination server your side of an exchange uses.",
    );
  });

  test("names only the relays on a console build", async () => {
    clientConfig.consoleBuild = true;
    expect(await description()).toBe(
      "Set the relays your side of an exchange uses.",
    );
  });
});
