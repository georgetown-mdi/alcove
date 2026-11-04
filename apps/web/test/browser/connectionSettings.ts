import { page, userEvent } from "vitest/browser";

/** The relay urls a test sets under an exchange's Connection settings. */
export interface OwnRelayEntry {
  turn?: Array<string>;
  stun?: Array<string>;
  websocket?: string;
}

/** Open the relay fields under Connection settings, type `relay` into them,
 * and close them with Done. */
export async function setOwnRelay(relay: OwnRelayEntry): Promise<void> {
  await page.getByRole("button", { name: "Set a relay" }).click();
  if (relay.turn !== undefined)
    await userEvent.fill(
      page.getByRole("textbox", { name: "TURN server urls" }),
      relay.turn.join("\n"),
    );
  if (relay.stun !== undefined)
    await userEvent.fill(
      page.getByRole("textbox", { name: "STUN server urls" }),
      relay.stun.join("\n"),
    );
  if (relay.websocket !== undefined)
    await userEvent.fill(
      page.getByRole("textbox", { name: "WebSocket relay url" }),
      relay.websocket,
    );
  await page.getByRole("button", { name: "Done" }).click();
}

/** Remove the exchange's own relay from its line under Connection settings. */
export async function removeOwnRelay(): Promise<void> {
  await page.getByRole("button", { name: "Remove relay" }).click();
}
