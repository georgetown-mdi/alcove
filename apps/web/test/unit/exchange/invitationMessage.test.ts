import { expect, test } from "vitest";

import { invitationMessage } from "@exchange/invitationMessage";

const base = {
  deepLink: "https://app.example.org/accept#TOKEN",
  expires: "2026-10-02T12:00:00Z",
};

test("the message holds the link, the expiry, and the sender", () => {
  const message = invitationMessage({
    ...base,
    inviterName: "  County Health Department ",
    practiceOrigin: "https://app.example.org",
  });
  expect(message).toContain("\nhttps://app.example.org/accept#TOKEN\n");
  expect(message).toContain("The link works until October 2, 2026");
  expect(message).toContain("https://app.example.org/quick");
  expect(message.endsWith("\n\nCounty Health Department")).toBe(true);
});

test("the practice pointer and signature drop when there is nothing to name", () => {
  const message = invitationMessage({
    ...base,
    inviterName: "",
    practiceOrigin: undefined,
  });
  expect(message).not.toContain("sample data");
  expect(message.endsWith("when you plan to open it.")).toBe(true);
});
