import { describe, expect, test, vi } from "vitest";

import { isRedirect } from "@tanstack/react-router";

import { Route as RelayRoute } from "../../../src/routes/relay.tsx";

const clientConfig = vi.hoisted(() => ({ consoleBuild: false }));
vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    { isConsoleBuild: () => clientConfig.consoleBuild },
  ),
);

function thrownBy(route: {
  options: { beforeLoad?: (ctx: unknown) => unknown };
}): unknown {
  const beforeLoad = route.options.beforeLoad;
  if (beforeLoad === undefined) throw new Error("route declares no beforeLoad");
  try {
    beforeLoad({});
  } catch (thrown) {
    return thrown;
  }
  throw new Error("beforeLoad did not throw a redirect");
}

describe("the /relay route", () => {
  test.each([
    { build: "a hosted build", consoleBuild: false },
    { build: "a console build", consoleBuild: true },
  ])("on $build replaces itself with /exchange", ({ consoleBuild }) => {
    clientConfig.consoleBuild = consoleBuild;
    const thrown = thrownBy(
      RelayRoute as unknown as {
        options: { beforeLoad?: (ctx: unknown) => unknown };
      },
    );
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { to?: string; replace?: boolean } })
      .options;
    expect(options.to).toBe("/exchange");
    expect(options.replace).toBe(true);
  });

  test("renders no page of its own", () => {
    expect(RelayRoute.options.component).toBeUndefined();
    expect(RelayRoute.options.head).toBeUndefined();
  });
});
