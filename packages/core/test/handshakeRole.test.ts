import { describe, expect, test } from "vitest";

import { InternalConsistencyError } from "../src/errors";
import { handshakeRoleForRendezvousRole } from "../src/rendezvous";
import type { RendezvousRole } from "../src/rendezvous";

describe("handshakeRoleForRendezvousRole", () => {
  test("the acceptor initiates and the inviter responds", () => {
    expect(handshakeRoleForRendezvousRole("acceptor")).toBe("initiator");
    expect(handshakeRoleForRendezvousRole("inviter")).toBe("responder");
  });

  test("refuses a role outside the rendezvous roles", () => {
    expect(() =>
      handshakeRoleForRendezvousRole("starter" as RendezvousRole),
    ).toThrow(InternalConsistencyError);
  });
});
