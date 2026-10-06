import { describe, expect, test } from "vitest";

import { isHostedDevDocumentRequest } from "../../vite.config";

const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

describe("isHostedDevDocumentRequest", () => {
  test.each(["/", "/accept", "/exchange/abc", "/accept?token=x.y"])(
    "rewrites a page navigation to %s",
    (url) => {
      expect(
        isHostedDevDocumentRequest({
          method: "GET",
          url,
          headers: { accept: HTML_ACCEPT },
        }),
      ).toBe(true);
    },
  );

  test.each(["/api/x", "/favicon.ico", "/assets/app.js"])(
    "leaves %s alone",
    (url) => {
      expect(
        isHostedDevDocumentRequest({
          method: "GET",
          url,
          headers: { accept: HTML_ACCEPT },
        }),
      ).toBe(false);
    },
  );

  test("leaves a POST alone", () => {
    expect(
      isHostedDevDocumentRequest({
        method: "POST",
        url: "/accept",
        headers: { accept: HTML_ACCEPT },
      }),
    ).toBe(false);
  });

  test.each([undefined, "application/json", "*/*"])(
    "leaves a request accepting %s alone",
    (accept) => {
      expect(
        isHostedDevDocumentRequest({
          method: "GET",
          url: "/accept",
          headers: accept === undefined ? {} : { accept },
        }),
      ).toBe(false);
    },
  );
});
