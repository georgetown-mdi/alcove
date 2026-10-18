// The rendezvous roles, in a module that imports nothing, so an entry point
// taking them reaches none of the config schemas rendezvous.ts imports.

/**
 * The two roles in a WebRTC rendezvous, each the suffix of one derived peer id
 * (`deriveRendezvousPeerId`). Frozen so a plain-JS caller cannot widen the set
 * that function's runtime guard checks.
 */
export const RENDEZVOUS_ROLES = Object.freeze(["inviter", "acceptor"] as const);

/** A rendezvous role; one of the fixed {@link RENDEZVOUS_ROLES}. */
export type RendezvousRole = (typeof RENDEZVOUS_ROLES)[number];
