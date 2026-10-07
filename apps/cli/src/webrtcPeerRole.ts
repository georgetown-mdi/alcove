import type {
  ConnectionConfig,
  RendezvousRole,
  WebRTCConnectionConfig,
} from "@alcove/core";

/**
 * Return `connection` holding `role`: `alcove invite` stamps `inviter` and
 * `alcove accept` stamps `acceptor`, independent of the PSI sender/receiver
 * roles. On WebRTC the persisted role is the CLI's half of the rendezvous
 * peer-id derivation (docs/spec/PROTOCOL.md, "WebRTC rendezvous peer-id
 * derivation"). Any other channel's schema has no `role`, so its connection is
 * returned unchanged; a stamped WebRTC connection is a copy.
 */
export function withWebRTCPeerRole<Connection extends ConnectionConfig>(
  connection: Connection,
  role: RendezvousRole,
): Connection {
  if (connection.channel !== "webrtc") return connection;
  // Pins the role label to the schema's field type. A separate statement
  // because a generic spread's overridden property is not checked.
  const schemaRole: NonNullable<WebRTCConnectionConfig["role"]> = role;
  return { ...connection, role: schemaRole };
}
