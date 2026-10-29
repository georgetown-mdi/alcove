import { describe, expect, test } from "vitest";

import {
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_WEBRTC_PEER_TIMEOUT_MS,
} from "@alcove/core";

import {
  SERVER_JOB_PEER_WINDOW_BODY,
  SERVER_JOB_WEBRTC_PEER_WINDOW_BODY,
  peerWindowDurationPhrase,
  serverJobPeerWindowBody,
} from "@exchange/RunSurface";

describe("serverJobPeerWindowBody", () => {
  test("states the file-sync default wait for SFTP and a shared folder", () => {
    for (const channel of ["sftp", "filedrop"] as const) {
      expect(serverJobPeerWindowBody(channel)).toBe(
        "Your partner's console must run its half while yours is running. Yours " +
          `waits about ${peerWindowDurationPhrase(DEFAULT_PEER_TIMEOUT_MS)} for the ` +
          "partner before the exchange stops; if it stops, coordinate a time and " +
          "run it again.",
      );
    }
    expect(SERVER_JOB_PEER_WINDOW_BODY).toBe(serverJobPeerWindowBody("sftp"));
  });

  test("states the WebRTC default wait, never the file-sync one", () => {
    expect(serverJobPeerWindowBody("webrtc")).toBe(
      "Your partner's side must be open while yours runs: their Alcove web " +
        "app page or their alcove command. Yours waits about " +
        `${peerWindowDurationPhrase(DEFAULT_WEBRTC_PEER_TIMEOUT_MS)} for them before ` +
        "the exchange stops; if it stops, agree on a time with your partner and " +
        "run it again.",
    );
    expect(SERVER_JOB_WEBRTC_PEER_WINDOW_BODY).toBe(
      serverJobPeerWindowBody("webrtc"),
    );
    expect(SERVER_JOB_WEBRTC_PEER_WINDOW_BODY).toContain("10 minutes");
    expect(SERVER_JOB_WEBRTC_PEER_WINDOW_BODY).not.toContain("an hour");
    expect(SERVER_JOB_PEER_WINDOW_BODY).toContain("an hour");
  });

  test("states the run's configured peer timeout over the channel default", () => {
    expect(serverJobPeerWindowBody("webrtc", 30 * 60_000)).toContain(
      "waits about 30 minutes for them",
    );
    expect(serverJobPeerWindowBody("sftp", 2 * 3_600_000)).toContain(
      "waits about 2 hours for the partner",
    );
  });

  test("formats durations, with an hour displayed as 'an hour'", () => {
    expect(peerWindowDurationPhrase(3_600_000)).toBe("an hour");
    expect(peerWindowDurationPhrase(2 * 3_600_000)).toBe("2 hours");
    expect(peerWindowDurationPhrase(60_000)).toBe("a minute");
    expect(peerWindowDurationPhrase(30 * 60_000)).toBe("30 minutes");
  });
});
