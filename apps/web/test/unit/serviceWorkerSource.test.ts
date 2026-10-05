import { describe, expect, test } from "vitest";

import { serviceWorkerStringArray } from "../../hosted/serviceWorkerSource";

describe("serviceWorkerStringArray", () => {
  test("skips a comment that holds a quoted string or a closing bracket", () => {
    const source = `const ROUTES = [
  "/", // the "root"; see [x];
  /* "/ignored" ]; */
  "/saved/_",
];`;

    expect(serviceWorkerStringArray("ROUTES", source)).toEqual([
      "/",
      "/saved/_",
    ]);
  });

  test("throws naming an entry that does not start with a slash", () => {
    const source = `const ROUTES = ["/", "saved"];`;

    expect(() => serviceWorkerStringArray("ROUTES", source)).toThrow('"saved"');
  });
});
