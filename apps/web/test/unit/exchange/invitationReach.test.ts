import { describe, expect, test } from "vitest";

import { invitationReach } from "@exchange/invitationReach";

describe("invitationReach", () => {
  test.each([
    "http://localhost:3000/accept#t",
    "http://LOCALHOST:3000/accept#t",
    "http://app.localhost/accept#t",
    "http://127.0.0.1:3000/accept#t",
    "http://127.1/accept#t",
    "http://0.0.0.0:3000/accept#t",
    "http://[::1]:3000/accept#t",
    "http://[0:0:0:0:0:0:0:1]/accept#t",
    "http://[::ffff:127.0.0.1]/accept#t",
  ])("%s only works on this computer", (link) => {
    expect(invitationReach(link)).toBe("thisComputer");
  });

  test.each([
    "http://10.1.2.3/accept#t",
    "http://172.16.0.1/accept#t",
    "http://172.31.255.255/accept#t",
    "http://192.168.1.20:3000/accept#t",
    "http://169.254.0.9/accept#t",
    "http://100.64.0.1/accept#t",
    "http://[fd12:3456::1]/accept#t",
    "http://[fe80::1]/accept#t",
    "http://[::ffff:192.168.0.1]/accept#t",
    "http://workstation:3000/accept#t",
    "http://alcove.local/accept#t",
    "http://alcove.corp.internal/accept#t",
    "http://alcove.home.arpa/accept#t",
  ])("%s only works on the local network", (link) => {
    expect(invitationReach(link)).toBe("localNetwork");
  });

  test.each([
    "https://psi.data-bridge.org/accept#t",
    "https://app.example.org:8443/accept#t",
    "http://172.32.0.1/accept#t",
    "http://8.8.8.8/accept#t",
    "http://[2001:db8::1]/accept#t",
    "not a url",
  ])("%s works anywhere", (link) => {
    expect(invitationReach(link)).toBe("anywhere");
  });
});
