import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CheckBrokenConnections } from "@alcove/peerjs-broker/services/checkBrokenConnections/index";
import { Client } from "@alcove/peerjs-broker/models/client";
import { PEER_PING_INTERVAL_MS } from "@psi/transport/rendezvous";
import { Realm } from "@alcove/peerjs-broker/models/realm";
import defaultConfig from "@alcove/peerjs-broker/config/index";

// The broker's reap windows against this app's PeerJS heartbeat cadence. The
// reaper itself is tested in packages/peerjs-broker/test/signalingReaping.test.ts;
// these cases are here because they read the cadence the web client sets.
const ALIVE_TIMEOUT_MS = defaultConfig.alive_timeout;
const UNCONFIRMED_TIMEOUT_MS = defaultConfig.unconfirmed_timeout;
const CHECK_INTERVAL_MS = 100;

describe("two-tier liveness reaper at the client's heartbeat cadence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a peer that confirms at the heartbeat cadence graduates past the unconfirmed window", () => {
    // A peer that registers silent and only proves liveness when its first
    // heartbeat lands: the slow-but-live invited peer the unconfirmed window
    // must not cut.
    const realm = new Realm();
    const client = new Client({ id: "slow", token: "t" });
    realm.setClient(client, "slow");
    const reaper = new CheckBrokenConnections({
      realm,
      config: {
        alive_timeout: ALIVE_TIMEOUT_MS,
        unconfirmed_timeout: UNCONFIRMED_TIMEOUT_MS,
      },
      checkInterval: CHECK_INTERVAL_MS,
    });
    reaper.start();
    try {
      // The PeerJS client's first heartbeat lands at the pinned cadence, which is
      // comfortably inside the unconfirmed window (pinned at >= 4x the cadence by
      // the invariant test below), so the peer is still registered -- not yet
      // reaped -- when that frame arrives.
      vi.advanceTimersByTime(PEER_PING_INTERVAL_MS);
      expect(realm.getClientById("slow")).toBeDefined();

      // That first inbound frame confirms the peer, graduating it from the
      // unconfirmed window to the generous alive window. Advance past the
      // unconfirmed deadline it would have been reaped at had it stayed silent: it
      // survives, because the reap is tied to liveness, not a flat wall-clock.
      client.confirm();
      vi.advanceTimersByTime(UNCONFIRMED_TIMEOUT_MS);
      expect(realm.getClientById("slow")).toBeDefined();
    } finally {
      reaper.stop();
    }
  });
});

describe("liveness-timeout config invariant", () => {
  // The unconfirmed window must stay at least 4x the PeerJS first-heartbeat
  // cadence (PEER_PING_INTERVAL_MS, set explicitly at Peer construction, not
  // the caret-ranged `peerjs` default) so a real peer always sends a frame and
  // graduates before the window can fire, with margin for a slow socket open
  // and one missed heartbeat. This pins the margin against both values so a
  // narrowing edit fails CI.
  test("unconfirmed_timeout stays at least 4x the heartbeat cadence", () => {
    expect(defaultConfig.unconfirmed_timeout).toBeGreaterThanOrEqual(
      4 * PEER_PING_INTERVAL_MS,
    );
  });
});
