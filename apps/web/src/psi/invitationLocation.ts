import { isConsoleBuild } from "@utils/clientConfig";

import {
  inviterSignalingAddress,
  reinviteSignalingAddress,
} from "./transport/signalingAddress";

import type { InvitationLocation } from "@psi/invitation";
import type { ReinviteLocation } from "@psi/managed/managedReinvite";

/**
 * This page's origin and the signaling address a new invitation names
 * ({@link inviterSignalingAddress}), in the shape
 * {@link generateInvitation} takes. It reads `window`, so it must be called
 * from the client and throws when `window` is absent rather than return a
 * server-side value. The inviter console's create and save-exchange-file paths
 * both use it so they build the locator identically.
 *
 * A console build names no signaling address: its server serves no signaling,
 * and its own origin is loopback, which a partner cannot reach.
 */
export function invitationLocation(): InvitationLocation {
  if (typeof window === "undefined")
    throw new Error("invitationLocation must be called in the browser");
  return {
    origin: window.location.origin,
    signaling: isConsoleBuild() ? undefined : inviterSignalingAddress(),
  };
}

/**
 * This page's origin and the coordination server a re-invite from a saved
 * exchange names ({@link reinviteSignalingAddress}), which differs from
 * {@link invitationLocation} only where this browser's setting cannot be
 * read. A console build names none, as there. Browser only.
 */
export function reinviteLocation(): ReinviteLocation {
  if (typeof window === "undefined")
    throw new Error("reinviteLocation must be called in the browser");
  return {
    origin: window.location.origin,
    signaling: isConsoleBuild() ? undefined : reinviteSignalingAddress(),
  };
}
