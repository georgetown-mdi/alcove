import { expect } from "vitest";

import { page, userEvent } from "vitest/browser";

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import type { InvitationToken, LinkageTerms } from "@alcove/core";

/** Two single-element keys, one per name field: the acceptor's terms for a
 * journey that needs a plain, fully-resolved match. */
export const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

/** An invitation token for the acceptor to open, on the local signaling
 * server. `expiresInMs` adds an expiry that far from now; left unset the token
 * carries none. */
export async function encodeAcceptToken({
  linkageTerms = acceptorTerms,
  expiresInMs,
}: {
  linkageTerms?: LinkageTerms;
  expiresInMs?: number;
} = {}): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
    sharedSecret: generateSharedSecret(),
    ...(expiresInMs !== undefined && {
      expires: new Date(Date.now() + expiresInMs).toISOString(),
    }),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

/**
 * From an already-rendered inviter screen: fill the name, supply `clients.csv`,
 * then walk to Review & create without creating. On the console profile the file is picked and
 * confirmed from the mounted directory (the two-stage commit); otherwise it is
 * uploaded through the file input.
 */
export async function reachReviewCreate({
  console: consoleProfile,
}: {
  console: boolean;
}): Promise<void> {
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  if (consoleProfile) {
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to matching & sharing" }),
      )
      .toBeEnabled();
  } else {
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob,program_code\n" +
            "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  }
  await page
    .getByRole("button", { name: "Continue to matching & sharing" })
    .click();
  await page
    .getByRole("button", { name: "Continue to review & create" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Review & create");
}
