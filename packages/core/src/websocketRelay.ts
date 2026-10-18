// The `./websocket-relay` entry point of @alcove/core: what the WebSocket relay
// (packages/websocket-relay) takes from core, without the library behind the
// main entry point.
//
// The relay listens on the internet, so its runtime closure is the set of
// packages an advisory can force a redeploy of it over. Every name below
// resolves without any package core declares, and the relay imports from core
// through this entry alone (packages/websocket-relay/test/coreReach.test.ts
// measures the built entry and holds the relay's source to it). A name belongs
// here only when the relay's own source uses it.

export {
  checkWebSocketRelayProof,
  deriveWebSocketRelayProofKey,
  parseWebSocketRelayProof,
  WebSocketRelayProofRefusedError,
} from "./websocketRelayProof";
export type { WebSocketRelayProof } from "./websocketRelayProof";
export { RENDEZVOUS_ROLES } from "./rendezvousRoles";
export type { RendezvousRole } from "./rendezvousRoles";
export { parseBoundedJson } from "./utils/boundedJson";
export { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay";
